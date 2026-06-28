export function readJwtClaims(token: string): Record<string, unknown> | null {
  const [, payload] = token.split('.')
  if (!payload) {
    return null
  }

  try {
    const decoded = Buffer.from(toBase64(payload), 'base64').toString('utf8')
    return JSON.parse(decoded) as Record<string, unknown>
  } catch {
    return null
  }
}

export function readJwtExpirationMs(token: string): number | null {
  const claims = readJwtClaims(token)
  const expiresAt = claims?.exp
  if (typeof expiresAt !== 'number') {
    return null
  }
  return expiresAt * 1000
}

export function readOpenAiAuthClaims(token: string): Record<string, unknown> {
  const claims = readJwtClaims(token)
  const authClaims = claims?.['https://api.openai.com/auth']
  if (!authClaims || typeof authClaims !== 'object' || Array.isArray(authClaims)) {
    return {}
  }
  return authClaims as Record<string, unknown>
}

export function readJwtScopes(token: string): string[] {
  const claims = readJwtClaims(token)
  const scope = claims?.scope ?? claims?.scp

  if (typeof scope === 'string') {
    return scope.split(/\s+/).filter(Boolean)
  }

  if (Array.isArray(scope)) {
    return scope.filter((value): value is string => typeof value === 'string')
  }

  return []
}

function toBase64(base64Url: string): string {
  const padded = base64Url.padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), '=')
  return padded.replaceAll('-', '+').replaceAll('_', '/')
}
