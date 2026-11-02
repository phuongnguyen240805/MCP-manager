import { createExecutionContext, env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { newCsrfToken } from '../../src/auth/csrf'
import {
  GATEWAY_CLOCK_SKEW_SECONDS,
  GATEWAY_MAX_LIFETIME_SECONDS
} from '../../src/auth/kedi-gateway'
import { signSession } from '../../src/auth/session'
import { upsertUser } from '../../src/db/queries/users'
import type { Env as WorkerEnv } from '../../src/env'
import { b64urlEncode } from '../../src/util/base64url'

/**
 * Trusted gateway (Nest → /api). The assertion is the credential; the
 * cookie + CSRF path is covered again at the bottom so the bearer branch
 * cannot relax it.
 */

const BASE = 'https://ctxlayer-kedi-gateway.test'
const SESSION_SECRET = 'kedi-gateway-integration-secret'
const ISSUER = 'https://kedi-gateway.example'
const AUDIENCE = 'ctxlayer'
const TENANTS = 'tenant-a, tenant-b'

const bareEnv = {
  ...(env as unknown as Record<string, unknown>),
  PUBLIC_BASE_URL: BASE,
  SESSION_COOKIE_SECRET: SESSION_SECRET
} as unknown as WorkerEnv

interface ExportedJwk {
  kty?: string
  crv?: string
  x?: string
  y?: string
  d?: string
  kid?: string
  alg?: string
  ext?: boolean
}

interface SigningKey {
  kid: string
  privateKey: CryptoKey
  publicJwk: ExportedJwk
  alg: 'ES256' | 'EdDSA'
}

let es256!: SigningKey
let es256Other!: SigningKey
let ed25519!: SigningKey
let gatewayEnv!: WorkerEnv
let singleJwkEnv!: WorkerEnv
let eddsaEnv!: WorkerEnv

beforeAll(async () => {
  es256 = await generateEs256('kid-es256')
  es256Other = await generateEs256('kid-rotated')
  ed25519 = await generateEd25519('kid-eddsa')
  const jwks = JSON.stringify({ keys: [publicOnly(es256), publicOnly(es256Other)] })
  gatewayEnv = withGateway(jwks)
  singleJwkEnv = withGateway(JSON.stringify(publicOnly(es256)))
  eddsaEnv = withGateway(JSON.stringify({ keys: [publicOnly(ed25519)] }))
})

function withGateway(publicJwk: string): WorkerEnv {
  return {
    ...(bareEnv as unknown as Record<string, unknown>),
    KEDI_GATEWAY_ISSUER: ISSUER,
    KEDI_GATEWAY_AUDIENCE: AUDIENCE,
    KEDI_GATEWAY_PUBLIC_JWK: publicJwk,
    KEDI_GATEWAY_ALLOWED_TENANTS: TENANTS
  } as unknown as WorkerEnv
}

function publicOnly(key: SigningKey): ExportedJwk {
  const pub: ExportedJwk = { ...key.publicJwk, kid: key.kid, alg: key.alg, ext: true }
  delete pub.d
  return pub
}

async function generateEs256(kid: string): Promise<SigningKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify'
  ])) as CryptoKeyPair
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as ExportedJwk
  return { kid, privateKey: pair.privateKey, publicJwk, alg: 'ES256' }
}

async function generateEd25519(kid: string): Promise<SigningKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify'
  ])) as CryptoKeyPair
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as ExportedJwk
  return { kid, privateKey: pair.privateKey, publicJwk, alg: 'EdDSA' }
}

function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'nest-user-1',
    tid: 'tenant-a',
    hub_role: 'member',
    jti: crypto.randomUUID(),
    rid: 'rid-1',
    iat: now,
    exp: now + 60,
    ...over
  }
}

async function signAssertion(
  key: SigningKey,
  payload: Record<string, unknown>,
  headerOver: Record<string, unknown> = {}
): Promise<string> {
  const header = { alg: key.alg, typ: 'JWT', kid: key.kid, ...headerOver }
  const h = b64urlEncode(new TextEncoder().encode(JSON.stringify(header)))
  const p = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)))
  const data = new TextEncoder().encode(`${h}.${p}`)
  const algorithm = (
    key.alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'Ed25519' }
  ) as Parameters<SubtleCrypto['sign']>[0]
  const sig = await crypto.subtle.sign(algorithm, key.privateKey, data)
  return `${h}.${p}.${b64urlEncode(new Uint8Array(sig))}`
}

function request(path: string, init: RequestInit, target: WorkerEnv = gatewayEnv) {
  return app.request(`${BASE}${path}`, init, target, createExecutionContext())
}

