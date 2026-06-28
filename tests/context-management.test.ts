import { describe, expect, it } from 'vitest'
import { configSchema } from '../src/config/schema.js'
import { buildContextManagement } from '../src/agent/context-management.js'

describe('buildContextManagement', () => {
  it('enables automatic compaction by default', () => {
    const config = configSchema.parse({})

    expect(buildContextManagement(config)).toEqual([
      {
        type: 'compaction',
        compact_threshold: 200_000
      }
    ])
  })

  it('can disable automatic compaction', () => {
    const config = configSchema.parse({
      contextWindow: {
        autoCompact: false
      }
    })

    expect(buildContextManagement(config)).toBeUndefined()
  })
})
