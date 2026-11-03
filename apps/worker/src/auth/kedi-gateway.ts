/**
 * Trusted-gateway assertions for `/api/*`.
 *
 * The Kedi Nest control plane authenticates the human and calls ctxlayer
 * with a short-lived JWT (`Authorization: Bearer`). ctxlayer stays the
 * data plane: it checks the signature, audience, tenant allowlist, and
 * replay, then maps (issuer, subject) onto a local user. It does not
 * mint a session cookie, so the cookie CSRF check does not apply.
 *
 * The mode is off unless issuer, audience, public JWK, and tenant
 * allowlist are all set. A request with no bearer never enters this
 * path. A request that presents a bearer while the mode is on is either
 * a gateway call or a 401 — it does not fall through to the cookie, so a
 * bad assertion cannot ride a browser session.
 */

import type { Env } from '../env'
import { b64urlDecode } from '../util/base64url'

/** API assertions. Nest mints ~60s tokens; anything longer than this is rejected. */
export const GATEWAY_MAX_LIFETIME_SECONDS = 120
/**
 * Collab tickets. A browser cannot set `Authorization` on `new WebSocket()`,
 * so the ticket rides the query string or `Sec-WebSocket-Protocol`. It is
 * shorter than an API assertion because it is handed to the page.
 */
export const COLLAB_TICKET_MAX_LIFETIME_SECONDS = 60
/** Subprotocol Nest offers alongside the raw ticket JWT. Echo this, not the JWT. */
export const COLLAB_TICKET_PROTOCOL = 'ctxlayer.kedi-ticket'
/** Small skew so a token minted on a slightly fast clock still verifies. */
export const GATEWAY_CLOCK_SKEW_SECONDS = 30
const MAX_CLAIM_CHARS = 256

export interface GatewayClaims {
  iss: string
  aud: string
  sub: string
  tid: string
  oid: string | null
  /** Display only. Never a join key. */
  name: string | null
  /** Display only. Never a join key. */
  email: string | null
  hubRole: 'member' | 'admin'
  jti: string
  rid: string
  iat: number
  exp: number
}

/** Stored on the OAuth verifier row when `start` was a gateway call. */
export interface GatewayOAuthBind {
  tenantId: string
  returnOrigin: string
}

export interface GatewayConfig {
  issuer: string
  audience: string
  publicJwk: string
  allowedTenants: Set<string>
}

export type GatewayDecision =
  | { kind: 'skip' }
  | { kind: 'reject'; reason: string }
  | { kind: 'ok'; claims: GatewayClaims }

interface PublicJwk {
  kty?: string
  crv?: string
  x?: string
  y?: string
  kid?: string
  alg?: string
  use?: string
}

const decisionCache = new WeakMap<Request, Promise<GatewayDecision>>()

export function readGatewayConfig(env: Env): GatewayConfig | null {
  const issuer = env.KEDI_GATEWAY_ISSUER?.trim() ?? ''
  const audience = env.KEDI_GATEWAY_AUDIENCE?.trim() ?? ''
  const publicJwk = env.KEDI_GATEWAY_PUBLIC_JWK?.trim() ?? ''
  const tenantsRaw = env.KEDI_GATEWAY_ALLOWED_TENANTS?.trim() ?? ''
  if (!issuer || !audience || !publicJwk || !tenantsRaw) return null
  const allowedTenants = new Set(
    tenantsRaw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
  )
  if (allowedTenants.size === 0) return null
  return { issuer, audience, publicJwk, allowedTenants }
}

/** Bearer token, or null when the header is absent / not Bearer. */
export function readBearer(req: Request): string | null {
  const header = req.headers.get('authorization')
  if (!header) return null
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match?.[1] ?? null
}

/**
 * Classify this request. Cached on the Request so CSRF and requireUser
 * share one verification. `skip` means "not a gateway call" (mode off,
 * or no bearer). `reject` means a bearer was presented and failed.
 */
