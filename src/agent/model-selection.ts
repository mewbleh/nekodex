import type { ResolvedAuth } from '../auth/manager.js'
import { DEFAULT_CHATGPT_CODEX_MODEL, DEFAULT_MODEL } from '../constants.js'

const RETIRED_CHATGPT_CODEX_MODELS = new Set([
  'gpt-5',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5.1-codex-mini',
  'gpt-5.1-codex-max',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.3-codex'
])

export interface SelectedResponseModel {
  model: string
  remappedFrom?: string
}

export function selectResponseModel(
  auth: Pick<ResolvedAuth, 'baseUrl'>,
  requestedModel: string | undefined,
  configModel: string
): SelectedResponseModel {
  const model = requestedModel ?? configModel
  if (!auth.baseUrl || !shouldUseChatGptCodexDefault(model)) {
    return { model }
  }

  return {
    model: DEFAULT_CHATGPT_CODEX_MODEL,
    ...(model === DEFAULT_CHATGPT_CODEX_MODEL ? {} : { remappedFrom: model })
  }
}

function shouldUseChatGptCodexDefault(model: string): boolean {
  return model === DEFAULT_MODEL || RETIRED_CHATGPT_CODEX_MODELS.has(model)
}
