import type { McpServerConfig, NekodexConfig, OpenAiHostedToolConfig } from '../config/schema.js'
import type { ResponseToolSchema } from './responses-client.js'

const FILE_SEARCH_TOOL_TYPE = 'file_search'
const CODE_INTERPRETER_TOOL_TYPE = 'code_interpreter'
const IMAGE_GENERATION_TOOL_TYPE = 'image_generation'
const MCP_TOOL_TYPE = 'mcp'

export function buildConfiguredOpenAiTools(config: NekodexConfig): ResponseToolSchema[] {
  return [
    ...config.openAiHostedTools.map(normalizeHostedTool),
    ...config.mcpServers.map(normalizeMcpTool)
  ]
}

function normalizeHostedTool(tool: OpenAiHostedToolConfig): ResponseToolSchema {
  // ref: https://platform.openai.com/docs/guides/tools
  if (tool.type === FILE_SEARCH_TOOL_TYPE) {
    return {
      type: FILE_SEARCH_TOOL_TYPE,
      vector_store_ids: tool.vectorStoreIds ?? []
    }
  }

  if (tool.type === CODE_INTERPRETER_TOOL_TYPE) {
    return {
      type: CODE_INTERPRETER_TOOL_TYPE,
      container: tool.container ?? { type: 'auto' }
    }
  }

  if (tool.type === IMAGE_GENERATION_TOOL_TYPE) {
    return {
      type: IMAGE_GENERATION_TOOL_TYPE,
      ...(tool.partialImages ? { partial_images: tool.partialImages } : {})
    }
  }

  return { ...tool }
}

function normalizeMcpTool(server: McpServerConfig): ResponseToolSchema {
  // ref: https://platform.openai.com/docs/guides/tools-remote-mcp
  const authorization = server.authorizationEnvVar
    ? process.env[server.authorizationEnvVar]
    : undefined
  const headers = authorization ? { Authorization: `Bearer ${authorization}` } : undefined

  return {
    type: MCP_TOOL_TYPE,
    server_label: server.serverLabel,
    server_url: server.serverUrl,
    ...(headers ? { headers } : {}),
    ...(server.allowedTools ? { allowed_tools: server.allowedTools } : {}),
    ...(server.requireApproval ? { require_approval: server.requireApproval } : {})
  }
}
