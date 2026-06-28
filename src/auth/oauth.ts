import { createHash, randomBytes } from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import axios, { type AxiosInstance } from 'axios'
import {
  DEFAULT_AUTH_ISSUER,
  DEFAULT_LOGIN_PORT,
  FALLBACK_LOGIN_PORT,
  OAUTH_CLIENT_ID
} from '../constants.js'
import { AuthError } from '../errors.js'
import { openExternalUrl } from '../platform.js'
import { readOpenAiAuthClaims } from './jwt.js'

export const REQUIRED_RESPONSES_SCOPE = 'api.responses.write'

export const OAUTH_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'api.connectors.read',
  'api.connectors.invoke'
]

const OAUTH_SCOPE = OAUTH_SCOPES.join(' ')
const TOKEN_EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange'
const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token'
const REQUESTED_API_KEY_TOKEN = 'openai-api-key'
const DEVICE_AUTH_TIMEOUT_MS = 15 * 60 * 1000

export interface OAuthOptions {
  issuer?: string
  clientId?: string
}

export interface OAuthTokens {
  accessToken: string
  refreshToken: string
  idToken: string
  apiKey?: string
  issuer: string
  clientId: string
  accountId?: string
}

interface PkceCodes {
  codeVerifier: string
  codeChallenge: string
}

interface DeviceCodeResponse {
  device_auth_id: string
  user_code?: string
  usercode?: string
  interval?: string | number
}

interface DeviceTokenResponse {
  authorization_code: string
  code_challenge: string
  code_verifier: string
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  id_token: string
}

interface ApiKeyExchangeResponse {
  access_token: string
}

interface RefreshResponse {
  access_token?: string
  refresh_token?: string
  id_token?: string
}

export class OAuthClient {
  private readonly issuer: string
  private readonly clientId: string
  private readonly httpClient: AxiosInstance

  constructor(options: OAuthOptions = {}) {
    this.issuer = trimTrailingSlash(options.issuer ?? DEFAULT_AUTH_ISSUER)
    this.clientId = options.clientId ?? OAUTH_CLIENT_ID
    this.httpClient = axios.create({ timeout: 30_000 })
  }

  async loginWithBrowser(): Promise<OAuthTokens> {
    const pkce = createPkce()
    const state = randomBase64Url(32)
    const server = await createCallbackServer(state)
    const redirectUri = `http://localhost:${server.port}/auth/callback`
    const authUrl = this.buildAuthorizeUrl(redirectUri, pkce, state)

    openExternalUrl(authUrl)
    console.error(
      `Starting local login server on http://localhost:${server.port}.\nIf your browser did not open, visit:\n\n${authUrl}\n`
    )

    try {
      const code = await server.waitForCode()
      const tokens = await this.exchangeCodeForTokens(code, redirectUri, pkce)
      return this.withApiKey(tokens)
    } finally {
      await server.close()
    }
  }

  async loginWithDeviceCode(): Promise<OAuthTokens> {
    const apiBaseUrl = `${this.issuer}/api/accounts`
    const deviceCode = await this.requestDeviceCode(apiBaseUrl)
    const userCode = deviceCode.user_code ?? deviceCode.usercode
    if (!userCode) {
      throw new AuthError('Device auth response did not include a user code.')
    }

    const intervalSeconds = normalizePollingInterval(deviceCode.interval)
    const verificationUrl = `${this.issuer}/codex/device`
    console.error(
      [
        '',
        'Sign in with ChatGPT using device code authorization:',
        '',
        `1. Open ${verificationUrl}`,
        `2. Enter this one-time code: ${userCode}`,
        '',
        'The code expires in 15 minutes.'
      ].join('\n')
    )

    const tokenResponse = await this.pollDeviceToken(
      apiBaseUrl,
      deviceCode.device_auth_id,
      userCode,
      intervalSeconds
    )
    const tokens = await this.exchangeCodeForTokens(
      tokenResponse.authorization_code,
      `${this.issuer}/deviceauth/callback`,
      {
        codeChallenge: tokenResponse.code_challenge,
        codeVerifier: tokenResponse.code_verifier
      }
    )
    return this.withApiKey(tokens)
  }

