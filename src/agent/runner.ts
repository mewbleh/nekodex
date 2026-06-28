import path from 'node:path'
import { DEFAULT_MAX_AGENT_STEPS } from '../constants.js'
import type { AuthManager } from '../auth/manager.js'
import type { NekodexConfig } from '../config/schema.js'
import type { MemoryStore } from '../memory/store.js'
import type { SessionStore } from '../session/store.js'
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
import {
  selectResponseModel,
  shouldDisableResponseStore,
  shouldUsePreviousResponseId
} from './model-selection.js'

export interface AgentRunnerOptions {
  authManager: AuthManager
  config: NekodexConfig
  workspaceRoot: string
  memoryStore?: MemoryStore
  sessionStore?: SessionStore
  model?: string
  approvalMode?: 'ask' | 'auto'
  onAssistantText?: (text: string) => void
  onStatus?: (text: string) => void
}

export interface AgentRunOptions {
  signal?: AbortSignal
}

export class AgentRunner {
  private conversationItems: unknown[] = []
  private isSessionLoaded = false
  private previousResponseId: string | undefined
  private readonly client: ResponsesClient
  private readonly toolRegistry = ToolRegistry.withDefaultTools()

  constructor(private readonly options: AgentRunnerOptions) {
    this.client = new ResponsesClient(options.config.openaiBaseUrl)
  }

  async run(prompt: string, runOptions: AgentRunOptions = {}): Promise<void> {
    await this.loadSessionIfNeeded()
    const auth = await this.options.authManager.resolveAuth()
    const shouldUseStorelessHistory = shouldDisableResponseStore(auth)
    const memoryInstructionBlock = (await this.options.memoryStore?.toInstructionBlock()) ?? ''
    const instructions = await buildInstructions(this.options.workspaceRoot, memoryInstructionBlock)
    const userInputItem = {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: prompt }]
    }
    const turnItems: unknown[] = [userInputItem]
    let input: unknown = shouldUseStorelessHistory
      ? buildStorelessInput(this.conversationItems, turnItems)
      : [userInputItem]

    for (let step = 0; step < DEFAULT_MAX_AGENT_STEPS; step += 1) {
      const selectedModel = selectResponseModel(
        auth,
        this.options.model,
        this.options.config.model
      )
      if (step === 0 && selectedModel.remappedFrom) {
        this.writeStatus(
          `model: ${selectedModel.model} (ChatGPT backend remapped from ${selectedModel.remappedFrom})`
        )
      }
      const shouldUseChatGptBackendOptions = shouldDisableResponseStore(auth)

      const response = await this.client.createResponse(
        {
          token: auth.token,
          baseUrl: auth.baseUrl,
          headers: auth.headers
        },
        {
          model: selectedModel.model,
          instructions,
          input,
          tools: [...this.toolRegistry.schemas(), ...buildConfiguredOpenAiTools(this.options.config)],
          reasoning: {
            effort: this.options.config.reasoningEffort
          },
          store: shouldUseChatGptBackendOptions ? false : undefined,
          stream: shouldUseChatGptBackendOptions ? true : undefined,
          previous_response_id: shouldUsePreviousResponseId(auth) ? this.previousResponseId : undefined,
          context_management: buildContextManagement(this.options.config)
        },
        { signal: runOptions.signal }
      )

      this.previousResponseId = response.id
      const savedImagePaths = await saveResponseImages(response, this.options.workspaceRoot)
      for (const savedImagePath of savedImagePaths) {
        this.writeStatus(`saved image: ${savedImagePath}`)
      }
      printResponseText(response, this.writeAssistantText)

      const functionCalls = getFunctionCalls(response)
      if (functionCalls.length === 0) {
        if (shouldUseStorelessHistory) {
          this.conversationItems = [
            ...this.conversationItems,
            ...turnItems,
            ...getResponseHistoryItems(response)
          ]
        }
        await this.saveSession()
        return
      }

      const outputs = []
      for (const functionCall of functionCalls) {
        this.writeStatus(`tool: ${functionCall.name}`)
        const result = await this.toolRegistry.execute(functionCall.name, functionCall.arguments, {
          workspaceRoot: path.resolve(this.options.workspaceRoot),
          approvalMode: this.options.approvalMode ?? this.options.config.approvalMode,
          sandboxMode: this.options.config.sandboxMode,
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

      if (shouldUseStorelessHistory) {
        turnItems.push(...getResponseHistoryItems(response), ...outputs)
        input = buildStorelessInput(this.conversationItems, turnItems)
      } else {
        input = outputs
      }
    }

    await this.saveSession()
    this.writeStatus(`Stopped after ${DEFAULT_MAX_AGENT_STEPS} agent steps.`)
  }

  private async loadSessionIfNeeded(): Promise<void> {
    if (this.isSessionLoaded) {
      return
    }
    this.isSessionLoaded = true
    const session = await this.options.sessionStore?.load(this.options.workspaceRoot)
    if (!session) {
      return
    }
    this.previousResponseId = session.previousResponseId
    this.conversationItems = sanitizeStorelessHistoryItems(session.conversationItems)
  }

  private async saveSession(): Promise<void> {
    await this.options.sessionStore?.save(this.options.workspaceRoot, {
      previousResponseId: this.previousResponseId,
      conversationItems: this.conversationItems
    })
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

function getResponseHistoryItems(response: OpenAiResponse): unknown[] {
  if (response.output?.length) {
    return sanitizeStorelessHistoryItems(response.output)
  }
  if (!response.output_text) {
    return []
  }
  return sanitizeStorelessHistoryItems([
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: response.output_text }]
    }
  ])
}

function buildStorelessInput(...itemGroups: unknown[][]): unknown[] {
  return sanitizeStorelessHistoryItems(itemGroups.flat())
}

export function sanitizeStorelessHistoryItems(items: unknown[]): unknown[] {
  return items.map((item) => sanitizeStorelessHistoryItem(item))
}

export function sanitizeStorelessHistoryItem(item: unknown): unknown {
  if (Array.isArray(item)) {
    return item.map((value) => sanitizeStorelessHistoryItem(value))
  }

  if (!isRecord(item)) {
    return item
  }

  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(item)) {
    if (key === 'id') {
      continue
    }
    sanitized[key] = sanitizeStorelessHistoryItem(value)
  }
  return sanitized
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
