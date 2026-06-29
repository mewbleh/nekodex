import { z } from 'zod'
import {
  DEFAULT_COMPACT_THRESHOLD_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_REASONING_EFFORT
} from '../constants.js'

export const approvalModeSchema = z.enum(['ask', 'auto'])
export type ApprovalMode = z.infer<typeof approvalModeSchema>

export const reasoningEffortSchema = z.enum(['none', 'low', 'medium', 'high', 'xhigh'])
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>

export const sandboxModeSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access'])
export type SandboxMode = z.infer<typeof sandboxModeSchema>

export const sandboxBackendSchema = z.enum(['auto', 'node', 'bwrap', 'none'])
export type SandboxBackend = z.infer<typeof sandboxBackendSchema>

export const openAiHostedToolSchema = z
  .object({
    type: z.string().min(1),
    vectorStoreIds: z.array(z.string().min(1)).optional(),
    container: z.unknown().optional(),
    partialImages: z.number().int().min(0).max(3).optional()
  })
  .passthrough()
export type OpenAiHostedToolConfig = z.infer<typeof openAiHostedToolSchema>

export const mcpServerSchema = z.object({
  serverLabel: z.string().min(1),
  serverUrl: z.string().url().optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  authorizationEnvVar: z.string().min(1).optional(),
  allowedTools: z.array(z.string().min(1)).optional(),
  requireApproval: z.union([z.literal('always'), z.literal('never')]).optional(),
  startupTimeoutSec: z.number().positive().optional(),
  toolTimeoutSec: z.number().positive().optional()
}).refine((server) => Boolean(server.serverUrl || server.command), {
  message: 'MCP server config must include serverUrl/url or command.'
})
export type McpServerConfig = z.infer<typeof mcpServerSchema>

export const contextWindowSchema = z
  .object({
    autoCompact: z.boolean().default(true),
    compactThresholdTokens: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_COMPACT_THRESHOLD_TOKENS)
  })
  .default({})
export type ContextWindowConfig = z.infer<typeof contextWindowSchema>

export const configSchema = z.object({
  model: z.string().min(1).default(DEFAULT_MODEL),
  reasoningEffort: reasoningEffortSchema.default(DEFAULT_REASONING_EFFORT),
  openaiBaseUrl: z.string().url().default(DEFAULT_OPENAI_BASE_URL),
  approvalMode: approvalModeSchema.default('ask'),
  sandboxMode: sandboxModeSchema.default('workspace-write'),
  sandboxBackend: sandboxBackendSchema.default('auto'),
  allowOutsideWorkspace: z.boolean().default(false),
  openAiHostedTools: z.array(openAiHostedToolSchema).default([]),
  mcpServers: z.array(mcpServerSchema).default([]),
  contextWindow: contextWindowSchema
})

export type NekodexConfig = z.infer<typeof configSchema>

export const authModeSchema = z.enum(['api-key', 'chatgpt'])
export type AuthMode = z.infer<typeof authModeSchema>

export const storedAuthSchema = z.object({
  mode: authModeSchema,
  apiKey: z.string().optional(),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  idToken: z.string().optional(),
  issuer: z.string().url().optional(),
  clientId: z.string().optional(),
  accountId: z.string().optional(),
  lastRefreshAt: z.string().datetime().optional()
})

export type StoredAuth = z.infer<typeof storedAuthSchema>
