import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { MAX_SESSION_HISTORY_ITEMS } from '../constants.js'
import type { ConfigStore } from '../config/store.js'

interface SessionFile {
  sessions: Record<string, PersistedSession>
  workspaceIndex?: Record<string, string>
}

export type PersistedTranscriptRole = 'assistant' | 'error' | 'status' | 'tool' | 'user'

export interface PersistedTranscriptItem {
  role: PersistedTranscriptRole
  text: string
}

export interface PersistedSession {
  conversationItems: unknown[]
  id: string
  previousResponseId?: string
  title?: string
  uiTranscript?: PersistedTranscriptItem[]
  updatedAt: string
  workspaceRoot: string
}

type SaveSessionInput = Omit<PersistedSession, 'id' | 'updatedAt' | 'workspaceRoot'> & {
  id?: string
}

const MAX_SESSION_TRANSCRIPT_ITEMS = 200

export class SessionStore {
  private writeChain: Promise<void> = Promise.resolve()

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

  async list(): Promise<PersistedSession[]> {
    const sessions = await this.loadSessionsFile()
    return Object.values(sessions.sessions)
      .map((session) => normalizeSession(session, session.workspaceRoot))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
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

  async save(workspaceRoot: string, session: SaveSessionInput): Promise<string> {
    return this.withWriteLock(async () => {
      const sessions = await this.loadSessionsFile()
      const key = sessionKey(workspaceRoot)
      const id = session.id ?? sessions.workspaceIndex?.[key] ?? createSessionId()
      const existingSession = sessions.sessions[id] ?? sessions.sessions[key]
      sessions.sessions[id] = {
        workspaceRoot: key,
        id,
        previousResponseId: session.previousResponseId,
        title: session.title ?? existingSession?.title,
        conversationItems: trimSessionItems(session.conversationItems),
        uiTranscript: trimTranscriptItems(session.uiTranscript ?? existingSession?.uiTranscript ?? []),
        updatedAt: new Date().toISOString()
      }
      sessions.workspaceIndex = {
        ...sessions.workspaceIndex,
        [key]: id
      }
      delete sessions.sessions[key]
      await this.writeSessionsFile(sessions)
      return id
    })
  }

  async saveTranscript(
    workspaceRoot: string,
    id: string,
    uiTranscript: PersistedTranscriptItem[]
  ): Promise<void> {
    await this.withWriteLock(async () => {
      const sessions = await this.loadSessionsFile()
      const key = sessionKey(workspaceRoot)
      const indexedSessionId = sessions.workspaceIndex?.[key]
      const existingSession =
        sessions.sessions[id] ??
        (indexedSessionId ? sessions.sessions[indexedSessionId] : undefined) ??
        sessions.sessions[key]
      const sessionId = existingSession?.id ?? id

      sessions.sessions[sessionId] = {
        workspaceRoot: key,
        id: sessionId,
        previousResponseId: existingSession?.previousResponseId,
        title: existingSession?.title,
        conversationItems: trimSessionItems(existingSession?.conversationItems ?? []),
        uiTranscript: trimTranscriptItems(uiTranscript),
        updatedAt: new Date().toISOString()
      }
      sessions.workspaceIndex = {
        ...sessions.workspaceIndex,
        [key]: sessionId
      }
      delete sessions.sessions[key]
      await this.writeSessionsFile(sessions)
    })
  }

  async rename(id: string, title: string): Promise<boolean> {
    return this.withWriteLock(async () => {
      const sessions = await this.loadSessionsFile()
      const sessionEntry = findStoredSessionEntry(sessions, id)
      if (!sessionEntry) {
        return false
      }

      sessions.sessions[sessionEntry.key] = {
        ...sessionEntry.session,
        id: sessionEntry.session.id || id,
        title: title.trim() || undefined,
        updatedAt: new Date().toISOString()
      }
      await this.writeSessionsFile(sessions)
      return true
    })
  }

  async remove(id: string): Promise<boolean> {
    return this.withWriteLock(async () => {
      const sessions = await this.loadSessionsFile()
      const sessionEntry = findStoredSessionEntry(sessions, id)
      if (!sessionEntry) {
        return false
      }

      delete sessions.sessions[sessionEntry.key]
      for (const [workspaceRoot, sessionId] of Object.entries(sessions.workspaceIndex ?? {})) {
        if (sessionId === sessionEntry.key || sessionId === sessionEntry.session.id) {
          delete sessions.workspaceIndex?.[workspaceRoot]
        }
      }
      await this.writeSessionsFile(sessions)
      return true
    })
  }

  async clearAll(): Promise<number> {
    return this.withWriteLock(async () => {
      const sessions = await this.loadSessionsFile()
      const count = Object.keys(sessions.sessions).length
      await this.writeSessionsFile({ sessions: {}, workspaceIndex: {} })
      return count
    })
  }

  async clear(workspaceRoot: string): Promise<boolean> {
    return this.withWriteLock(async () => {
      const sessions = await this.loadSessionsFile()
      const key = sessionKey(workspaceRoot)
      const sessionId = sessions.workspaceIndex?.[key]
      const hadSession =
        Boolean(sessionId && sessions.sessions[sessionId]) || Boolean(sessions.sessions[key])
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
    })
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

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(operation, operation)
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}

function trimSessionItems(items: unknown[]): unknown[] {
  return items.slice(-MAX_SESSION_HISTORY_ITEMS)
}

function trimTranscriptItems(items: PersistedTranscriptItem[]): PersistedTranscriptItem[] {
  return items
    .filter(isPersistedTranscriptItem)
    .map((item) => ({
      role: item.role,
      text: item.text
    }))
    .slice(-MAX_SESSION_TRANSCRIPT_ITEMS)
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
    conversationItems: Array.isArray(session.conversationItems) ? session.conversationItems : [],
    id: session.id || createLegacySessionId(workspaceRoot),
    title: typeof session.title === 'string' && session.title.trim() ? session.title : undefined,
    uiTranscript: trimTranscriptItems(session.uiTranscript ?? []),
    workspaceRoot
  }
}

export function transcriptFromSession(session: PersistedSession): PersistedTranscriptItem[] {
  const savedTranscript = trimTranscriptItems(session.uiTranscript ?? [])
  if (savedTranscript.length > 0) {
    return savedTranscript
  }

  return trimTranscriptItems(
    session.conversationItems
      .map((item) => transcriptItemFromHistoryItem(item))
      .filter((item): item is PersistedTranscriptItem => Boolean(item))
  )
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

function findStoredSessionEntry(
  sessions: SessionFile,
  id: string
): { key: string; session: PersistedSession } | null {
  const directSession = sessions.sessions[id]
  if (directSession) {
    return { key: id, session: directSession }
  }

  for (const [key, session] of Object.entries(sessions.sessions)) {
    const normalizedSession = normalizeSession(session, session.workspaceRoot)
    if (normalizedSession.id === id) {
      return { key, session }
    }
  }

  return null
}

function transcriptItemFromHistoryItem(item: unknown): PersistedTranscriptItem | null {
  if (!isRecord(item)) {
    return null
  }

  if (item.type === 'function_call') {
    const toolName = typeof item.name === 'string' ? item.name : 'tool'
    return { role: 'tool', text: `tool: ${toolName}` }
  }

  if (item.type !== 'message') {
    return null
  }

  const text = collectContentText(item.content).trim()
  if (!text) {
    return null
  }

  if (item.role === 'user') {
    return { role: 'user', text }
  }
  if (item.role === 'assistant') {
    return { role: 'assistant', text }
  }

  return null
}

function collectContentText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map((item) => {
      if (typeof item === 'string') {
        return item
      }
      if (isRecord(item) && typeof item.text === 'string') {
        return item.text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function isPersistedTranscriptItem(value: unknown): value is PersistedTranscriptItem {
  return (
    isRecord(value) &&
    isPersistedTranscriptRole(value.role) &&
    typeof value.text === 'string' &&
    value.text.length > 0
  )
}

function isPersistedTranscriptRole(value: unknown): value is PersistedTranscriptRole {
  return (
    value === 'assistant' ||
    value === 'error' ||
    value === 'status' ||
    value === 'tool' ||
    value === 'user'
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
