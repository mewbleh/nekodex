import { describe, expect, it } from 'vitest'
import { parseConfigPatch } from '../src/command-helpers.js'
import { configSchema } from '../src/config/schema.js'
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
})
