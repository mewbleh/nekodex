import path from 'node:path'
import { Box, Text, render, useApp, useInput, useStdout } from 'ink'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AgentRunner } from '../agent/runner.js'
import { AuthManager } from '../auth/manager.js'
import type { NekodexConfig } from '../config/schema.js'
import type { ConfigStore } from '../config/store.js'
import { APP_VERSION } from '../constants.js'
import { MemoryStore } from '../memory/store.js'
import { SessionStore } from '../session/store.js'
import type { ToolApprovalRequest } from '../tools/types.js'
import { buildTuiStatus } from './status.js'

const ANIMATION_INTERVAL_MS = 120
const ANIMATION_FRAMES = ['-', '\\', '|', '/']
const APPROVAL_DETAIL_ROWS = 5
const MAX_TRANSCRIPT_ITEMS = 80
const MIN_TRANSCRIPT_HEIGHT = 8
const STATIC_LAYOUT_ROWS = 6

type TranscriptRole = 'assistant' | 'error' | 'status' | 'tool' | 'user'

interface TranscriptItem {
  id: number
  role: TranscriptRole
  text: string
}

interface PendingApproval {
  detail: string
  id: number
  request: ToolApprovalRequest
}

export interface TuiOptions {
  configStore: ConfigStore
  config: NekodexConfig
  workspaceRoot: string
  model?: string
  approvalMode?: 'ask' | 'auto'
}

export function startTui(options: TuiOptions): void {
  render(<NekodexTui options={options} />)
}

