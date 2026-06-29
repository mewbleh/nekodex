import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import {
  type McpServerConfig,
  type NekodexConfig,
  type OpenAiHostedToolConfig,
  type StoredAuth,
  configSchema,
  storedAuthSchema
} from './schema.js'
import { defaultConfigHome } from '../platform.js'

const CONFIG_FILE_NAME = 'config.toml'
const LEGACY_CONFIG_FILE_NAME = 'config.json'
const AUTH_FILE_NAME = 'auth.json'
const MEMORY_FILE_NAME = 'memories.json'
const SESSIONS_FILE_NAME = 'sessions.json'
const PRIVATE_FILE_MODE = 0o600

type ConfigPatch = Omit<Partial<NekodexConfig>, 'contextWindow'> & {
  contextWindow?: Partial<NekodexConfig['contextWindow']>
}

export class ConfigStore {
  readonly homeDir: string
  readonly configPath: string
  readonly legacyConfigPath: string
  readonly authPath: string
  readonly memoryPath: string
  readonly sessionsPath: string

  constructor(homeDir = defaultNekodexHome()) {
    this.homeDir = homeDir
    this.configPath = path.join(homeDir, CONFIG_FILE_NAME)
    this.legacyConfigPath = path.join(homeDir, LEGACY_CONFIG_FILE_NAME)
    this.authPath = path.join(homeDir, AUTH_FILE_NAME)
    this.memoryPath = path.join(homeDir, MEMORY_FILE_NAME)
    this.sessionsPath = path.join(homeDir, SESSIONS_FILE_NAME)
  }

  async loadConfig(): Promise<NekodexConfig> {
    const rawConfig = await this.readConfigFile()
    const config = configSchema.parse(normalizeConfig(rawConfig ?? {}))
    return {
      ...config,
      openaiBaseUrl: process.env.OPENAI_BASE_URL?.trim() || config.openaiBaseUrl
    }
  }

  async saveConfig(config: NekodexConfig): Promise<void> {
    await this.writeTomlFile(this.configPath, configToToml(config))
  }

  async patchConfig(patch: ConfigPatch): Promise<NekodexConfig> {
    const current = await this.loadConfig()
    const next = configSchema.parse({
      ...current,
      ...patch,
      contextWindow: {
        ...current.contextWindow,
        ...patch.contextWindow
      }
    })
    await this.saveConfig(next)
    return next
  }

  async loadAuth(): Promise<StoredAuth | null> {
    const rawAuth = await this.readJsonFile(this.authPath)
    if (!rawAuth) {
      return null
    }
    return storedAuthSchema.parse(rawAuth)
  }

  async saveAuth(auth: StoredAuth): Promise<void> {
    await this.writeJsonFile(this.authPath, storedAuthSchema.parse(auth), PRIVATE_FILE_MODE)
  }

  async clearAuth(): Promise<void> {
    await fs.rm(this.authPath, { force: true })
  }

  private async readConfigFile(): Promise<unknown | null> {
    try {
      const content = await fs.readFile(this.configPath, 'utf8')
      return parseToml(content)
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error
      }
    }

    return this.readJsonFile(this.legacyConfigPath)
  }

  private async readJsonFile(filePath: string): Promise<unknown | null> {
    try {
      const content = await fs.readFile(filePath, 'utf8')
      return JSON.parse(content) as unknown
    } catch (error) {
      if (isNotFoundError(error)) {
        return null
      }
      throw error
    }
  }

  private async writeJsonFile(
    filePath: string,
    value: unknown,
    mode?: number
  ): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode
    })
    if (mode !== undefined) {
      await fs.chmod(filePath, mode).catch(() => undefined)
    }
  }

  private async writeTomlFile(filePath: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, stringifyToml(value), { encoding: 'utf8' })
  }
}

export function defaultNekodexHome(): string {
  return defaultConfigHome()
}

