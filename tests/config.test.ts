import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseConfigPatch } from '../src/command-helpers.js'
import { configSchema } from '../src/config/schema.js'
import { ConfigStore } from '../src/config/store.js'
import { DEFAULT_REASONING_EFFORT } from '../src/constants.js'

describe('config schema', () => {
  it('defaults reasoning effort to medium', () => {
    expect(configSchema.parse({}).reasoningEffort).toBe(DEFAULT_REASONING_EFFORT)
  })

  it('accepts configured reasoning effort values', () => {
    expect(configSchema.parse({ reasoningEffort: 'xhigh' }).reasoningEffort).toBe('xhigh')
  })

  it('builds a reasoning effort config patch from CLI config set', () => {
    expect(parseConfigPatch('reasoningEffort', 'low')).toEqual({ reasoningEffort: 'low' })
  })

  it('defaults sandbox backend to auto', () => {
    expect(configSchema.parse({}).sandboxBackend).toBe('auto')
  })

  it('builds a sandbox backend config patch from CLI config set', () => {
    expect(parseConfigPatch('sandboxBackend', 'bwrap')).toEqual({ sandboxBackend: 'bwrap' })
  })

  it('loads Codex-style TOML config with MCP tables', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nekodex-config-'))
    try {
      const store = new ConfigStore(homeDir)
      await fs.mkdir(homeDir, { recursive: true })
      await fs.writeFile(
        store.configPath,
        [
          'model = "gpt-5.5"',
          'reasoning_effort = "high"',
          'sandbox_mode = "workspace-write"',
          '',
          '[context_window]',
          'auto_compact = false',
          'compact_threshold_tokens = 1234',
          '',
          '[[openai_hosted_tools]]',
          'type = "image_generation"',
          'partial_images = 2',
          '',
          '[mcp_servers.docs]',
          'url = "https://example.com/mcp"',
          'bearer_token_env_var = "DOCS_MCP_TOKEN"',
          'enabled_tools = ["search"]',
          'require_approval = "never"',
          '',
          '[mcp_servers.local]',
          'command = "node"',
          'args = ["server.js"]'
        ].join('\n'),
        'utf8'
      )

      const config = await store.loadConfig()

      expect(config.reasoningEffort).toBe('high')
      expect(config.contextWindow.autoCompact).toBe(false)
      expect(config.contextWindow.compactThresholdTokens).toBe(1234)
      expect(config.openAiHostedTools).toMatchObject([
        { type: 'image_generation', partialImages: 2 }
      ])
      expect(config.mcpServers).toMatchObject([
        {
          serverLabel: 'docs',
          serverUrl: 'https://example.com/mcp',
          authorizationEnvVar: 'DOCS_MCP_TOKEN',
          allowedTools: ['search'],
          requireApproval: 'never'
        },
        {
          serverLabel: 'local',
          command: 'node',
          args: ['server.js']
        }
      ])
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true })
    }
  })

  it('writes config changes to config.toml', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nekodex-config-'))
    try {
      const store = new ConfigStore(homeDir)

      await store.patchConfig({
        model: 'gpt-5.4-mini',
        contextWindow: { autoCompact: false }
      })

      const content = await fs.readFile(store.configPath, 'utf8')
      expect(content).toContain('model = "gpt-5.4-mini"')
      expect(content).toContain('[context_window]')
      expect(content).toContain('auto_compact = false')
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true })
    }
  })

  it('keeps legacy config.json readable as a fallback', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nekodex-config-'))
    try {
      const store = new ConfigStore(homeDir)
      await fs.writeFile(
        store.legacyConfigPath,
        JSON.stringify({ model: 'gpt-5.4-mini', reasoningEffort: 'low' }),
        'utf8'
      )

      const config = await store.loadConfig()

      expect(config.model).toBe('gpt-5.4-mini')
      expect(config.reasoningEffort).toBe('low')
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true })
    }
  })
})
