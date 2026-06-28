export const APP_NAME = 'nekodex'
export const DEFAULT_MODEL = 'gpt-5'
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_AUTH_ISSUER = 'https://auth.openai.com'
export const DEFAULT_LOGIN_PORT = 1455
export const FALLBACK_LOGIN_PORT = 1457
export const DEFAULT_MAX_AGENT_STEPS = 12
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
export const MAX_FILE_READ_BYTES = 120_000
export const MAX_SEARCH_FILE_BYTES = 1_000_000
export const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000

export const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.next',
  '.turbo',
  '.cache'
])