function bearer(token: string, extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${token}`, ...extra }
}

describe('kedi trusted gateway', () => {
  it('accepts a valid assertion, JIT-creates one user, and reuses it', async () => {
    const seeded = await upsertUser(
      gatewayEnv,
      {
        idp: 'github',
        idpSub: 'gh-not-merged',
        email: 'person@example.com',
        name: 'Existing human',
        avatarUrl: null
      },
      'active'
    )
    const sub = 'nest-user-stable'
    const first = await signAssertion(es256Other, claims({ sub, jti: crypto.randomUUID(), rid: 'r1' }))
    const res1 = await request('/api/me', { headers: bearer(first) })
    expect(res1.status).toBe(200)
    const body1 = (await res1.json()) as { id: string; email: string; role: string; idp: string }
    expect(body1.idp).toBe('kedi')
    expect(body1.role).toBe('user')
    expect(body1.email.endsWith('@gateway.invalid')).toBe(true)
    expect(body1.email).not.toBe('person@example.com')
    expect(body1.id).not.toBe(seeded.user.id)
    expect(res1.headers.get('set-cookie') ?? '').not.toContain('__Host-ctx_session')

    const second = await signAssertion(es256Other, claims({ sub, jti: crypto.randomUUID(), rid: 'r2' }))
    const res2 = await request('/api/me', { headers: bearer(second) })
    expect(res2.status).toBe(200)
    const body2 = (await res2.json()) as { id: string }
    expect(body2.id).toBe(body1.id)

    const mapped = await gatewayEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM external_identities WHERE issuer = ?1 AND subject = ?2`
    )
      .bind(ISSUER, sub)
      .first<{ n: number }>()
    expect(mapped?.n).toBe(1)
  })

  it('accepts a single JWK object as well as a JWKS', async () => {
    const token = await signAssertion(es256, claims({ sub: 'single-jwk-user' }))
    const res = await request('/api/me', { headers: bearer(token) }, singleJwkEnv)
    expect(res.status).toBe(200)
  })

  it('accepts an EdDSA assertion', async () => {
    const token = await signAssertion(ed25519, claims({ sub: 'eddsa-user' }))
    const res = await request('/api/me', { headers: bearer(token) }, eddsaEnv)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { idp: string }).idp).toBe('kedi')
  })

  it('rejects an expired assertion', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await signAssertion(
      es256,
      claims({
        sub: 'expired-user',
        iat: now - GATEWAY_CLOCK_SKEW_SECONDS - 90,
        exp: now - GATEWAY_CLOCK_SKEW_SECONDS - 30
      })
    )
    const res = await request('/api/me', { headers: bearer(token) })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'not_signed_in' })
  })

  it('rejects a lifetime longer than 120s', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await signAssertion(
      es256,
      claims({
        sub: 'long-lived',
        iat: now,
        exp: now + GATEWAY_MAX_LIFETIME_SECONDS + 1
      })
    )
    expect((await request('/api/me', { headers: bearer(token) })).status).toBe(401)
  })

  it('rejects the wrong audience', async () => {
    const token = await signAssertion(es256, claims({ sub: 'wrong-aud', aud: 'someone-else' }))
    expect((await request('/api/me', { headers: bearer(token) })).status).toBe(401)
  })

  it('rejects the wrong issuer', async () => {
    const token = await signAssertion(es256, claims({ sub: 'wrong-iss', iss: 'https://other.example' }))
    expect((await request('/api/me', { headers: bearer(token) })).status).toBe(401)
  })

  it('rejects a bad signature', async () => {
    const token = await signAssertion(es256, claims({ sub: 'bad-sig' }))
    const flipped = `${token.slice(0, -2)}${token.endsWith('a') ? 'b' : 'a'}`
    expect((await request('/api/me', { headers: bearer(flipped) })).status).toBe(401)
  })

  it('rejects a replayed jti', async () => {
    const token = await signAssertion(es256, claims({ sub: 'replay-user', jti: 'jti-once' }))
    expect((await request('/api/me', { headers: bearer(token) })).status).toBe(200)
    const again = await request('/api/me', { headers: bearer(token) })
    expect(again.status).toBe(401)
    expect(await again.json()).toEqual({ error: 'not_signed_in' })
  })

  it('rejects a tenant that is not on the allowlist and does not create a user', async () => {
    const token = await signAssertion(es256, claims({ sub: 'foreign-tenant', tid: 'tenant-nope' }))
    expect((await request('/api/me', { headers: bearer(token) })).status).toBe(401)
    const row = await gatewayEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM external_identities WHERE subject = ?1`
    )
      .bind('foreign-tenant')
      .first<{ n: number }>()
    expect(row?.n).toBe(0)
  })

  it('allows a second configured tenant', async () => {
    const token = await signAssertion(es256, claims({ sub: 'tenant-b-user', tid: 'tenant-b' }))
    expect((await request('/api/me', { headers: bearer(token) })).status).toBe(200)
  })

  it('does not let a member reach /api/admin, and does let hub_role=admin', async () => {
    const member = await signAssertion(
      es256,
      claims({ sub: 'member-user', hub_role: 'member', jti: crypto.randomUUID() })
    )
    const memberRes = await request('/api/admin/users', { headers: bearer(member) })
    expect(memberRes.status).toBe(403)
    expect(await memberRes.json()).toEqual({ error: 'forbidden' })

    const admin = await signAssertion(
      es256,
      claims({ sub: 'admin-user', hub_role: 'admin', jti: crypto.randomUUID() })
    )
    const adminRes = await request('/api/admin/users', { headers: bearer(admin) })
    expect(adminRes.status).toBe(200)
  })

  it('drops admin rights when a later assertion says member', async () => {
    const sub = 'demoted-user'
    const asAdmin = await signAssertion(
      es256,
      claims({ sub, hub_role: 'admin', jti: crypto.randomUUID() })
    )
    expect((await request('/api/admin/users', { headers: bearer(asAdmin) })).status).toBe(200)

    const asMember = await signAssertion(
      es256,
      claims({ sub, hub_role: 'member', jti: crypto.randomUUID() })
    )
    const res = await request('/api/admin/users', { headers: bearer(asMember) })
    expect(res.status).toBe(403)
  })

  it('skips cookie CSRF for a verified assertion', async () => {
    const token = await signAssertion(es256, claims({ sub: 'csrf-skip-user' }))
    const res = await request('/api/docs', {
      method: 'POST',
      headers: bearer(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ title: 'from the gateway' })
    })
    expect(res.status).toBe(201)
  })

  it('is disabled when the gateway env is unset', async () => {
    const token = await signAssertion(es256, claims({ sub: 'disabled-user' }))
    const rejected = await request('/api/me', { headers: bearer(token) }, bareEnv)
    expect(rejected.status).toBe(401)

    const { user } = await upsertUser(
      bareEnv,
      {
        idp: 'github',
        idpSub: 'disabled-cookie-user',
        email: 'disabled-cookie@example.com',
        name: null,
        avatarUrl: null
      },
      'active'
    )
    const cookie = await signSession(
      { userId: user.id, role: user.role, epoch: user.session_epoch },
      SESSION_SECRET
    )
    const ok = await request(
      '/api/me',
      { headers: { cookie: `__Host-ctx_session=${cookie}`, authorization: `Bearer ${token}` } },
      bareEnv
    )
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { id: string }).id).toBe(user.id)
  })

  it('keeps the cookie session and CSRF gate when no bearer is sent', async () => {
    const { user } = await upsertUser(
      gatewayEnv,
      {
        idp: 'github',
        idpSub: 'cookie-still-works',
        email: 'cookie-still-works@example.com',
        name: null,
        avatarUrl: null
      },
      'active'
    )
    const cookie = await signSession(
      { userId: user.id, role: user.role, epoch: user.session_epoch },
      SESSION_SECRET
    )
    const session = `__Host-ctx_session=${cookie}`
    const me = await request('/api/me', { headers: { cookie: session } })
    expect(me.status).toBe(200)
    expect(((await me.json()) as { id: string }).id).toBe(user.id)

    const missing = await request('/api/docs', {
      method: 'POST',
      headers: { cookie: session, origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'should be blocked' })
    })
    expect(missing.status).toBe(403)
    expect(await missing.json()).toEqual({ error: 'bad_csrf' })

    const csrf = newCsrfToken()
    const posted = await request('/api/docs', {
      method: 'POST',
      headers: {
        cookie: `${session}; __Host-ctx_csrf=${csrf}`,
        origin: BASE,
        'x-csrf': csrf,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ title: 'cookie created' })
    })
    expect(posted.status).toBe(201)
  })

  it('does not fall through to a cookie when the bearer is invalid', async () => {
    const { user } = await upsertUser(
      gatewayEnv,
      {
        idp: 'github',
        idpSub: 'no-fallthrough',
        email: 'no-fallthrough@example.com',
        name: null,
        avatarUrl: null
      },
      'active'
    )
    const cookie = await signSession(
      { userId: user.id, role: user.role, epoch: user.session_epoch },
      SESSION_SECRET
    )
    const token = await signAssertion(es256, claims({ sub: 'ignored', aud: 'nope' }))
    const res = await request('/api/me', {
      headers: {
        cookie: `__Host-ctx_session=${cookie}`,
        authorization: `Bearer ${token}`
      }
    })
    expect(res.status).toBe(401)
  })
})