  async refreshTokens(refreshToken: string): Promise<Partial<OAuthTokens>> {
    const response = await this.httpClient.post<RefreshResponse>(
      `${this.issuer}/oauth/token`,
      {
        client_id: this.clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      },
      {
        headers: { 'Content-Type': 'application/json' }
      }
    )

    const idToken = response.data.id_token
    const refreshed: Partial<OAuthTokens> = {
      accessToken: response.data.access_token,
      refreshToken: response.data.refresh_token,
      idToken,
      issuer: this.issuer,
      clientId: this.clientId
    }

    if (idToken) {
      refreshed.accountId = getAccountId(idToken)
      refreshed.apiKey = await this.obtainApiKey(idToken).catch(() => undefined)
    }

    return refreshed
  }

  private buildAuthorizeUrl(redirectUri: string, pkce: PkceCodes, state: string): string {
    // ref: https://github.com/openai/codex/blob/main/codex-rs/login/src/server.rs
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: redirectUri,
      scope: OAUTH_SCOPE,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      state,
      originator: 'nekodex_cli'
    })
    return `${this.issuer}/oauth/authorize?${params.toString()}`
  }

  private async requestDeviceCode(apiBaseUrl: string): Promise<DeviceCodeResponse> {
    // ref: https://github.com/openai/codex/blob/main/codex-rs/login/src/device_code_auth.rs
    const response = await this.httpClient.post<DeviceCodeResponse>(
      `${apiBaseUrl}/deviceauth/usercode`,
      { client_id: this.clientId },
      { headers: { 'Content-Type': 'application/json' } }
    )
    return response.data
  }

  private async pollDeviceToken(
    apiBaseUrl: string,
    deviceAuthId: string,
    userCode: string,
    intervalSeconds: number
  ): Promise<DeviceTokenResponse> {
    const startedAt = Date.now()
    const pollUrl = `${apiBaseUrl}/deviceauth/token`

    while (Date.now() - startedAt < DEVICE_AUTH_TIMEOUT_MS) {
      const response = await this.httpClient
        .post<DeviceTokenResponse>(
          pollUrl,
          {
            device_auth_id: deviceAuthId,
            user_code: userCode
          },
          {
            headers: { 'Content-Type': 'application/json' },
            validateStatus: () => true
          }
        )
        .catch((error: unknown) => {
          throw new AuthError(`Device auth polling failed: ${formatAxiosError(error)}`)
        })

      if (response.status >= 200 && response.status < 300) {
        return response.data
      }

      if (response.status !== 403 && response.status !== 404) {
        throw new AuthError(`Device auth failed with status ${response.status}.`)
      }

      await delay(intervalSeconds * 1000)
    }

    throw new AuthError('Device auth timed out after 15 minutes.')
  }

  private async exchangeCodeForTokens(
    code: string,
    redirectUri: string,
    pkce: PkceCodes
  ): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: this.clientId,
      code_verifier: pkce.codeVerifier
    })

    const response = await this.httpClient.post<TokenResponse>(
      `${this.issuer}/oauth/token`,
      body.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    )

    return {
      accessToken: response.data.access_token,
      refreshToken: response.data.refresh_token,
      idToken: response.data.id_token,
      issuer: this.issuer,
      clientId: this.clientId,
      accountId: getAccountId(response.data.id_token)
    }
  }

  private async withApiKey(tokens: OAuthTokens): Promise<OAuthTokens> {
    const apiKey = await this.obtainApiKey(tokens.idToken).catch((error: unknown) => {
      throw new AuthError(
        [
          'ChatGPT sign-in completed, but Nekodex could not obtain an API-capable token for the Responses API.',
          `API token exchange failed: ${formatAxiosError(error)}.`,
          'Run `nekodex auth login --api-key` if this ChatGPT account cannot mint an API token.'
        ].join(' ')
      )
    })
    return { ...tokens, apiKey }
  }

  private async obtainApiKey(idToken: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      client_id: this.clientId,
      requested_token: REQUESTED_API_KEY_TOKEN,
      subject_token: idToken,
      subject_token_type: ID_TOKEN_TYPE
    })

    const response = await this.httpClient.post<ApiKeyExchangeResponse>(
      `${this.issuer}/oauth/token`,
      body.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    )
    const apiKey = response.data.access_token?.trim()
    if (!apiKey) {
      throw new AuthError('API token exchange response did not include an access token.')
    }
    return apiKey
  }
}

