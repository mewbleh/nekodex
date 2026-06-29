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
    'You are Nekodex, a lightweight coding agent running in a local TypeScript CLI.',
    'Work directly in the user workspace. Prefer small, clear edits and verify changes with tests or focused commands when practical.',
    'Use available tools for reading files, writing files, replacing text, searching, and running shell commands.',
    'Before editing, inspect the relevant files. Keep responses concise and include concrete file paths and commands.',
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
      return `From ${formatInstructionSource(workspaceRoot, source)}:\n${content.trimEnd()}`
    })
  )

  return `Custom instruction files:\n\n${renderedInstructions.join('\n\n')}`
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
