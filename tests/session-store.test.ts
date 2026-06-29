import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../src/config/store.js'
import { MAX_SESSION_HISTORY_ITEMS } from '../src/constants.js'
import { SessionStore } from '../src/session/store.js'

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

  it('clears workspace sessions', async () => {
    const workspaceRoot = path.join(homeDir, 'workspace')
    await sessionStore.save(workspaceRoot, { conversationItems: [] })

    await expect(sessionStore.clear(workspaceRoot)).resolves.toBe(true)
    await expect(sessionStore.load(workspaceRoot)).resolves.toBeNull()
  })
})