function normalizeConfig(value: unknown): unknown {
  if (!isRecord(value)) {
    return value
  }

  return {
    ...value,
    reasoningEffort: readField(value, 'reasoningEffort', 'reasoning_effort'),
    openaiBaseUrl: readField(value, 'openaiBaseUrl', 'openai_base_url'),
    approvalMode: normalizeApprovalMode(readField(value, 'approvalMode', 'approval_mode', 'approval_policy')),
    sandboxMode: readField(value, 'sandboxMode', 'sandbox_mode'),
    sandboxBackend: readField(value, 'sandboxBackend', 'sandbox_backend'),
    allowOutsideWorkspace: readField(value, 'allowOutsideWorkspace', 'allow_outside_workspace'),
    openAiHostedTools: normalizeHostedTools(
      readField(value, 'openAiHostedTools', 'openai_hosted_tools')
    ),
    mcpServers: normalizeMcpServers(readField(value, 'mcpServers', 'mcp_servers')),
    contextWindow: normalizeContextWindow(readField(value, 'contextWindow', 'context_window'))
  }
}

function normalizeContextWindow(value: unknown): unknown {
  if (!isRecord(value)) {
    return value
  }

  return {
    ...value,
    autoCompact: readField(value, 'autoCompact', 'auto_compact'),
    compactThresholdTokens: readField(value, 'compactThresholdTokens', 'compact_threshold_tokens')
  }
}

function normalizeHostedTools(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value
  }

  return value.map((tool) => {
    if (!isRecord(tool)) {
      return tool
    }
    return {
      ...tool,
      vectorStoreIds: readField(tool, 'vectorStoreIds', 'vector_store_ids'),
      partialImages: readField(tool, 'partialImages', 'partial_images')
    }
  })
}

function normalizeMcpServers(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((server) => normalizeMcpServer(server))
  }
  if (!isRecord(value)) {
    return value
  }

  return Object.entries(value).map(([label, server]) => normalizeMcpServer(server, label))
}

function normalizeMcpServer(value: unknown, label?: string): unknown {
  if (!isRecord(value)) {
    return value
  }

  return {
    ...value,
    serverLabel: readField(value, 'serverLabel', 'server_label') ?? label,
    serverUrl: readField(value, 'serverUrl', 'server_url', 'url'),
    authorizationEnvVar: readField(
      value,
      'authorizationEnvVar',
      'authorization_env_var',
      'bearer_token_env_var'
    ),
    allowedTools: readField(value, 'allowedTools', 'allowed_tools', 'enabled_tools'),
    requireApproval: readField(value, 'requireApproval', 'require_approval'),
    startupTimeoutSec: readField(value, 'startupTimeoutSec', 'startup_timeout_sec'),
    toolTimeoutSec: readField(value, 'toolTimeoutSec', 'tool_timeout_sec')
  }
}

function configToToml(config: NekodexConfig): Record<string, unknown> {
  return {
    model: config.model,
    reasoning_effort: config.reasoningEffort,
    openai_base_url: config.openaiBaseUrl,
    approval_mode: config.approvalMode,
    sandbox_mode: config.sandboxMode,
    sandbox_backend: config.sandboxBackend,
    allow_outside_workspace: config.allowOutsideWorkspace,
    context_window: {
      auto_compact: config.contextWindow.autoCompact,
      compact_threshold_tokens: config.contextWindow.compactThresholdTokens
    },
    openai_hosted_tools: config.openAiHostedTools.map(hostedToolToToml),
    mcp_servers: mcpServersToToml(config.mcpServers)
  }
}

function hostedToolToToml(tool: OpenAiHostedToolConfig): Record<string, unknown> {
  return removeUndefinedFields({
    ...tool,
    vector_store_ids: tool.vectorStoreIds,
    partial_images: tool.partialImages,
    vectorStoreIds: undefined,
    partialImages: undefined
  })
}

function mcpServersToToml(servers: McpServerConfig[]): Record<string, unknown> {
  return Object.fromEntries(
    servers.map((server) => [
      server.serverLabel,
      removeUndefinedFields({
        url: server.serverUrl,
        command: server.command,
        args: server.args,
        env: server.env,
        bearer_token_env_var: server.authorizationEnvVar,
        enabled_tools: server.allowedTools,
        require_approval: server.requireApproval,
        startup_timeout_sec: server.startupTimeoutSec,
        tool_timeout_sec: server.toolTimeoutSec
      })
    ])
  )
}

function removeUndefinedFields(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined))
}

function normalizeApprovalMode(value: unknown): unknown {
  if (value === 'on-request') {
    return 'ask'
  }
  if (value === 'never') {
    return 'auto'
  }
  return value
}

function readField(value: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (value[key] !== undefined) {
      return value[key]
    }
  }
  return undefined
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
