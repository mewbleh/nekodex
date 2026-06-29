import { describe, expect, it } from 'vitest'
import { buildFileEditPreview } from '../src/tools/edit-preview.js'

describe('file edit preview', () => {
  it('formats write_file content with added-line prefixes', () => {
    expect(
      buildFileEditPreview('write_file', {
        path: 'cli-snake.js',
        content: 'const score = 0\nconsole.log(score)\n'
      })
    ).toBe(
      ['edited file: cli-snake.js', '[+] const score = 0', '[+] console.log(score)', '[+] '].join(
        '\n'
      )
    )
  })

  it('formats replace_in_file JSON arguments', () => {
    expect(
      buildFileEditPreview(
        'replace_in_file',
        JSON.stringify({ path: 'app.js', search: 'old()', replace: 'newCall()' })
      )
    ).toBe(['edited file: app.js', '[+] newCall()'].join('\n'))
  })
})
