import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveWorkspacePath } from '../src/tools/path-utils.js'

describe('resolveWorkspacePath', () => {
  it('resolves paths inside the workspace', () => {
    const root = path.resolve('/tmp/workspace')

    expect(resolveWorkspacePath(root, 'src/index.ts', false)).toBe(
      path.join(root, 'src/index.ts')
    )
  })

  it('rejects paths outside the workspace by default', () => {
    const root = path.resolve('/tmp/workspace')

    expect(() => resolveWorkspacePath(root, '../secret.txt', false)).toThrow(
      'Path is outside workspace'
    )
  })
})
