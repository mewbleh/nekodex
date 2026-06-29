import { describe, expect, it } from 'vitest'
import {
  findSlashCommand,
  formatSlashCommandHelp,
  getSlashCommandSuggestions,
  parseSlashCommand,
  parseSlashCommandArguments
} from '../src/tui/slash-commands.js'

describe('slash commands', () => {
  it('parses slash command names', () => {
    expect(parseSlashCommand('/status now')).toBe('status')
  })

  it('parses slash command arguments', () => {
    expect(parseSlashCommandArguments('/model gpt-5.4-mini')).toBe('gpt-5.4-mini')
  })

  it('finds commands by name and alias', () => {
    expect(findSlashCommand('/status')?.name).toBe('status')
    expect(findSlashCommand('/quit')?.name).toBe('exit')
    expect(findSlashCommand('/skills')?.name).toBe('skills')
    expect(findSlashCommand('/instructions')?.name).toBe('skills')
    expect(findSlashCommand('/custom')?.name).toBe('skills')
  })

  it('suggests commands from partial input', () => {
    expect(getSlashCommandSuggestions('/st').map((command) => command.name)).toEqual(['status'])
    expect(getSlashCommandSuggestions('/mo').map((command) => command.name)).toEqual(['model'])
  })

  it('formats help from the command table', () => {
    expect(formatSlashCommandHelp()).toContain('/status')
    expect(formatSlashCommandHelp()).toContain('/model <name>')
    expect(formatSlashCommandHelp()).toContain('/skills')
    expect(formatSlashCommandHelp()).toContain('/exit')
  })
})
