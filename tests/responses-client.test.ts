import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildRequestHeaders,
  buildResponsesUrl,
  ResponsesClient
} from '../src/openai/responses-client.js'
import { APP_VERSION } from '../src/constants.js'

let server: http.Server | undefined

afterEach(async () => {
  await closeServer()
})

describe('ResponsesClient', () => {
  it('builds Responses URLs from the active auth base URL', () => {
    expect(
      buildResponsesUrl(
        { baseUrl: 'https://chatgpt.com/backend-api/codex/' },
        'https://api.openai.com/v1'
      )
    ).toBe('https://chatgpt.com/backend-api/codex/responses')
  })

  it('builds default and auth-specific request headers', () => {
    expect(
      buildRequestHeaders({
        token: 'access-token',
        headers: { 'ChatGPT-Account-ID': 'account-123' }
      })
    ).toMatchObject({
      Authorization: 'Bearer access-token',
      'Content-Type': 'application/json',
      'User-Agent': `nekodex/${APP_VERSION}`,
      originator: 'nekodex_cli',
      version: APP_VERSION,
      'ChatGPT-Account-ID': 'account-123'
    })
  })

  it('posts Responses requests with custom backend headers', async () => {
    const received = await withCaptureServer(async (baseUrl) => {
      const client = new ResponsesClient('https://api.openai.com/v1')
      await client.createResponse(
        {
          token: 'chatgpt-access-token',
          baseUrl,
          headers: { 'ChatGPT-Account-ID': 'account-123' }
        },
        {
          model: 'gpt-5',
          instructions: 'test',
          input: 'hello',
          tools: [],
          reasoning: {
            effort: 'high'
          }
        }
      )
    })

    expect(received.path).toBe('/responses')
    expect(received.headers.authorization).toBe('Bearer chatgpt-access-token')
    expect(received.headers['chatgpt-account-id']).toBe('account-123')
    expect(received.body).toMatchObject({ model: 'gpt-5', reasoning: { effort: 'high' } })
  })

  it('parses streamed Responses events for ChatGPT backend requests', async () => {
    const received = await withCaptureServer(
      async (baseUrl) => {
        const client = new ResponsesClient('https://api.openai.com/v1')
        const response = await client.createResponse(
          {
            token: 'chatgpt-access-token',
            baseUrl,
            headers: { 'ChatGPT-Account-ID': 'account-123' }
          },
          {
            model: 'gpt-5.5',
            instructions: 'test',
            input: 'hello',
            tools: [],
            store: false,
            stream: true
          }
        )

        expect(response).toMatchObject({
          id: 'resp-stream',
          output_text: 'hello world'
        })
        expect(response.output).toContainEqual({
          type: 'function_call',
          call_id: 'call-1',
          name: 'shell_command',
          arguments: '{}'
        })
      },
      writeStreamingResponse
    )

    expect(received.headers.accept).toBe('text/event-stream')
    expect(received.body).toMatchObject({
      model: 'gpt-5.5',
      store: false,
      stream: true
    })
  })

  it('formats streamed HTTP error bodies instead of printing object placeholders', async () => {
    await withCaptureServer(
      async (baseUrl) => {
        const client = new ResponsesClient('https://api.openai.com/v1')
        await expect(
          client.createResponse(
            {
              token: 'chatgpt-access-token',
              baseUrl
            },
            {
              model: 'gpt-5.5',
              instructions: 'test',
              input: 'hello',
              tools: [],
              store: false,
              stream: true
            }
          )
        ).rejects.toThrow(
          'OpenAI request failed with status 400: {"detail":"previous_response_id is not available when store is false"}'
        )
      },
      writeStreamingErrorResponse
    )
  })

  it('collects streamed message output text when no output_text delta is sent', async () => {
    await withCaptureServer(
      async (baseUrl) => {
        const client = new ResponsesClient('https://api.openai.com/v1')
        await expect(
          client.createResponse(
            {
              token: 'chatgpt-access-token',
              baseUrl
            },
            {
              model: 'gpt-5.5',
              instructions: 'test',
              input: 'hello',
              tools: [],
              store: false,
              stream: true
            }
          )
        ).resolves.toMatchObject({
          id: 'resp-message',
          output_text: 'final answer'
        })
      },
      writeStreamingMessageResponse
    )
  })
})

async function withCaptureServer(
  callback: (baseUrl: string) => Promise<void>,
  respond: (response: http.ServerResponse) => void = writeJsonResponse
): Promise<{
  path: string
  headers: http.IncomingHttpHeaders
  body: Record<string, unknown>
}> {
  const requestPromise = new Promise<{
    path: string
    headers: http.IncomingHttpHeaders
    body: Record<string, unknown>
  }>((resolve) => {
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        respond(response)
        resolve({
          path: request.url ?? '',
          headers: request.headers,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        })
      })
    })
  })

  const baseUrl = await listenServer()
  await callback(baseUrl)
  return requestPromise
}

function writeJsonResponse(response: http.ServerResponse): void {
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ id: 'response-123', output_text: 'ok' }))
}

function writeStreamingResponse(response: http.ServerResponse): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.write(
    'event: response.created\n' +
      'data: {"type":"response.created","response":{"id":"resp-stream"}}\n\n'
  )
  response.write(
    'event: response.output_text.delta\n' +
      'data: {"type":"response.output_text.delta","delta":"hello "}\n\n'
  )
  response.write(
    'event: response.output_text.delta\n' +
      'data: {"type":"response.output_text.delta","delta":"world"}\n\n'
  )
  response.write(
    'event: response.output_item.done\n' +
      'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call-1","name":"shell_command","arguments":"{}"}}\n\n'
  )
  response.end(
    'event: response.completed\n' +
      'data: {"type":"response.completed","response":{"id":"resp-stream"}}\n\n'
  )
}

function writeStreamingErrorResponse(response: http.ServerResponse): void {
  response.writeHead(400, { 'Content-Type': 'application/json' })
  response.end(
    JSON.stringify({
      detail: 'previous_response_id is not available when store is false'
    })
  )
}

function writeStreamingMessageResponse(response: http.ServerResponse): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.write(
    'event: response.created\n' +
      'data: {"type":"response.created","response":{"id":"resp-message"}}\n\n'
  )
  response.write(
    'event: response.output_item.done\n' +
      'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"text","text":"final answer"}]}}\n\n'
  )
  response.end(
    'event: response.completed\n' +
      'data: {"type":"response.completed","response":{"id":"resp-message"}}\n\n'
  )
}

function listenServer(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!server) {
      reject(new Error('Test server was not created.'))
      return
    }

    server.listen(0, '127.0.0.1', () => {
      const address = server?.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Test server address was unavailable.'))
        return
      }
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function closeServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server?.listening) {
      server = undefined
      resolve()
      return
    }

    server.close((error) => {
      server = undefined
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}
