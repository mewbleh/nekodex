import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildInstructions, listInstructionSources } from '../src/agent/instructions.js'

describe('instructions', () => {
  let tempRoot: string

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nekodex-instructions-'))
  })

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('loads project, personal, and env instruction sources', async () => {
    const workspaceRoot = path.join(tempRoot, 'workspace')
    const configHome = path.join(tempRoot, 'home')
    const envFile = path.join(tempRoot, 'env-instructions.md')

    await fs.mkdir(workspaceRoot, { recursive: true })
    await fs.mkdir(configHome, { recursive: true })
    await fs.writeFile(path.join(workspaceRoot, 'AGENTS.md'), 'Project rule', 'utf8')
    await fs.writeFile(path.join(configHome, 'instructions.md'), 'Personal rule', 'utf8')
    await fs.writeFile(envFile, 'Env rule', 'utf8')

    const sources = await listInstructionSources(workspaceRoot, {
      configHome,
      envValue: envFile
    })

    expect(sources.map((source) => source.scope)).toEqual(['env', 'personal', 'project'])
  })

  it('includes custom instructions in the agent prompt', async () => {
    const workspaceRoot = path.join(tempRoot, 'workspace')
    await fs.mkdir(path.join(workspaceRoot, '.nekodex'), { recursive: true })
    await fs.writeFile(
      path.join(workspaceRoot, '.nekodex', 'instructions.md'),
      'Use short final answers.',
      'utf8'
    )

    const instructions = await buildInstructions(workspaceRoot, '', {
      configHome: path.join(tempRoot, 'empty-home'),
      envValue: ''
    })

    expect(instructions).toContain('Custom instruction files')
    expect(instructions).toContain('Use short final answers.')
  })
})
