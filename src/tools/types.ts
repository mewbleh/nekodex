import type { FunctionToolSchema } from '../openai/responses-client.js'

export interface ToolExecutionContext {
  workspaceRoot: string
  approvalMode: 'ask' | 'auto'
  allowOutsideWorkspace: boolean
}

export interface ToolResult {
  ok: boolean
  output?: unknown
  error?: string
}

export interface AgentTool<TInput = unknown> {
  name: string
  description: string
  requiresApproval: boolean
  schema: FunctionToolSchema
  execute(input: TInput, context: ToolExecutionContext): Promise<ToolResult>
}
