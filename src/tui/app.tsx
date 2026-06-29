import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Box, Text, render, useApp, useInput, useStdout } from 'ink'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listInstructionSources } from '../agent/instructions.js'
import { AgentRunner, type AgentToolState } from '../agent/runner.js'
import { AuthManager } from '../auth/manager.js'
import { reasoningEffortSchema, type NekodexConfig } from '../config/schema.js'
import type { ConfigStore } from '../config/store.js'
import { APP_VERSION } from '../constants.js'
import { MemoryStore } from '../memory/store.js'
import { SessionStore, type PersistedSession, type PersistedTranscriptItem } from '../session/store.js'
import { buildFileEditPreview } from '../tools/edit-preview.js'
import { ToolRegistry } from '../tools/registry.js'
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
const execFileAsync = promisify(execFile)
const ANIMATION_FRAMES = ['-', '\\', '|', '/']
const APPROVAL_DETAIL_ROWS = 5
const MAX_TRANSCRIPT_ITEMS = 80
const MIN_TRANSCRIPT_HEIGHT = 8
const STATIC_LAYOUT_ROWS = 3
const PROMPT_MARK = '\u203a'
const BULLET_MARK = '\u2022'
const CHECK_MARK = '\u2713'
const CROSS_MARK = '\u2717'
const DOT_MARK = '\u00b7'
const LOCAL_TOOL_COUNT = ToolRegistry.withDefaultTools().schemas().length

const MODEL_OPTIONS = [
  {
    value: 'gpt-5.5',
    label: 'gpt-5.5',
    description: 'Default Nekodex model for the ChatGPT Codex backend and Responses API.'
  },
  {
    value: 'gpt-5.4',
    label: 'gpt-5.4',
    description: 'Balanced coding model when available on your account.'
  },
  {
    value: 'gpt-5.4-mini',
    label: 'gpt-5.4-mini',
    description: 'Faster, cheaper model for small edits and quick questions.'
  },
  {
    value: 'gpt-5.3-codex-spark',
    label: 'gpt-5.3-codex-spark',
    description: 'Compatibility option for older Codex-style workflows.'
  }
]

const EFFORT_OPTIONS = [
  { value: 'none', label: 'none', description: 'No extra reasoning budget.' },
  { value: 'low', label: 'low', description: 'Fast responses for simple work.' },
  { value: 'medium', label: 'medium', description: 'Default balance for coding tasks.' },
  { value: 'high', label: 'high', description: 'More reasoning for larger changes.' },
  { value: 'xhigh', label: 'xhigh', description: 'Maximum reasoning when the model supports it.' }
]

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

interface SelectionOption {
  description: string
  label: string
  value: string
}

interface ActiveSelection {
  id: 'effort' | 'model'
  options: SelectionOption[]
  selectedIndex: number
  title: string
}

export interface TuiOptions {
  configStore: ConfigStore
  config: NekodexConfig
  workspaceRoot: string
  sessionId: string
  initialTranscript?: PersistedTranscriptItem[]
  model?: string
  approvalMode?: 'ask' | 'auto'
}

export function startTui(options: TuiOptions): void {
  const app = render(<NekodexTui options={options} />)
  void app.waitUntilExit().then(() => {
    clearTerminal()
    process.stdout.write(
      [
        `Nekodex session ${options.sessionId}`,
        `Resume with: nekodex resume ${options.sessionId}`,
        ''
      ].join('\n')
    )
  })
}

