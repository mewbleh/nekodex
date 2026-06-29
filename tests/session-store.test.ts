import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../src/config/store.js'
import { MAX_SESSION_HISTORY_ITEMS } from '../src/constants.js'
import { SessionStore, transcriptFromSession } from '../src/session/store.js'

describe('SessionStore', () => {
  let homeDir: string
  let sessionStore: SessionStore

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nekodex-session-'))
    sessionStore = new SessionStore(new ConfigStore(homeDir))
  })

  afterEach(async () => {
    await fs.rm(homeDir, { recursive: true, force: true })
  })

  it('saves and loads workspace sessions', async () => {
    const workspaceRoot = path.join(homeDir, 'workspace')

    await sessionStore.save(workspaceRoot, {
      previousResponseId: 'resp-123',
      conversationItems: [{ type: 'message', role: 'user', content: [] }]
    })

    await expect(sessionStore.load(workspaceRoot)).resolves.toMatchObject({
      id: expect.any(String),
      previousResponseId: 'resp-123',
      workspaceRoot: path.resolve(workspaceRoot),
      conversationItems: [{ type: 'message', role: 'user', content: [] }]
    })
  })

  it('loads sessions by id for resume', async () => {
    const workspaceRoot = path.join(homeDir, 'workspace')
    const id = await sessionStore.save(workspaceRoot, { conversationItems: [] })

    await expect(sessionStore.loadById(id)).resolves.toMatchObject({
      id,
      workspaceRoot: path.resolve(workspaceRoot)
    })
  })

  it('lists, renames, and removes sessions', async () => {
    const firstWorkspaceRoot = path.join(homeDir, 'workspace-one')
    const secondWorkspaceRoot = path.join(homeDir, 'workspace-two')
    const firstId = await sessionStore.save(firstWorkspaceRoot, { conversationItems: [] })
    const secondId = await sessionStore.save(secondWorkspaceRoot, { conversationItems: [] })

    await expect(sessionStore.rename(firstId, 'First project')).resolves.toBe(true)
    await expect(sessionStore.rename('missing', 'Missing')).resolves.toBe(false)

    const sessions = await sessionStore.list()
    expect(sessions.map((session) => session.id).sort()).toEqual([firstId, secondId].sort())
    expect((await sessionStore.loadById(firstId))?.title).toBe('First project')

    await expect(sessionStore.remove(secondId)).resolves.toBe(true)
    await expect(sessionStore.remove('missing')).resolves.toBe(false)
    await expect(sessionStore.loadById(secondId)).resolves.toBeNull()
  })

  it('clears every saved session', async () => {
    await sessionStore.save(path.join(homeDir, 'workspace-one'), { conversationItems: [] })
    await sessionStore.save(path.join(homeDir, 'workspace-two'), { conversationItems: [] })

    await expect(sessionStore.clearAll()).resolves.toBe(2)
    await expect(sessionStore.list()).resolves.toEqual([])
  })

  it('ensures a workspace has a session id', async () => {
    const workspaceRoot = path.join(homeDir, 'workspace')

    const session = await sessionStore.ensure(workspaceRoot)

    expect(session.id).toMatch(/^[a-f0-9]{12}$/)
    await expect(sessionStore.loadById(session.id)).resolves.toMatchObject({
      workspaceRoot: path.resolve(workspaceRoot)
    })
  })

  it('trims long session histories', async () => {
    const workspaceRoot = path.join(homeDir, 'workspace')
    const conversationItems = Array.from({ length: MAX_SESSION_HISTORY_ITEMS + 5 }, (_, index) => ({
      index
    }))

    await sessionStore.save(workspaceRoot, { conversationItems })

    const session = await sessionStore.load(workspaceRoot)
    expect(session?.conversationItems).toHaveLength(MAX_SESSION_HISTORY_ITEMS)
    expect(session?.conversationItems[0]).toEqual({ index: 5 })
  })

  it('persists visible TUI transcript content for resume', async () => {
    const workspaceRoot = path.join(homeDir, 'workspace')
    const session = await sessionStore.ensure(workspaceRoot)

    await sessionStore.saveTranscript(workspaceRoot, session.id, [
      { role: 'user', text: 'make a snake game' },
      { role: 'assistant', text: 'Created script.js.' }
    ])

    await expect(sessionStore.loadById(session.id)).resolves.toMatchObject({
      uiTranscript: [
        { role: 'user', text: 'make a snake game' },
        { role: 'assistant', text: 'Created script.js.' }
      ]
    })
  })

  it('keeps visible transcript content when conversation history is saved', async () => {
    const workspaceRoot = path.join(homeDir, 'workspace')
    const id = await sessionStore.save(workspaceRoot, {
      conversationItems: [],
      uiTranscript: [{ role: 'assistant', text: 'hello' }]
    })

    await sessionStore.save(workspaceRoot, {
      id,
      conversationItems: [{ type: 'message', role: 'user', content: [] }]
    })

    const session = await sessionStore.loadById(id)
    expect(session?.uiTranscript).toEqual([{ role: 'assistant', text: 'hello' }])
  })

  it('preserves transcript and conversation content across overlapping writes', async () => {
    const workspaceRoot = path.join(homeDir, 'workspace')
    const session = await sessionStore.ensure(workspaceRoot)
    const conversationItems = [{ type: 'message', role: 'user', content: [] }]
    const uiTranscript = [{ role: 'user' as const, text: 'hello' }]

    await Promise.all([
      sessionStore.saveTranscript(workspaceRoot, session.id, uiTranscript),
      sessionStore.save(workspaceRoot, {
        id: session.id,
        previousResponseId: 'resp-456',
        conversationItems
      })
    ])

    const savedSession = await sessionStore.loadById(session.id)
    expect(savedSession?.conversationItems).toEqual(conversationItems)
    expect(savedSession?.uiTranscript).toEqual(uiTranscript)
    expect(savedSession?.previousResponseId).toBe('resp-456')
  })

  it('reconstructs a transcript from storeless conversation history', () => {
    const transcript = transcriptFromSession({
      id: 'abc123',
      workspaceRoot: homeDir,
      updatedAt: new Date().toISOString(),
      conversationItems: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello' }]
        },
        {
          type: 'function_call',
          name: 'list_files'
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hi there' }]
        }
      ]
    })

    expect(transcript).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'tool', text: 'tool: list_files' },
      { role: 'assistant', text: 'hi there' }
    ])
  })

  it('clears workspace sessions', async () => {
    const workspaceRoot = path.join(homeDir, 'workspace')
    await sessionStore.save(workspaceRoot, { conversationItems: [] })

    await expect(sessionStore.clear(workspaceRoot)).resolves.toBe(true)
    await expect(sessionStore.load(workspaceRoot)).resolves.toBeNull()
  })
})
