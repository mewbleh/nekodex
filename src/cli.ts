#!/usr/bin/env node
import 'dotenv/config'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { Command } from 'commander'
import { AuthManager, maskSecret } from './auth/manager.js'
import { ConfigStore } from './config/store.js'
import type {
  ApprovalMode,
  NekodexConfig,
  ReasoningEffort,
  SandboxBackend,
  SandboxMode
} from './config/schema.js'
import { APP_VERSION, DEFAULT_AUTH_ISSUER, OAUTH_CLIENT_ID } from './constants.js'
import { AgentRunner } from './agent/runner.js'
import { NekodexError } from './errors.js'
import { MemoryStore } from './memory/store.js'
import { SessionStore } from './session/store.js'
import { startTui } from './tui/app.js'
import { startCommandHub } from './tui/command-hub.js'
import { serveMcp } from './mcp/server.js'
import { getPlatformInfo } from './platform.js'
import {
  collectOption,
  formatAuthStatus,
  formatChatGptLoginMessage,
  nonEmptyArrayField,
  parseConfigPatch,
  parsePartialImagesOption
} from './command-helpers.js'

const program = new Command()

program
  .name('nekodex')
  .description('Lightweight TypeScript agent CLI.')
  .version(APP_VERSION)
  .option('-C, --cwd <path>', 'workspace directory', process.cwd())
  .option('-m, --model <model>', 'model to use')
  .option('--effort <effort>', 'reasoning effort: none, low, medium, high, xhigh')
  .option('--reasoning-effort <effort>', 'reasoning effort: none, low, medium, high, xhigh')
  .option('-y, --yes', 'approve tool calls automatically')
  .option('--sandbox <mode>', 'sandbox mode: read-only, workspace-write, danger-full-access')
  .option('--sandbox-backend <backend>', 'sandbox backend: auto, node, bwrap, none')
  .option('--danger-full-access', 'disable workspace sandbox restrictions')
  .option('--plain', 'use the simple readline chat instead of the TUI')
  .argument('[prompt...]', 'prompt to run')
  .action(async (promptParts: string[], options: RootOptions) => {
    await runChat(promptParts.join(' '), options)
  })

program
  .command('chat')
  .description('Start an interactive or one-shot agent chat.')
  .option('-C, --cwd <path>', 'workspace directory', process.cwd())
  .option('-m, --model <model>', 'model to use')
  .option('--effort <effort>', 'reasoning effort: none, low, medium, high, xhigh')
  .option('--reasoning-effort <effort>', 'reasoning effort: none, low, medium, high, xhigh')
  .option('-y, --yes', 'approve tool calls automatically')
  .option('--sandbox <mode>', 'sandbox mode: read-only, workspace-write, danger-full-access')
  .option('--sandbox-backend <backend>', 'sandbox backend: auto, node, bwrap, none')
  .option('--danger-full-access', 'disable workspace sandbox restrictions')
  .option('--plain', 'use the simple readline chat instead of the TUI')
  .argument('[prompt...]', 'prompt to run')
  .action(async (promptParts: string[], options: RootOptions) => {
    await runChat(promptParts.join(' '), options)
  })

program
  .command('tui')
  .description('Start the Nekodex terminal UI.')
  .option('-C, --cwd <path>', 'workspace directory', process.cwd())
  .option('-m, --model <model>', 'model to use')
  .option('--effort <effort>', 'reasoning effort: none, low, medium, high, xhigh')
  .option('--reasoning-effort <effort>', 'reasoning effort: none, low, medium, high, xhigh')
  .option('-y, --yes', 'approve tool calls automatically')
  .option('--sandbox <mode>', 'sandbox mode: read-only, workspace-write, danger-full-access')
  .option('--sandbox-backend <backend>', 'sandbox backend: auto, node, bwrap, none')
  .option('--danger-full-access', 'disable workspace sandbox restrictions')
  .action(async (options: RootOptions) => {
    const store = new ConfigStore()
    const config = resolveRuntimeConfig(await store.loadConfig(), options)
    const workspaceRoot = path.resolve(options.cwd)
    const sessionStore = new SessionStore(store)
    const session = await sessionStore.ensure(workspaceRoot)
    startTui({
      configStore: store,
      config,
      workspaceRoot,
      sessionId: session.id,
      model: options.model,
      approvalMode: options.yes ? 'auto' : config.approvalMode
    })
  })

