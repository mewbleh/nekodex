import { spawn } from 'node:child_process'
import path from 'node:path'
import type { ToolExecutionContext } from './types.js'

export type ShellSandboxBackend = 'bwrap' | 'node'

let cachedBwrapAvailability: Promise<boolean> | null = null

export async function resolveShellSandboxBackend(
  context: ToolExecutionContext,
  env: NodeJS.ProcessEnv = process.env
): Promise<ShellSandboxBackend> {
  const sandboxBackend = context.sandboxBackend ?? 'auto'

  if (!shouldAttemptBwrap(context, env, process.platform)) {
    return 'node'
  }

  const isAvailable = await isBwrapAvailable()
  if (isAvailable) {
    return 'bwrap'
  }

  if (sandboxBackend === 'bwrap') {
    throw new Error(
      'sandboxBackend is bwrap, but bubblewrap is not available or cannot start on this host.'
    )
  }

  return 'node'
}

export function shouldAttemptBwrap(
  context: ToolExecutionContext,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  const sandboxBackend = context.sandboxBackend ?? 'auto'
  if (sandboxBackend === 'node' || sandboxBackend === 'none') {
    return false
  }
  if (context.sandboxMode !== 'workspace-write') {
    return false
  }
  if (platform !== 'linux' || isTermuxEnvironment(env)) {
    return sandboxBackend === 'bwrap'
  }
  return true
}

export function buildBwrapArgs(options: {
  command: string
  cwd: string
  workspaceRoot: string
}): string[] {
  const workspaceRoot = path.resolve(options.workspaceRoot)
  const cwd = path.resolve(options.cwd)

  return [
    '--die-with-parent',
    '--unshare-user',
    '--unshare-ipc',
    '--unshare-pid',
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    '--bind',
    workspaceRoot,
    workspaceRoot,
    '--chdir',
    cwd,
    '--setenv',
    'NEKODEX_SANDBOX',
    'bwrap',
    '/bin/sh',
    '-lc',
    options.command
  ]
}

async function isBwrapAvailable(): Promise<boolean> {
  cachedBwrapAvailability ??= runBwrapProbe()
  return cachedBwrapAvailability
}

function runBwrapProbe(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('bwrap', ['--version'], {
      stdio: 'ignore',
      windowsHide: true
    })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

function isTermuxEnvironment(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.TERMUX_VERSION) || Boolean(env.PREFIX?.includes('/com.termux/'))
}
