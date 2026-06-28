import blessed from 'blessed'
import { AuthManager } from '../auth/manager.js'
import type { NekodexConfig } from '../config/schema.js'
import type { ConfigStore } from '../config/store.js'
import { MemoryStore } from '../memory/store.js'
import { AgentRunner } from '../agent/runner.js'

const STATUS_ANIMATION_INTERVAL_MS = 120
const STATUS_ANIMATION_FRAMES = ['|', '/', '-', '\\']

export interface TuiOptions {
  configStore: ConfigStore
  config: NekodexConfig
  workspaceRoot: string
  model?: string
  approvalMode?: 'ask' | 'auto'
}

export function startTui(options: TuiOptions): void {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'Nekodex'
  })

  const log = blessed.log({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%-3',
    border: 'line',
    label: ' Nekodex ',
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    tags: true,
    style: {
      border: { fg: 'cyan' }
    }
  })

  const input = blessed.textbox({
    parent: screen,
    bottom: 1,
    left: 0,
    width: '100%',
    height: 3,
    border: 'line',
    label: ' Prompt ',
    inputOnFocus: true,
    style: {
      border: { fg: 'green' }
    }
  })

  const status = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: 'Enter: send | Ctrl+C/q: quit',
    style: {
      fg: 'white',
      bg: 'blue'
    }
  })

  let statusAnimationTimer: NodeJS.Timeout | null = null
  let statusAnimationIndex = 0
  let currentStatusText = 'Ready'

  const setStatus = (text: string): void => {
    currentStatusText = text
    if (!statusAnimationTimer) {
      status.setContent(text)
    }
    screen.render()
  }

  const startStatusAnimation = (): void => {
    stopStatusAnimation('Running...')
    currentStatusText = 'Running...'
    statusAnimationTimer = setInterval(() => {
      const frame = STATUS_ANIMATION_FRAMES[statusAnimationIndex % STATUS_ANIMATION_FRAMES.length]
      statusAnimationIndex += 1
      status.setContent(`${frame} ${currentStatusText}`)
      screen.render()
    }, STATUS_ANIMATION_INTERVAL_MS)
  }

  const stopStatusAnimation = (nextStatus = 'Ready'): void => {
    if (statusAnimationTimer) {
      clearInterval(statusAnimationTimer)
      statusAnimationTimer = null
    }
    statusAnimationIndex = 0
    setStatus(nextStatus)
  }

  const runner = new AgentRunner({
    authManager: new AuthManager(options.configStore),
    config: options.config,
    workspaceRoot: options.workspaceRoot,
    memoryStore: new MemoryStore(options.configStore),
    model: options.model,
    approvalMode: options.approvalMode,
    onAssistantText: (text) => appendLog(log, text),
    onStatus: (text) => {
      currentStatusText = text
      appendLog(log, `{gray-fg}${text}{/gray-fg}`)
      screen.render()
    }
  })

  let isRunning = false

  input.key('enter', () => {
    const prompt = input.getValue().trim()
    input.clearValue()
    screen.render()

    if (!prompt || isRunning) {
      return
    }

    isRunning = true
    appendLog(log, `{bold}> ${prompt}{/bold}`)
    startStatusAnimation()
    screen.render()

    void runner
      .run(prompt)
      .catch((error: unknown) => {
        appendLog(log, `{red-fg}${error instanceof Error ? error.message : String(error)}{/red-fg}`)
      })
      .finally(() => {
        isRunning = false
        stopStatusAnimation('Ready')
        input.focus()
        screen.render()
      })
  })

  screen.key(['q', 'C-c'], () => {
    stopStatusAnimation('Exiting...')
    process.exit(0)
  })
  input.focus()
  screen.render()
}

function appendLog(log: blessed.Widgets.Log, text: string): void {
  for (const line of text.split(/\r?\n/)) {
    log.log(line)
  }
}
