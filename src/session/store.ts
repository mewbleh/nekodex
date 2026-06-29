import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { MAX_SESSION_HISTORY_ITEMS } from '../constants.js'
import type { ConfigStore } from '../config/store.js'

interface SessionFile {
  sessions: Record<string, PersistedSession>
  workspaceIndex?: Record<string, string>
}

export interface PersistedSession {
  conversationItems: unknown[]
  id: string
  previousResponseId?: string
  updatedAt: string
  workspaceRoot: string
}

export class SessionStore {
  constructor(private readonly configStore: ConfigStore) {}

  async load(workspaceRoot: string): Promise<PersistedSession | null> {
    const sessions = await this.loadSessionsFile()
    const key = sessionKey(workspaceRoot)
    const indexedSessionId = sessions.workspaceIndex?.[key]
    if (indexedSessionId && sessions.sessions[indexedSessionId]) {
      return normalizeSession(sessions.sessions[indexedSessionId], key)
    }

    const legacySession = sessions.sessions[key]
    return legacySession ? normalizeSession(legacySession, key) : null
  }

  async loadById(id: string): Promise<PersistedSession | null> {
    const sessions = await this.loadSessionsFile()
    const directSession = sessions.sessions[id]
    if (directSession) {
      return normalizeSession(directSession, directSession.workspaceRoot)
    }

    for (const session of Object.values(sessions.sessions)) {
      const normalizedSession = normalizeSession(session, session.workspaceRoot)
      if (normalizedSession.id === id) {
        return normalizedSession
      }
    }

    return null
  }

  async ensure(workspaceRoot: string): Promise<PersistedSession> {
    const existingSession = await this.load(workspaceRoot)
    if (existingSession) {
      return existingSession
    }

    const id = createSessionId()
    await this.save(workspaceRoot, { conversationItems: [], id })
    const createdSession = await this.loadById(id)
    if (!createdSession) {
      throw new Error(`Could not create session ${id}.`)
    }
    return createdSession
  }

  async save(
    workspaceRoot: string,
    session: Omit<PersistedSession, 'id' | 'updatedAt' | 'workspaceRoot'> & { id?: string }
  ): Promise<string> {
    const sessions = await this.loadSessionsFile()
    const key = sessionKey(workspaceRoot)
    const id = session.id ?? sessions.workspaceIndex?.[key] ?? createSessionId()
    sessions.sessions[id] = {
      workspaceRoot: key,
      id,
      previousResponseId: session.previousResponseId,
      conversationItems: trimSessionItems(session.conversationItems),
      updatedAt: new Date().toISOString()
    }
    sessions.workspaceIndex = {
      ...sessions.workspaceIndex,
      [key]: id
    }
    delete sessions.sessions[key]
    await this.writeSessionsFile(sessions)
    return id
  }

  async clear(workspaceRoot: string): Promise<boolean> {
    const sessions = await this.loadSessionsFile()
    const key = sessionKey(workspaceRoot)
    const sessionId = sessions.workspaceIndex?.[key]
    const hadSession = Boolean(sessionId && sessions.sessions[sessionId]) || Boolean(sessions.sessions[key])
    if (!hadSession) {
      return false
    }
    if (sessionId) {
      delete sessions.sessions[sessionId]
      delete sessions.workspaceIndex?.[key]
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
        return {
          sessions: parsed.sessions,
          workspaceIndex: parsed.workspaceIndex ?? {}
        }
      }
      return { sessions: {}, workspaceIndex: {} }
    } catch (error) {
      if (isNotFoundError(error)) {
        return { sessions: {}, workspaceIndex: {} }
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

function createSessionId(): string {
  return randomBytes(6).toString('hex')
}

function normalizeSession(session: PersistedSession, fallbackWorkspaceRoot: string): PersistedSession {
  const workspaceRoot = path.resolve(session.workspaceRoot || fallbackWorkspaceRoot)
  return {
    ...session,
    id: session.id || createLegacySessionId(workspaceRoot),
    workspaceRoot
  }
}

function createLegacySessionId(workspaceRoot: string): string {
  return Buffer.from(path.resolve(workspaceRoot)).toString('base64url').slice(0, 12)
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