function NekodexTui({ options }: { options: TuiOptions }) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [prompt, setPrompt] = useState('')
  const [status, setStatus] = useState('Ready')
  const [isRunning, setIsRunning] = useState(false)
  const [frameIndex, setFrameIndex] = useState(0)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const [transcript, setTranscript] = useState<TranscriptItem[]>([
    {
      id: 1,
      role: 'status',
      text: 'Nekodex is ready. Ask for a change, review, command, or plan.'
    }
  ])
  const nextIdRef = useRef(2)
  const abortControllerRef = useRef<AbortController | null>(null)
  const approvalResolverRef = useRef<((approved: boolean) => void) | null>(null)
  const authManagerRef = useRef<AuthManager | null>(null)
  const sessionStoreRef = useRef<SessionStore | null>(null)
  const runnerRef = useRef<AgentRunner | null>(null)

  const appendTranscript = useCallback((role: TranscriptRole, text: string) => {
    setTranscript((current) => {
      const nextItem = {
        id: nextIdRef.current,
        role,
        text
      }
      nextIdRef.current += 1
      return [...current, nextItem].slice(-MAX_TRANSCRIPT_ITEMS)
    })
  }, [])

  const requestToolApproval = useCallback(
    async (request: ToolApprovalRequest): Promise<boolean> =>
      new Promise((resolve) => {
        const detail = formatToolArguments(request.arguments)
        approvalResolverRef.current = resolve
        setPendingApproval({
          detail,
          id: nextIdRef.current,
          request
        })
        nextIdRef.current += 1
        setStatus(`Approve ${request.toolName}?`)
        appendTranscript('tool', `approval requested: ${request.toolName}\n${detail}`)
      }),
    [appendTranscript]
  )

  const resolvePendingApproval = useCallback(
    (approved: boolean) => {
      if (!pendingApproval) {
        return
      }

      approvalResolverRef.current?.(approved)
      approvalResolverRef.current = null
      setPendingApproval(null)
      setStatus(approved ? 'Approved' : 'Denied')
      appendTranscript('tool', `${approved ? 'approved' : 'denied'}: ${pendingApproval.request.toolName}`)
    },
    [appendTranscript, pendingApproval]
  )

  if (!authManagerRef.current) {
    authManagerRef.current = new AuthManager(options.configStore)
  }

  if (!sessionStoreRef.current) {
    sessionStoreRef.current = new SessionStore(options.configStore)
  }

  if (!runnerRef.current) {
    runnerRef.current = new AgentRunner({
      authManager: authManagerRef.current,
      config: options.config,
      workspaceRoot: options.workspaceRoot,
      memoryStore: new MemoryStore(options.configStore),
      sessionStore: sessionStoreRef.current,
      model: options.model,
      approvalMode: options.approvalMode,
      onAssistantText: (text) => appendTranscript('assistant', text),
      onToolApproval: requestToolApproval,
      onStatus: (text) => {
        setStatus(text)
        appendTranscript(text.startsWith('tool:') ? 'tool' : 'status', text)
      }
    })
  }

  useEffect(() => {
    if (!isRunning) {
      setFrameIndex(0)
      return undefined
    }

    const interval = setInterval(() => {
      setFrameIndex((current) => current + 1)
    }, ANIMATION_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [isRunning])

  const runSlashCommand = useCallback(
    async (commandLine: string) => {
      const command = parseSlashCommand(commandLine)

      if (command === 'clear') {
        setTranscript([])
        setStatus('Ready')
        return
      }

      if (command === 'exit' || command === 'quit') {
        exit()
        return
      }

      if (command === 'help') {
        appendTranscript('status', SLASH_COMMAND_HELP)
        return
      }

      if (command === 'status') {
        setStatus('Status')
        appendTranscript(
          'status',
          await buildTuiStatus({
            approvalMode: options.approvalMode,
            authManager: authManagerRef.current as AuthManager,
            config: options.config,
            model: options.model,
            sessionStore: sessionStoreRef.current as SessionStore,
            workspaceRoot: options.workspaceRoot
          })
        )
        setStatus('Ready')
        return
      }

      appendTranscript('error', `Unknown command: /${command || ''}. Try /help.`)
    },
    [appendTranscript, exit, options]
  )

  const submitPrompt = useCallback(() => {
    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt || isRunning) {
      return
    }

    setPrompt('')
    appendTranscript('user', trimmedPrompt)

    if (trimmedPrompt.startsWith('/')) {
      void runSlashCommand(trimmedPrompt).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        appendTranscript('error', message)
        setStatus('Ready')
      })
      return
    }

    setIsRunning(true)
    setStatus('Thinking')
    const abortController = new AbortController()
    abortControllerRef.current = abortController

    void runnerRef.current
      ?.run(trimmedPrompt, { signal: abortController.signal })
      .catch((error: unknown) => {
        if (abortController.signal.aborted) {
          appendTranscript('status', 'Interrupted.')
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        appendTranscript('error', message)
      })
      .finally(() => {
        if (abortControllerRef.current === abortController) {
          abortControllerRef.current = null
        }
        setIsRunning(false)
        setStatus('Ready')
      })
  }, [appendTranscript, isRunning, prompt, runSlashCommand])

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (pendingApproval) {
        resolvePendingApproval(false)
        setStatus('Stopping')
        abortControllerRef.current?.abort()
        return
      }
      if (isRunning) {
        setStatus('Stopping')
        abortControllerRef.current?.abort()
        return
      }
      exit()
      return
    }
    if (pendingApproval) {
      if (key.return || input.toLowerCase() === 'y') {
        resolvePendingApproval(true)
        return
      }
      if (key.escape || input.toLowerCase() === 'n') {
        resolvePendingApproval(false)
        return
      }
      return
    }
    if (key.escape) {
      setPrompt('')
      return
    }
    if (key.return) {
      submitPrompt()
      return
    }
    if (key.backspace || key.delete) {
      setPrompt((current) => current.slice(0, -1))
      return
    }
    if (!key.ctrl && input) {
      setPrompt((current) => `${current}${input}`)
    }
  })

  const dimensions = getTerminalDimensions(stdout)
  const approvalRows = pendingApproval
    ? getApprovalPanelRows(pendingApproval.detail, dimensions.columns)
    : 0
  const transcriptHeight = Math.max(
    MIN_TRANSCRIPT_HEIGHT,
    dimensions.rows - STATIC_LAYOUT_ROWS - approvalRows
  )
  const visibleTranscript = useMemo(
    () => transcript.slice(-transcriptHeight),
    [transcript, transcriptHeight]
  )
  const model = options.model ?? options.config.model
  const workspaceLabel = compactPath(options.workspaceRoot, dimensions.columns)
  const frame = ANIMATION_FRAMES[frameIndex % ANIMATION_FRAMES.length]
  const approvalMode = options.approvalMode ?? options.config.approvalMode
  const contextMode = options.config.contextWindow.autoCompact ? 'auto' : 'manual'
  const reasoningEffort = options.config.reasoningEffort
  const sandboxMode = options.config.sandboxMode

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header
        approvalMode={approvalMode}
        contextMode={contextMode}
        frame={frame}
        isRunning={isRunning}
        model={model}
        reasoningEffort={reasoningEffort}
        sandboxMode={sandboxMode}
        status={status}
        width={dimensions.columns - 2}
        workspaceLabel={workspaceLabel}
      />
      <Box marginTop={1} flexDirection="column" height={transcriptHeight}>
        {visibleTranscript.map((item) => (
          <TranscriptLine key={item.id} item={item} width={dimensions.columns - 12} />
        ))}
      </Box>
      {pendingApproval ? <ApprovalPanel approval={pendingApproval} width={dimensions.columns - 4} /> : null}
      <Composer isApprovalPending={Boolean(pendingApproval)} prompt={prompt} isRunning={isRunning} />
      <Footer isRunning={isRunning} />
    </Box>
  )
}