function clearTerminal(): void {
  if (!process.stdout.isTTY) {
    return
  }
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H')
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
  const [instructionCount, setInstructionCount] = useState(0)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const [activeToolState, setActiveToolState] = useState<AgentToolState | null>(null)
  const [activeSelection, setActiveSelection] = useState<ActiveSelection | null>(null)
  const [transcript, setTranscript] = useState<TranscriptItem[]>(() =>
    createInitialTranscript(options.initialTranscript)
  )
  const nextIdRef = useRef(0)
  if (nextIdRef.current === 0) {
    nextIdRef.current = transcript.length + 1
  }
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
        setActiveToolState({ status: 'approval', toolName: request.toolName })
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
      setActiveToolState({
        status: approved ? 'running' : 'denied',
        toolName: pendingApproval.request.toolName
      })
      appendTranscript(
        'tool',
        `${approved ? CHECK_MARK : CROSS_MARK} You ${approved ? 'approved' : 'denied'} ${pendingApproval.request.toolName}`
      )
    },
    [appendTranscript, pendingApproval]
  )

  const updatePrompt = useCallback((nextPrompt: string, nextCursorIndex = nextPrompt.length) => {
    setPrompt(nextPrompt)
    setCursorIndex(clampCursor(nextCursorIndex, nextPrompt))
  }, [])

  const openModelSelection = useCallback(() => {
    setActiveSelection({
      id: 'model',
      title: 'Select Model and Effort',
      options: MODEL_OPTIONS.map((option) => ({
        ...option,
        label: option.value === activeModel ? `${option.label} (current)` : option.label
      })),
      selectedIndex: Math.max(
        0,
        MODEL_OPTIONS.findIndex((option) => option.value === activeModel)
      )
    })
  }, [activeModel])

  const openEffortSelection = useCallback(() => {
    setActiveSelection({
      id: 'effort',
      title: 'Select Reasoning Effort',
      options: EFFORT_OPTIONS.map((option) => ({
        ...option,
        label: option.value === runtimeConfig.reasoningEffort ? `${option.label} (current)` : option.label
      })),
      selectedIndex: Math.max(
        0,
        EFFORT_OPTIONS.findIndex((option) => option.value === runtimeConfig.reasoningEffort)
      )
    })
  }, [runtimeConfig.reasoningEffort])

  const applySelection = useCallback(async () => {
    if (!activeSelection) {
      return
    }

    const selectedOption = activeSelection.options[activeSelection.selectedIndex]
    if (!selectedOption) {
      return
    }

    if (activeSelection.id === 'model') {
      const nextConfig = await options.configStore.patchConfig({ model: selectedOption.value })
      setRuntimeConfig(nextConfig)
      setModelOverride(selectedOption.value)
      runnerRef.current = null
      setStatus(`Model set to ${selectedOption.value}`)
      appendTranscript('status', `Model set to ${selectedOption.value}. New requests will use it.`)
    } else {
      const parsedEffort = reasoningEffortSchema.safeParse(selectedOption.value)
      if (!parsedEffort.success) {
        appendTranscript('error', 'Invalid reasoning effort selection.')
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
    }

    setActiveSelection(null)
  }, [activeSelection, appendTranscript, options.configStore])

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
      sessionId: options.sessionId,
      memoryStore: new MemoryStore(options.configStore),
      sessionStore: sessionStoreRef.current,
      model: activeModel,
      approvalMode: options.approvalMode,
      onAssistantText: (text) => appendTranscript('assistant', text),
      onToolApproval: requestToolApproval,
      onToolState: setActiveToolState,
      onStatus: (text) => {
        setStatus(text)
        appendTranscript(text.startsWith('tool:') ? 'tool' : 'status', formatStatusText(text))
      }
    })
  }

  useEffect(() => {
    const sessionStore = sessionStoreRef.current
    if (!sessionStore) {
      return
    }

    void sessionStore
      .saveTranscript(options.workspaceRoot, options.sessionId, toPersistedTranscriptItems(transcript))
      .catch(() => undefined)
  }, [options.sessionId, options.workspaceRoot, transcript])

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

  useEffect(() => {
    if (
      !activeToolState ||
      !['denied', 'done', 'failed'].includes(activeToolState.status)
    ) {
      return undefined
    }

    const timeout = setTimeout(() => {
      setActiveToolState((current) => (current === activeToolState ? null : current))
    }, 1600)

    return () => clearTimeout(timeout)
  }, [activeToolState])

  useEffect(() => {
    let isMounted = true
    void listInstructionSources(options.workspaceRoot)
      .then((sources) => {
        if (isMounted) {
          setInstructionCount(sources.length)
        }
      })
      .catch(() => {
        if (isMounted) {
          setInstructionCount(0)
        }
      })

    return () => {
      isMounted = false
    }
  }, [options.workspaceRoot])

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
          openModelSelection()
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
          openEffortSelection()
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

      if (command?.name === 'instructions' || command?.name === 'skills') {
        const instructionSources = await listInstructionSources(options.workspaceRoot)
        setInstructionCount(instructionSources.length)
        appendTranscript('status', formatInstructionSources(instructionSources, options.workspaceRoot))
        return
      }

      if (command?.name === 'sessions') {
        appendTranscript(
          'status',
          formatTuiSessionList(await (sessionStoreRef.current as SessionStore).list())
        )
        return
      }

      if (command?.name === 'mcp') {
        appendTranscript('status', formatTuiMcpStatus(runtimeConfig))
        return
      }

      if (command?.name === 'tools') {
        appendTranscript('status', formatTuiToolStatus(runtimeConfig))
        return
      }

      if (command?.name === 'permissions') {
        appendTranscript(
          'status',
          [
            `approval: ${options.approvalMode ?? runtimeConfig.approvalMode}`,
            `sandbox: ${runtimeConfig.sandboxMode}`,
            `sandbox backend: ${runtimeConfig.sandboxBackend}`,
            `outside-workspace reads: ${runtimeConfig.allowOutsideWorkspace ? 'allowed' : 'blocked'}`
          ].join('\n')
        )
        return
      }

      if (command?.name === 'compact') {
        appendTranscript(
          'status',
          [
            `context compaction: ${runtimeConfig.contextWindow.autoCompact ? 'auto' : 'manual'}`,
            `threshold: ${runtimeConfig.contextWindow.compactThresholdTokens.toLocaleString()} tokens`
          ].join('\n')
        )
        return
      }

      if (command?.name === 'diff') {
        appendTranscript('status', await buildGitDiffSummary(options.workspaceRoot))
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
    [activeModel, appendTranscript, exit, openEffortSelection, openModelSelection, options, runtimeConfig]
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
          setActiveToolState(null)
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
      if (activeSelection) {
        setActiveSelection(null)
        setStatus('Ready')
        return
      }
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
    if (activeSelection) {
      if (key.upArrow) {
        setActiveSelection((current) =>
          current
            ? { ...current, selectedIndex: Math.max(0, current.selectedIndex - 1) }
            : current
        )
        return
      }
      if (key.downArrow) {
        setActiveSelection((current) =>
          current
            ? {
                ...current,
                selectedIndex: Math.min(current.options.length - 1, current.selectedIndex + 1)
              }
            : current
        )
        return
      }
      if (key.return) {
        void applySelection().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          appendTranscript('error', message)
          setActiveSelection(null)
          setStatus('Ready')
        })
        return
      }
      if (key.escape) {
        setActiveSelection(null)
        setStatus('Ready')
        return
      }
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
    if (isRunning && key.escape) {
      setStatus('Stopping')
      abortControllerRef.current?.abort()
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
  const selectionRows = activeSelection
    ? getSelectionPanelRows(activeSelection, dimensions.columns)
    : 0
  const suggestionRows = commandSuggestions.length > 0 && !pendingApproval && !activeSelection
    ? commandSuggestions.length + 1
    : 0
  const activityRows = isRunning || status !== 'Ready' ? 1 : 0
  const composerRows = pendingApproval || activeSelection ? 0 : 2
  const hasConversation = transcript.some((item) =>
    ['assistant', 'error', 'tool', 'user'].includes(item.role)
  )
  const showSplash = !hasConversation
  const transcriptHeight = Math.max(
    MIN_TRANSCRIPT_HEIGHT,
    dimensions.rows -
      STATIC_LAYOUT_ROWS -
      approvalRows -
      selectionRows -
      suggestionRows -
      activityRows -
      composerRows
  )
  const visibleTranscript = useMemo(
    () => (showSplash ? [] : transcript.slice(-transcriptHeight)),
    [showSplash, transcript, transcriptHeight]
  )
  const workspaceLabel = compactPath(options.workspaceRoot, dimensions.columns)
  const frame = ANIMATION_FRAMES[frameIndex % ANIMATION_FRAMES.length]
  const reasoningEffort = runtimeConfig.reasoningEffort
  const startupSummary = buildStartupSummary(runtimeConfig, instructionCount)

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column" height={transcriptHeight}>
        {showSplash ? (
          <SplashPanel
            instructionCount={instructionCount}
            model={activeModel}
            sessionId={options.sessionId}
            startupSummary={startupSummary}
            width={dimensions.columns - 4}
            workspaceLabel={workspaceLabel}
          />
        ) : null}
        {visibleTranscript.map((item) => (
          <TranscriptLine key={item.id} item={item} width={dimensions.columns - 8} />
        ))}
      </Box>
      <ActivityLine
        activeToolState={activeToolState}
        frame={frame}
        isRunning={isRunning}
        status={status}
      />
      {pendingApproval ? (
        <ApprovalPanel approval={pendingApproval} width={dimensions.columns - 4} />
      ) : null}
      {activeSelection ? (
        <SelectionPanel selection={activeSelection} width={dimensions.columns - 4} />
      ) : null}
      {!pendingApproval && !activeSelection ? (
        <>
          <Composer
            cursorIndex={cursorIndex}
            isApprovalPending={Boolean(pendingApproval)}
            prompt={prompt}
          />
          <CommandForeshadowing
            selectedIndex={selectedCommandIndex}
            suggestions={commandSuggestions}
          />
        </>
      ) : null}
      <Footer
        isRunning={isRunning}
        model={activeModel}
        reasoningEffort={reasoningEffort}
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

function SplashPanel({
  instructionCount,
  model,
  sessionId,
  startupSummary,
  width,
  workspaceLabel
}: {
  instructionCount: number
  model: string
  sessionId: string
  startupSummary: string[]
  width: number
  workspaceLabel: string
}) {
  const panelWidth = Math.min(48, Math.max(38, width))
  const skillsLine =
    instructionCount === 1 ? '1 custom instruction file' : `${instructionCount} custom instruction files`

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box borderColor="gray" borderStyle="round" flexDirection="column" paddingX={1} width={panelWidth}>
        <Text color="cyan" bold>{`${PROMPT_MARK}_ Nekodex (v${APP_VERSION})`}</Text>
        <Text> </Text>
        <Text>
          <Text color="gray">model:     </Text>
          <Text>{model}</Text>
          <Text color="gray">   /model to change</Text>
        </Text>
        <Text>
          <Text color="gray">directory: </Text>
          <Text>{workspaceLabel}</Text>
        </Text>
        <Text>
          <Text color="gray">session:   </Text>
          <Text>{sessionId}</Text>
        </Text>
      </Box>
      <Text> </Text>
      <Text color="gray">Tip: GPT-5.5 is Nekodex's default agentic coding model.</Text>
      <Text color="gray">startup</Text>
      {startupSummary.map((line) => (
        <Text key={line} color="gray">{BULLET_MARK} {line}</Text>
      ))}
      <Text color="gray">{BULLET_MARK} Run /status to view auth, model, and context usage.</Text>
      <Text color="gray">{PROMPT_MARK} Use /skills to list {skillsLine}.</Text>
    </Box>
  )
}

