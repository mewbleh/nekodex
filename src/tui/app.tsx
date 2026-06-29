import path from 'node:path'
import { Box, Text, render, useApp, useInput, useStdout } from 'ink'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AgentRunner } from '../agent/runner.js'
import { AuthManager } from '../auth/manager.js'
import { reasoningEffortSchema, type NekodexConfig } from '../config/schema.js'
import type { ConfigStore } from '../config/store.js'
import { APP_VERSION } from '../constants.js'
import { MemoryStore } from '../memory/store.js'
import { SessionStore } from '../session/store.js'
import { buildFileEditPreview } from '../tools/edit-preview.js'
import type { ToolApprovalRequest } from '../tools/types.js'
import {
  findSlashCommand,
  formatSlashCommandHelp,
  getSlashCommandSuggestions,
  parseSlashCommandArguments
} from './slash-commands.js'
import { parseTranscriptBlocks } from './markdown.js'
import { buildTuiStatus } from './status.js'

const ANIMATION_INTERVAL_MS = 120
const ANIMATION_FRAMES = ['-', '\\', '|', '/']
const APPROVAL_DETAIL_ROWS = 5
const MAX_TRANSCRIPT_ITEMS = 80
const MIN_TRANSCRIPT_HEIGHT = 8
const STATIC_LAYOUT_ROWS = 5

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
  const [runtimeConfig, setRuntimeConfig] = useState(options.config)
  const [modelOverride, setModelOverride] = useState(options.model)
  const [prompt, setPrompt] = useState('')
  const [cursorIndex, setCursorIndex] = useState(0)
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0)
  const [status, setStatus] = useState('Ready')
  const [isRunning, setIsRunning] = useState(false)
  const [frameIndex, setFrameIndex] = useState(0)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const [transcript, setTranscript] = useState<TranscriptItem[]>([
    {
      id: 1,
      role: 'status',
      text: 'Ready. Ask Nekodex to do anything.'
    }
  ])
  const nextIdRef = useRef(2)
  const abortControllerRef = useRef<AbortController | null>(null)
  const approvalResolverRef = useRef<((approved: boolean) => void) | null>(null)
  const authManagerRef = useRef<AuthManager | null>(null)
  const sessionStoreRef = useRef<SessionStore | null>(null)
  const runnerRef = useRef<AgentRunner | null>(null)
  const activeModel = modelOverride ?? runtimeConfig.model

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
        const detail = formatToolArguments(request.toolName, request.arguments)
        approvalResolverRef.current = resolve
        setPendingApproval({
          detail,
          id: nextIdRef.current,
          request
        })
        nextIdRef.current += 1
        setStatus(`Approve ${request.toolName}?`)
        appendTranscript('tool', `Approval requested for ${request.toolName}\n${detail}`)
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
      appendTranscript(
        'tool',
        `${approved ? '✔ You approved' : '✗ You denied'} ${pendingApproval.request.toolName}`
      )
    },
    [appendTranscript, pendingApproval]
  )

  const updatePrompt = useCallback((nextPrompt: string, nextCursorIndex = nextPrompt.length) => {
    setPrompt(nextPrompt)
    setCursorIndex(clampCursor(nextCursorIndex, nextPrompt))
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
      config: runtimeConfig,
      workspaceRoot: options.workspaceRoot,
      memoryStore: new MemoryStore(options.configStore),
      sessionStore: sessionStoreRef.current,
      model: activeModel,
      approvalMode: options.approvalMode,
      onAssistantText: (text) => appendTranscript('assistant', text),
      onToolApproval: requestToolApproval,
      onStatus: (text) => {
        setStatus(text)
        appendTranscript(text.startsWith('tool:') ? 'tool' : 'status', formatStatusText(text))
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
      const command = findSlashCommand(commandLine)
      const commandArguments = parseSlashCommandArguments(commandLine)

      if (command?.name === 'clear') {
        setTranscript([])
        setStatus('Ready')
        return
      }

      if (command?.name === 'exit') {
        exit()
        return
      }

      if (command?.name === 'help') {
        appendTranscript('status', formatSlashCommandHelp())
        return
      }

      if (command?.name === 'model') {
        if (!commandArguments) {
          appendTranscript(
            'status',
            [
              `Current model: ${activeModel}`,
              'Usage: /model <name>',
              'Examples: /model gpt-5.5, /model gpt-5.4-mini'
            ].join('\n')
          )
          return
        }

        const nextModel = commandArguments.split(/\s+/)[0]
        const nextConfig = await options.configStore.patchConfig({ model: nextModel })
        setRuntimeConfig(nextConfig)
        setModelOverride(nextModel)
        runnerRef.current = null
        setStatus(`Model set to ${nextModel}`)
        appendTranscript('status', `Model set to ${nextModel}. New requests will use it.`)
        return
      }

      if (command?.name === 'effort') {
        if (!commandArguments) {
          appendTranscript(
            'status',
            [
              `Current reasoning effort: ${runtimeConfig.reasoningEffort}`,
              'Usage: /effort <none|low|medium|high|xhigh>'
            ].join('\n')
          )
          return
        }

        const parsedEffort = reasoningEffortSchema.safeParse(commandArguments)
        if (!parsedEffort.success) {
          appendTranscript('error', 'Reasoning effort must be one of none, low, medium, high, xhigh.')
          return
        }

        const nextConfig = await options.configStore.patchConfig({
          reasoningEffort: parsedEffort.data
        })
        setRuntimeConfig(nextConfig)
        runnerRef.current = null
        setStatus(`Reasoning effort set to ${parsedEffort.data}`)
        appendTranscript(
          'status',
          `Reasoning effort set to ${parsedEffort.data}. New requests will use it.`
        )
        return
      }

      if (command?.name === 'status') {
        setStatus('Status')
        appendTranscript(
          'status',
          await buildTuiStatus({
            approvalMode: options.approvalMode,
            authManager: authManagerRef.current as AuthManager,
            config: runtimeConfig,
            model: activeModel,
            sessionStore: sessionStoreRef.current as SessionStore,
            workspaceRoot: options.workspaceRoot
          })
        )
        setStatus('Ready')
        return
      }

      appendTranscript('error', `Unknown command: ${commandLine}. Try /help.`)
    },
    [activeModel, appendTranscript, exit, options, runtimeConfig]
  )

  const submitPrompt = useCallback(() => {
    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt || isRunning) {
      return
    }

    const suggestions = getSlashCommandSuggestions(trimmedPrompt)
    const selectedCommand = suggestions[selectedCommandIndex] ?? suggestions[0]
    const commandPrompt =
      trimmedPrompt.startsWith('/') && !findSlashCommand(trimmedPrompt) && selectedCommand
        ? `/${selectedCommand.name}`
        : trimmedPrompt

    updatePrompt('', 0)
    appendTranscript('user', commandPrompt)

    if (commandPrompt.startsWith('/')) {
      void runSlashCommand(commandPrompt).catch((error: unknown) => {
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
      ?.run(commandPrompt, { signal: abortController.signal })
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
  }, [appendTranscript, isRunning, prompt, runSlashCommand, selectedCommandIndex, updatePrompt])

  useInput((input, key) => {
    const commandSuggestions = getSlashCommandSuggestions(prompt)

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
    if (commandSuggestions.length > 0 && key.upArrow) {
      setSelectedCommandIndex((current) => Math.max(0, current - 1))
      return
    }
    if (commandSuggestions.length > 0 && key.downArrow) {
      setSelectedCommandIndex((current) => Math.min(commandSuggestions.length - 1, current + 1))
      return
    }
    if (commandSuggestions.length > 0 && key.tab) {
      const selectedCommand = commandSuggestions[selectedCommandIndex] ?? commandSuggestions[0]
      updatePrompt(`/${selectedCommand.name}`, selectedCommand.name.length + 1)
      return
    }
    if (key.escape) {
      updatePrompt('', 0)
      setSelectedCommandIndex(0)
      return
    }
    if (key.return) {
      submitPrompt()
      return
    }
    if (key.leftArrow) {
      setCursorIndex((current) => Math.max(0, current - 1))
      return
    }
    if (key.rightArrow) {
      setCursorIndex((current) => Math.min(prompt.length, current + 1))
      return
    }
    if (key.ctrl && input === 'a') {
      setCursorIndex(0)
      return
    }
    if (key.ctrl && input === 'e') {
      setCursorIndex(prompt.length)
      return
    }
    if (key.backspace || key.delete) {
      if (key.backspace) {
        if (cursorIndex === 0) {
          return
        }
        const nextPrompt = `${prompt.slice(0, cursorIndex - 1)}${prompt.slice(cursorIndex)}`
        updatePrompt(nextPrompt, cursorIndex - 1)
        return
      }
      if (cursorIndex >= prompt.length) {
        return
      }
      const nextPrompt = `${prompt.slice(0, cursorIndex)}${prompt.slice(cursorIndex + 1)}`
      updatePrompt(nextPrompt, cursorIndex)
      return
    }
    if (!key.ctrl && input) {
      const nextPrompt = `${prompt.slice(0, cursorIndex)}${input}${prompt.slice(cursorIndex)}`
      updatePrompt(nextPrompt, cursorIndex + input.length)
    }
  })

  const dimensions = getTerminalDimensions(stdout)
  const commandSuggestions = useMemo(() => getSlashCommandSuggestions(prompt), [prompt])
  useEffect(() => {
    setSelectedCommandIndex((current) =>
      commandSuggestions.length === 0 ? 0 : Math.min(current, commandSuggestions.length - 1)
    )
  }, [commandSuggestions.length])

  const approvalRows = pendingApproval
    ? getApprovalPanelRows(pendingApproval.detail, dimensions.columns)
    : 0
  const suggestionRows = commandSuggestions.length > 0 && !pendingApproval
    ? commandSuggestions.length + 1
    : 0
  const activityRows = isRunning || status !== 'Ready' ? 1 : 0
  const transcriptHeight = Math.max(
    MIN_TRANSCRIPT_HEIGHT,
    dimensions.rows - STATIC_LAYOUT_ROWS - approvalRows - suggestionRows - activityRows
  )
  const visibleTranscript = useMemo(
    () => transcript.slice(-transcriptHeight),
    [transcript, transcriptHeight]
  )
  const workspaceLabel = compactPath(options.workspaceRoot, dimensions.columns)
  const frame = ANIMATION_FRAMES[frameIndex % ANIMATION_FRAMES.length]
  const approvalMode = options.approvalMode ?? runtimeConfig.approvalMode
  const contextMode = runtimeConfig.contextWindow.autoCompact ? 'auto' : 'manual'
  const reasoningEffort = runtimeConfig.reasoningEffort
  const sandboxMode = runtimeConfig.sandboxMode

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column" height={transcriptHeight}>
        {visibleTranscript.map((item) => (
          <TranscriptLine key={item.id} item={item} width={dimensions.columns - 8} />
        ))}
      </Box>
      {pendingApproval ? <ApprovalPanel approval={pendingApproval} width={dimensions.columns - 4} /> : null}
      <ActivityLine frame={frame} isRunning={isRunning} status={status} />
      {!pendingApproval ? (
        <CommandForeshadowing
          selectedIndex={selectedCommandIndex}
          suggestions={commandSuggestions}
        />
      ) : null}
      <Composer
        cursorIndex={cursorIndex}
        isApprovalPending={Boolean(pendingApproval)}
        prompt={prompt}
      />
      <Footer
        approvalMode={approvalMode}
        contextMode={contextMode}
        isRunning={isRunning}
        model={activeModel}
        reasoningEffort={reasoningEffort}
        sandboxMode={sandboxMode}
        width={dimensions.columns - 2}
        workspaceLabel={workspaceLabel}
      />
    </Box>
  )
}

type TranscriptTextColor = 'cyan' | 'gray' | 'green' | 'red' | 'white' | 'yellow'

interface TranscriptRenderRow {
  color: TranscriptTextColor
  text: string
}

function TranscriptLine({ item, width }: { item: TranscriptItem; width: number }) {
  const role = roleStyle(item.role)
  const rows = buildTranscriptRows(item.text, role.bodyColor, Math.max(24, width))
  const prefix = role.label.padEnd(2, ' ')

  return (
    <Box flexDirection="column">
      {rows.map((row, index) => (
        <Box key={`${item.id}-${index}`}>
          <Text color={role.color} bold>
            {index === 0 ? prefix : ' '.repeat(prefix.length)}
          </Text>
          <Text color={row.color}>{row.text || ' '}</Text>
        </Box>
      ))}
    </Box>
  )
}

function buildTranscriptRows(
  value: string,
  bodyColor: TranscriptTextColor,
  width: number
): TranscriptRenderRow[] {
  const rows: TranscriptRenderRow[] = []
  const codeIndent = '    '
  const codeWidth = Math.max(8, width - codeIndent.length)

  for (const block of parseTranscriptBlocks(value)) {
    if (block.type === 'code') {
      const codeLines = block.lines.length > 0 ? block.lines : ['']
      for (const line of codeLines) {
        for (const chunk of wrapCodeLine(line, codeWidth)) {
          rows.push({ color: 'cyan', text: `${codeIndent}${chunk}` })
        }
      }
      continue
    }

    for (const line of block.lines) {
      const rowColor = line.startsWith('[+] ') ? 'green' : bodyColor
      for (const wrappedLine of wrapText(line, width)) {
        rows.push({ color: rowColor, text: wrappedLine })
      }
    }
  }

  return rows.length > 0 ? rows : [{ color: bodyColor, text: '' }]
}

function ActivityLine({
  frame,
  isRunning,
  status
}: {
  frame: string
  isRunning: boolean
  status: string
}) {
  if (!isRunning && status === 'Ready') {
    return null
  }

  const label = isRunning ? `${frame} Working` : status
  const hint = isRunning ? 'Ctrl+C to interrupt' : 'ready'

  return (
    <Box marginTop={1}>
      <Text color={isRunning ? 'yellow' : 'gray'}>• {label}</Text>
      <Text color="gray"> ({hint})</Text>
    </Box>
  )
}

function CommandForeshadowing({
  selectedIndex,
  suggestions
}: {
  selectedIndex: number
  suggestions: Array<{ description: string; name: string }>
}) {
  if (suggestions.length === 0) {
    return null
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {suggestions.map((suggestion, index) => (
        <Box key={suggestion.name}>
          <Text color={index === selectedIndex ? 'cyan' : 'gray'}>
            {index === selectedIndex ? '› ' : '  '}
            {index + 1}. /{suggestion.name}
          </Text>
          <Text color="gray">  {suggestion.description}</Text>
        </Box>
      ))}
      <Text color="gray">  Tab complete  Up/Down select  Enter run</Text>
    </Box>
  )
}

function ApprovalPanel({ approval, width }: { approval: PendingApproval; width: number }) {
  const detailLines = wrapText(approval.detail, Math.max(24, width - 4)).slice(
    0,
    APPROVAL_DETAIL_ROWS
  )
  const title = getApprovalTitle(approval.request)
  const firstDetailPrefix = approval.request.toolName === 'run_command' ? '$ ' : '  '

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{title}</Text>
      {detailLines.map((line, index) => (
        <Text key={`${approval.id}-${index}`} color="gray">
          {index === 0 ? firstDetailPrefix : '  '}
          {line}
        </Text>
      ))}
      <Text color="cyan">› 1. Yes, proceed (y)</Text>
      <Text color="gray">  2. No, tell Nekodex what to do differently (esc)</Text>
      <Text color="gray">  Press enter to confirm or esc to cancel</Text>
    </Box>
  )
}

