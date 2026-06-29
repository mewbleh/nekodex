import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildBwrapArgs, shouldAttemptBwrap } from '../src/tools/bwrap.js'
import { runCommandTool } from '../src/tools/shell.js'
import type { ToolExecutionContext } from '../src/tools/types.js'

describe('runCommandTool sandboxing', () => {
  let workspaceRoot: string
  let outsideRoot: string
  let context: ToolExecutionContext

  beforeEach(async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nekodex-shell-'))
    workspaceRoot = path.join(tempRoot, 'workspace')
    outsideRoot = path.join(tempRoot, 'outside')
    await fs.mkdir(workspaceRoot)
    await fs.mkdir(outsideRoot)
    context = {
      workspaceRoot,
      approvalMode: 'auto',
      sandboxMode: 'workspace-write',
      allowOutsideWorkspace: true
    }
  })

  afterEach(async () => {
    await fs.rm(path.dirname(workspaceRoot), { recursive: true, force: true })
  })

  it('blocks shell commands in read-only sandbox mode', async () => {
    await expect(
      runCommandTool.execute(
        { command: 'echo nope', timeoutMs: 1_000 },
        { ...context, sandboxMode: 'read-only' }
      )
    ).rejects.toThrow('read-only')
  })

  it('blocks shell cwd outside the workspace in workspace-write mode', async () => {
    await expect(
      runCommandTool.execute(
        { command: 'echo nope', cwd: outsideRoot, timeoutMs: 1_000 },
        context
      )
    ).rejects.toThrow('outside workspace')
  })

  it('does not auto-enable bwrap on Termux', () => {
    expect(
      shouldAttemptBwrap(
        { ...context, sandboxBackend: 'auto' },
        { TERMUX_VERSION: '1' },
        'linux'
      )
    ).toBe(false)
  })

  it('builds bwrap arguments with read-only root and writable workspace', () => {
    expect(
      buildBwrapArgs({
        command: 'echo hi',
        cwd: workspaceRoot,
        workspaceRoot
      })
    ).toContain('--bind')
  })
})