function ActivityLine({
  activeToolState,
  frame,
  isRunning,
  status
}: {
  activeToolState: AgentToolState | null
  frame: string
  isRunning: boolean
  status: string
}) {
  if (!activeToolState && !isRunning && status === 'Ready') {
    return null
  }

  const label = activeToolState
    ? formatToolStateLabel(activeToolState, frame)
    : isRunning
      ? `${frame} Working`
      : status
  const hint = activeToolState
    ? formatToolStateHint(activeToolState)
    : isRunning
      ? 'esc to interrupt'
      : 'ready'

  return (
    <Box marginTop={1}>
      <Text color={activeToolState ? toolStateColor(activeToolState) : isRunning ? 'yellow' : 'gray'}>
        {BULLET_MARK} {label}
      </Text>
      <Text color="gray"> ({hint})</Text>
    </Box>
  )
}

function formatToolStateLabel(state: AgentToolState, frame: string): string {
  if (state.status === 'approval') {
    return `${PROMPT_MARK} Tool ${state.toolName}`
  }
  if (state.status === 'running') {
    return `${frame} Tool ${state.toolName}`
  }
  if (state.status === 'done') {
    return `${CHECK_MARK} Tool ${state.toolName}`
  }
  if (state.status === 'denied') {
    return `${CROSS_MARK} Tool ${state.toolName}`
  }
  return `${CROSS_MARK} Tool ${state.toolName}`
}

