import { maskSecret } from './auth/manager.js'
import type { ApprovalMode, NekodexConfig, StoredAuth } from './config/schema.js'
import { DEFAULT_MODEL } from './constants.js'

export type ConfigPatch = Omit<Partial<NekodexConfig>, 'contextWindow'> & {
  contextWindow?: Partial<NekodexConfig['contextWindow']>
}

export function parseConfigPatch(key: string, value: string): ConfigPatch {
  if (key === 'model') {
    return { model: value || DEFAULT_MODEL }
  }
  if (key === 'openaiBaseUrl') {
    return { openaiBaseUrl: value }
  }
  if (key === 'approvalMode') {
    return { approvalMode: value as ApprovalMode }
  }
  if (key === 'allowOutsideWorkspace') {
    return { allowOutsideWorkspace: parseBooleanValue(key, value) }
  }
  if (key === 'contextWindow.autoCompact') {
    return { contextWindow: { autoCompact: parseBooleanValue(key, value) } }
  }
  if (key === 'contextWindow.compactThresholdTokens') {
    return { contextWindow: { compactThresholdTokens: parseIntegerValue(key, value) } }
  }
  throw new Error(`Unsupported config key: ${key}`)
}

export function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value]
}

export function formatAuthStatus(storedAuth: StoredAuth | null): string {
  if (!storedAuth) {
    return 'Not logged in.'
  }

  if (storedAuth.mode === 'api-key') {
    return `Logged in with API key ${maskSecret(storedAuth.apiKey)}.`
  }

  return `Logged in with ChatGPT${storedAuth.accountId ? ` (${storedAuth.accountId})` : ''}.`
}

export function formatChatGptLoginMessage(auth: { accountId?: string; apiKey?: string }): string {
  const accountSuffix = auth.accountId ? ` (${auth.accountId})` : ''
  const backend = auth.apiKey ? 'OpenAI API token exchange enabled' : 'ChatGPT backend auth enabled'
  return `Logged in with ChatGPT${accountSuffix}. ${backend}.`
}

export function parsePartialImagesOption(options: {
  partialImages?: string
}): { partialImages?: number } {
  if (!options.partialImages) {
    return {}
  }
  const partialImages = Number.parseInt(options.partialImages, 10)
  if (!Number.isFinite(partialImages)) {
    throw new Error(`Invalid partial image count: ${options.partialImages}`)
  }
  return { partialImages }
}

export function nonEmptyArrayField<TField extends string>(
  field: TField,
  values: string[] | undefined
): Record<TField, string[]> | Record<string, never> {
  return values && values.length > 0 ? ({ [field]: values } as Record<TField, string[]>) : {}
}

export function parseCommaList(value: string | undefined): string[] | undefined {
  const values = value
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  return values && values.length > 0 ? values : undefined
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function parseBooleanValue(key: string, value: string): boolean {
  if (value === 'true') {
    return true
  }
  if (value === 'false') {
    return false
  }
  throw new Error(`${key} must be true or false.`)
}

function parseIntegerValue(key: string, value: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be an integer.`)
  }
  return parsed
}
