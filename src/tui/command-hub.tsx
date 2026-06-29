import { Box, Text, render, useApp, useInput } from 'ink'
import { useMemo, useState } from 'react'
import { AuthManager, maskSecret } from '../auth/manager.js'
import type { ApprovalMode, McpServerConfig, ReasoningEffort, SandboxMode } from '../config/schema.js'
import { ConfigStore } from '../config/store.js'
import {
  formatAuthStatus,
  formatChatGptLoginMessage,
  formatJson,
  nonEmptyArrayField,
  parseCommaList,
  parsePartialImagesOption
} from '../command-helpers.js'
import {
  APP_VERSION,
  DEFAULT_AUTH_ISSUER,
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  OAUTH_CLIENT_ID
} from '../constants.js'
import { MemoryStore } from '../memory/store.js'
import { SessionStore, type PersistedSession } from '../session/store.js'

const REQUIRED_INPUT_MESSAGE = 'This field is required.'
const VALID_APPROVAL_MODES = new Set(['ask', 'auto'])
const VALID_REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh'])
const VALID_SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const VALID_MCP_APPROVAL_MODES = new Set(['always', 'never'])

export type CommandHubGroup = 'auth' | 'config' | 'mcp' | 'memory' | 'sessions' | 'tools'

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
  if (group === 'sessions') {
    return buildSessionActions(store)
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
      description: 'change model and reasoning effort',
      prompts: [
        { label: 'Model', name: 'model', required: true },
        { label: 'Reasoning effort (none/low/medium/high/xhigh)', name: 'reasoningEffort' }
      ],
      run: async ({ model, reasoningEffort }) => {
        const current = await store.loadConfig()
        return formatJson(
          await store.patchConfig({
            model: model || DEFAULT_MODEL,
            reasoningEffort: parseReasoningEffort(reasoningEffort, current.reasoningEffort)
          })
        )
      }
    },
    {
      id: 'set-reasoning-effort',
      label: 'Set reasoning effort',
      description: 'change none, low, medium, high, or xhigh',
      prompts: [{ label: 'Reasoning effort', name: 'reasoningEffort', required: true }],
      run: async ({ reasoningEffort }) =>
        formatJson(
          await store.patchConfig({
            reasoningEffort: parseReasoningEffort(reasoningEffort, DEFAULT_REASONING_EFFORT)
          })
        )
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

function buildSessionActions(store: ConfigStore): CommandHubAction[] {
  const sessionStore = new SessionStore(store)
  return [
    {
      id: 'list',
      label: 'List sessions',
      description: 'show saved resumable sessions',
      run: async () => formatSessionList(await sessionStore.list())
    },
    {
      id: 'show',
      label: 'Show session',
      description: 'inspect one session by id',
      prompts: [{ label: 'Session id', name: 'id', required: true }],
      run: async ({ id }) => {
        const session = await sessionStore.loadById(id)
        return session ? formatSessionDetail(session) : 'Session not found.'
      }
    },
    {
      id: 'rename',
      label: 'Rename session',
      description: 'set a friendly title',
      prompts: [
        { label: 'Session id', name: 'id', required: true },
        { label: 'New title', name: 'title', required: true }
      ],
      run: async ({ id, title }) =>
        (await sessionStore.rename(id, title)) ? 'Renamed session.' : 'Session not found.'
    },
    {
      id: 'remove',
      label: 'Delete session',
      description: 'remove one saved session by id',
      prompts: [{ label: 'Session id', name: 'id', required: true }],
      run: async ({ id }) =>
        (await sessionStore.remove(id)) ? 'Deleted session.' : 'Session not found.'
    },
    {
      id: 'clear-current',
      label: 'Delete current workspace',
      description: 'remove the session for this directory',
      run: async () =>
        (await sessionStore.clear(process.cwd()))
          ? 'Deleted current workspace session.'
          : 'No session for this workspace.'
    },
    {
      id: 'clear-all',
      label: 'Delete all sessions',
      description: 'remove every saved session',
      run: async () => {
        const count = await sessionStore.clearAll()
        return `Deleted ${count} session${count === 1 ? '' : 's'}.`
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

function formatSessionList(sessions: PersistedSession[]): string {
  if (sessions.length === 0) {
    return 'No saved sessions.'
  }

  return sessions
    .map((session) => {
      const title = session.title ?? '(untitled)'
      const itemCount = session.conversationItems.length
      return `${session.id}\t${title}\t${session.workspaceRoot}\t${itemCount} item${itemCount === 1 ? '' : 's'}\t${session.updatedAt}`
    })
    .join('\n')
}

function formatSessionDetail(session: PersistedSession): string {
  return [
    `id: ${session.id}`,
    `title: ${session.title ?? '(untitled)'}`,
    `workspace: ${session.workspaceRoot}`,
    `updated: ${session.updatedAt}`,
    `conversation items: ${session.conversationItems.length}`,
    `visible transcript items: ${session.uiTranscript?.length ?? 0}`,
    '',
    `resume: nekodex resume ${session.id}`
  ].join('\n')
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
      id: 'status',
      label: 'MCP status',
      description: 'show auth env and allow-list readiness',
      run: async () => formatMcpStatus((await store.loadConfig()).mcpServers)
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
      id: 'rename',
      label: 'Rename MCP server',
      description: 'change a server label',
      prompts: [
        { label: 'Current label', name: 'label', required: true },
        { label: 'New label', name: 'newLabel', required: true }
      ],
      run: async ({ label, newLabel }) =>
        (await updateMcpServer(store, label, (server) => ({
          ...server,
          serverLabel: newLabel
        })))
          ? `Renamed MCP server to: ${newLabel}`
          : `MCP server not found: ${label}`
    },
    {
      id: 'set-url',
      label: 'Set MCP URL',
      description: 'change a server URL',
      prompts: [
        { label: 'Server label', name: 'label', required: true },
        { label: 'Server URL', name: 'url', required: true }
      ],
      run: async ({ label, url }) =>
        (await updateMcpServer(store, label, (server) => ({
          ...server,
          serverUrl: url
        })))
          ? `Updated MCP server URL: ${label}`
          : `MCP server not found: ${label}`
    },
    {
      id: 'set-auth',
      label: 'Set MCP auth env',
      description: 'set bearer token env var',
      prompts: [
        { label: 'Server label', name: 'label', required: true },
        { label: 'Auth env var', name: 'authEnv', required: true }
      ],
      run: async ({ authEnv, label }) =>
        (await updateMcpServer(store, label, (server) => ({
          ...server,
          authorizationEnvVar: authEnv
        })))
          ? `Updated MCP auth env: ${label}`
          : `MCP server not found: ${label}`
    },
    {
      id: 'clear-auth',
      label: 'Clear MCP auth env',
      description: 'remove bearer token env var',
      prompts: [{ label: 'Server label', name: 'label', required: true }],
      run: async ({ label }) =>
        (await updateMcpServer(store, label, (server) => ({
          ...server,
          authorizationEnvVar: undefined
        })))
          ? `Cleared MCP auth env: ${label}`
          : `MCP server not found: ${label}`
    },
    {
      id: 'allow-tool',
      label: 'Allow MCP tool',
      description: 'add one tool to allow-list',
      prompts: [
        { label: 'Server label', name: 'label', required: true },
        { label: 'Tool name', name: 'tool', required: true }
      ],
      run: async ({ label, tool }) =>
        (await updateMcpServer(store, label, (server) => ({
          ...server,
          allowedTools: uniqueStrings([...(server.allowedTools ?? []), tool])
        })))
          ? `Allowed MCP tool ${tool} on ${label}.`
          : `MCP server not found: ${label}`
    },
    {
      id: 'disallow-tool',
      label: 'Disallow MCP tool',
      description: 'remove one allow-listed tool',
      prompts: [
        { label: 'Server label', name: 'label', required: true },
        { label: 'Tool name', name: 'tool', required: true }
      ],
      run: async ({ label, tool }) =>
        (await updateMcpServer(store, label, (server) => {
          const allowedTools = (server.allowedTools ?? []).filter((item) => item !== tool)
          return {
            ...server,
            allowedTools: allowedTools.length > 0 ? allowedTools : undefined
          }
        }))
          ? `Removed MCP tool ${tool} from ${label}.`
          : `MCP server not found: ${label}`
    },
    {
      id: 'set-approval',
      label: 'Set MCP approval',
      description: 'always, never, or default',
      prompts: [
        { label: 'Server label', name: 'label', required: true },
        { label: 'Approval (always/never/default)', name: 'approval', required: true }
      ],
      run: async ({ approval, label }) =>
        (await updateMcpServer(store, label, (server) => ({
          ...server,
          requireApproval: parseMcpApprovalWithDefault(approval)
        })))
          ? `Updated MCP approval: ${label}`
          : `MCP server not found: ${label}`
    },
    {
      id: 'remove',
      label: 'Remove MCP server',
      description: 'delete one server by label',
      prompts: [{ label: 'Server label', name: 'label', required: true }],
      run: async ({ label }) =>
        (await removeMcpServer(store, label))
          ? `Removed MCP server: ${label}`
          : `MCP server not found: ${label}`
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

function formatMcpStatus(servers: McpServerConfig[]): string {
  if (servers.length === 0) {
    return 'No MCP servers configured.'
  }

  return servers
    .map((server) => {
      const authStatus = server.authorizationEnvVar
        ? process.env[server.authorizationEnvVar]
          ? `${server.authorizationEnvVar}: set`
          : `${server.authorizationEnvVar}: missing`
        : 'no auth env'
      const allowedTools = server.allowedTools?.length
        ? server.allowedTools.join(', ')
        : 'all tools'
      return [
        `${server.serverLabel}`,
        `target: ${formatMcpTarget(server)}`,
        `auth: ${authStatus}`,
        `allowed: ${allowedTools}`,
        `approval: ${server.requireApproval ?? 'default'}`
      ].join('\n')
    })
    .join('\n\n')
}

function formatMcpTarget(server: McpServerConfig): string {
  if (server.serverUrl) {
    return server.serverUrl
  }
  if (server.command) {
    return [server.command, ...(server.args ?? [])].join(' ')
  }
  return 'not configured'
}

async function updateMcpServer(
  store: ConfigStore,
  label: string,
  update: (server: McpServerConfig) => McpServerConfig
): Promise<boolean> {
  const current = await store.loadConfig()
  let didUpdate = false
  const mcpServers = current.mcpServers.map((server) => {
    if (server.serverLabel !== label) {
      return server
    }
    didUpdate = true
    return update(server)
  })

  if (!didUpdate) {
    return false
  }

  await store.patchConfig({ mcpServers })
  return true
}

async function removeMcpServer(store: ConfigStore, label: string): Promise<boolean> {
  const current = await store.loadConfig()
  const mcpServers = current.mcpServers.filter((server) => server.serverLabel !== label)
  if (mcpServers.length === current.mcpServers.length) {
    return false
  }
  await store.patchConfig({ mcpServers })
  return true
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

function parseMcpApprovalWithDefault(value: string | undefined): 'always' | 'never' | undefined {
  if (value === 'default') {
    return undefined
  }
  return parseMcpApproval(value)
}

function parseReasoningEffort(value: string | undefined, fallback: ReasoningEffort): ReasoningEffort {
  if (!value) {
    return fallback
  }
  if (!VALID_REASONING_EFFORTS.has(value)) {
    throw new Error('Reasoning effort must be none, low, medium, high, or xhigh.')
  }
  return value as ReasoningEffort
}

function maskInput(value: string): string {
  return value ? '*'.repeat(Math.min(value.length, 32)) : ''
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
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
