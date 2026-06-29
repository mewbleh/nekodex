import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/tools/registry.js'
import type { AgentTool, ToolExecutionContext } from '../src/tools/types.js'

describe('ToolRegistry approvals', () => {
  it('uses the injected approval handler for interactive UIs', async () => {
    let didExecute = false
    const registry = new ToolRegistry([approvalTool(() => {
      didExecute = true
    })])

    const result = await registry.execute('approval_test', '{"path":"game.js"}', {
      ...baseContext(),
      approvalMode: 'ask',
      requestApproval: async (request) => {
        expect(request).toEqual({
          toolName: 'approval_test',
          arguments: { path: 'game.js' }
        })
        return false
      }
    })

    expect(result).toEqual({ ok: false, error: 'User denied tool call: approval_test' })
    expect(didExecute).toBe(false)
  })

  it('runs approved tools after injected approval', async () => {
    const registry = new ToolRegistry([approvalTool()])

    await expect(
      registry.execute('approval_test', '{}', {
        ...baseContext(),
        approvalMode: 'ask',
        requestApproval: async () => true
      })
    ).resolves.toEqual({ ok: true, output: { approved: true } })
  })
})

function approvalTool(onExecute?: () => void): AgentTool {
  return {
    name: 'approval_test',
    description: 'Approval test tool.',
    requiresApproval: true,
    schema: {
      type: 'function',
      name: 'approval_test',
      description: 'Approval test tool.',
      parameters: { type: 'object', properties: {}, additionalProperties: true }
    },
    async execute() {
      onExecute?.()
      return { ok: true, output: { approved: true } }
    }
  }
}

function baseContext(): ToolExecutionContext {
  return {
    workspaceRoot: process.cwd(),
    approvalMode: 'auto',
    sandboxMode: 'workspace-write',
    allowOutsideWorkspace: false
  }
}
