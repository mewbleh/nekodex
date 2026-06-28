import { Box, Text, render, useApp, useInput } from 'ink'
import { useMemo, useState } from 'react'
import { AuthManager, maskSecret } from '../auth/manager.js'
import type { ApprovalMode, SandboxMode } from '../config/schema.js'
import { ConfigStore } from '../config/store.js'
import {
  formatAuthStatus,
  formatChatGptLoginMessage,
  formatJson,
  nonEmptyArrayField,
  parseCommaList,
  parsePartialImagesOption
} from '../command-helpers.js'
import { APP_VERSION, DEFAULT_AUTH_ISSUER, DEFAULT_MODEL, OAUTH_CLIENT_ID } from '../constants.js'
import { MemoryStore } from '../memory/store.js'

const REQUIRED_INPUT_MESSAGE = 'This field is required.'
const VALID_APPROVAL_MODES = new Set(['ask', 'auto'])
const VALID_SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const VALID_MCP_APPROVAL_MODES = new Set(['always', 'never'])

export type CommandHubGroup = 'auth' | 'config' | 'mcp' | 'memory' | 'tools'

export interface CommandHubOptions {
  group: CommandHubGroup
  configStore?: ConfigStore
}

interface PromptField {
  label: string
  name: string
  required?: boolean
  secret?: boolean
}

interface CommandHubAction {
  description: string
  id: string
  label: string
  prompts?: PromptField[]
  run?: (answers: Record<string, string>) => Promise<string>
}

type CommandHubPhase = 'busy' | 'done' | 'input' | 'menu'

export async function startCommandHub(options: CommandHubOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    printCommandHubFallback(options)
    return
  }

  const instance = render(<CommandHub options={options} />)
  await instance.waitUntilExit()
}

function CommandHub({ options }: { options: CommandHubOptions }) {
  const { exit } = useApp()
  const store = useMemo(() => options.configStore ?? new ConfigStore(), [options.configStore])
  const actions = useMemo(() => buildCommandHubActions(options.group, store), [options.group, store])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [phase, setPhase] = useState<CommandHubPhase>('menu')
  const [activeAction, setActiveAction] = useState<CommandHubAction | null>(null)
  const [promptIndex, setPromptIndex] = useState(0)
  const [inputValue, setInputValue] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [message, setMessage] = useState('')
  const selectedAction = actions[selectedIndex]
  const activePrompt = activeAction?.prompts?.[promptIndex]

  const runAction = (action: CommandHubAction, nextAnswers: Record<string, string>): void => {
    if (!action.run) {
      exit()
      return
    }

    setPhase('busy')
    setMessage(`${action.label}...`)
    void action
      .run(nextAnswers)
      .then((result) => {
        setMessage(result)
        setPhase('done')
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : String(error))
        setPhase('done')
      })
  }

  useInput((input, key) => {
    if ((key.ctrl && input === 'c') || key.escape) {
      exit()
      return
    }

    if (phase === 'busy') {
      return
    }

    if (phase === 'done') {
      if (key.return || input === 'q') {
        exit()
      }
      return
    }

    if (phase === 'menu') {
      if (key.upArrow) {
        setSelectedIndex((current) => Math.max(0, current - 1))
        return
      }
      if (key.downArrow) {
        setSelectedIndex((current) => Math.min(actions.length - 1, current + 1))
        return
      }
      if (input === 'q') {
        exit()
        return
      }
      if (key.return) {
        if (selectedAction.id === 'exit') {
          exit()
          return
        }
        if (!selectedAction.prompts?.length) {
          runAction(selectedAction, {})
          return
        }
        setActiveAction(selectedAction)
        setPromptIndex(0)
        setAnswers({})
        setInputValue('')
        setMessage('')
        setPhase('input')
      }
      return
    }

    if (!activeAction || !activePrompt) {
      setPhase('menu')
      return
    }

    if (key.backspace || key.delete) {
      setInputValue((current) => current.slice(0, -1))
      return
    }

    if (key.return) {
      const trimmedInput = inputValue.trim()
      if (activePrompt.required && !trimmedInput) {
        setMessage(REQUIRED_INPUT_MESSAGE)
        return
      }

      const nextAnswers = { ...answers, [activePrompt.name]: trimmedInput }
      const nextPromptIndex = promptIndex + 1
      if (nextPromptIndex >= (activeAction.prompts?.length ?? 0)) {
        runAction(activeAction, nextAnswers)
        return
      }

      setAnswers(nextAnswers)
      setPromptIndex(nextPromptIndex)
      setInputValue('')
      setMessage('')
      return
    }

    if (!key.ctrl && input) {
      setInputValue((current) => `${current}${input}`)
    }
  })

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color="cyan" bold>
          Nekodex
        </Text>
        <Text color="gray"> v{APP_VERSION} </Text>
        <Text color="white">{options.group}</Text>
      </Box>

      {phase === 'menu' ? (
        <MenuView actions={actions} selectedIndex={selectedIndex} />
      ) : (
        <ActionView
          activePrompt={activePrompt}
          inputValue={inputValue}
          message={message}
          phase={phase}
        />
      )}
    </Box>
  )
}

