import { describe, expect, it } from 'vitest'
import {
  buildImageGenerationRequest,
  getDefaultImageOutputPath
} from '../src/tools/image-generation.js'

describe('image generation tool helpers', () => {
  it('builds the OpenAI image generation request body', () => {
    expect(
      buildImageGenerationRequest({
        prompt: 'A clean product mockup',
        outputFormat: 'webp',
        background: 'transparent'
      })
    ).toEqual({
      model: 'gpt-image-2',
      prompt: 'A clean product mockup',
      size: '1024x1024',
      quality: 'medium',
      output_format: 'webp',
      background: 'transparent'
    })
  })

  it('creates a workspace-relative default output path', () => {
    expect(getDefaultImageOutputPath('A clean product mockup!', 'png')).toMatch(
      /^generated-images[\\/]+a-clean-product-mockup-[0-9a-f-]+\.png$/
    )
  })
})
