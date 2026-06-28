import axios, { type AxiosInstance } from 'axios'
import { DEFAULT_OPENAI_BASE_URL } from '../constants.js'
import { NekodexError } from '../errors.js'

export interface FunctionToolSchema {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  strict?: boolean
}

export type ResponseToolSchema = FunctionToolSchema | Record<string, unknown>

export interface CreateResponseRequest {
  model: string
  instructions: string
  input: unknown
  tools: ResponseToolSchema[]
  previous_response_id?: string
}

export interface ResponseOutputMessage {
  type: 'message'
  content?: Array<{ type: string; text?: string }>
}

export interface ResponseFunctionCall {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string
}

export interface OpenAiResponse {
  id: string
  output?: Array<ResponseOutputMessage | ResponseFunctionCall | Record<string, unknown>>
  output_text?: string
}

export class ResponsesClient {
  private readonly client: AxiosInstance

  constructor(baseUrl = process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL) {
    this.client = axios.create({
      baseURL: baseUrl.replace(/\/+$/, ''),
      timeout: 120_000
    })
  }

  async createResponse(token: string, request: CreateResponseRequest): Promise<OpenAiResponse> {
    try {
      const response = await this.client.post<OpenAiResponse>('/responses', request, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      })
      return response.data
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status
        const detail = error.response?.data
        throw new NekodexError(
          `OpenAI request failed${status ? ` with status ${status}` : ''}: ${formatDetail(detail)}`
        )
      }
      throw error
    }
  }
}

function formatDetail(detail: unknown): string {
  if (!detail) {
    return 'no response body'
  }
  if (typeof detail === 'string') {
    return detail
  }
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}
