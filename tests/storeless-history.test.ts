import { describe, expect, it } from 'vitest'
import { sanitizeStorelessHistoryItems } from '../src/agent/runner.js'

describe('storeless response history', () => {
  it('removes persisted response item ids while preserving function call ids', () => {
    expect(
      sanitizeStorelessHistoryItems([
        {
          id: 'rs_123',
          type: 'function_call',
          call_id: 'call_123',
          name: 'list_files',
          arguments: '{}',
          nested: [{ id: 'content_123', text: 'kept' }]
        }
      ])
    ).toEqual([
      {
        type: 'function_call',
        call_id: 'call_123',
        name: 'list_files',
        arguments: '{}',
        nested: [{ text: 'kept' }]
      }
    ])
  })
})
