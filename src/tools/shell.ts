import { spawn } from 'node:child_process'
import { DEFAULT_COMMAND_TIMEOUT_MS } from '../constants.js'
import type { AgentTool, ToolResult } from './types.js'
import { resolveWorkspacePath } from './path-utils.js'
import { assertCanRunCommand, canResolveShellCwdOutsideWorkspace } from './sandbox.js'

export const runCommandTool: AgentTool<{
  command: string
  cwd?: string
  timeoutMs?: number
}> = {
  name: 'run_command',
  description: 'Run a shell command in the workspace and return stdout, stderr, and exit code.',
  requiresApproval: true,
  schema: {
    type: 'function',
    name: 'run_command',
    description: 'Run a shell command in the workspace and return stdout, stderr, and exit code.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command line to run.' },
        cwd: { type: 'string', description: 'Workspace-relative working directory.' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds.' }
      },
      required: ['command'],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const cwd = resolveWorkspacePath(
      context.workspaceRoot,
      input.cwd,
      canResolveShellCwdOutsideWorkspace(context)
    )
    assertCanRunCommand(context, cwd)
    return runShellCommand(input.command, cwd, input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS)
  }
}

function runShellCommand(command: string, cwd: string, timeoutMs: number): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let didTimeout = false
    const timer = setTimeout(() => {
      didTimeout = true
      child.kill('SIGTERM')
    }, Math.max(1_000, timeoutMs))

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, error: error.message })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')
      resolve({
        ok: !didTimeout && code === 0,
        output: {
          code,
          signal,
          stdout: trimCommandOutput(stdout),
          stderr: trimCommandOutput(stderr),
          timedOut: didTimeout
        },
        error: didTimeout ? `Command timed out after ${timeoutMs}ms.` : undefined
      })
    })
  })
}

function trimCommandOutput(value: string): string {
  const maxOutputLength = 30_000
  if (value.length <= maxOutputLength) {
    return value
  }
  return `${value.slice(0, maxOutputLength)}\n...[truncated]`
}