function Header({
  approvalMode,
  contextMode,
  frame,
  isRunning,
  model,
  reasoningEffort,
  sandboxMode,
  status,
  width,
  workspaceLabel
}: {
  approvalMode: string
  contextMode: string
  frame: string
  isRunning: boolean
  model: string
  reasoningEffort: string
  sandboxMode: string
  status: string
  width: number
  workspaceLabel: string
}) {
  const state = isRunning ? frame : 'ok'
  const title = truncateLine(`Nekodex v${APP_VERSION} ${state} ${status}`, width)
  const metadata = truncateLine(
    `cwd ${workspaceLabel} | model ${model} | approval ${approvalMode} | effort ${reasoningEffort} | sandbox ${sandboxMode} | context ${contextMode}`,
    width
  )

  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>{title}</Text>
      <Text color="gray">{metadata}</Text>
    </Box>
  )
}

function TranscriptLine({ item, width }: { item: TranscriptItem; width: number }) {
  const role = roleStyle(item.role)
  const lines = wrapText(item.text, Math.max(24, width))
  const prefix = role.label.padEnd(8, ' ')

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Box key={`${item.id}-${index}`}>
          <Text color={role.color} bold>
            {index === 0 ? prefix : ' '.repeat(prefix.length)}
          </Text>
          <Text color={role.bodyColor}>{line || ' '}</Text>
        </Box>
      ))}
    </Box>
  )
}

function ApprovalPanel({ approval, width }: { approval: PendingApproval; width: number }) {
  const detailLines = wrapText(approval.detail, Math.max(24, width - 4)).slice(
    0,
    APPROVAL_DETAIL_ROWS
  )

  return (
    <Box
      borderColor="yellow"
      borderStyle="round"
      flexDirection="column"
      marginTop={1}
      paddingX={1}
    >
      <Text color="yellow" bold>
        approval required: {approval.request.toolName}
      </Text>
      {detailLines.map((line, index) => (
        <Text key={`${approval.id}-${index}`} color="gray">
          {line}
        </Text>
      ))}
      <Text color="gray">Y/Enter approve  N/Esc deny  Ctrl+C stop</Text>
    </Box>
  )
}

function Composer({
  isApprovalPending,
  isRunning,
  prompt
}: {
  isApprovalPending: boolean
  isRunning: boolean
  prompt: string
}) {
  const placeholder = isApprovalPending ? 'answer approval above' : isRunning ? 'working...' : 'type a request'

  return (
    <Box marginTop={1}>
      <Text color="cyan" bold>
        {'> '}
      </Text>
      <Text>{prompt}</Text>
      <Text color="gray">{prompt ? '' : placeholder}</Text>
    </Box>
  )
}

function Footer({ isRunning }: { isRunning: boolean }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="gray">
        {isRunning ? 'Enter send  Esc clear  Ctrl+C stop' : 'Enter send  Esc clear  Ctrl+C quit'}
      </Text>
      <Text color="gray">/status /help /clear /exit</Text>
    </Box>
  )
}

