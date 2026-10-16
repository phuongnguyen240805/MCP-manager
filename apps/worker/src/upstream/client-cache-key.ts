import type { UpstreamConnection } from '../db/queries/upstreams'

/** Key the reusable transport by the credential actually resolved, not second-resolution timestamps. */
export async function clientCacheKey(
  conn: UpstreamConnection,
  bearer: string | null
): Promise<string> {
  const input = new TextEncoder().encode(JSON.stringify([conn, bearer]))
  const digest = await crypto.subtle.digest('SHA-256', input)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
