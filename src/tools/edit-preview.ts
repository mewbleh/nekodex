const DEFAULT_PREVIEW_LINES = 12
const DEFAULT_PREVIEW_LINE_WIDTH = 120

interface PreviewOptions {
  lineLimit?: number
  lineWidth?: number
}

export function buildFileEditPreview(
  toolName: string,
  rawArguments: unknown,
  options: PreviewOptions = {}
): string | null {
  const argumentsValue = parseArguments(rawArguments)
  if (!isRecord(argumentsValue) || typeof argumentsValue.path !== 'string') {
    return null
  }

  if (toolName === 'write_file' && typeof argumentsValue.content === 'string') {
    return formatPreview(argumentsValue.path, argumentsValue.content, options)
  }

  if (toolName === 'replace_in_file' && typeof argumentsValue.replace === 'string') {
    return formatPreview(argumentsValue.path, argumentsValue.replace, options)
  }

  return null
}

function formatPreview(path: string, content: string, options: PreviewOptions): string {
  const lineLimit = options.lineLimit ?? DEFAULT_PREVIEW_LINES
  const lineWidth = options.lineWidth ?? DEFAULT_PREVIEW_LINE_WIDTH
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const visibleLines = lines.slice(0, lineLimit)
  const previewLines =
    visibleLines.length > 0
      ? visibleLines.map((line) => `[+] ${truncateLine(line, lineWidth)}`)
      : ['[+] <empty file>']
  const omittedLines = Math.max(0, lines.length - visibleLines.length)

  if (omittedLines > 0) {
    previewLines.push(`[+] ... ${omittedLines} more line${omittedLines === 1 ? '' : 's'}`)
  }

  return [`edited file: ${path}`, ...previewLines].join('\n')
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value
  }

  if (!value.trim()) {
    return {}
  }

  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function truncateLine(value: string, width: number): string {
  if (value.length <= width) {
    return value
  }
  if (width <= 3) {
    return value.slice(0, width)
  }
  return `${value.slice(0, width - 3)}...`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