export function createPkce(): PkceCodes {
  const codeVerifier = randomBase64Url(64)
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  return { codeVerifier, codeChallenge }
}

export function getAccountId(idToken: string): string | undefined {
  const claims = readOpenAiAuthClaims(idToken)
  const accountId = claims.chatgpt_account_id
  return typeof accountId === 'string' ? accountId : undefined
}

function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString('base64url')
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function normalizePollingInterval(interval: DeviceCodeResponse['interval']): number {
  if (typeof interval === 'number' && Number.isFinite(interval) && interval > 0) {
    return interval
  }
  if (typeof interval === 'string') {
    const parsed = Number.parseInt(interval.trim(), 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed
    }
  }
  return 5
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs)
  })
}

interface CallbackServer {
  port: number
  waitForCode: () => Promise<string>
  close: () => Promise<void>
}

async function createCallbackServer(state: string): Promise<CallbackServer> {
  const ports = [DEFAULT_LOGIN_PORT, FALLBACK_LOGIN_PORT, 0]
  let lastError: unknown

  for (const port of ports) {
    try {
      return await bindCallbackServer(port, state)
    } catch (error) {
      lastError = error
    }
  }

  throw new AuthError(`Unable to start login callback server: ${String(lastError)}`)
}

function bindCallbackServer(port: number, expectedState: string): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let resolveCode: (code: string) => void
    let rejectCode: (error: Error) => void
    const codePromise = new Promise<string>((innerResolve, innerReject) => {
      resolveCode = innerResolve
      rejectCode = innerReject
    })

    const server = http.createServer((request, response) => {
      handleCallbackRequest(request, response, expectedState, resolveCode, rejectCode)
    })

    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      const actualPort = typeof address === 'object' && address ? address.port : port
      resolve({
        port: actualPort,
        waitForCode: () => codePromise,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()))
          })
      })
    })
  })
}

function handleCallbackRequest(
  request: IncomingMessage,
  response: ServerResponse,
  expectedState: string,
  resolveCode: (code: string) => void,
  rejectCode: (error: Error) => void
): void {
  const url = new URL(request.url ?? '/', 'http://localhost')

  if (url.pathname === '/auth/callback') {
    const state = url.searchParams.get('state')
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error')

    if (state !== expectedState) {
      response.writeHead(400, { 'Content-Type': 'text/plain' })
      response.end('State mismatch.')
      rejectCode(new AuthError('OAuth callback state mismatch.'))
      return
    }

    if (error) {
      response.writeHead(400, { 'Content-Type': 'text/plain' })
      response.end('Sign-in failed.')
      rejectCode(new AuthError(`OAuth callback failed: ${error}`))
      return
    }

    if (!code) {
      response.writeHead(400, { 'Content-Type': 'text/plain' })
      response.end('Missing authorization code.')
      rejectCode(new AuthError('OAuth callback did not include an authorization code.'))
      return
    }

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end('<h1>Nekodex sign-in complete</h1><p>You can close this tab.</p>')
    resolveCode(code)
    return
  }

  response.writeHead(404, { 'Content-Type': 'text/plain' })
  response.end('Not found.')
}

function formatAxiosError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    if (error.response) {
      return `HTTP ${error.response.status}${formatResponseDetail(error.response.data)}`
    }
    return error.message ?? 'request failed'
  }
  return error instanceof Error ? error.message : String(error)
}

function formatResponseDetail(detail: unknown): string {
  if (!detail) {
    return ''
  }
  if (typeof detail === 'string') {
    return `: ${detail}`
  }
  try {
    return `: ${JSON.stringify(detail)}`
  } catch {
    return `: ${String(detail)}`
  }
}