function Composer({
  cursorIndex,
  isApprovalPending,
  prompt
}: {
  cursorIndex: number
  isApprovalPending: boolean
  prompt: string
}) {
  const placeholder = isApprovalPending ? 'answer approval above' : 'Ask Nekodex to do anything'
  const beforeCursor = prompt.slice(0, cursorIndex)
  const cursorCharacter = prompt[cursorIndex] ?? ' '
  const afterCursor = prompt.slice(cursorIndex + 1)

  return (
    <Box marginTop={1}>
      <Text color="cyan" bold>
        {'› '}
      </Text>
      <Text>{beforeCursor}</Text>
      <Text backgroundColor="cyan" color="black">
        {cursorCharacter}
      </Text>
      <Text>{afterCursor}</Text>
      <Text color="gray">{prompt ? '' : placeholder}</Text>
    </Box>
  )
}

function Footer({
  approvalMode,
  contextMode,
  isRunning,
  model,
  reasoningEffort,
  sandboxMode,
  width,
  workspaceLabel
}: {
  approvalMode: string
  contextMode: string
  isRunning: boolean
  model: string
  reasoningEffort: string
  sandboxMode: string
  width: number
  workspaceLabel: string
}) {
  const statusLine = truncateLine(
    `${model} ${reasoningEffort} · ${workspaceLabel} · approval ${approvalMode} · sandbox ${sandboxMode} · context ${contextMode} · v${APP_VERSION}`,
    width
  )

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="gray">
        {isRunning ? '  Ctrl+C interrupt · Esc clear · Tab complete' : '  Enter send · Esc clear · Ctrl+C quit · Tab complete'}
      </Text>
      <Text color="gray">  {statusLine}</Text>
    </Box>
  )
}

