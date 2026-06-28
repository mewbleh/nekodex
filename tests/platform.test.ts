import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getPlatformInfo } from '../src/platform.js'

describe('getPlatformInfo', () => {
  it('resolves Windows support details', () => {
    const info = getPlatformInfo({
      NEKODEX_FORCE_PLATFORM: 'windows',
      APPDATA: 'C:\\Users\\mew\\AppData\\Roaming'
    })

    expect(info.platform).toBe('windows')
    expect(info.configHome).toBe(path.join('C:\\Users\\mew\\AppData\\Roaming', 'Nekodex'))
    expect(info.browserOpeners[0]?.command).toBe('cmd')
  })

  it('resolves macOS support details', () => {
    const info = getPlatformInfo({ NEKODEX_FORCE_PLATFORM: 'macos' })

    expect(info.platform).toBe('macos')
    expect(info.configHome).toContain(path.join('Library', 'Application Support', 'Nekodex'))
    expect(info.browserOpeners[0]?.command).toBe('open')
  })

  it('resolves Linux support details', () => {
    const info = getPlatformInfo({
      NEKODEX_FORCE_PLATFORM: 'linux',
      XDG_CONFIG_HOME: '/home/mew/.config'
    })

    expect(info.platform).toBe('linux')
    expect(info.configHome).toBe(path.join('/home/mew/.config', 'nekodex'))
    expect(info.browserOpeners[0]?.command).toBe('xdg-open')
  })

  it('resolves Termux support details', () => {
    const info = getPlatformInfo({
      NEKODEX_FORCE_PLATFORM: 'android-termux',
      PREFIX: '/data/data/com.termux/files/usr'
    })

    expect(info.platform).toBe('android-termux')
    expect(info.browserOpeners.map((opener) => opener.command)).toContain('termux-open-url')
    expect(info.notes.join('\n')).toContain('device-code auth')
  })
})
