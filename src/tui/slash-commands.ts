export interface SlashCommand {
  aliases?: string[]
  description: string
  name: string
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'status',
    description: 'show auth, model, context, approval, and sandbox'
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
  return SLASH_COMMANDS.map((command) => `/${command.name}  ${command.description}`).join('\n')
}
