import type { NekodexConfig } from '../config/schema.js'

export function buildContextManagement(
  config: NekodexConfig
): Array<Record<string, unknown>> | undefined {
  if (!config.contextWindow.autoCompact) {
    return undefined
  }

  // ref: https://platform.openai.com/docs/guides/compaction
  return [
    {
      type: 'compaction',
      compact_threshold: config.contextWindow.compactThresholdTokens
    }
  ]
}
