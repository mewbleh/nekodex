import type { FunctionToolSchema } from '../openai/responses-client.js'
import type { SandboxMode } from '../config/schema.js'

export interface ToolExecutionContext {
  workspaceRoot: string
  approvalMode: 'ask' | 'auto'
  sandboxMode: SandboxMode
  allowOutsideWorkspace: boolean
  openAiToken?: string
  openAiBaseUrl?: string
  requestApproval?: (request: ToolApprovalRequest) => Promise<boolean>
}

export interface ToolResult {
  ok: boolean
  output?: unknown
  error?: string
}

export interface ToolApprovalRequest {
  arguments: unknown
  toolName: string
}

export interface AgentTool<TInput = unknown> {
  name: string
  description: string
  requiresApproval: boolean
  schema: FunctionToolSchema
  execute(input: TInput, context: ToolExecutionContext): Promise<ToolResult>
}