program
  .command('resume')
  .description('Resume a saved Nekodex TUI session by id.')
  .argument('<id>', 'session id')
  .option('-m, --model <model>', 'model to use')
  .option('--effort <effort>', 'reasoning effort: none, low, medium, high, xhigh')
  .option('--reasoning-effort <effort>', 'reasoning effort: none, low, medium, high, xhigh')
  .option('-y, --yes', 'approve tool calls automatically')
  .option('--sandbox <mode>', 'sandbox mode: read-only, workspace-write, danger-full-access')
  .option('--sandbox-backend <backend>', 'sandbox backend: auto, node, bwrap, none')
  .option('--danger-full-access', 'disable workspace sandbox restrictions')
  .action(async (id: string, options: Omit<RootOptions, 'cwd'>) => {
    const store = new ConfigStore()
    const sessionStore = new SessionStore(store)
    const session = await sessionStore.loadById(id)
    if (!session) {
      throw new Error(`Session not found: ${id}`)
    }
    const config = resolveRuntimeConfig(await store.loadConfig(), options)
    startTui({
      configStore: store,
      config,
      workspaceRoot: session.workspaceRoot,
      sessionId: session.id,
      model: options.model,
      approvalMode: options.yes ? 'auto' : config.approvalMode
    })
  })

program
  .command('init')
  .description('Create AGENTS.md and SKILL.md starter files if they do not exist.')
  .option('-C, --cwd <path>', 'workspace directory', process.cwd())
  .action(async (options: { cwd: string }) => {
    const workspaceRoot = path.resolve(options.cwd)
    await writeStarterFile(
      path.join(workspaceRoot, 'AGENTS.md'),
      '# Nekodex Project Instructions\n\n- Inspect relevant files before editing.\n- Keep changes small, readable, and verified.\n- Prefer existing project patterns over new abstractions.\n- Run the narrowest useful check before calling work done.\n'
    )
    await writeStarterFile(
      path.join(workspaceRoot, 'SKILL.md'),
      '# Nekodex Skill Guide\n\nUse this file for reusable project workflows, commands, and task-specific playbooks.\n'
    )
    console.log('Initialized AGENTS.md and SKILL.md.')
  })

program
  .command('doctor')
  .description('Show platform and runtime support diagnostics.')
  .option('--json', 'print diagnostics as JSON')
  .action((options: { json?: boolean }) => {
    const platformInfo = getPlatformInfo()
    const diagnostics = {
      platform: platformInfo.platform,
      nodePlatform: platformInfo.nodePlatform,
      arch: platformInfo.arch,
      nodeVersion: process.version,
      configHome: platformInfo.configHome,
      browserOpeners: platformInfo.browserOpeners.map((opener) => opener.command),
      notes: platformInfo.notes
    }

    if (options.json) {
      console.log(JSON.stringify(diagnostics, null, 2))
      return
    }

    console.log(`Platform: ${diagnostics.platform} (${diagnostics.nodePlatform}/${diagnostics.arch})`)
    console.log(`Node: ${diagnostics.nodeVersion}`)
    console.log(`Config home: ${diagnostics.configHome}`)
    console.log(`Browser openers: ${diagnostics.browserOpeners.join(', ') || 'none'}`)
    for (const note of diagnostics.notes) {
      console.log(`Note: ${note}`)
    }
  })

const auth = program
  .command('auth')
  .description('Manage Nekodex auth.')
  .action(async () => {
    await startCommandHub({ group: 'auth' })
  })

