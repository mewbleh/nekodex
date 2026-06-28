import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveResponseImages } from '../src/agent/generated-images.js'

describe('saveResponseImages', () => {
  let workspaceRoot: string

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nekodex-images-'))
  })

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true })
  })

  it('saves hosted image generation outputs into the workspace', async () => {
    const savedPaths = await saveResponseImages(
      {
        id: 'resp_123',
        output: [
          {
            type: 'image_generation_call',
            result: Buffer.from('image-bytes').toString('base64')
          }
        ]
      },
      workspaceRoot
    )

    expect(savedPaths).toEqual([path.join('generated-images', 'resp_123-1.png')])
    await expect(fs.readFile(path.join(workspaceRoot, savedPaths[0] ?? ''))).resolves.toEqual(
      Buffer.from('image-bytes')
    )
  })
})
