import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

export type NekodexPlatform = 'windows' | 'macos' | 'linux' | 'android-termux' | 'android' | 'unknown'

export interface PlatformInfo {
  platform: NekodexPlatform
  nodePlatform: NodeJS.Platform
  arch: string
  isTermux: boolean
  configHome: string
  browserOpeners: Array<{ command: string; args: string[] }>
  notes: string[]
}

export function getPlatformInfo(env: NodeJS.ProcessEnv = process.env): PlatformInfo {
  const nodePlatform = normalizeNodePlatform(env.NEKODEX_FORCE_PLATFORM) ?? process.platform
  const isTermux = isTermuxEnvironment(nodePlatform, env)
  const platform = detectPlatform(nodePlatform, isTermux)
  const configHome = resolveConfigHome(platform, env)

  return {
    platform,
    nodePlatform,
    arch: process.arch,
    isTermux,
    configHome,
    browserOpeners: browserOpenersFor(platform),
    notes: supportNotesFor(platform)
  }
}

export function defaultConfigHome(env: NodeJS.ProcessEnv = process.env): string {
  return getPlatformInfo(env).configHome
}

export function openExternalUrl(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const { browserOpeners } = getPlatformInfo(env)

  for (const opener of browserOpeners) {
    try {
      const child = spawn(opener.command, opener.args.map((arg) => (arg === '{url}' ? url : arg)), {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      child.on('error', () => undefined)
      child.unref()
      return true
    } catch {
      continue
    }
  }

  return false
}

function detectPlatform(nodePlatform: NodeJS.Platform, isTermux: boolean): NekodexPlatform {
  if (isTermux) {
    return 'android-termux'
  }
  if (nodePlatform === 'win32') {
    return 'windows'
  }
  if (nodePlatform === 'darwin') {
    return 'macos'
  }
  if (nodePlatform === 'linux') {
    return 'linux'
  }
  if (nodePlatform === 'android') {
    return 'android'
  }
  return 'unknown'
}

function normalizeNodePlatform(value: string | undefined): NodeJS.Platform | undefined {
  if (!value) {
    return undefined
  }
  if (value === 'windows') {
    return 'win32'
  }
  if (value === 'macos') {
    return 'darwin'
  }
  if (value === 'android-termux') {
    return 'android'
  }
  return value as NodeJS.Platform
}

function isTermuxEnvironment(nodePlatform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (env.NEKODEX_FORCE_PLATFORM === 'android') {
    return false
  }
  return (
    env.NEKODEX_FORCE_PLATFORM === 'android-termux' ||
    Boolean(env.TERMUX_VERSION) ||
    Boolean(env.PREFIX?.includes('/com.termux/')) ||
    nodePlatform === 'android'
  )
}

function resolveConfigHome(platform: NekodexPlatform, env: NodeJS.ProcessEnv): string {
  if (env.NEKODEX_HOME?.trim()) {
    return env.NEKODEX_HOME.trim()
  }

  if (platform === 'windows') {
    return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Nekodex')
  }

  if (platform === 'macos') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Nekodex')
  }

  if (platform === 'linux' || platform === 'android-termux' || platform === 'android') {
    return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'nekodex')
  }

  return path.join(os.homedir(), '.nekodex')
}

function browserOpenersFor(platform: NekodexPlatform): Array<{ command: string; args: string[] }> {
  if (platform === 'windows') {
    return [{ command: 'cmd', args: ['/c', 'start', '""', '{url}'] }]
  }
  if (platform === 'macos') {
    return [{ command: 'open', args: ['{url}'] }]
  }
  if (platform === 'android-termux' || platform === 'android') {
    return [
      { command: 'termux-open-url', args: ['{url}'] },
      { command: 'xdg-open', args: ['{url}'] }
    ]
  }
  if (platform === 'linux') {
    return [{ command: 'xdg-open', args: ['{url}'] }]
  }
  return []
}

function supportNotesFor(platform: NekodexPlatform): string[] {
  if (platform === 'android-termux') {
    return [
      'Use device-code auth when browser callbacks are awkward.',
      'Install termux-api for browser opening: pkg install termux-api.'
    ]
  }
  if (platform === 'linux') {
    return ['Install xdg-utils for browser login auto-open support.']
  }
  if (platform === 'unknown') {
    return ['Unknown platform; set NEKODEX_HOME and prefer device-code auth.']
  }
  return []
}
