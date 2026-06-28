import { DEFAULT_CHATGPT_CODEX_BASE_URL, TOKEN_REFRESH_WINDOW_MS } from '../constants.js'
import { AuthError } from '../errors.js'
import type { ConfigStore } from '../config/store.js'
import type { StoredAuth } from '../config/schema.js'
import { readJwtExpirationMs, readOpenAiAuthClaims } from './jwt.js'
import { OAuthClient, type OAuthOptions, type OAuthTokens } from './oauth.js'

const CHATGPT_ACCOUNT_ID_HEADER = 'ChatGPT-Account-ID'
const CHATGPT_FEDRAMP_HEADER = 'X-OpenAI-Fedramp'

export interface ResolvedAuth {
  mode: 'api-key' | 'chatgpt'
  token: string
  source: 'env' | 'stored'
  accountId?: string
  baseUrl?: string
  headers?: Record<string, string>
}

export class AuthManager {
  constructor(private readonly store: ConfigStore) {}

  async loginWithApiKey(apiKey: string): Promise<void> {
    const trimmedApiKey = apiKey.trim()
    if (!trimmedApiKey) {
      throw new AuthError('API key cannot be empty.')
    }
    await this.store.saveAuth({ mode: 'api-key', apiKey: trimmedApiKey })
  }

  async loginWithBrowser(options: OAuthOptions = {}): Promise<StoredAuth> {
    const oauthClient = new OAuthClient(options)
    const tokens = await oauthClient.loginWithBrowser()
    return this.persistOAuthTokens(tokens)
  }

  async loginWithDeviceCode(options: OAuthOptions = {}): Promise<StoredAuth> {
    const oauthClient = new OAuthClient(options)
    const tokens = await oauthClient.loginWithDeviceCode()
    return this.persistOAuthTokens(tokens)
  }

  async logout(): Promise<void> {
    await this.store.clearAuth()
  }

  async status(): Promise<StoredAuth | null> {
    return this.store.loadAuth()
  }

  async resolveAuth(): Promise<ResolvedAuth> {
    const envApiKey = process.env.OPENAI_API_KEY?.trim()
    if (envApiKey) {
      return { mode: 'api-key', token: envApiKey, source: 'env' }
    }

    const storedAuth = await this.store.loadAuth()
    if (!storedAuth) {
      throw new AuthError('Not logged in. Run `nekodex auth login --api-key` first.')
    }

    if (storedAuth.mode === 'api-key') {
      if (!storedAuth.apiKey) {
        throw new AuthError('Stored API-key auth is missing the API key.')
      }
      return { mode: 'api-key', token: storedAuth.apiKey, source: 'stored' }
    }

    return resolveStoredChatGptAuth(await this.refreshChatGptAuthIfNeeded(storedAuth))
  }

  private async persistOAuthTokens(tokens: OAuthTokens): Promise<StoredAuth> {
    const auth: StoredAuth = {
      mode: 'chatgpt',
      apiKey: tokens.apiKey,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      issuer: tokens.issuer,
      clientId: tokens.clientId,
      accountId: tokens.accountId,
      lastRefreshAt: new Date().toISOString()
    }
    await this.store.saveAuth(auth)
    return auth
  }

  private async refreshChatGptAuthIfNeeded(auth: StoredAuth): Promise<StoredAuth> {
    if (!auth.refreshToken || !shouldRefresh(auth.accessToken, auth.lastRefreshAt)) {
      return auth
    }

    const oauthClient = new OAuthClient({
      issuer: auth.issuer,
      clientId: auth.clientId
    })
    const refreshed = await oauthClient.refreshTokens(auth.refreshToken)
    const nextAuth: StoredAuth = {
      ...auth,
      apiKey: refreshed.apiKey ?? auth.apiKey,
      accessToken: refreshed.accessToken ?? auth.accessToken,
      refreshToken: refreshed.refreshToken ?? auth.refreshToken,
      idToken: refreshed.idToken ?? auth.idToken,
      accountId: refreshed.accountId ?? auth.accountId,
      lastRefreshAt: new Date().toISOString()
    }
    await this.store.saveAuth(nextAuth)
    return nextAuth
  }
}

function resolveStoredChatGptAuth(auth: StoredAuth): ResolvedAuth {
  if (auth.apiKey) {
    return {
      mode: 'chatgpt',
      token: auth.apiKey,
      source: 'stored',
      accountId: getStoredChatGptAccountId(auth)
    }
  }

  if (!auth.accessToken) {
    throw new AuthError('Stored ChatGPT auth is missing an access token.')
  }

  const accountId = getStoredChatGptAccountId(auth)
  return {
    mode: 'chatgpt',
    token: auth.accessToken,
    source: 'stored',
    accountId,
    baseUrl: DEFAULT_CHATGPT_CODEX_BASE_URL,
    headers: buildChatGptBackendHeaders(accountId, isFedrampAccount(auth))
  }
}

function buildChatGptBackendHeaders(
  accountId: string | undefined,
  isFedrampAccount: boolean
): Record<string, string> {
  return {
    ...(accountId ? { [CHATGPT_ACCOUNT_ID_HEADER]: accountId } : {}),
    ...(isFedrampAccount ? { [CHATGPT_FEDRAMP_HEADER]: 'true' } : {})
  }
}

function getStoredChatGptAccountId(auth: StoredAuth): string | undefined {
  if (auth.accountId) {
    return auth.accountId
  }

  const accountId = auth.idToken ? readOpenAiAuthClaims(auth.idToken).chatgpt_account_id : undefined
  return typeof accountId === 'string' ? accountId : undefined
}

function isFedrampAccount(auth: StoredAuth): boolean {
  if (!auth.idToken) {
    return false
  }

  return readOpenAiAuthClaims(auth.idToken).chatgpt_account_is_fedramp === true
}

export function maskSecret(secret: string | undefined): string {
  if (!secret || secret.length < 14) {
    return '***'
  }
  return `${secret.slice(0, 8)}***${secret.slice(-5)}`
}

function shouldRefresh(accessToken: string | undefined, lastRefreshAt: string | undefined): boolean {
  if (accessToken) {
    const expiresAtMs = readJwtExpirationMs(accessToken)
    if (expiresAtMs !== null) {
      return expiresAtMs <= Date.now() + TOKEN_REFRESH_WINDOW_MS
    }
  }

  if (!lastRefreshAt) {
    return false
  }

  const lastRefreshMs = Date.parse(lastRefreshAt)
  if (Number.isNaN(lastRefreshMs)) {
    return true
  }

  const refreshEveryEightDaysMs = 8 * 24 * 60 * 60 * 1000
  return lastRefreshMs < Date.now() - refreshEveryEightDaysMs
}
