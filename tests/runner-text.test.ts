import { describe, expect, it } from 'vitest'
import { collectResponseText } from '../src/agent/runner.js'

describe('collectResponseText', () => {
  it('reads assistant text from message output items', () => {
    expect(
      collectResponseText({
        id: 'resp-1',
        output: [
          {
            type: 'message',
            content: [{ type: 'text', text: 'Created the Snake game.' }]
          }
        ]
      })
    ).toEqual(['Created the Snake game.'])
  })
})
