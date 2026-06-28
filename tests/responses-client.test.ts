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
          tools: []
        }
      )
    })

    expect(received.path).toBe('/responses')
    expect(received.headers.authorization).toBe('Bearer chatgpt-access-token')
    expect(received.headers['chatgpt-account-id']).toBe('account-123')
    expect(received.body).toMatchObject({ model: 'gpt-5' })
  })
})

async function withCaptureServer(callback: (baseUrl: string) => Promise<void>): Promise<{
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
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ id: 'response-123', output_text: 'ok' }))
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
