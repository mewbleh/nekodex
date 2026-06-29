import { describe, expect, it } from 'vitest'
import type { ResolvedAuth } from '../src/auth/manager.js'
import { configSchema, type StoredAuth } from '../src/config/schema.js'
import { DEFAULT_CHATGPT_CODEX_BASE_URL, DEFAULT_CHATGPT_CODEX_MODEL } from '../src/constants.js'
import type { PersistedSession } from '../src/session/store.js'
import {
  buildTuiStatus,
  estimateContextTokens,
  type TuiStatusAuthManager,
  type TuiStatusSessionStore
} from '../src/tui/status.js'

describe('TUI status', () => {
  it('shows ChatGPT account, effective model, and approximate context usage', async () => {
    const conversationItems = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }]
      }
    ]
    const status = await buildTuiStatus({
      approvalMode: 'auto',
      authManager: fakeAuthManager(
        { mode: 'chatgpt', accessToken: 'token', accountId: 'acct-123' },
        {
          mode: 'chatgpt',
          token: 'token',
          source: 'stored',
          accountId: 'acct-123',
          baseUrl: DEFAULT_CHATGPT_CODEX_BASE_URL
        }
      ),
      config: configSchema.parse({
        approvalMode: 'ask',
        contextWindow: {
          autoCompact: true,
          compactThresholdTokens: 1_000
        },
        model: 'gpt-5',
        reasoningEffort: 'high',
        sandboxMode: 'read-only'
      }),
      sessionStore: fakeSessionStore(conversationItems),
      workspaceRoot: '/workspace'
    })

    expect(status).toContain('ChatGPT account acct-123 (ChatGPT backend)')
    expect(status).toContain(`model: ${DEFAULT_CHATGPT_CODEX_MODEL} (remapped from gpt-5)`)
    expect(status).toContain('reasoning: high')
    expect(status).toContain(`approx ${estimateContextTokens(conversationItems)} / 1,000 tokens`)
    expect(status).toContain('1 session items')
    expect(status).toContain('approval: auto')
    expect(status).toContain('sandbox: read-only')
  })
})

function fakeAuthManager(
  storedAuth: StoredAuth | null,
  resolvedAuth: ResolvedAuth
): TuiStatusAuthManager {
  return {
    async resolveAuth() {
      return resolvedAuth
    },
    async status() {
      return storedAuth
    }
  }
}

function fakeSessionStore(conversationItems: unknown[]): TuiStatusSessionStore {
  const session: PersistedSession = {
    conversationItems,
    id: 'session-123',
    updatedAt: new Date(0).toISOString(),
    workspaceRoot: '/workspace'
  }
  return {
    async load() {
      return session
    }
  }
}