auth
  .command('login')
  .description('Log in with an API key, browser ChatGPT auth, or device code.')
  .option('--api-key [key]', 'store an OpenAI API key')
  .option('--chatgpt', 'sign in with a ChatGPT account in the browser')
  .option('--device-code', 'sign in with ChatGPT using a device code')
  .option('--issuer <url>', 'OAuth issuer base URL', DEFAULT_AUTH_ISSUER)
  .option('--client-id <id>', 'OAuth client ID', OAUTH_CLIENT_ID)
  .action(async (options: LoginOptions) => {
    const manager = new AuthManager(new ConfigStore())

    if (options.apiKey !== undefined) {
      const apiKey = typeof options.apiKey === 'string' ? options.apiKey : await askSecret('API key')
      await manager.loginWithApiKey(apiKey)
      console.log(`Logged in with API key ${maskSecret(apiKey)}.`)
      return
    }

    if (options.deviceCode) {
      const savedAuth = await manager.loginWithDeviceCode({
        issuer: options.issuer,
        clientId: options.clientId
      })
      console.log(formatChatGptLoginMessage(savedAuth))
      return
    }

    const savedAuth = await manager.loginWithBrowser({
      issuer: options.issuer,
      clientId: options.clientId
    })
    console.log(formatChatGptLoginMessage(savedAuth))
  })

auth
  .command('status')
  .description('Show current auth status.')
  .action(async () => {
    const manager = new AuthManager(new ConfigStore())
    const storedAuth = await manager.status()
    console.log(formatAuthStatus(storedAuth))
  })

auth
  .command('logout')
  .description('Remove stored local credentials.')
  .action(async () => {
    const manager = new AuthManager(new ConfigStore())
    await manager.logout()
    console.log('Logged out.')
  })

const config = program
  .command('config')
  .description('Manage local config.')
  .action(async () => {
    await startCommandHub({ group: 'config' })
  })

config
  .command('show')
  .description('Print the resolved config.')
  .action(async () => {
    const store = new ConfigStore()
    console.log(JSON.stringify(await store.loadConfig(), null, 2))
  })

config
  .command('set')
  .description('Set a config value.')
  .argument('<key>', 'config key')
  .argument('<value>', 'config value')
  .action(async (key: string, value: string) => {
    const store = new ConfigStore()
    const patch = parseConfigPatch(key, value)
    const nextConfig = await store.patchConfig(patch)
    console.log(JSON.stringify(nextConfig, null, 2))
  })

const memory = program
  .command('memory')
  .description('Manage persistent memories.')
  .action(async () => {
    await startCommandHub({ group: 'memory' })
  })

memory
  .command('add')
  .description('Add a memory that is injected into agent instructions.')
  .argument('<content...>', 'memory content')
  .option('-t, --title <title>', 'memory title')
  .option('--tag <tag>', 'memory tag; repeat for multiple tags', collectOption, [])
  .action(async (contentParts: string[], options: { title?: string; tag?: string[] }) => {
    const memoryStore = new MemoryStore(new ConfigStore())
    const record = await memoryStore.add({
      title: options.title,
      content: contentParts.join(' '),
      tags: options.tag
    })
    console.log(`Added memory ${record.id}: ${record.title}`)
  })

memory
  .command('list')
  .description('List memories.')
  .action(async () => {
    const records = await new MemoryStore(new ConfigStore()).list()
    for (const record of records) {
      console.log(`${record.id}\t${record.title}`)
    }
  })

memory
  .command('search')
  .description('Search memories.')
  .argument('<query>', 'query text')
  .action(async (query: string) => {
    const records = await new MemoryStore(new ConfigStore()).search(query)
    for (const record of records) {
      console.log(`${record.id}\t${record.title}\n${record.content}\n`)
    }
  })

memory
  .command('remove')
  .description('Remove a memory by id.')
  .argument('<id>', 'memory id')
  .action(async (id: string) => {
    const removed = await new MemoryStore(new ConfigStore()).remove(id)
    console.log(removed ? 'Removed memory.' : 'Memory not found.')
  })

memory
  .command('clear')
  .description('Remove all memories.')
  .action(async () => {
    await new MemoryStore(new ConfigStore()).clear()
    console.log('Cleared memories.')
  })

const tools = program
  .command('tools')
  .description('Manage OpenAI-hosted tool config.')
  .action(async () => {
    await startCommandHub({ group: 'tools' })
  })

tools
  .command('list')
  .description('List configured OpenAI-hosted tools.')
  .action(async () => {
    const store = new ConfigStore()
    const current = await store.loadConfig()
    console.log(JSON.stringify(current.openAiHostedTools, null, 2))
  })

