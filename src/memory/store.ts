import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { z } from 'zod'
import type { ConfigStore } from '../config/store.js'

const memorySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
})

const memoryFileSchema = z.object({
  memories: z.array(memorySchema).default([])
})

export type MemoryRecord = z.infer<typeof memorySchema>

export class MemoryStore {
  constructor(private readonly configStore: ConfigStore) {}

  async list(): Promise<MemoryRecord[]> {
    return (await this.load()).memories
  }

  async add(input: { title?: string; content: string; tags?: string[] }): Promise<MemoryRecord> {
    const now = new Date().toISOString()
    const memory: MemoryRecord = {
      id: randomUUID(),
      title: input.title?.trim() || summarizeTitle(input.content),
      content: input.content.trim(),
      tags: normalizeTags(input.tags ?? []),
      createdAt: now,
      updatedAt: now
    }

    const file = await this.load()
    file.memories.push(memory)
    await this.save(file.memories)
    return memory
  }

  async remove(id: string): Promise<boolean> {
    const file = await this.load()
    const nextMemories = file.memories.filter((memory) => memory.id !== id)
    await this.save(nextMemories)
    return nextMemories.length !== file.memories.length
  }

  async clear(): Promise<void> {
    await this.save([])
  }

  async search(query: string): Promise<MemoryRecord[]> {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) {
      return []
    }

    return (await this.list()).filter((memory) => {
      const haystack = [memory.title, memory.content, ...memory.tags].join('\n').toLowerCase()
      return haystack.includes(normalizedQuery)
    })
  }

  async toInstructionBlock(): Promise<string> {
    const memories = await this.list()
    if (memories.length === 0) {
      return ''
    }

    const renderedMemories = memories
      .map((memory) => {
        const tags = memory.tags.length > 0 ? ` [${memory.tags.join(', ')}]` : ''
        return `- ${memory.title}${tags}: ${memory.content}`
      })
      .join('\n')

    return `Persistent user/project memories:\n${renderedMemories}`
  }

  private async load(): Promise<{ memories: MemoryRecord[] }> {
    try {
      const content = await fs.readFile(this.configStore.memoryPath, 'utf8')
      return memoryFileSchema.parse(JSON.parse(content) as unknown)
    } catch (error) {
      if (isNotFoundError(error)) {
        return { memories: [] }
      }
      throw error
    }
  }

  private async save(memories: MemoryRecord[]): Promise<void> {
    await fs.mkdir(this.configStore.homeDir, { recursive: true })
    await fs.writeFile(
      this.configStore.memoryPath,
      `${JSON.stringify({ memories }, null, 2)}\n`,
      'utf8'
    )
  }
}

function summarizeTitle(content: string): string {
  const firstLine = content.trim().split(/\r?\n/, 1)[0] ?? 'Memory'
  return firstLine.length <= 60 ? firstLine : `${firstLine.slice(0, 57)}...`
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))]
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}
