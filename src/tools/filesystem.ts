import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  IGNORED_DIRECTORY_NAMES,
  MAX_FILE_READ_BYTES,
  MAX_SEARCH_FILE_BYTES
} from '../constants.js'
import { ToolExecutionError } from '../errors.js'
import type { AgentTool, ToolResult } from './types.js'
import { resolveWorkspacePath } from './path-utils.js'

const textDecoder = new TextDecoder('utf8', { fatal: false })

export const listFilesTool: AgentTool<{ path?: string; maxDepth?: number }> = {
  name: 'list_files',
  description: 'List files and directories inside the workspace.',
  requiresApproval: false,
  schema: {
    type: 'function',
    name: 'list_files',
    description: 'List files and directories inside the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path to list.' },
        maxDepth: { type: 'number', description: 'Maximum recursion depth. Defaults to 2.' }
      },
      required: [],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const root = resolveWorkspacePath(
      context.workspaceRoot,
      input.path,
      context.allowOutsideWorkspace
    )
    const maxDepth = normalizeDepth(input.maxDepth)
    const entries = await listEntries(root, context.workspaceRoot, maxDepth)
    return ok({ entries })
  }
}

export const readFileTool: AgentTool<{ path: string; maxBytes?: number }> = {
  name: 'read_file',
  description: 'Read a UTF-8 text file from the workspace.',
  requiresApproval: false,
  schema: {
    type: 'function',
    name: 'read_file',
    description: 'Read a UTF-8 text file from the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        maxBytes: {
          type: 'number',
          description: `Maximum bytes to read. Defaults to ${MAX_FILE_READ_BYTES}.`
        }
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const filePath = resolveWorkspacePath(
      context.workspaceRoot,
      input.path,
      context.allowOutsideWorkspace
    )
    const maxBytes = Math.min(input.maxBytes ?? MAX_FILE_READ_BYTES, MAX_FILE_READ_BYTES)
    const file = await fs.open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(maxBytes)
      const { bytesRead } = await file.read(buffer, 0, maxBytes, 0)
      const stat = await file.stat()
      return ok({
        path: input.path,
        content: textDecoder.decode(buffer.subarray(0, bytesRead)),
        truncated: stat.size > bytesRead,
        bytesRead,
        totalBytes: stat.size
      })
    } finally {
      await file.close()
    }
  }
}

export const writeFileTool: AgentTool<{ path: string; content: string }> = {
  name: 'write_file',
  description: 'Create or overwrite a UTF-8 text file in the workspace.',
  requiresApproval: true,
  schema: {
    type: 'function',
    name: 'write_file',
    description: 'Create or overwrite a UTF-8 text file in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        content: { type: 'string', description: 'Complete file content.' }
      },
      required: ['path', 'content'],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const filePath = resolveWorkspacePath(
      context.workspaceRoot,
      input.path,
      context.allowOutsideWorkspace
    )
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, input.content, 'utf8')
    return ok({ path: input.path, bytesWritten: Buffer.byteLength(input.content, 'utf8') })
  }
}

export const replaceInFileTool: AgentTool<{
  path: string
  search: string
  replace: string
  replaceAll?: boolean
}> = {
  name: 'replace_in_file',
  description: 'Replace text in an existing UTF-8 workspace file.',
  requiresApproval: true,
  schema: {
    type: 'function',
    name: 'replace_in_file',
    description: 'Replace text in an existing UTF-8 workspace file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        search: { type: 'string', description: 'Exact text to replace.' },
        replace: { type: 'string', description: 'Replacement text.' },
        replaceAll: { type: 'boolean', description: 'Replace all matches. Defaults to false.' }
      },
      required: ['path', 'search', 'replace'],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    if (!input.search) {
      throw new ToolExecutionError('search cannot be empty.')
    }

    const filePath = resolveWorkspacePath(
      context.workspaceRoot,
      input.path,
      context.allowOutsideWorkspace
    )
    const original = await fs.readFile(filePath, 'utf8')
    const occurrences = countOccurrences(original, input.search)

    if (occurrences === 0) {
      throw new ToolExecutionError(`No matches found in ${input.path}.`)
    }
    if (!input.replaceAll && occurrences > 1) {
      throw new ToolExecutionError(
        `Found ${occurrences} matches in ${input.path}; set replaceAll to true to replace all.`
      )
    }

    const updated = input.replaceAll
      ? original.split(input.search).join(input.replace)
      : original.replace(input.search, input.replace)
    await fs.writeFile(filePath, updated, 'utf8')
    return ok({ path: input.path, replacements: input.replaceAll ? occurrences : 1 })
  }
}

