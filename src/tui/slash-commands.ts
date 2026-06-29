export interface SlashCommand {
  aliases?: string[]
  description: string
  name: string
  usage?: string
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'status',
    description: 'show auth, model, context, approval, and sandbox'
  },
  {
    name: 'model',
    description: 'change model for this chat and future launches',
    usage: '/model <name>'
  },
  {
    name: 'effort',
    description: 'change reasoning effort',
    usage: '/effort <none|low|medium|high|xhigh>'
  },
  {
    name: 'skills',
    aliases: ['instructions', 'custom'],
    description: 'show project, personal, and skill instruction files'
  },
  {
    name: 'permissions',
    description: 'show approval and sandbox settings'
  },
  {
    name: 'diff',
    description: 'show git status and diff summary'
  },
  {
    name: 'compact',
    description: 'show context compaction settings'
  },
  {
    name: 'help',
    description: 'show slash commands'
  },
  {
    name: 'clear',
    description: 'clear this TUI transcript'
  },
  {
    name: 'exit',
    aliases: ['quit'],
    description: 'quit Nekodex'
  }
]

export function parseSlashCommand(value: string): string {
  return value.slice(1).trim().split(/\s+/)[0]?.toLowerCase() ?? ''
}

export function parseSlashCommandArguments(value: string): string {
  const commandLine = value.trim()
  if (!commandLine.startsWith('/')) {
    return ''
  }

  const [, ...parts] = commandLine.slice(1).split(/\s+/)
  return parts.join(' ').trim()
}

export function findSlashCommand(value: string): SlashCommand | undefined {
  const command = parseSlashCommand(value)
  return SLASH_COMMANDS.find(
    (entry) => entry.name === command || entry.aliases?.includes(command)
  )
}

export function getSlashCommandSuggestions(value: string, limit = 4): SlashCommand[] {
  if (!value.startsWith('/')) {
    return []
  }

  const command = parseSlashCommand(value)
  return SLASH_COMMANDS.filter(
    (entry) =>
      entry.name.startsWith(command) ||
      entry.aliases?.some((alias) => alias.startsWith(command))
  ).slice(0, limit)
}

export function formatSlashCommandHelp(): string {
  return SLASH_COMMANDS.map((command) => {
    const commandLabel = command.usage ?? `/${command.name}`
    return `${commandLabel}  ${command.description}`
  }).join('\n')
}