function roleStyle(role: TranscriptRole): {
  bodyColor: TranscriptTextColor
  color: 'cyan' | 'gray' | 'green' | 'red' | 'yellow'
  label: string
} {
  if (role === 'user') {
    return { bodyColor: 'white', color: 'cyan', label: '›' }
  }
  if (role === 'assistant') {
    return { bodyColor: 'white', color: 'gray', label: '•' }
  }
  if (role === 'error') {
    return { bodyColor: 'red', color: 'red', label: '✗' }
  }
  if (role === 'tool') {
    return { bodyColor: 'gray', color: 'yellow', label: '•' }
  }
  return { bodyColor: 'gray', color: 'gray', label: '•' }
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

function formatToolArguments(toolName: string, value: unknown): string {
  const editPreview = buildFileEditPreview(toolName, value, { lineLimit: 8 })
  if (editPreview) {
    return trimLongText(editPreview)
  }

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

function getApprovalTitle(request: ToolApprovalRequest): string {
  if (request.toolName === 'run_command') {
    return 'Would you like to run the following command?'
  }
  if (request.toolName === 'write_file' || request.toolName === 'replace_in_file') {
    return 'Would you like to apply the following file change?'
  }
  return `Would you like to allow ${request.toolName}?`
}

function formatStatusText(text: string): string {
  if (!text.startsWith('tool:')) {
    return text
  }
  const toolName = text.slice('tool:'.length).trim()
  return toolName ? `Running ${toolName}` : text
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

function wrapCodeLine(value: string, width: number): string[] {
  if (!value) {
    return ['']
  }
  return chunkWord(value, Math.max(1, width))
}

function chunkWord(value: string, width: number): string[] {
  const chunks: string[] = []
  for (let index = 0; index < value.length; index += width) {
    chunks.push(value.slice(index, index + width))
  }
  return chunks
}

function clampCursor(value: number, prompt: string): number {
  return Math.max(0, Math.min(value, prompt.length))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
