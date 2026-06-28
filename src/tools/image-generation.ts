import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import axios from 'axios'
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_OUTPUT_DIR,
  DEFAULT_IMAGE_OUTPUT_FORMAT,
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_IMAGE_SIZE,
  DEFAULT_OPENAI_BASE_URL
} from '../constants.js'
import { ToolExecutionError } from '../errors.js'
import type { AgentTool, ToolResult } from './types.js'
import { resolveWorkspacePath } from './path-utils.js'
import { assertCanWritePath, canReadOutsideWorkspace } from './sandbox.js'

const IMAGE_PROMPT_SLUG_LENGTH = 48

interface GenerateImageInput {
  prompt: string
  outputPath?: string
  model?: string
  size?: string
  quality?: string
  outputFormat?: 'png' | 'jpeg' | 'webp'
  background?: 'auto' | 'transparent' | 'opaque'
}

interface ImageGenerationResponse {
  data?: Array<{
    b64_json?: string
    revised_prompt?: string
  }>
}

export const generateImageTool: AgentTool<GenerateImageInput> = {
  name: 'generate_image',
  description: 'Generate an image with OpenAI and save it into the workspace.',
  requiresApproval: true,
  schema: {
    type: 'function',
    name: 'generate_image',
    description: 'Generate an image with OpenAI and save it into the workspace.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Image prompt.' },
        outputPath: {
          type: 'string',
          description: 'Optional workspace-relative output path. Defaults to generated-images/.'
        },
        model: {
          type: 'string',
          description: `Image model. Defaults to ${DEFAULT_IMAGE_MODEL}.`
        },
        size: {
          type: 'string',
          description: `Image size. Defaults to ${DEFAULT_IMAGE_SIZE}.`
        },
        quality: {
          type: 'string',
          description: `Image quality. Defaults to ${DEFAULT_IMAGE_QUALITY}.`
        },
        outputFormat: {
          type: 'string',
          enum: ['png', 'jpeg', 'webp'],
          description: `Output format. Defaults to ${DEFAULT_IMAGE_OUTPUT_FORMAT}.`
        },
        background: {
          type: 'string',
          enum: ['auto', 'transparent', 'opaque'],
          description: 'Background behavior for supported models.'
        }
      },
      required: ['prompt'],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    if (!context.openAiToken) {
      throw new ToolExecutionError('Image generation requires OpenAI auth.')
    }

    const outputFormat = input.outputFormat ?? DEFAULT_IMAGE_OUTPUT_FORMAT
    const requestedOutputPath =
      input.outputPath ?? getDefaultImageOutputPath(input.prompt, outputFormat)
    const outputPath = resolveWorkspacePath(
      context.workspaceRoot,
      requestedOutputPath,
      canReadOutsideWorkspace(context)
    )
    assertCanWritePath(context, outputPath)
    const requestBody = buildImageGenerationRequest(input)
    const baseUrl = (context.openAiBaseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '')

    // ref: https://platform.openai.com/docs/guides/image-generation
    const response = await axios.post<ImageGenerationResponse>(
      `${baseUrl}/images/generations`,
      requestBody,
      {
        headers: {
          Authorization: `Bearer ${context.openAiToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 180_000
      }
    )

    const image = response.data.data?.[0]
    if (!image?.b64_json) {
      throw new ToolExecutionError('Image generation response did not include image data.')
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    const imageBuffer = Buffer.from(image.b64_json, 'base64')
    await fs.writeFile(outputPath, imageBuffer)

    return ok({
      path: path.relative(context.workspaceRoot, outputPath),
      bytesWritten: imageBuffer.byteLength,
      model: requestBody.model,
      size: requestBody.size,
      quality: requestBody.quality,
      revisedPrompt: image.revised_prompt
    })
  }
}

export function buildImageGenerationRequest(input: GenerateImageInput): Record<string, unknown> {
  const outputFormat = input.outputFormat ?? DEFAULT_IMAGE_OUTPUT_FORMAT
  return {
    model: input.model ?? DEFAULT_IMAGE_MODEL,
    prompt: input.prompt,
    size: input.size ?? DEFAULT_IMAGE_SIZE,
    quality: input.quality ?? DEFAULT_IMAGE_QUALITY,
    output_format: outputFormat,
    ...(input.background ? { background: input.background } : {})
  }
}

export function getDefaultImageOutputPath(prompt: string, outputFormat: string): string {
  const slug = slugify(prompt) || 'image'
  return path.join(DEFAULT_IMAGE_OUTPUT_DIR, `${slug}-${randomUUID()}.${outputFormat}`)
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, IMAGE_PROMPT_SLUG_LENGTH)
}

function ok(output: unknown): ToolResult {
  return { ok: true, output }
}