function formatToolStateHint(state: AgentToolState): string {
  if (state.status === 'approval') {
    return 'waiting for approval'
  }
  if (state.status === 'running') {
    return 'running'
  }
  if (state.status === 'done') {
    return 'done'
  }
  if (state.status === 'denied') {
    return 'denied'
  }
  return state.detail ? `failed: ${truncateLine(state.detail, 42)}` : 'failed'
}

function toolStateColor(state: AgentToolState): 'gray' | 'green' | 'red' | 'yellow' {
  if (state.status === 'done') {
    return 'green'
  }
  if (state.status === 'denied' || state.status === 'failed') {
    return 'red'
  }
  return state.status === 'approval' ? 'yellow' : 'gray'
}

function CommandForeshadowing({
  selectedIndex,
  suggestions
}: {
  selectedIndex: number
  suggestions: Array<{ description: string; name: string; usage?: string }>
}) {
  if (suggestions.length === 0) {
    return null
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {suggestions.map((suggestion, index) => (
        <Box key={suggestion.name}>
          <Text color={index === selectedIndex ? 'cyan' : 'gray'}>
            {index === selectedIndex ? `${PROMPT_MARK} ` : '  '}
            /{suggestion.name}
          </Text>
          <Text color="gray">  {suggestion.description}</Text>
        </Box>
      ))}
      <Text color="gray">  Tab complete  Up/Down select  Enter run</Text>
    </Box>
  )
}