export function decideGateway(
  req: Request,
  env: Env,
  now: number = Math.floor(Date.now() / 1000)
): Promise<GatewayDecision> {
  const cached = decisionCache.get(req)
  if (cached) return cached
  const pending = decideUncached(req, env, now)
  decisionCache.set(req, pending)
  return pending
}

async function decideUncached(req: Request, env: Env, now: number): Promise<GatewayDecision> {
  const config = readGatewayConfig(env)
  if (!config) return { kind: 'skip' }
  const token = readBearer(req)
  if (!token) return { kind: 'skip' }
  const verified = await verifyGatewayAssertion(token, config, now)
  if (!verified.ok) return { kind: 'reject', reason: verified.reason }
  return { kind: 'ok', claims: verified.claims }
}

type VerifyResult = { ok: true; claims: GatewayClaims } | { ok: false; reason: string }

export async function verifyGatewayAssertion(
  token: string,
  config: GatewayConfig,
  now: number,
  maxLifetimeSeconds: number = GATEWAY_MAX_LIFETIME_SECONDS
): Promise<VerifyResult> {
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  const [headerB64, payloadB64, sigB64] = parts
  if (!headerB64 || !payloadB64 || !sigB64) return { ok: false, reason: 'malformed' }

  let header: { alg?: unknown; kid?: unknown; typ?: unknown; crit?: unknown }
  let payload: Record<string, unknown>
  try {
    header = decodeJson(headerB64)
    payload = decodeJson(payloadB64)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (header.crit !== undefined) return { ok: false, reason: 'bad_alg' }
  if (header.typ !== undefined && header.typ !== 'JWT') return { ok: false, reason: 'malformed' }
  if (header.alg !== 'ES256' && header.alg !== 'EdDSA') return { ok: false, reason: 'bad_alg' }
  if (typeof header.kid !== 'string' || !header.kid) return { ok: false, reason: 'bad_alg' }

  // Signature before claims so an unsigned payload cannot choose the
  // reject reason (or skip the cryptographic check via a cheap claim miss).
  const key = await findVerifyKey(config.publicJwk, header.kid, header.alg)
  if (!key.ok) return key

  let valid = false
  try {
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    const sig = b64urlDecode(sigB64)
    valid = await crypto.subtle.verify(key.algorithm, key.cryptoKey, sig, data)
  } catch {
    return { ok: false, reason: 'bad_signature' }
  }
  if (!valid) return { ok: false, reason: 'bad_signature' }

  return readClaims(payload, config, now, maxLifetimeSeconds)
}

/**
 * Record `jti` until the assertion can no longer be inside its lifetime.
 * KV's minimum TTL is 60s, which still covers a token of at most 120s.
 * Returns `replay` when this jti was already stored.
 */
const jtiOnce = new WeakMap<Request, Promise<'ok' | 'replay' | 'replay_store'>>()

export async function consumeGatewayJti(
  env: Env,
  claims: GatewayClaims,
  now: number = Math.floor(Date.now() / 1000),
  req?: Request
): Promise<'ok' | 'replay' | 'replay_store'> {
  // Hono runs every `use('*')` mounted on the same prefix, so requireUser
  // can see one Request twice. The second call must not look like a replay.
  if (req) {
    const cached = jtiOnce.get(req)
    if (cached) return cached
    const pending = consumeGatewayJtiStored(env, claims, now)
    jtiOnce.set(req, pending)
    return pending
  }
  return consumeGatewayJtiStored(env, claims, now)
}

async function consumeGatewayJtiStored(
  env: Env,
  claims: GatewayClaims,
  now: number
): Promise<'ok' | 'replay' | 'replay_store'> {
  const digest = await sha256Hex(`${claims.iss}\n${claims.jti}`)
  const key = `kedi-gw:jti:${digest}`
  try {
    const existing = await env.OAUTH_KV.get(key)
    if (existing !== null) return 'replay'
    const ttl = Math.max(
      60,
      Math.min(600, Math.ceil(claims.exp - now + GATEWAY_CLOCK_SKEW_SECONDS))
    )
    await env.OAUTH_KV.put(key, '1', { expirationTtl: ttl })
    return 'ok'
  } catch (err) {
    console.error('[kedi-gateway] jti store failed', err instanceof Error ? err.name : 'error')
    return 'replay_store'
  }
}

/** Printable correlation id. Unsigned payloads must not reach this. */
export function safeRid(rid: string): string {
  const clean = rid.replace(/[^\x20-\x7E]/g, '').slice(0, 128)
  return clean || '-'
}

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

export interface CollabTicket {
  token: string
  /** Set when the ticket arrived as a subprotocol. Echo this on the 101, never the JWT. */
  echoProtocol: string | null
}

/**
 * A collab ticket is the same ES256 assertion, carried where a browser can
 * put it. Query `ticket` or a `Sec-WebSocket-Protocol` entry that is a JWT.
 * Offer `ctxlayer.kedi-ticket` as well so the 101 can echo that name.
 * A present-but-malformed ticket does not fall through to the cookie.
 */
export function readCollabTicket(req: Request): {
  attempted: boolean
  ticket: CollabTicket | null
} {
  const query = new URL(req.url).searchParams.get('ticket')
  const protocols = (req.headers.get('sec-websocket-protocol') ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  const fromProtocol = protocols.find((part) => JWT_RE.test(part)) ?? null
  const attempted = query !== null || fromProtocol !== null
  if (!attempted) return { attempted: false, ticket: null }
  const queryOk = query !== null && JWT_RE.test(query)
  if (query !== null && !queryOk) return { attempted: true, ticket: null }
  if (queryOk && fromProtocol && query !== fromProtocol) return { attempted: true, ticket: null }
  const token = queryOk ? query : fromProtocol
  if (!token) return { attempted: true, ticket: null }
  const echoProtocol = fromProtocol
    ? protocols.includes(COLLAB_TICKET_PROTOCOL)
      ? COLLAB_TICKET_PROTOCOL
      : fromProtocol
    : null
  return { attempted: true, ticket: { token, echoProtocol } }
}

function readClaims(
  payload: Record<string, unknown>,
  config: GatewayConfig,
  now: number,
  maxLifetimeSeconds: number
): { ok: true; claims: GatewayClaims } | { ok: false; reason: string } {
  if (payload.iss !== config.issuer) return { ok: false, reason: 'bad_iss' }
  if (!audienceMatches(payload.aud, config.audience)) return { ok: false, reason: 'bad_aud' }

  const sub = boundedString(payload.sub)
  const tid = boundedString(payload.tid)
  const jti = boundedString(payload.jti)
  const rid = boundedString(payload.rid)
  if (!sub || !tid || !jti || !rid) return { ok: false, reason: 'bad_claims' }
  const name = optionalBounded(payload.name)
  const email = optionalBounded(payload.email)
  if (name === 'invalid' || email === 'invalid') return { ok: false, reason: 'bad_claims' }
  if (email && !isDisplayEmail(email)) return { ok: false, reason: 'bad_claims' }
  if (payload.hub_role !== 'member' && payload.hub_role !== 'admin') {
    return { ok: false, reason: 'bad_claims' }
  }
  let oid: string | null = null
  if (payload.oid !== undefined && payload.oid !== null) {
    oid = boundedString(payload.oid)
    if (!oid) return { ok: false, reason: 'bad_claims' }
  }
  if (!config.allowedTenants.has(tid)) return { ok: false, reason: 'tenant' }

  const iat = payload.iat
  const exp = payload.exp
  if (typeof iat !== 'number' || typeof exp !== 'number') return { ok: false, reason: 'bad_claims' }
  if (!Number.isFinite(iat) || !Number.isFinite(exp)) return { ok: false, reason: 'bad_claims' }
  if (exp < iat || exp - iat > maxLifetimeSeconds) {
    return { ok: false, reason: 'lifetime' }
  }
  if (iat > now + GATEWAY_CLOCK_SKEW_SECONDS) return { ok: false, reason: 'bad_iat' }
  if (exp < now - GATEWAY_CLOCK_SKEW_SECONDS) return { ok: false, reason: 'expired' }
  if (typeof payload.nbf === 'number' && payload.nbf > now + GATEWAY_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'bad_nbf' }
  }

  return {
    ok: true,
    claims: {
      iss: config.issuer,
      aud: config.audience,
      sub,
      tid,
      oid,
      name,
      email,
      hubRole: payload.hub_role,
      jti,
      rid,
      iat,
      exp
    }
  }
}

function audienceMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === 'string') return aud === expected
  if (!Array.isArray(aud)) return false
  return aud.some((entry) => entry === expected)
}

