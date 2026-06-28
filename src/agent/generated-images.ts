import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DEFAULT_IMAGE_OUTPUT_DIR, DEFAULT_IMAGE_OUTPUT_FORMAT } from '../constants.js'
import type { OpenAiResponse, ResponseImageGenerationCall } from '../openai/responses-client.js'

export async function saveResponseImages(
  response: OpenAiResponse,
  workspaceRoot: string
): Promise<string[]> {
  const imageCalls = getImageGenerationCalls(response)
  if (imageCalls.length === 0) {
    return []
  }

  const outputDirectory = path.join(workspaceRoot, DEFAULT_IMAGE_OUTPUT_DIR)
  await fs.mkdir(outputDirectory, { recursive: true })

  const savedPaths: string[] = []
  for (const [index, imageCall] of imageCalls.entries()) {
    if (!imageCall.result) {
      continue
    }

    const fileName = `${response.id}-${index + 1}.${DEFAULT_IMAGE_OUTPUT_FORMAT}`
    const outputPath = path.join(outputDirectory, fileName)
    await fs.writeFile(outputPath, Buffer.from(imageCall.result, 'base64'))
    savedPaths.push(path.relative(workspaceRoot, outputPath))
  }

  return savedPaths
}

function getImageGenerationCalls(response: OpenAiResponse): ResponseImageGenerationCall[] {
  return (response.output ?? []).filter(
    (item): item is ResponseImageGenerationCall =>
      typeof item === 'object' &&
      item !== null &&
      (item as { type?: unknown }).type === 'image_generation_call'
  )
}
