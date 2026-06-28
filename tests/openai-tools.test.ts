import { describe, expect, it, vi } from 'vitest'
import { configSchema } from '../src/config/schema.js'
import { buildConfiguredOpenAiTools } from '../src/openai/tools.js'

describe('buildConfiguredOpenAiTools', () => {
  it('normalizes hosted tools and remote MCP config', () => {
    vi.stubEnv('REMOTE_MCP_TOKEN', 'secret-token')
    const config = configSchema.parse({
      openAiHostedTools: [
        { type: 'web_search' },
        { type: 'file_search', vectorStoreIds: ['vs_123'] },
        { type: 'code_interpreter' }
      ],
      mcpServers: [
        {
          serverLabel: 'docs',
          serverUrl: 'https://example.com/mcp',
          authorizationEnvVar: 'REMOTE_MCP_TOKEN',
          allowedTools: ['search'],
          requireApproval: 'never'
        }
      ]
    })

    expect(buildConfiguredOpenAiTools(config)).toEqual([
      { type: 'web_search' },
      { type: 'file_search', vector_store_ids: ['vs_123'] },
      { type: 'code_interpreter', container: { type: 'auto' } },
      {
        type: 'mcp',
        server_label: 'docs',
        server_url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer secret-token' },
        allowed_tools: ['search'],
        require_approval: 'never'
      }
    ])
    vi.unstubAllEnvs()
  })
})
