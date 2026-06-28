import path from 'node:path'
import { ToolExecutionError } from '../errors.js'

export function resolveWorkspacePath(
  workspaceRoot: string,
  requestedPath: string | undefined,
  allowOutsideWorkspace: boolean
): string {
  const basePath = requestedPath?.trim() || '.'
  const resolvedPath = path.resolve(workspaceRoot, basePath)

  if (!allowOutsideWorkspace && !isInsidePath(workspaceRoot, resolvedPath)) {
    throw new ToolExecutionError(`Path is outside workspace: ${requestedPath}`)
  }

  return resolvedPath
}

export function isInsidePath(parentPath: string, childPath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