const SLASH_COMMAND_HELP = [
  '/status  show auth, model, context, approval, and sandbox',
  '/clear   clear this TUI transcript',
  '/exit    quit Nekodex',
  '/help    show slash commands'
].join('\n')

function parseSlashCommand(value: string): string {
  return value.slice(1).trim().split(/\s+/)[0]?.toLowerCase() ?? ''
}

function roleStyle(role: TranscriptRole): {
  bodyColor: 'gray' | 'red' | 'white'
  color: 'cyan' | 'green' | 'red' | 'yellow'
  label: string
} {
  if (role === 'user') {
    return { bodyColor: 'white', color: 'green', label: 'you' }
  }
  if (role === 'assistant') {
    return { bodyColor: 'white', color: 'cyan', label: 'nekodex' }
  }
  if (role === 'error') {
    return { bodyColor: 'red', color: 'red', label: 'error' }
  }
  if (role === 'tool') {
    return { bodyColor: 'gray', color: 'yellow', label: 'tool' }
  }
  return { bodyColor: 'gray', color: 'yellow', label: 'system' }
}

function getTerminalDimensions(stdout: NodeJS.WriteStream): { columns: number; rows: number } {
  return {
    columns: stdout.columns ?? 100,
    rows: stdout.rows ?? 32
  }
}

function compactPath(value: string, columns: number): string {
  const maxLength = Math.max(12, Math.min(48, Math.floor(columns * 0.32)))
  if (value.length <= maxLength) {
    return value
  }

  const parsed = path.parse(value)
  const tail = path.join(parsed.base)
  return `...${path.sep}${tail}`
}

function formatToolArguments(value: unknown): string {
  if (!isRecord(value)) {
    return trimLongText(JSON.stringify(value, null, 2) ?? String(value))
  }

  if (typeof value.path === 'string' && typeof value.content === 'string') {
    return trimLongText(
      [`path: ${value.path}`, `content: ${Buffer.byteLength(value.content, 'utf8')} bytes`].join('\n')
    )
  }

  if (typeof value.command === 'string') {
    return trimLongText([`command: ${value.command}`, value.cwd ? `cwd: ${String(value.cwd)}` : ''].filter(Boolean).join('\n'))
  }

  return trimLongText(JSON.stringify(value, null, 2))
}

function getApprovalPanelRows(detail: string, columns: number): number {
  const detailRows = wrapText(detail, Math.max(24, columns - 8)).slice(0, APPROVAL_DETAIL_ROWS)
    .length
  return detailRows + 5
}

function truncateLine(value: string, width: number): string {
  const maxWidth = Math.max(8, width)
  if (value.length <= maxWidth) {
    return value
  }
  if (maxWidth <= 3) {
    return value.slice(0, maxWidth)
  }
  return `${value.slice(0, maxWidth - 3)}...`
}

function trimLongText(value: string): string {
  const maxLength = 900
  if (value.length <= maxLength) {
    return value
  }
  return `${value.slice(0, maxLength)}...`
}

function wrapText(value: string, width: number): string[] {
  const wrapped: string[] = []
  const safeWidth = Math.max(1, width)
  for (const paragraph of value.split(/\r?\n/)) {
    let line = ''
    for (const word of paragraph.split(/\s+/)) {
      if (!word) {
        continue
      }
      if (word.length > safeWidth) {
        if (line) {
          wrapped.push(line)
          line = ''
        }
        const chunks = chunkWord(word, safeWidth)
        wrapped.push(...chunks.slice(0, -1))
        line = chunks.at(-1) ?? ''
        continue
      }
      if ((line ? line.length + 1 : 0) + word.length > safeWidth) {
        if (line) {
          wrapped.push(line)
        }
        line = word
      } else {
        line = line ? `${line} ${word}` : word
      }
    }
    wrapped.push(line)
  }
  return wrapped
}

function chunkWord(value: string, width: number): string[] {
  const chunks: string[] = []
  for (let index = 0; index < value.length; index += width) {
    chunks.push(value.slice(index, index + width))
  }
  return chunks
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
