import path from 'node:path'
import { DEFAULT_MAX_AGENT_STEPS } from '../constants.js'
import type { AuthManager } from '../auth/manager.js'
import type { NekodexConfig } from '../config/schema.js'
import type { MemoryStore } from '../memory/store.js'
import {
  ResponsesClient,
  type OpenAiResponse,
  type ResponseFunctionCall,
  type ResponseOutputMessage
} from '../openai/responses-client.js'
import { buildConfiguredOpenAiTools } from '../openai/tools.js'
import { ToolRegistry } from '../tools/registry.js'
import { buildContextManagement } from './context-management.js'
import { saveResponseImages } from './generated-images.js'
import { buildInstructions } from './instructions.js'

export interface AgentRunnerOptions {
  authManager: AuthManager
  config: NekodexConfig
  workspaceRoot: string
  memoryStore?: MemoryStore
  model?: string
  approvalMode?: 'ask' | 'auto'
  onAssistantText?: (text: string) => void
  onStatus?: (text: string) => void
}

export class AgentRunner {
  private previousResponseId: string | undefined
  private readonly client: ResponsesClient
  private readonly toolRegistry = ToolRegistry.withDefaultTools()

  constructor(private readonly options: AgentRunnerOptions) {
    this.client = new ResponsesClient(options.config.openaiBaseUrl)
  }

  async run(prompt: string): Promise<void> {
    const auth = await this.options.authManager.resolveAuth()
    const memoryInstructionBlock = (await this.options.memoryStore?.toInstructionBlock()) ?? ''
    const instructions = await buildInstructions(this.options.workspaceRoot, memoryInstructionBlock)
    let input: unknown = [
      {
        role: 'user',
        content: [{ type: 'input_text', text: prompt }]
      }
    ]

    for (let step = 0; step < DEFAULT_MAX_AGENT_STEPS; step += 1) {
      const response = await this.client.createResponse(auth.token, {
        model: this.options.model ?? this.options.config.model,
        instructions,
        input,
        tools: [...this.toolRegistry.schemas(), ...buildConfiguredOpenAiTools(this.options.config)],
        previous_response_id: this.previousResponseId,
        context_management: buildContextManagement(this.options.config)
      })

      this.previousResponseId = response.id
      const savedImagePaths = await saveResponseImages(response, this.options.workspaceRoot)
      for (const savedImagePath of savedImagePaths) {
        this.writeStatus(`saved image: ${savedImagePath}`)
      }
      printResponseText(response, this.writeAssistantText)

      const functionCalls = getFunctionCalls(response)
      if (functionCalls.length === 0) {
        return
      }

      const outputs = []
      for (const functionCall of functionCalls) {
        this.writeStatus(`tool: ${functionCall.name}`)
        const result = await this.toolRegistry.execute(functionCall.name, functionCall.arguments, {
          workspaceRoot: path.resolve(this.options.workspaceRoot),
          approvalMode: this.options.approvalMode ?? this.options.config.approvalMode,
          allowOutsideWorkspace: this.options.config.allowOutsideWorkspace,
          openAiToken: auth.token,
          openAiBaseUrl: this.options.config.openaiBaseUrl
        })
        outputs.push({
          type: 'function_call_output',
          call_id: functionCall.call_id,
          output: JSON.stringify(result)
        })
      }

      input = outputs
    }

    this.writeStatus(`Stopped after ${DEFAULT_MAX_AGENT_STEPS} agent steps.`)
  }

  private readonly writeAssistantText = (text: string): void => {
    if (this.options.onAssistantText) {
      this.options.onAssistantText(text)
      return
    }
    console.log(text)
  }

  private readonly writeStatus = (text: string): void => {
    if (this.options.onStatus) {
      this.options.onStatus(text)
      return
    }
    console.error(text)
  }
}

function getFunctionCalls(response: OpenAiResponse): ResponseFunctionCall[] {
  return (response.output ?? []).filter(
    (item): item is ResponseFunctionCall =>
      typeof item === 'object' &&
      item !== null &&
      (item as { type?: unknown }).type === 'function_call'
  )
}

function printResponseText(response: OpenAiResponse, write: (text: string) => void): void {
  if (response.output_text) {
    write(response.output_text)
    return
  }

  for (const item of response.output ?? []) {
    if (!isOutputMessage(item)) {
      continue
    }
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && content.text) {
        write(content.text)
      }
    }
  }
}

function isOutputMessage(item: unknown): item is ResponseOutputMessage {
  return (
    typeof item === 'object' &&
    item !== null &&
    (item as { type?: unknown }).type === 'message'
  )
}
