import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { ToolExecutionError } from '../errors.js'
import { listFilesTool, readFileTool, replaceInFileTool, searchFilesTool, writeFileTool } from './filesystem.js'
import { runCommandTool } from './shell.js'
import type { AgentTool, ToolExecutionContext, ToolResult } from './types.js'

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>()

  static withDefaultTools(): ToolRegistry {
    return new ToolRegistry([
      listFilesTool,
      readFileTool,
      searchFilesTool,
      writeFileTool,
      replaceInFileTool,
      runCommandTool
    ])
  }

  constructor(tools: AgentTool[]) {
    for (const tool of tools) {
      this.tools.set(tool.name, tool)
    }
  }

  schemas() {
    return [...this.tools.values()].map((tool) => tool.schema)
  }

  async execute(name: string, rawArguments: string, context: ToolExecutionContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return { ok: false, error: `Unknown tool: ${name}` }
    }

    try {
      const parsedArguments = parseToolArguments(rawArguments)
      if (tool.requiresApproval && context.approvalMode !== 'auto') {
        const isApproved = await askApproval(name, parsedArguments)
        if (!isApproved) {
          return { ok: false, error: `User denied tool call: ${name}` }
        }
      }
      return await tool.execute(parsedArguments, context)
    } catch (error) {
      if (error instanceof ToolExecutionError) {
        return { ok: false, error: error.message }
      }
      if (error instanceof Error) {
        return { ok: false, error: error.message }
      }
      return { ok: false, error: String(error) }
    }
  }
}

function parseToolArguments(rawArguments: string): unknown {
  if (!rawArguments.trim()) {
    return {}
  }

  try {
    return JSON.parse(rawArguments) as unknown
  } catch (error) {
    throw new ToolExecutionError(
      `Tool arguments are not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

async function askApproval(name: string, argumentsValue: unknown): Promise<boolean> {
  console.error(`\nTool request: ${name}`)
  console.error(JSON.stringify(argumentsValue, null, 2))
  const readline = createInterface({ input, output })
  try {
    const answer = await readline.question('Approve this tool call? [y/N] ')
    return answer.trim().toLowerCase() === 'y'
  } finally {
    readline.close()
  }
}
