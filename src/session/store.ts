import { promises as fs } from 'node:fs'
import path from 'node:path'
import { MAX_SESSION_HISTORY_ITEMS } from '../constants.js'
import type { ConfigStore } from '../config/store.js'

interface SessionFile {
  sessions: Record<string, PersistedSession>
}

export interface PersistedSession {
  conversationItems: unknown[]
  previousResponseId?: string
  updatedAt: string
  workspaceRoot: string
}

export class SessionStore {
  constructor(private readonly configStore: ConfigStore) {}

  async load(workspaceRoot: string): Promise<PersistedSession | null> {
    const sessions = await this.loadSessionsFile()
    return sessions.sessions[sessionKey(workspaceRoot)] ?? null
  }

  async save(workspaceRoot: string, session: Omit<PersistedSession, 'updatedAt' | 'workspaceRoot'>): Promise<void> {
    const sessions = await this.loadSessionsFile()
    sessions.sessions[sessionKey(workspaceRoot)] = {
      workspaceRoot: path.resolve(workspaceRoot),
      previousResponseId: session.previousResponseId,
      conversationItems: trimSessionItems(session.conversationItems),
      updatedAt: new Date().toISOString()
    }
    await this.writeSessionsFile(sessions)
  }

  async clear(workspaceRoot: string): Promise<boolean> {
    const sessions = await this.loadSessionsFile()
    const key = sessionKey(workspaceRoot)
    if (!sessions.sessions[key]) {
      return false
    }
    delete sessions.sessions[key]
    await this.writeSessionsFile(sessions)
    return true
  }

  private async loadSessionsFile(): Promise<SessionFile> {
    try {
      const content = await fs.readFile(this.configStore.sessionsPath, 'utf8')
      const parsed = JSON.parse(content) as unknown
      if (isSessionFile(parsed)) {
        return parsed
      }
      return { sessions: {} }
    } catch (error) {
      if (isNotFoundError(error)) {
        return { sessions: {} }
      }
      throw error
    }
  }

  private async writeSessionsFile(sessions: SessionFile): Promise<void> {
    await fs.mkdir(path.dirname(this.configStore.sessionsPath), { recursive: true })
    await fs.writeFile(this.configStore.sessionsPath, `${JSON.stringify(sessions, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    await fs.chmod(this.configStore.sessionsPath, 0o600).catch(() => undefined)
  }
}

function trimSessionItems(items: unknown[]): unknown[] {
  return items.slice(-MAX_SESSION_HISTORY_ITEMS)
}

function sessionKey(workspaceRoot: string): string {
  return path.resolve(workspaceRoot)
}

function isSessionFile(value: unknown): value is SessionFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    'sessions' in value &&
    typeof (value as { sessions?: unknown }).sessions === 'object' &&
    (value as { sessions?: unknown }).sessions !== null
  )
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}
