import path from 'node:path'
import { Box, Text, render, useApp, useInput, useStdout } from 'ink'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AgentRunner } from '../agent/runner.js'
import { AuthManager } from '../auth/manager.js'
import type { NekodexConfig } from '../config/schema.js'
import type { ConfigStore } from '../config/store.js'
import { APP_VERSION } from '../constants.js'
import { MemoryStore } from '../memory/store.js'

const ANIMATION_INTERVAL_MS = 120
const ANIMATION_FRAMES = ['dots', 'o..', '.o.', '..o']
const MAX_TRANSCRIPT_ITEMS = 80
const MIN_TRANSCRIPT_HEIGHT = 8
const STATIC_LAYOUT_ROWS = 13

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

  if (!runnerRef.current) {
    runnerRef.current = new AgentRunner({
      authManager: new AuthManager(options.configStore),
      config: options.config,
      workspaceRoot: options.workspaceRoot,
      memoryStore: new MemoryStore(options.configStore),
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

  const submitPrompt = useCallback(() => {
    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt || isRunning) {
      return
    }

    setPrompt('')
    setIsRunning(true)
    setStatus('Thinking')
    appendTranscript('user', trimmedPrompt)

    void runnerRef.current
      ?.run(trimmedPrompt)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        appendTranscript('error', message)
      })
      .finally(() => {
        setIsRunning(false)
        setStatus('Ready')
      })
  }, [appendTranscript, isRunning, prompt])

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
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

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header model={model} status={status} frame={frame} isRunning={isRunning} />
      <Box marginTop={1} gap={1}>
        <InfoPill label="cwd" value={workspaceLabel} />
        <InfoPill label="approval" value={options.approvalMode ?? options.config.approvalMode} />
        <InfoPill
          label="context"
          value={options.config.contextWindow.autoCompact ? 'auto compact' : 'manual'}
        />
      </Box>
      <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={1} height={transcriptHeight + 2}>
        <Box flexDirection="column">
          {visibleTranscript.map((item) => (
            <TranscriptLine key={item.id} item={item} width={dimensions.columns - 8} />
          ))}
        </Box>
      </Box>
      <Composer prompt={prompt} isRunning={isRunning} />
      <Footer />
    </Box>
  )
}

function Header({
  frame,
  isRunning,
  model,
  status
}: {
  frame: string
  isRunning: boolean
  model: string
  status: string
}) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan" bold>
          Nekodex
        </Text>
        <Text color="gray"> v{APP_VERSION} </Text>
        <Text color="gray">lightweight agentic coding</Text>
      </Box>
      <Box>
        <Text color={isRunning ? 'yellow' : 'green'}>{isRunning ? frame : 'ok'}</Text>
        <Text color="gray"> {status}</Text>
        <Text color="gray"> | model </Text>
        <Text color="white">{model}</Text>
      </Box>
    </Box>
  )
}

function InfoPill({ label, value }: { label: string; value: string }) {
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="gray">{label} </Text>
      <Text color="white">{value}</Text>
    </Box>
  )
}

function TranscriptLine({ item, width }: { item: TranscriptItem; width: number }) {
  const role = roleStyle(item.role)
  const lines = wrapText(item.text, Math.max(24, width))

  return (
    <Box marginBottom={1} flexDirection="column">
      <Box>
        <Text color={role.color} bold>
          {role.label}
        </Text>
        <Text color="gray"> {role.rule}</Text>
      </Box>
      {lines.map((line, index) => (
        <Box key={`${item.id}-${index}`} paddingLeft={2}>
          <Text color={role.bodyColor}>{line || ' '}</Text>
        </Box>
      ))}
    </Box>
  )
}

function Composer({ isRunning, prompt }: { isRunning: boolean; prompt: string }) {
  return (
    <Box marginTop={1} borderStyle="round" borderColor={isRunning ? 'yellow' : 'cyan'} paddingX={1}>
      <Text color="cyan" bold>
        ›{' '}
      </Text>
      <Text>{prompt}</Text>
      <Text color="gray">{prompt ? '' : 'Ask Nekodex to edit, inspect, run, or explain...'}</Text>
      <Text color={isRunning ? 'yellow' : 'gray'}>{isRunning ? '  working...' : '  '}</Text>
    </Box>
  )
}

function Footer() {
  return (
    <Box marginTop={1}>
      <Text color="gray">Enter send</Text>
      <Text color="gray">  Esc clear</Text>
      <Text color="gray">  Ctrl+C quit</Text>
      <Text color="gray">  use --plain for readline mode</Text>
    </Box>
  )
}

function roleStyle(role: TranscriptRole): {
  bodyColor: 'gray' | 'red' | 'white'
  color: 'cyan' | 'green' | 'red' | 'yellow'
  label: string
  rule: string
} {
  if (role === 'user') {
    return { bodyColor: 'white', color: 'green', label: 'you', rule: 'request' }
  }
  if (role === 'assistant') {
    return { bodyColor: 'white', color: 'cyan', label: 'nekodex', rule: 'response' }
  }
  if (role === 'error') {
    return { bodyColor: 'red', color: 'red', label: 'error', rule: 'needs attention' }
  }
  return { bodyColor: 'gray', color: 'yellow', label: 'system', rule: 'activity' }
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