function SelectionPanel({
  selection,
  width
}: {
  selection: ActiveSelection
  width: number
}) {
  const descriptionWidth = Math.max(24, width - 32)

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>  {selection.title}</Text>
      <Text> </Text>
      {selection.options.map((option, index) => {
        const prefix = index === selection.selectedIndex ? `${PROMPT_MARK} ` : '  '
        const label = `${index + 1}. ${option.label}`.padEnd(28, ' ')
        const descriptionLines = wrapText(option.description, descriptionWidth)
        return (
          <Box key={option.value} flexDirection="column">
            <Box>
              <Text color={index === selection.selectedIndex ? 'cyan' : 'gray'}>{prefix}</Text>
              <Text color={index === selection.selectedIndex ? 'white' : 'gray'}>{label}</Text>
              <Text color="gray">{descriptionLines[0] ?? ''}</Text>
            </Box>
            {descriptionLines.slice(1).map((line, lineIndex) => (
              <Box key={`${option.value}-${lineIndex}`}>
                <Text color="gray">{' '.repeat(32)}{line}</Text>
              </Box>
            ))}
          </Box>
        )
      })}
      <Text color="gray">  Enter select  Esc cancel</Text>
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
      <Text color="cyan">{PROMPT_MARK} 1. Yes, proceed (y)</Text>
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
        {`${PROMPT_MARK} `}
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
  isRunning,
  model,
  reasoningEffort,
  width,
  workspaceLabel
}: {
  isRunning: boolean
  model: string
  reasoningEffort: string
  width: number
  workspaceLabel: string
}) {
  const effortLabel = reasoningEffort === 'medium' ? 'default' : reasoningEffort
  const modeHint = isRunning ? ` ${DOT_MARK} Esc to interrupt` : ''
  const statusLine = truncateLine(
    `${model} ${effortLabel} ${DOT_MARK} ${workspaceLabel}${modeHint}`,
    width
  )

  return (
    <Box marginTop={1}>
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
    return { bodyColor: 'white', color: 'cyan', label: PROMPT_MARK }
  }
  if (role === 'assistant') {
    return { bodyColor: 'white', color: 'gray', label: BULLET_MARK }
  }
  if (role === 'error') {
    return { bodyColor: 'red', color: 'red', label: CROSS_MARK }
  }
  if (role === 'tool') {
    return { bodyColor: 'gray', color: 'yellow', label: BULLET_MARK }
  }
  return { bodyColor: 'gray', color: 'gray', label: BULLET_MARK }
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

function buildStartupSummary(config: NekodexConfig, instructionCount: number): string[] {
  const hostedTools = config.openAiHostedTools.map((tool) => tool.type).filter(Boolean)
  const mcpServers = config.mcpServers
  const missingMcpAuth = mcpServers.filter(
    (server) => server.authorizationEnvVar && !process.env[server.authorizationEnvVar]
  ).length
  const hostedSummary = hostedTools.length > 0 ? hostedTools.join(', ') : 'none'
  const mcpSummary =
    mcpServers.length === 0
      ? 'none'
      : `${mcpServers.length} server${mcpServers.length === 1 ? '' : 's'}${missingMcpAuth ? `, ${missingMcpAuth} auth env missing` : ''}`

  return [
    `tools: ${LOCAL_TOOL_COUNT} local, hosted ${hostedSummary}`,
    `mcp: ${mcpSummary}`,
    `sandbox: ${config.sandboxMode}/${config.sandboxBackend}`,
    `instructions: ${instructionCount}`
  ]
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

function formatInstructionSources(
  sources: Array<{ path: string; scope: 'env' | 'personal' | 'project' }>,
  workspaceRoot: string
): string {
  if (sources.length === 0) {
    return [
      'No custom instruction files loaded.',
      'Create AGENTS.md or .nekodex/instructions.md in this project,',
      'or set NEKODEX_INSTRUCTIONS to one or more instruction files.'
    ].join('\n')
  }

  return [
    'Custom instructions loaded:',
    ...sources.map((source) => {
      const displayPath =
        source.scope === 'project' ? path.relative(workspaceRoot, source.path) : source.path
      return `- ${source.scope}: ${displayPath}`
    })
  ].join('\n')
}

function formatTuiSessionList(sessions: PersistedSession[]): string {
  if (sessions.length === 0) {
    return 'No saved sessions.'
  }

  return [
    'Saved sessions:',
    ...sessions.slice(0, 12).map((session) => {
      const title = session.title ?? '(untitled)'
      const marker = `${session.id}  ${title}`
      return `- ${marker}\n  ${compactPath(session.workspaceRoot, 80)}\n  resume: nekodex resume ${session.id}`
    })
  ].join('\n')
}

function formatTuiMcpStatus(config: NekodexConfig): string {
  if (config.mcpServers.length === 0) {
    return 'No MCP servers configured. Run `nekodex mcp` to add one.'
  }

  return [
    'MCP servers:',
    ...config.mcpServers.map((server) => {
      const authStatus = server.authorizationEnvVar
        ? process.env[server.authorizationEnvVar]
          ? `${server.authorizationEnvVar}: set`
          : `${server.authorizationEnvVar}: missing`
        : 'no auth env'
      const allowedTools = server.allowedTools?.length
        ? server.allowedTools.join(', ')
        : 'all tools'
      return `- ${server.serverLabel}\n  target: ${formatTuiMcpTarget(server)}\n  auth: ${authStatus}\n  allowed: ${allowedTools}\n  approval: ${server.requireApproval ?? 'default'}`
    })
  ].join('\n')
}

function formatTuiMcpTarget(server: NekodexConfig['mcpServers'][number]): string {
  if (server.serverUrl) {
    return server.serverUrl
  }
  if (server.command) {
    return [server.command, ...(server.args ?? [])].join(' ')
  }
  return 'not configured'
}

function formatTuiToolStatus(config: NekodexConfig): string {
  const hostedTools = config.openAiHostedTools.map((tool) => tool.type).filter(Boolean)
  return [
    'Tools:',
    `- local workspace tools: ${LOCAL_TOOL_COUNT} ready`,
    `- hosted OpenAI tools: ${hostedTools.length ? hostedTools.join(', ') : 'none'}`,
    `- MCP servers: ${config.mcpServers.length}`
  ].join('\n')
}

async function buildGitDiffSummary(workspaceRoot: string): Promise<string> {
  try {
    const [status, diffStat] = await Promise.all([
      execFileAsync('git', ['-C', workspaceRoot, 'status', '--short'], {
        maxBuffer: 128_000
      }),
      execFileAsync('git', ['-C', workspaceRoot, 'diff', '--stat'], {
        maxBuffer: 128_000
      })
    ])
    const statusText = status.stdout.trim() || 'clean'
    const diffText = diffStat.stdout.trim() || 'no unstaged diff'
    return [`git status --short`, statusText, '', 'git diff --stat', diffText].join('\n')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Could not read git diff: ${message}`
  }
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

function getSelectionPanelRows(selection: ActiveSelection, columns: number): number {
  const descriptionWidth = Math.max(24, columns - 36)
  return selection.options.reduce(
    (rows, option) => rows + Math.max(1, wrapText(option.description, descriptionWidth).length),
    4
  )
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

function createInitialTranscript(items: PersistedTranscriptItem[] | undefined): TranscriptItem[] {
  if (items?.length) {
    return items.slice(-MAX_TRANSCRIPT_ITEMS).map((item, index) => ({
      id: index + 1,
      role: item.role,
      text: item.text
    }))
  }

  return [
    {
      id: 1,
      role: 'status',
      text: 'Nekodex is ready. Type /help for commands or ask for a code change.'
    }
  ]
}

function toPersistedTranscriptItems(items: TranscriptItem[]): PersistedTranscriptItem[] {
  return items.map((item) => ({
    role: item.role,
    text: item.text
  }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
