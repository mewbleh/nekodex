import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileTool, replaceInFileTool, searchFilesTool } from '../src/tools/filesystem.js'
import type { ToolExecutionContext } from '../src/tools/types.js'

describe('filesystem tools', () => {
  let workspaceRoot: string
  let context: ToolExecutionContext

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nekodex-tools-'))
    context = {
      workspaceRoot,
      approvalMode: 'auto',
      allowOutsideWorkspace: false
    }
  })

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true })
  })

  it('reads and searches text files', async () => {
    await fs.writeFile(path.join(workspaceRoot, 'note.txt'), 'alpha\nbeta\n', 'utf8')

    const readResult = await readFileTool.execute({ path: 'note.txt' }, context)
    const searchResult = await searchFilesTool.execute({ query: 'beta' }, context)

    expect(readResult.ok).toBe(true)
    expect(readResult.output).toMatchObject({ content: 'alpha\nbeta\n' })
    expect(searchResult.output).toMatchObject({
      matches: [{ path: 'note.txt', line: 2, preview: 'beta' }]
    })
  })

  it('replaces exact text once by default', async () => {
    const filePath = path.join(workspaceRoot, 'note.txt')
    await fs.writeFile(filePath, 'alpha\nbeta\n', 'utf8')

    const result = await replaceInFileTool.execute(
      { path: 'note.txt', search: 'beta', replace: 'gamma' },
      context
    )

    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('alpha\ngamma\n')
    expect(result.output).toMatchObject({ replacements: 1 })
  })
})
