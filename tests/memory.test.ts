import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../src/config/store.js'
import { MemoryStore } from '../src/memory/store.js'

describe('MemoryStore', () => {
  let homeDir: string
  let memoryStore: MemoryStore

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nekodex-memory-'))
    memoryStore = new MemoryStore(new ConfigStore(homeDir))
  })

  afterEach(async () => {
    await fs.rm(homeDir, { recursive: true, force: true })
  })

  it('adds, searches, and renders memories', async () => {
    const memory = await memoryStore.add({
      title: 'Project style',
      content: 'Use strict TypeScript.',
      tags: ['typescript']
    })

    await expect(memoryStore.search('strict')).resolves.toMatchObject([
      { id: memory.id, title: 'Project style' }
    ])
    await expect(memoryStore.toInstructionBlock()).resolves.toContain('Use strict TypeScript.')
  })

  it('removes memories by id', async () => {
    const memory = await memoryStore.add({ content: 'Temporary note.' })

    await expect(memoryStore.remove(memory.id)).resolves.toBe(true)
    await expect(memoryStore.list()).resolves.toEqual([])
  })
})