export const searchFilesTool: AgentTool<{ query: string; path?: string; maxResults?: number }> = {
  name: 'search_files',
  description: 'Search UTF-8 files for an exact text query.',
  requiresApproval: false,
  schema: {
    type: 'function',
    name: 'search_files',
    description: 'Search UTF-8 files for an exact text query.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Exact text query.' },
        path: { type: 'string', description: 'Workspace-relative directory to search.' },
        maxResults: { type: 'number', description: 'Maximum matches. Defaults to 50.' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const searchRoot = resolveWorkspacePath(
      context.workspaceRoot,
      input.path,
      context.allowOutsideWorkspace
    )
    const maxResults = Math.min(input.maxResults ?? 50, 200)
    const matches = await searchFiles(searchRoot, context.workspaceRoot, input.query, maxResults)
    return ok({ matches, truncated: matches.length >= maxResults })
  }
}

async function listEntries(
  currentPath: string,
  workspaceRoot: string,
  maxDepth: number,
  depth = 0
): Promise<string[]> {
  const entries = await fs.readdir(currentPath, { withFileTypes: true })
  const results: string[] = []

  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name)) {
      continue
    }

    const entryPath = path.join(currentPath, entry.name)
    const relativePath = path.relative(workspaceRoot, entryPath) || '.'
    results.push(entry.isDirectory() ? `${relativePath}/` : relativePath)

    if (entry.isDirectory() && depth < maxDepth) {
      results.push(...(await listEntries(entryPath, workspaceRoot, maxDepth, depth + 1)))
    }
  }

  return results
}

async function searchFiles(
  currentPath: string,
  workspaceRoot: string,
  query: string,
  maxResults: number
): Promise<Array<{ path: string; line: number; preview: string }>> {
  const stat = await fs.stat(currentPath)
  if (stat.isFile()) {
    return searchFile(currentPath, workspaceRoot, query, maxResults)
  }

  const results: Array<{ path: string; line: number; preview: string }> = []
  const entries = await fs.readdir(currentPath, { withFileTypes: true })

  for (const entry of entries) {
    if (results.length >= maxResults) {
      break
    }
    if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name)) {
      continue
    }

    const entryPath = path.join(currentPath, entry.name)
    if (entry.isDirectory()) {
      results.push(
        ...(await searchFiles(entryPath, workspaceRoot, query, maxResults - results.length))
      )
    } else if (entry.isFile()) {
      results.push(
        ...(await searchFile(entryPath, workspaceRoot, query, maxResults - results.length))
      )
    }
  }

  return results
}

async function searchFile(
  filePath: string,
  workspaceRoot: string,
  query: string,
  maxResults: number
): Promise<Array<{ path: string; line: number; preview: string }>> {
  const stat = await fs.stat(filePath)
  if (stat.size > MAX_SEARCH_FILE_BYTES) {
    return []
  }

  const content = await fs.readFile(filePath, 'utf8').catch(() => null)
  if (content === null || !content.includes(query)) {
    return []
  }

  const matches: Array<{ path: string; line: number; preview: string }> = []
  const lines = content.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    if (line.includes(query)) {
      matches.push({
        path: path.relative(workspaceRoot, filePath),
        line: index + 1,
        preview: line.trim().slice(0, 240)
      })
      if (matches.length >= maxResults) {
        break
      }
    }
  }
  return matches
}

function normalizeDepth(depth: number | undefined): number {
  if (depth === undefined || !Number.isFinite(depth)) {
    return 2
  }
  return Math.max(0, Math.min(Math.floor(depth), 8))
}

function countOccurrences(value: string, search: string): number {
  return value.split(search).length - 1
}

function ok(output: unknown): ToolResult {
  return { ok: true, output }
}
