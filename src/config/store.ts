import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  type NekodexConfig,
  type StoredAuth,
  configSchema,
  storedAuthSchema
} from './schema.js'
import { defaultConfigHome } from '../platform.js'

const CONFIG_FILE_NAME = 'config.json'
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
  readonly authPath: string
  readonly memoryPath: string
  readonly sessionsPath: string

  constructor(homeDir = defaultNekodexHome()) {
    this.homeDir = homeDir
    this.configPath = path.join(homeDir, CONFIG_FILE_NAME)
    this.authPath = path.join(homeDir, AUTH_FILE_NAME)
    this.memoryPath = path.join(homeDir, MEMORY_FILE_NAME)
    this.sessionsPath = path.join(homeDir, SESSIONS_FILE_NAME)
  }

  async loadConfig(): Promise<NekodexConfig> {
    const rawConfig = await this.readJsonFile(this.configPath)
    const config = configSchema.parse(rawConfig ?? {})
    return {
      ...config,
      openaiBaseUrl: process.env.OPENAI_BASE_URL?.trim() || config.openaiBaseUrl
    }
  }

  async saveConfig(config: NekodexConfig): Promise<void> {
    await this.writeJsonFile(this.configPath, config)
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
}

export function defaultNekodexHome(): string {
  return defaultConfigHome()
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}
