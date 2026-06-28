import { promises as fs } from 'node:fs'
import path from 'node:path'

const INSTRUCTION_FILE_NAMES = [
  'AGENTS.md',
  'AGENT.md',
  'agent.md',
  'SKILL.md',
  'skill.md',
  '.nekodex/AGENT.md',
  '.nekodex/SKILL.md'
]

export async function buildInstructions(
  workspaceRoot: string,
  memoryInstructionBlock = ''
): Promise<string> {
  const projectInstructionBlock = await buildProjectInstructionBlock(workspaceRoot)

  return [
    'You are Nekodex, a lightweight coding agent running in a local TypeScript CLI.',
    'Work directly in the user workspace. Prefer small, clear edits and verify changes with tests or focused commands when practical.',
    'Use available tools for reading files, writing files, replacing text, searching, and running shell commands.',
    'Before editing, inspect the relevant files. Keep responses concise and include concrete file paths and commands.',
    projectInstructionBlock,
    memoryInstructionBlock
  ]
    .filter(Boolean)
    .join('\n\n')
}

async function buildProjectInstructionBlock(workspaceRoot: string): Promise<string> {
  const instructionFiles = await findInstructionFiles(workspaceRoot)
  if (instructionFiles.length === 0) {
    return ''
  }

  const renderedInstructions = await Promise.all(
    instructionFiles.map(async (filePath) => {
      const content = await fs.readFile(filePath, 'utf8')
      return `From ${path.relative(workspaceRoot, filePath)}:\n${content}`
    })
  )

  return `Project instruction files:\n\n${renderedInstructions.join('\n\n')}`
}

async function findInstructionFiles(workspaceRoot: string): Promise<string[]> {
  const results: string[] = []
  for (const fileName of INSTRUCTION_FILE_NAMES) {
    const candidate = path.join(workspaceRoot, fileName)
    if (await exists(candidate)) {
      results.push(candidate)
    }
  }
  return results
}

async function exists(filePath: string): Promise<boolean> {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false)
}
