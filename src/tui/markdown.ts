export interface TranscriptBlock {
  language?: string
  lines: string[]
  type: 'code' | 'text'
}

const FENCE_PATTERN = /^\s*```([A-Za-z0-9_+.-]*)\s*$/

export function parseTranscriptBlocks(value: string): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = []
  let textLines: string[] = []
  let codeLines: string[] = []
  let codeLanguage: string | undefined
  let isCodeBlock = false

  const pushTextBlock = () => {
    if (textLines.length === 0) {
      return
    }
    blocks.push({ lines: textLines, type: 'text' })
    textLines = []
  }

  const pushCodeBlock = () => {
    blocks.push({ language: codeLanguage, lines: codeLines, type: 'code' })
    codeLines = []
    codeLanguage = undefined
  }

  for (const line of value.replace(/\r\n/g, '\n').split('\n')) {
    const fenceMatch = line.match(FENCE_PATTERN)
    if (fenceMatch) {
      if (isCodeBlock) {
        pushCodeBlock()
        isCodeBlock = false
      } else {
        pushTextBlock()
        codeLanguage = fenceMatch[1] || undefined
        isCodeBlock = true
      }
      continue
    }

    if (isCodeBlock) {
      codeLines.push(line)
      continue
    }

    textLines.push(formatInlineMarkdown(line))
  }

  if (isCodeBlock) {
    pushCodeBlock()
  } else {
    pushTextBlock()
  }

  return blocks.length > 0 ? blocks : [{ lines: [''], type: 'text' }]
}

export function formatInlineMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]+)]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
}