tools
  .command('add-openai')
  .description('Add an OpenAI-hosted Responses API tool.')
  .argument(
    '<type>',
    'tool type, for example web_search, file_search, code_interpreter, or image_generation'
  )
  .option('--vector-store-id <id>', 'vector store id for file_search; repeat for more', collectOption, [])
  .option('--partial-images <count>', 'partial image count for hosted image_generation')
  .action(async (type: string, options: { vectorStoreId?: string[]; partialImages?: string }) => {
    const store = new ConfigStore()
    const current = await store.loadConfig()
    const nextTool = {
      type,
      ...nonEmptyArrayField('vectorStoreIds', options.vectorStoreId),
      ...parsePartialImagesOption(options)
    }
    await store.patchConfig({
      openAiHostedTools: [...current.openAiHostedTools, nextTool]
    })
    console.log(`Added OpenAI-hosted tool: ${type}`)
  })

tools
  .command('clear-openai')
  .description('Remove all configured OpenAI-hosted tools.')
  .action(async () => {
    await new ConfigStore().patchConfig({ openAiHostedTools: [] })
    console.log('Cleared OpenAI-hosted tools.')
  })

const mcp = program
  .command('mcp')
  .description('Manage MCP configuration and server mode.')
  .action(async () => {
    await startCommandHub({ group: 'mcp' })
  })

mcp
  .command('list')
  .description('List remote MCP servers configured for OpenAI Responses.')
  .action(async () => {
    const current = await new ConfigStore().loadConfig()
    console.log(JSON.stringify(current.mcpServers, null, 2))
  })

mcp
  .command('add')
  .description('Add a remote MCP server for OpenAI Responses.')
  .argument('<label>', 'server label')
  .argument('<url>', 'server URL')
  .option('--auth-env <name>', 'environment variable containing a bearer token')
  .option('--allowed-tool <tool>', 'allowed remote MCP tool name; repeat for more', collectOption, [])
  .option('--approval <mode>', 'approval mode: always or never')
  .action(
    async (
      label: string,
      url: string,
      options: { authEnv?: string; allowedTool?: string[]; approval?: 'always' | 'never' }
    ) => {
      const store = new ConfigStore()
      const current = await store.loadConfig()
      await store.patchConfig({
        mcpServers: [
          ...current.mcpServers,
          {
            serverLabel: label,
            serverUrl: url,
            authorizationEnvVar: options.authEnv,
            ...nonEmptyArrayField('allowedTools', options.allowedTool),
            requireApproval: options.approval
          }
        ]
      })
      console.log(`Added MCP server: ${label}`)
    }
  )

mcp
  .command('clear')
  .description('Remove all remote MCP server config.')
  .action(async () => {
    await new ConfigStore().patchConfig({ mcpServers: [] })
    console.log('Cleared MCP servers.')
  })

mcp
  .command('serve')
  .description('Run Nekodex as a local stdio MCP server exposing workspace tools.')
  .option('-C, --cwd <path>', 'workspace directory', process.cwd())
  .option('--approval <mode>', 'approval mode: ask or auto')
  .option('--sandbox <mode>', 'sandbox mode: read-only, workspace-write, danger-full-access')
  .option('--sandbox-backend <backend>', 'sandbox backend: auto, node, bwrap, none')
  .option('--danger-full-access', 'disable workspace sandbox restrictions')
  .action(async (options: { cwd: string; approval?: ApprovalMode; sandbox?: string; sandboxBackend?: string; dangerFullAccess?: boolean }) => {
    const store = new ConfigStore()
    const current = resolveRuntimeConfig(await store.loadConfig(), options)
    await serveMcp({
      workspaceRoot: path.resolve(options.cwd),
      approvalMode: options.approval ?? current.approvalMode,
      sandboxMode: current.sandboxMode,
      sandboxBackend: current.sandboxBackend,
      allowOutsideWorkspace: current.allowOutsideWorkspace
    })
  })

interface RootOptions {
  cwd: string
  model?: string
  effort?: string
  reasoningEffort?: string
  yes?: boolean
  sandbox?: string
  sandboxBackend?: string
  dangerFullAccess?: boolean
  plain?: boolean
}

