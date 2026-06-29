import { promises as fs } from 'node:fs'
import path from 'node:path'
import { defaultConfigHome } from '../platform.js'

const INSTRUCTION_FILE_NAMES = [
  'AGENTS.md',
  'AGENT.md',
  'agent.md',
  'agents.md',
  'SKILL.md',
  'skill.md',
  'instructions.md',
  'custom-instructions.md',
  '.nekodex/AGENTS.md',
  '.nekodex/AGENT.md',
  '.nekodex/agent.md',
  '.nekodex/SKILL.md',
  '.nekodex/skill.md',
  '.nekodex/instructions.md',
  '.nekodex/custom-instructions.md'
]

const PERSONAL_INSTRUCTION_FILE_NAMES = [
  'instructions.md',
  'custom-instructions.md',
  'AGENTS.md',
  'agent.md'
]

const DEFAULT_NEKODEX_INSTRUCTIONS = [
  'You are Nekodex, an agentic coding assistant running in a local CLI.',
  'Work in the user workspace. Inspect relevant files before editing and follow the project style you find.',
  'Preserve user work. Do not overwrite, remove, or revert changes you did not make unless the user explicitly asks.',
  'Use tools to read files, search, edit, and run commands. Prefer focused edits over broad rewrites.',
  'For code changes, verify with the narrowest useful test, typecheck, build, or syntax check when practical.',
  'Do not claim a command passed unless you ran it. If verification is blocked, say exactly what blocked it.',
  'Keep final answers concise, mention changed files and verification, and include concrete next steps only when useful.'
]

export interface InstructionSource {
  path: string
  scope: 'env' | 'personal' | 'project'
}

export interface InstructionSourceOptions {
  configHome?: string
  envValue?: string
}

export async function buildInstructions(
  workspaceRoot: string,
  memoryInstructionBlock = '',
  options: InstructionSourceOptions = {}
): Promise<string> {
  const instructionBlock = await buildInstructionBlock(workspaceRoot, options)

  return [
    ...DEFAULT_NEKODEX_INSTRUCTIONS,
    instructionBlock,
    memoryInstructionBlock
  ]
    .filter(Boolean)
    .join('\n\n')
}

export async function listInstructionSources(
  workspaceRoot: string,
  options: InstructionSourceOptions = {}
): Promise<InstructionSource[]> {
  const candidates: InstructionSource[] = [
    ...envInstructionSources(options.envValue ?? process.env.NEKODEX_INSTRUCTIONS),
    ...personalInstructionSources(options.configHome ?? defaultConfigHome()),
    ...projectInstructionSources(workspaceRoot)
  ]
  const results: InstructionSource[] = []
  const seenPaths = new Set<string>()

  for (const candidate of candidates) {
    const resolvedPath = path.resolve(candidate.path)
    const pathKey = await getExistingInstructionPathKey(resolvedPath)
    if (!pathKey || seenPaths.has(pathKey)) {
      continue
    }
    seenPaths.add(pathKey)
    results.push({ ...candidate, path: resolvedPath })
  }

  return results
}

async function buildInstructionBlock(
  workspaceRoot: string,
  options: InstructionSourceOptions
): Promise<string> {
  const instructionSources = await listInstructionSources(workspaceRoot, options)
  if (instructionSources.length === 0) {
    return ''
  }

  const renderedInstructions = await Promise.all(
    instructionSources.map(async (source) => {
      const content = await fs.readFile(source.path, 'utf8')
      return [
        `# AGENTS.md instructions for ${formatInstructionSource(workspaceRoot, source)}`,
        '',
        '<INSTRUCTIONS>',
        content.trimEnd(),
        '</INSTRUCTIONS>'
      ].join('\n')
    })
  )

  return renderedInstructions.join('\n\n')
}

function envInstructionSources(value: string | undefined): InstructionSource[] {
  return (value ?? '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((filePath) => ({ path: filePath, scope: 'env' }))
}

function personalInstructionSources(configHome: string): InstructionSource[] {
  return PERSONAL_INSTRUCTION_FILE_NAMES.map((fileName) => ({
    path: path.join(configHome, fileName),
    scope: 'personal'
  }))
}

function projectInstructionSources(workspaceRoot: string): InstructionSource[] {
  return INSTRUCTION_FILE_NAMES.map((fileName) => ({
    path: path.join(workspaceRoot, fileName),
    scope: 'project'
  }))
}

function formatInstructionSource(workspaceRoot: string, source: InstructionSource): string {
  if (source.scope === 'project') {
    return path.relative(workspaceRoot, source.path)
  }
  return `${source.scope} ${source.path}`
}

function normalizeInstructionPathKey(filePath: string): string {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? filePath.toLowerCase()
    : filePath
}

async function getExistingInstructionPathKey(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath)
    if (stat.ino !== 0) {
      return `inode:${stat.dev}:${stat.ino}`
    }
    return `path:${normalizeInstructionPathKey(filePath)}`
  } catch (error) {
    if (isNotFoundError(error)) {
      return null
    }
    throw error
  }
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}
