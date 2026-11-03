/**
 * Origin comparison shared by `requireCsrf` and the `/collab/:docId`
 * WS upgrade. In prod the rule is strict: the Origin header must
 * equal `env.PUBLIC_BASE_URL` exactly. In local dev that's too strict:
 * Vite serves the SPA from `:5173` and proxies to wrangler on `:8787`,
 * but the browser's `Origin` header carries `:5173` while
 * `PUBLIC_BASE_URL` is `:8787`. We allow any `https?://localhost:*`
 * Origin when `PUBLIC_BASE_URL` itself is a localhost URL — i.e.,
 * only in dev. Production deployments never have a localhost
 * `PUBLIC_BASE_URL`, so the prod check stays byte-exact.
 */

export function isAllowedOrigin(origin: string | null, publicBaseUrl: string): boolean {
  if (!origin) return false
  if (origin === publicBaseUrl) return true
  if (!isLocalhostUrl(publicBaseUrl)) return false
  return isLocalhostUrl(origin)
}

/**
 * Exact origin from a comma-separated allowlist. The candidate must be
 * `scheme://host[:port]` with no path, so it cannot carry a redirect target.
 */
export function listedOrigin(
  candidate: string | null | undefined,
  allowlist: string | undefined
): string | null {
  if (!candidate) return null
  const trimmed = candidate.trim()
  let origin: string
  try {
    const url = new URL(trimmed)
    if (url.origin !== trimmed) return null
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    origin = url.origin
  } catch {
    return null
  }
  for (const part of (allowlist ?? '').split(',')) {
    if (part.trim() === origin) return origin
  }
  return null
}

/**
 * Gateway OAuth return origin. An explicit `return_origin` query wins and
 * is not replaced by `Origin` when it fails the allowlist.
 */
export function gatewayReturnOrigin(req: Request, allowlist: string | undefined): string | null {
  const fromQuery = new URL(req.url).searchParams.get('return_origin')
  if (fromQuery !== null) return listedOrigin(fromQuery, allowlist)
  return listedOrigin(req.headers.get('origin'), allowlist)
}

function isLocalhostUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  } catch {
    return false
  }
}
