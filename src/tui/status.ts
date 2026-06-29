import type { SelectedResponseModel } from '../agent/model-selection.js'
import { selectResponseModel } from '../agent/model-selection.js'
import { listInstructionSources } from '../agent/instructions.js'
import type { ResolvedAuth } from '../auth/manager.js'
import { maskSecret } from '../auth/manager.js'
import type { NekodexConfig, StoredAuth } from '../config/schema.js'
import type { PersistedSession } from '../session/store.js'

const APPROX_CHARS_PER_TOKEN = 4
const NUMBER_FORMATTER = new Intl.NumberFormat('en-US')

export interface TuiStatusAuthManager {
  resolveAuth(): Promise<ResolvedAuth>
  status(): Promise<StoredAuth | null>
}

export interface TuiStatusSessionStore {
  load(workspaceRoot: string): Promise<PersistedSession | null>
}

export interface BuildTuiStatusOptions {
  approvalMode?: 'ask' | 'auto'
  authManager: TuiStatusAuthManager
  config: NekodexConfig
  model?: string
  sessionStore: TuiStatusSessionStore
  workspaceRoot: string
}

export async function buildTuiStatus(options: BuildTuiStatusOptions): Promise<string> {
  const [storedAuth, session] = await Promise.all([
    options.authManager.status().catch(() => null),
    options.sessionStore.load(options.workspaceRoot).catch(() => null)
  ])
  const instructionSources = await listInstructionSources(options.workspaceRoot).catch(() => [])
  const { authError, resolvedAuth } = await resolveAuthForStatus(options.authManager)
  const selectedModel = selectResponseModel(
    resolvedAuth ?? {},
    options.model,
    options.config.model
  )
  const conversationItems = session?.conversationItems ?? []
  const approxTokens = estimateContextTokens(conversationItems)
  const compactThresholdTokens = options.config.contextWindow.compactThresholdTokens
  const contextMode = options.config.contextWindow.autoCompact ? 'auto compact' : 'manual compact'

  return [
    `auth: ${formatAuthForStatus(storedAuth, resolvedAuth, authError)}`,
    `model: ${formatModelForStatus(selectedModel)}`,
    `reasoning: ${options.config.reasoningEffort}`,
    `context: ${contextMode}, approx ${formatNumber(approxTokens)} / ${formatNumber(compactThresholdTokens)} tokens, ${formatNumber(conversationItems.length)} session items`,
    `instructions: ${formatInstructionSourcesForStatus(instructionSources)}`,
    `approval: ${options.approvalMode ?? options.config.approvalMode}`,
    `sandbox: ${options.config.sandboxMode}`
  ].join('\n')
}

export function estimateContextTokens(items: unknown[]): number {
  if (items.length === 0) {
    return 0
  }
  return Math.ceil(JSON.stringify(items).length / APPROX_CHARS_PER_TOKEN)
}

async function resolveAuthForStatus(
  authManager: TuiStatusAuthManager
): Promise<{ authError?: string; resolvedAuth: ResolvedAuth | null }> {
  try {
    return { resolvedAuth: await authManager.resolveAuth() }
  } catch (error) {
    return {
      authError: error instanceof Error ? error.message : String(error),
      resolvedAuth: null
    }
  }
}

function formatAuthForStatus(
  storedAuth: StoredAuth | null,
  resolvedAuth: ResolvedAuth | null,
  authError: string | undefined
): string {
  if (resolvedAuth?.source === 'env') {
    return 'OpenAI API key from OPENAI_API_KEY'
  }

  if (storedAuth?.mode === 'api-key') {
    return `API key ${maskSecret(storedAuth.apiKey)}`
  }

  if (storedAuth?.mode === 'chatgpt') {
    const accountId = resolvedAuth?.accountId ?? storedAuth.accountId ?? 'unknown account'
    const backend = resolvedAuth?.baseUrl ? 'ChatGPT backend' : 'API token'
    return `ChatGPT account ${accountId} (${backend})`
  }

  return authError ? `not logged in (${authError})` : 'not logged in'
}

function formatModelForStatus(selectedModel: SelectedResponseModel): string {
  if (!selectedModel.remappedFrom) {
    return selectedModel.model
  }
  return `${selectedModel.model} (remapped from ${selectedModel.remappedFrom})`
}

function formatInstructionSourcesForStatus(
  sources: Array<{ path: string; scope: string }>
): string {
  if (sources.length === 0) {
    return 'none'
  }

  const counts = sources.reduce<Record<string, number>>((result, source) => {
    result[source.scope] = (result[source.scope] ?? 0) + 1
    return result
  }, {})
  return Object.entries(counts)
    .map(([scope, count]) => `${count} ${scope}`)
    .join(', ')
}

function formatNumber(value: number): string {
  return NUMBER_FORMATTER.format(value)
}
