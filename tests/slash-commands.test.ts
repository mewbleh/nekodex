import { describe, expect, it } from 'vitest'
import {
  findSlashCommand,
  formatSlashCommandHelp,
  getSlashCommandSuggestions,
  parseSlashCommand
} from '../src/tui/slash-commands.js'

describe('slash commands', () => {
  it('parses slash command names', () => {
    expect(parseSlashCommand('/status now')).toBe('status')
  })

  it('finds commands by name and alias', () => {
    expect(findSlashCommand('/status')?.name).toBe('status')
    expect(findSlashCommand('/quit')?.name).toBe('exit')
  })

  it('suggests commands from partial input', () => {
    expect(getSlashCommandSuggestions('/st').map((command) => command.name)).toEqual(['status'])
  })

  it('formats help from the command table', () => {
    expect(formatSlashCommandHelp()).toContain('/status')
    expect(formatSlashCommandHelp()).toContain('/exit')
  })
})
