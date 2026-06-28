import { createInterface } from 'node:readline'
import { APP_VERSION } from '../constants.js'
import type { ApprovalMode, SandboxMode } from '../config/schema.js'
import { ToolRegistry } from '../tools/registry.js'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: unknown
}

interface ToolCallParams {
  name: string
  arguments?: Record<string, unknown>
}

export interface McpServerOptions {
  workspaceRoot: string
  approvalMode: ApprovalMode
  sandboxMode: SandboxMode
  allowOutsideWorkspace: boolean
}

export async function serveMcp(options: McpServerOptions): Promise<void> {
  const registry = ToolRegistry.withDefaultTools()
  const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })

  for await (const line of input) {
    if (!line.trim()) {
      continue
    }

    const request = parseRequest(line)
    if (!request) {
      writeResponse(null, undefined, { code: -32700, message: 'Parse error' })
      continue
    }

    if (request.id === undefined) {
      continue
    }

    try {
      const result = await handleRequest(request, registry, options)
      writeResponse(request.id, result)
    } catch (error) {
      writeResponse(request.id, undefined, {
        code: -32603,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

async function handleRequest(
  request: JsonRpcRequest,
  registry: ToolRegistry,
  options: McpServerOptions
): Promise<unknown> {
  if (request.method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      serverInfo: {
        name: 'nekodex',
        version: APP_VERSION
      },
      capabilities: {
        tools: {}
      }
    }
  }

  if (request.method === 'tools/list') {
    return {
      tools: registry.schemas().map((schema) => ({
        name: schema.name,
        description: schema.description,
        inputSchema: schema.parameters
      }))
    }
  }

  if (request.method === 'tools/call') {
    const params = request.params as ToolCallParams
    const result = await registry.execute(params.name, JSON.stringify(params.arguments ?? {}), {
      workspaceRoot: options.workspaceRoot,
      approvalMode: options.approvalMode,
      sandboxMode: options.sandboxMode,
      allowOutsideWorkspace: options.allowOutsideWorkspace
    })

    return {
      isError: !result.ok,
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  }

  throw new Error(`Unsupported MCP method: ${request.method}`)
}

function parseRequest(line: string): JsonRpcRequest | null {
  try {
    const parsed = JSON.parse(line) as JsonRpcRequest
    if (parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function writeResponse(
  id: string | number | null,
  result?: unknown,
  error?: { code: number; message: string }
): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result, error })}\n`)
}
