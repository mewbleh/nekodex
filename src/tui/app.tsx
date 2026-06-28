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
import { buildTuiStatus } from './status.js'

const ANIMATION_INTERVAL_MS = 120
const ANIMATION_FRAMES = ['-', '\\', '|', '/']
const MAX_TRANSCRIPT_ITEMS = 80
const MIN_TRANSCRIPT_HEIGHT = 8
const STATIC_LAYOUT_ROWS = 5

type TranscriptRole = 'assistant' | 'error' | 'status' | 'user'

interface TranscriptItem {
  id: number
  role: TranscriptRole
  text: string
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
  const [transcript, setTranscript] = useState<TranscriptItem[]>([
    {
      id: 1,
      role: 'status',
      text: 'Nekodex is ready. Ask for a change, review, command, or plan.'
    }
  ])
  const nextIdRef = useRef(2)
  const abortControllerRef = useRef<AbortController | null>(null)
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
      onStatus: (text) => {
        setStatus(text)
        appendTranscript('status', text)
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
      if (isRunning) {
        setStatus('Stopping')
        abortControllerRef.current?.abort()
        return
      }
      exit()
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
  const transcriptHeight = Math.max(MIN_TRANSCRIPT_HEIGHT, dimensions.rows - STATIC_LAYOUT_ROWS)
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
        workspaceLabel={workspaceLabel}
      />
      <Box marginTop={1} flexDirection="column" height={transcriptHeight}>
        {visibleTranscript.map((item) => (
          <TranscriptLine key={item.id} item={item} width={dimensions.columns - 12} />
        ))}
      </Box>
      <Composer prompt={prompt} isRunning={isRunning} />
      <Footer />
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
  workspaceLabel: string
}) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan" bold>
          Nekodex
        </Text>
        <Text color="gray"> v{APP_VERSION} </Text>
        <Text color={isRunning ? 'yellow' : 'green'}>{isRunning ? frame : 'ok'}</Text>
        <Text color="gray"> {status}</Text>
      </Box>
      <Box>
        <Text color="gray">cwd</Text>
        <Text> {workspaceLabel}</Text>
        <Text color="gray"> | model</Text>
        <Text> {model}</Text>
        <Text color="gray"> | approval</Text>
        <Text> {approvalMode}</Text>
        <Text color="gray"> | effort</Text>
        <Text> {reasoningEffort}</Text>
        <Text color="gray"> | sandbox</Text>
        <Text> {sandboxMode}</Text>
        <Text color="gray"> | context</Text>
        <Text> {contextMode}</Text>
      </Box>
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

function Composer({ isRunning, prompt }: { isRunning: boolean; prompt: string }) {
  return (
    <Box marginTop={1}>
      <Text color="cyan" bold>
        {'> '}
      </Text>
      <Text>{prompt}</Text>
      <Text color="gray">{prompt ? '' : isRunning ? 'working...' : 'type a request'}</Text>
    </Box>
  )
}

function Footer() {
  return (
    <Box marginTop={1}>
      <Text color="gray">Enter send | Esc clear | Ctrl+C quit | /status /help /clear /exit</Text>
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
  return { bodyColor: 'gray', color: 'yellow', label: 'system' }
}

function getTerminalDimensions(stdout: NodeJS.WriteStream): { columns: number; rows: number } {
  return {
    columns: stdout.columns ?? 100,
    rows: stdout.rows ?? 32
  }
}

function compactPath(value: string, columns: number): string {
  const maxLength = Math.max(28, Math.floor(columns * 0.42))
  if (value.length <= maxLength) {
    return value
  }

  const parsed = path.parse(value)
  const tail = path.join(parsed.base)
  return `...${path.sep}${tail}`
}

function wrapText(value: string, width: number): string[] {
  const wrapped: string[] = []
  for (const paragraph of value.split(/\r?\n/)) {
    let line = ''
    for (const word of paragraph.split(/\s+/)) {
      if (!word) {
        continue
      }
      if ((line ? line.length + 1 : 0) + word.length > width) {
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