interface LoginOptions {
  apiKey?: string | boolean
  chatgpt?: boolean
  deviceCode?: boolean
  issuer: string
  clientId: string
}

async function runChat(prompt: string, options: RootOptions): Promise<void> {
  const store = new ConfigStore()
  const config = resolveRuntimeConfig(await store.loadConfig(), options)
  const workspaceRoot = path.resolve(options.cwd)
  const sessionStore = new SessionStore(store)
  const runner = new AgentRunner({
    authManager: new AuthManager(store),
    config,
    workspaceRoot,
    memoryStore: new MemoryStore(store),
    sessionStore,
    model: options.model,
    approvalMode: options.yes ? 'auto' : config.approvalMode
  })

  if (prompt.trim()) {
    await runner.run(prompt)
    return
  }

  if (!options.plain && process.stdout.isTTY && process.stdin.isTTY) {
    const session = await sessionStore.ensure(workspaceRoot)
    startTui({
      configStore: store,
      config,
      workspaceRoot,
      sessionId: session.id,
      model: options.model,
      approvalMode: options.yes ? 'auto' : config.approvalMode
    })
    return
  }

  await runInteractiveChat(runner)
}

function resolveRuntimeConfig(
  config: NekodexConfig,
  options: {
    dangerFullAccess?: boolean
    effort?: string
    reasoningEffort?: string
    sandbox?: string
    sandboxBackend?: string
  }
): NekodexConfig {
  const reasoningEffort = resolveReasoningEffortOption(options)
  const backendConfig = resolveSandboxBackendOption(options.sandboxBackend)
  const nextConfig = {
    ...config,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(backendConfig ? { sandboxBackend: backendConfig } : {})
  }

  if (options.dangerFullAccess) {
    return { ...nextConfig, sandboxMode: 'danger-full-access' }
  }
  if (!options.sandbox) {
    return nextConfig
  }
  if (!isSandboxMode(options.sandbox)) {
    throw new Error(`Unsupported sandbox mode: ${options.sandbox}`)
  }
  return { ...nextConfig, sandboxMode: options.sandbox }
}

function isSandboxMode(value: string): value is SandboxMode {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access'
}

function resolveSandboxBackendOption(value: string | undefined): SandboxBackend | undefined {
  if (!value) {
    return undefined
  }
  if (!isSandboxBackend(value)) {
    throw new Error(`Unsupported sandbox backend: ${value}`)
  }
  return value
}

function isSandboxBackend(value: string): value is SandboxBackend {
  return value === 'auto' || value === 'node' || value === 'bwrap' || value === 'none'
}

function resolveReasoningEffortOption(options: {
  effort?: string
  reasoningEffort?: string
}): ReasoningEffort | undefined {
  const value = options.reasoningEffort ?? options.effort
  if (!value) {
    return undefined
  }
  if (!isReasoningEffort(value)) {
    throw new Error(`Unsupported reasoning effort: ${value}`)
  }
  return value
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return value === 'none' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
}

async function runInteractiveChat(runner: AgentRunner): Promise<void> {
  const readline = createInterface({ input, output })
  try {
    console.log('\x1b[96mNekodex\x1b[0m interactive chat')
    console.log('\x1b[90mType /exit to quit. Run `nekodex tui` for the full terminal UI.\x1b[0m')
    while (true) {
      const prompt = await readline.question('\x1b[92mnekodex>\x1b[0m ')
      if (prompt.trim() === '/exit') {
        return
      }
      if (prompt.trim()) {
        await runner.run(prompt)
      }
    }
  } finally {
    readline.close()
  }
}

async function askSecret(label: string): Promise<string> {
  const readline = createInterface({ input, output })
  try {
    return await readline.question(`${label}: `)
  } finally {
    readline.close()
  }
}

async function writeStarterFile(filePath: string, content: string): Promise<void> {
  try {
    await fs.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'EEXIST'
    ) {
      return
    }
    throw error
  }
}

try {
  await program.parseAsync(process.argv)
} catch (error) {
  console.error(formatCliError(error))
  process.exitCode = 1
}

function formatCliError(error: unknown): string {
  if (error instanceof NekodexError) {
    return error.message
  }
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
