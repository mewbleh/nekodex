import { describe, expect, it } from 'vitest'
import { readJwtClaims, readJwtExpirationMs, readOpenAiAuthClaims } from '../src/auth/jwt.js'
import { maskSecret } from '../src/auth/manager.js'

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
