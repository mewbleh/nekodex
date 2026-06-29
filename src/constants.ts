export const APP_NAME = 'nekodex'
export const APP_VERSION = '1.0.16'
// ref: https://developers.openai.com/codex/models
export const DEFAULT_MODEL = 'gpt-5.5'
export const DEFAULT_CHATGPT_CODEX_MODEL = 'gpt-5.5'
export const DEFAULT_REASONING_EFFORT = 'medium'
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
export const DEFAULT_AUTH_ISSUER = 'https://auth.openai.com'
export const DEFAULT_LOGIN_PORT = 1455
export const FALLBACK_LOGIN_PORT = 1457
export const DEFAULT_MAX_AGENT_STEPS = 12
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000
export const MAX_FILE_READ_BYTES = 120_000
export const MAX_SEARCH_FILE_BYTES = 1_000_000
export const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000
export const DEFAULT_COMPACT_THRESHOLD_TOKENS = 200_000
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2'
export const DEFAULT_IMAGE_OUTPUT_DIR = 'generated-images'
export const DEFAULT_IMAGE_OUTPUT_FORMAT = 'png'
export const DEFAULT_IMAGE_QUALITY = 'medium'
export const DEFAULT_IMAGE_SIZE = '1024x1024'
export const MAX_SESSION_HISTORY_ITEMS = 200

export const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.next',
  '.turbo',
  '.cache'
])
