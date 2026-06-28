import { Readable } from 'node:stream'
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
  stream?: boolean
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
      const response = await this.client.post<OpenAiResponse | Readable>(
        buildResponsesUrl(auth, this.defaultBaseUrl),
        request,
        {
          headers: buildRequestHeaders(auth, request.stream),
          responseType: request.stream ? 'stream' : 'json'
        }
      )
      if (request.stream) {
        return parseResponseStream(toReadableStream(response.data))
      }
      return response.data as OpenAiResponse
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status
        const detail = await formatResponseDetail(error.response?.data)
        throw new NekodexError(
          `OpenAI request failed${status ? ` with status ${status}` : ''}: ${detail}`
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

export function buildRequestHeaders(
  auth: ResponseAuth,
  acceptsEventStream = false
): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.token}`,
    ...(acceptsEventStream ? { Accept: 'text/event-stream' } : {}),
    'Content-Type': 'application/json',
    'User-Agent': `nekodex/${APP_VERSION}`,
    originator: 'nekodex_cli',
    version: APP_VERSION,
    ...auth.headers
  }
}

function toReadableStream(value: OpenAiResponse | Readable): Readable {
  if (value instanceof Readable) {
    return value
  }
  throw new NekodexError('OpenAI streaming response was not a readable stream.')
}

async function parseResponseStream(stream: Readable): Promise<OpenAiResponse> {
  const output: OpenAiResponse['output'] = []
  const textParts: string[] = []
  let buffer = ''
  let responseId: string | undefined

  for await (const chunk of stream) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    buffer = buffer.replace(/\r\n/g, '\n')

    let boundaryIndex = buffer.indexOf('\n\n')
    while (boundaryIndex !== -1) {
      const block = buffer.slice(0, boundaryIndex)
      buffer = buffer.slice(boundaryIndex + 2)
      responseId = applyResponseStreamBlock(block, output, textParts) ?? responseId
      boundaryIndex = buffer.indexOf('\n\n')
    }
  }

  if (buffer.trim()) {
    responseId = applyResponseStreamBlock(buffer, output, textParts) ?? responseId
  }

  if (!responseId) {
    throw new NekodexError('OpenAI streaming response ended before response.completed.')
  }

  return {
    id: responseId,
    output,
    ...(textParts.length > 0 ? { output_text: textParts.join('') } : {})
  }
}

function applyResponseStreamBlock(
  block: string,
  output: NonNullable<OpenAiResponse['output']>,
  textParts: string[]
): string | undefined {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart())
    .join('\n')
    .trim()

  if (!data || data === '[DONE]') {
    return undefined
  }

  const event = parseStreamEvent(data)
  const type = getStringField(event, 'type')
  if (type === 'response.output_text.delta') {
    const delta = getStringField(event, 'delta')
    if (delta) {
      textParts.push(delta)
    }
    return undefined
  }

  if (type === 'response.output_text.done') {
    const text = getStringField(event, 'text')
    if (text && textParts.length === 0) {
      textParts.push(text)
    }
    return undefined
  }

  if (type === 'response.output_item.done') {
    const item = getRecordField(event, 'item')
    if (item) {
      output.push(item)
    }
    return undefined
  }

  if (type === 'response.completed') {
    const response = getRecordField(event, 'response')
    const completedOutput = response?.output
    if (typeof response?.output_text === 'string' && textParts.length === 0) {
      textParts.push(response.output_text)
    }
    if (output.length === 0 && Array.isArray(completedOutput)) {
      output.push(...completedOutput.filter(isRecord))
    }
    return typeof response?.id === 'string' ? response.id : undefined
  }

  if (type === 'response.created') {
    const response = getRecordField(event, 'response')
    return typeof response?.id === 'string' ? response.id : undefined
  }

  if (type === 'response.failed' || type === 'error') {
    throw new NekodexError(`OpenAI streaming response failed: ${formatDetail(event.error ?? event)}`)
  }

  return undefined
}

function parseStreamEvent(data: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(data) as unknown
    if (isRecord(parsed)) {
      return parsed
    }
  } catch {
    throw new NekodexError(`OpenAI streaming response included invalid JSON: ${data}`)
  }
  throw new NekodexError(`OpenAI streaming response included an invalid event: ${data}`)
}

function getRecordField(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const field = value[key]
  return isRecord(field) ? field : undefined
}

function getStringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  return typeof field === 'string' ? field : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function formatResponseDetail(detail: unknown): Promise<string> {
  if (detail instanceof Readable) {
    return formatDetail(await readStreamText(detail))
  }
  return formatDetail(detail)
}

async function readStreamText(stream: Readable): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
  }
  return chunks.join('')
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
