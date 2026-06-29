import { describe, expect, it } from 'vitest'
import { formatInlineMarkdown, parseTranscriptBlocks } from '../src/tui/markdown.js'

describe('transcript markdown', () => {
  it('splits fenced code blocks from text', () => {
    expect(
      parseTranscriptBlocks(['Run it with:', '', '```bash', 'node cli-snake.js', '```'].join('\n'))
    ).toEqual([
      { lines: ['Run it with:', ''], type: 'text' },
      { language: 'bash', lines: ['node cli-snake.js'], type: 'code' }
    ])
  })

  it('strips lightweight inline markdown markers', () => {
    expect(formatInlineMarkdown('Use `node cli-snake.js` and **restart**.')).toBe(
      'Use node cli-snake.js and restart.'
    )
  })
})