/** Absent claim, a bounded string, or `invalid` when the value is the wrong shape. */
function optionalBounded(value: unknown): string | null | 'invalid' {
  if (value === undefined || value === null) return null
  return boundedString(value) ?? 'invalid'
}

/** Display address only. Not looked up against `users.email`. */
function isDisplayEmail(value: string): boolean {
  const at = value.indexOf('@')
  return at > 0 && at === value.lastIndexOf('@') && at < value.length - 1
}

/** Exact, non-empty, no surrounding space, no control chars, bounded. */
function boundedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value.length === 0 || value.length > MAX_CLAIM_CHARS) return null
  if (value !== value.trim()) return null
  if (hasControlChar(value)) return null
  return value
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

type VerifyAlgorithm = Parameters<SubtleCrypto['verify']>[0]

type ImportedKey =
  | { ok: true; cryptoKey: CryptoKey; algorithm: VerifyAlgorithm }
  | { ok: false; reason: string }

async function findVerifyKey(
  raw: string,
  kid: string,
  alg: 'ES256' | 'EdDSA'
): Promise<ImportedKey> {
  let keys: PublicJwk[]
  try {
    keys = parseJwks(raw)
  } catch {
    return { ok: false, reason: 'bad_key' }
  }
  const jwk = keys.find((key) => key.kid === kid && key.use !== 'enc')
  if (!jwk) return { ok: false, reason: 'unknown_kid' }
  try {
    if (alg === 'ES256' && jwk.kty === 'EC' && jwk.crv === 'P-256' && jwk.x && jwk.y) {
      const cryptoKey = await crypto.subtle.importKey(
        'jwk',
        { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, alg: 'ES256', ext: true },
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify']
      )
      return {
        ok: true,
        cryptoKey,
        algorithm: { name: 'ECDSA', hash: 'SHA-256' } as VerifyAlgorithm
      }
    }
    if (alg === 'EdDSA' && jwk.kty === 'OKP' && jwk.crv === 'Ed25519' && jwk.x) {
      const cryptoKey = await crypto.subtle.importKey(
        'jwk',
        { kty: 'OKP', crv: 'Ed25519', x: jwk.x, alg: 'EdDSA', ext: true },
        { name: 'Ed25519' },
        false,
        ['verify']
      )
      return { ok: true, cryptoKey, algorithm: { name: 'Ed25519' } as VerifyAlgorithm }
    }
  } catch {
    return { ok: false, reason: 'bad_key' }
  }
  return { ok: false, reason: 'bad_alg' }
}

function parseJwks(raw: string): PublicJwk[] {
  const parsed = JSON.parse(raw) as { keys?: PublicJwk[]; kty?: string }
  if (parsed && Array.isArray(parsed.keys)) return parsed.keys
  if (parsed && typeof parsed.kty === 'string') return [parsed as PublicJwk]
  throw new Error('jwk')
}

function decodeJson<T>(segment: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(segment))) as T
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