function MenuView({
  actions,
  selectedIndex
}: {
  actions: CommandHubAction[]
  selectedIndex: number
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {actions.map((action, index) => (
        <Box key={action.id}>
          <Text color={index === selectedIndex ? 'cyan' : 'gray'}>
            {index === selectedIndex ? '> ' : '  '}
          </Text>
          <Text color={index === selectedIndex ? 'white' : 'gray'}>{action.label}</Text>
          <Text color="gray"> - {action.description}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color="gray">Enter select  Up/Down move  Esc/q quit</Text>
      </Box>
    </Box>
  )
}

function ActionView({
  activePrompt,
  inputValue,
  message,
  phase
}: {
  activePrompt: PromptField | undefined
  inputValue: string
  message: string
  phase: CommandHubPhase
}) {
  if (phase === 'busy') {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="yellow">{message}</Text>
      </Box>
    )
  }

  if (phase === 'done') {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text>{message}</Text>
        <Box marginTop={1}>
          <Text color="gray">Enter/q close</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color="cyan">{activePrompt?.label ?? 'Value'}</Text>
        <Text color="gray">: </Text>
        <Text>{activePrompt?.secret ? maskInput(inputValue) : inputValue}</Text>
      </Box>
      {message ? (
        <Box marginTop={1}>
          <Text color="red">{message}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

function buildCommandHubActions(group: CommandHubGroup, store: ConfigStore): CommandHubAction[] {
  if (group === 'auth') {
    return buildAuthActions(store)
  }
  if (group === 'config') {
    return buildConfigActions(store)
  }
  if (group === 'memory') {
    return buildMemoryActions(store)
  }
  if (group === 'tools') {
    return buildToolsActions(store)
  }
  return buildMcpActions(store)
}

function buildAuthActions(store: ConfigStore): CommandHubAction[] {
  const manager = new AuthManager(store)
  return [
    {
      id: 'status',
      label: 'Status',
      description: 'show the current login',
      run: async () => formatAuthStatus(await manager.status())
    },
    {
      id: 'login-chatgpt',
      label: 'Login with ChatGPT',
      description: 'open browser sign-in',
      run: async () =>
        formatChatGptLoginMessage(
          await manager.loginWithBrowser({
            issuer: DEFAULT_AUTH_ISSUER,
            clientId: OAUTH_CLIENT_ID
          })
        )
    },
    {
      id: 'login-device',
      label: 'Login with device code',
      description: 'use a browser on another device',
      run: async () =>
        formatChatGptLoginMessage(
          await manager.loginWithDeviceCode({
            issuer: DEFAULT_AUTH_ISSUER,
            clientId: OAUTH_CLIENT_ID
          })
        )
    },
    {
      id: 'login-api-key',
      label: 'Login with API key',
      description: 'store an OpenAI API key',
      prompts: [{ label: 'OpenAI API key', name: 'apiKey', required: true, secret: true }],
      run: async ({ apiKey }) => {
        await manager.loginWithApiKey(apiKey)
        return `Logged in with API key ${maskSecret(apiKey)}.`
      }
    },
    {
      id: 'logout',
      label: 'Logout',
      description: 'remove stored local credentials',
      run: async () => {
        await manager.logout()
        return 'Logged out.'
      }
    },
    exitAction()
  ]
}

function buildConfigActions(store: ConfigStore): CommandHubAction[] {
  return [
    {
      id: 'show',
      label: 'Show config',
      description: 'print resolved settings',
      run: async () => formatJson(await store.loadConfig())
    },
    {
      id: 'set-model',
      label: 'Set model',
      description: 'change the default model',
      prompts: [{ label: 'Model', name: 'model', required: true }],
      run: async ({ model }) => formatJson(await store.patchConfig({ model: model || DEFAULT_MODEL }))
    },
    {
      id: 'set-base-url',
      label: 'Set OpenAI base URL',
      description: 'change the API endpoint',
      prompts: [{ label: 'OpenAI base URL', name: 'openaiBaseUrl', required: true }],
      run: async ({ openaiBaseUrl }) => formatJson(await store.patchConfig({ openaiBaseUrl }))
    },
    {
      id: 'set-approval',
      label: 'Set approval mode',
      description: 'choose ask or auto',
      prompts: [{ label: 'Approval mode (ask/auto)', name: 'approvalMode', required: true }],
      run: async ({ approvalMode }) => {
        if (!VALID_APPROVAL_MODES.has(approvalMode)) {
          throw new Error('Approval mode must be ask or auto.')
        }
        return formatJson(await store.patchConfig({ approvalMode: approvalMode as ApprovalMode }))
      }
    },
    {
      id: 'set-sandbox',
      label: 'Set sandbox mode',
      description: 'choose read-only, workspace-write, or danger-full-access',
      prompts: [{ label: 'Sandbox mode', name: 'sandboxMode', required: true }],
      run: async ({ sandboxMode }) => {
        if (!VALID_SANDBOX_MODES.has(sandboxMode)) {
          throw new Error('Sandbox mode must be read-only, workspace-write, or danger-full-access.')
        }
        return formatJson(await store.patchConfig({ sandboxMode: sandboxMode as SandboxMode }))
      }
    },
    {
      id: 'toggle-outside-workspace',
      label: 'Toggle outside workspace',
      description: 'flip workspace boundary access',
      run: async () => {
        const current = await store.loadConfig()
        return formatJson(
          await store.patchConfig({ allowOutsideWorkspace: !current.allowOutsideWorkspace })
        )
      }
    },
    {
      id: 'toggle-auto-compact',
      label: 'Toggle auto compact',
      description: 'flip context compaction',
      run: async () => {
        const current = await store.loadConfig()
        return formatJson(
          await store.patchConfig({
            contextWindow: { autoCompact: !current.contextWindow.autoCompact }
          })
        )
      }
    },
    {
      id: 'set-compact-threshold',
      label: 'Set compact threshold',
      description: 'change token threshold',
      prompts: [{ label: 'Threshold tokens', name: 'compactThresholdTokens', required: true }],
      run: async ({ compactThresholdTokens }) =>
        formatJson(
          await store.patchConfig({
            contextWindow: {
              compactThresholdTokens: Number.parseInt(compactThresholdTokens, 10)
            }
          })
        )
    },
    exitAction()
  ]
}

function buildMemoryActions(store: ConfigStore): CommandHubAction[] {
  const memoryStore = new MemoryStore(store)
  return [
    {
      id: 'list',
      label: 'List memories',
      description: 'show stored memories',
      run: async () => {
        const records = await memoryStore.list()
        return records.length
          ? records.map((record) => `${record.id}\t${record.title}`).join('\n')
          : 'No memories.'
      }
    },
    {
      id: 'add',
      label: 'Add memory',
      description: 'save reusable context',
      prompts: [
        { label: 'Title', name: 'title' },
        { label: 'Content', name: 'content', required: true },
        { label: 'Tags (comma-separated)', name: 'tags' }
      ],
      run: async ({ content, tags, title }) => {
        const record = await memoryStore.add({
          title: title || undefined,
          content,
          tags: parseCommaList(tags)
        })
        return `Added memory ${record.id}: ${record.title}`
      }
    },
    {
      id: 'search',
      label: 'Search memories',
      description: 'find saved context',
      prompts: [{ label: 'Search query', name: 'query', required: true }],
      run: async ({ query }) => {
        const records = await memoryStore.search(query)
        return records.length
          ? records.map((record) => `${record.id}\t${record.title}\n${record.content}`).join('\n\n')
          : 'No matching memories.'
      }
    },
    {
      id: 'remove',
      label: 'Remove memory',
      description: 'delete by id',
      prompts: [{ label: 'Memory id', name: 'id', required: true }],
      run: async ({ id }) => ((await memoryStore.remove(id)) ? 'Removed memory.' : 'Memory not found.')
    },
    {
      id: 'clear',
      label: 'Clear memories',
      description: 'delete all memories',
      run: async () => {
        await memoryStore.clear()
        return 'Cleared memories.'
      }
    },
    exitAction()
  ]
}

function buildToolsActions(store: ConfigStore): CommandHubAction[] {
  return [
    {
      id: 'list-openai',
      label: 'List OpenAI tools',
      description: 'show hosted tool config',
      run: async () => formatJson((await store.loadConfig()).openAiHostedTools)
    },
    {
      id: 'add-openai',
      label: 'Add OpenAI tool',
      description: 'web_search, file_search, code_interpreter, image_generation',
      prompts: [
        { label: 'Tool type', name: 'type', required: true },
        { label: 'Vector store IDs (comma-separated)', name: 'vectorStoreIds' },
        { label: 'Partial images', name: 'partialImages' }
      ],
      run: async ({ partialImages, type, vectorStoreIds }) => {
        const current = await store.loadConfig()
        const nextTool = {
          type,
          ...nonEmptyArrayField('vectorStoreIds', parseCommaList(vectorStoreIds)),
          ...parsePartialImagesOption({ partialImages })
        }
        await store.patchConfig({
          openAiHostedTools: [...current.openAiHostedTools, nextTool]
        })
        return `Added OpenAI-hosted tool: ${type}`
      }
    },
    {
      id: 'clear-openai',
      label: 'Clear OpenAI tools',
      description: 'remove hosted tool config',
      run: async () => {
        await store.patchConfig({ openAiHostedTools: [] })
        return 'Cleared OpenAI-hosted tools.'
      }
    },
    exitAction()
  ]
}

function buildMcpActions(store: ConfigStore): CommandHubAction[] {
  return [
    {
      id: 'list',
      label: 'List MCP servers',
      description: 'show remote MCP config',
      run: async () => formatJson((await store.loadConfig()).mcpServers)
    },
    {
      id: 'add',
      label: 'Add MCP server',
      description: 'configure a remote MCP endpoint',
      prompts: [
        { label: 'Server label', name: 'label', required: true },
        { label: 'Server URL', name: 'url', required: true },
        { label: 'Auth env var', name: 'authEnv' },
        { label: 'Allowed tools (comma-separated)', name: 'allowedTools' },
        { label: 'Approval (always/never)', name: 'approval' }
      ],
      run: async ({ allowedTools, approval, authEnv, label, url }) => {
        const requireApproval = parseMcpApproval(approval)
        const current = await store.loadConfig()
        await store.patchConfig({
          mcpServers: [
            ...current.mcpServers,
            {
              serverLabel: label,
              serverUrl: url,
              authorizationEnvVar: authEnv || undefined,
              ...nonEmptyArrayField('allowedTools', parseCommaList(allowedTools)),
              requireApproval
            }
          ]
        })
        return `Added MCP server: ${label}`
      }
    },
    {
      id: 'clear',
      label: 'Clear MCP servers',
      description: 'remove remote MCP config',
      run: async () => {
        await store.patchConfig({ mcpServers: [] })
        return 'Cleared MCP servers.'
      }
    },
    exitAction()
  ]
}

function exitAction(): CommandHubAction {
  return {
    id: 'exit',
    label: 'Exit',
    description: 'close this menu'
  }
}

function parseMcpApproval(value: string | undefined): 'always' | 'never' | undefined {
  if (!value) {
    return undefined
  }
  if (!VALID_MCP_APPROVAL_MODES.has(value)) {
    throw new Error('MCP approval must be always or never.')
  }
  return value as 'always' | 'never'
}

function maskInput(value: string): string {
  return value ? '*'.repeat(Math.min(value.length, 32)) : ''
}

function printCommandHubFallback(options: CommandHubOptions): void {
  const store = options.configStore ?? new ConfigStore()
  const actions = buildCommandHubActions(options.group, store).filter((action) => action.id !== 'exit')
  console.log(`nekodex ${options.group}`)
  console.log('Run this command in an interactive terminal to open the menu.')
  console.log('Available actions:')
  for (const action of actions) {
    console.log(`- ${action.label}: ${action.description}`)
  }
}
