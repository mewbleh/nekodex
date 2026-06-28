import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readJwtClaims, readJwtExpirationMs, readJwtScopes, readOpenAiAuthClaims } from '../src/auth/jwt.js'
import { AuthManager, maskSecret } from '../src/auth/manager.js'
import { OAUTH_SCOPES, REQUIRED_RESPONSES_SCOPE } from '../src/auth/oauth.js'
import { ConfigStore } from '../src/config/store.js'

describe('jwt helpers', () => {
  it('reads jwt claims without verifying signatures', () => {
    const token = makeJwt({
      exp: 2,
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'account-123'
      }
    })

    expect(readJwtExpirationMs(token)).toBe(2000)
    expect(readOpenAiAuthClaims(token)).toEqual({ chatgpt_account_id: 'account-123' })
    expect(readJwtClaims(token)?.exp).toBe(2)
  })

  it('reads jwt scopes', () => {
    const token = makeJwt({ scope: `openid ${REQUIRED_RESPONSES_SCOPE}` })

    expect(readJwtScopes(token)).toEqual(['openid', REQUIRED_RESPONSES_SCOPE])
  })
})

describe('ChatGPT auth scopes', () => {
  it('does not request API-only Responses scopes during OAuth login', () => {
    expect(OAUTH_SCOPES).toEqual([
      'openid',
      'profile',
      'email',
      'offline_access',
      'api.connectors.read',
      'api.connectors.invoke'
    ])
    expect(OAUTH_SCOPES).not.toContain(REQUIRED_RESPONSES_SCOPE)
  })

  it('rejects stored ChatGPT auth without an API-capable token', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nekodex-auth-'))
    const store = new ConfigStore(homeDir)
    await store.saveAuth({
      mode: 'chatgpt',
      accessToken: makeJwt({ scope: 'openid profile' }),
      accountId: 'account-123'
    })

    await expect(new AuthManager(store).resolveAuth()).rejects.toThrow('API-capable token')
    await fs.rm(homeDir, { recursive: true, force: true })
  })

  it('uses the exchanged API token for stored ChatGPT auth', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nekodex-auth-'))
    const store = new ConfigStore(homeDir)
    await store.saveAuth({
      mode: 'chatgpt',
      apiKey: 'nekodex-exchanged-api-token',
      accessToken: makeJwt({ scope: 'openid profile' }),
      accountId: 'account-123'
    })

    await expect(new AuthManager(store).resolveAuth()).resolves.toMatchObject({
      mode: 'chatgpt',
      token: 'nekodex-exchanged-api-token',
      accountId: 'account-123'
    })
    await fs.rm(homeDir, { recursive: true, force: true })
  })

  it('accepts stored ChatGPT tokens with the Responses write scope', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nekodex-auth-'))
    const store = new ConfigStore(homeDir)
    await store.saveAuth({
      mode: 'chatgpt',
      accessToken: makeJwt({ scope: `openid ${REQUIRED_RESPONSES_SCOPE}` }),
      accountId: 'account-123'
    })

    await expect(new AuthManager(store).resolveAuth()).resolves.toMatchObject({
      mode: 'chatgpt',
      accountId: 'account-123'
    })
    await fs.rm(homeDir, { recursive: true, force: true })
  })
})

describe('maskSecret', () => {
  it('masks long secrets', () => {
    expect(maskSecret('sk-proj-1234567890ABCDE')).toBe('sk-proj-***ABCDE')
  })

  it('fully masks short secrets', () => {
    expect(maskSecret('short')).toBe('***')
  })
})

function makeJwt(payload: Record<string, unknown>): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `header.${encodedPayload}.signature`
}
