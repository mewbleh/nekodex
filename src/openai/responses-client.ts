import axios, { type AxiosInstance } from 'axios'
import { APP_VERSION, DEFAULT_OPENAI_BASE_URL } from '../constants.js'
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
  store?: boolean
  previous_response_id?: string
  context_management?: Array<Record<string, unknown>>
}

export interface ResponseAuth {
  token: string
  baseUrl?: string
  headers?: Record<string, string>
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

export interface ResponseImageGenerationCall {
  type: 'image_generation_call'
  id?: string
  result?: string
}

export interface OpenAiResponse {
  id: string
  output?: Array<
    ResponseOutputMessage | ResponseFunctionCall | ResponseImageGenerationCall | Record<string, unknown>
  >
  output_text?: string
}

export class ResponsesClient {
  private readonly client: AxiosInstance
  private readonly defaultBaseUrl: string

  constructor(baseUrl = process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL) {
    this.defaultBaseUrl = baseUrl
    this.client = axios.create({
      timeout: 120_000
    })
  }

  async createResponse(auth: ResponseAuth, request: CreateResponseRequest): Promise<OpenAiResponse> {
    try {
      const response = await this.client.post<OpenAiResponse>(
        buildResponsesUrl(auth, this.defaultBaseUrl),
        request,
        {
          headers: buildRequestHeaders(auth)
        }
      )
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

export function buildResponsesUrl(
  auth: Pick<ResponseAuth, 'baseUrl'>,
  defaultBaseUrl: string
): string {
  return `${(auth.baseUrl ?? defaultBaseUrl).replace(/\/+$/, '')}/responses`
}

export function buildRequestHeaders(auth: ResponseAuth): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.token}`,
    'Content-Type': 'application/json',
    'User-Agent': `nekodex/${APP_VERSION}`,
    originator: 'nekodex_cli',
    version: APP_VERSION,
    ...auth.headers
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
