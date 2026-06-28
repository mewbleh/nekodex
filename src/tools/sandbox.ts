import { ToolExecutionError } from '../errors.js'
import { isInsidePath } from './path-utils.js'
import type { ToolExecutionContext } from './types.js'

export function canReadOutsideWorkspace(context: ToolExecutionContext): boolean {
  return context.allowOutsideWorkspace || context.sandboxMode === 'danger-full-access'
}

export function canResolveShellCwdOutsideWorkspace(context: ToolExecutionContext): boolean {
  return context.sandboxMode === 'danger-full-access'
}

export function assertCanWritePath(context: ToolExecutionContext, targetPath: string): void {
  if (context.sandboxMode === 'read-only') {
    throw new ToolExecutionError('Sandbox is read-only; write tools are disabled.')
  }

  if (
    context.sandboxMode === 'workspace-write' &&
    !isInsidePath(context.workspaceRoot, targetPath)
  ) {
    throw new ToolExecutionError('Sandbox allows writes only inside the workspace.')
  }
}

export function assertCanRunCommand(context: ToolExecutionContext, cwd: string): void {
  if (context.sandboxMode === 'read-only') {
    throw new ToolExecutionError('Sandbox is read-only; shell commands are disabled.')
  }

  if (context.sandboxMode === 'workspace-write' && !isInsidePath(context.workspaceRoot, cwd)) {
    throw new ToolExecutionError('Sandbox allows shell commands only inside the workspace.')
  }
}
