import { createExecutionContext, env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { newCsrfToken } from '../../src/auth/csrf'
import { COLLAB_TICKET_MAX_LIFETIME_SECONDS } from '../../src/auth/kedi-gateway'
import { signSession } from '../../src/auth/session'
import { runWithGatewayTenant } from '../../src/db/tenant-db'
import { setGitConnectionAuthConfig } from '../../src/db/queries/git-connections'
import { createGitSource } from '../../src/db/queries/git-sources'
import { upsertUser } from '../../src/db/queries/users'
import type { Env as WorkerEnv } from '../../src/env'
import { b64urlEncode } from '../../src/util/base64url'

/**
 * Gateway calls that cross more than one `use('*')`, plus the browser
 * hops that cannot send `Authorization`: collab tickets and OAuth callbacks.
 */

const BASE = 'https://ctxlayer-kedi-gateway.test'
const KEDI = 'https://kedi.example'
const SESSION_SECRET = 'kedi-gateway-surfaces-secret'
const ISSUER = 'https://kedi-gateway.example'
const AUDIENCE = 'ctxlayer'
const TENANT = 'tenant-a'

const AUTH_CONFIG = JSON.stringify({
  oauth: {
    clientId: 'app-123',
    authorizeUrl: 'https://login.microsoftonline.com/tid/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/tid/oauth2/v2.0/token',
    scopes: ['offline_access']
  }
})

const gatewayEnv = {
  ...(env as unknown as Record<string, unknown>),
  PUBLIC_BASE_URL: BASE,
  SESSION_COOKIE_SECRET: SESSION_SECRET,
  KEDI_GATEWAY_ISSUER: ISSUER,
  KEDI_GATEWAY_AUDIENCE: AUDIENCE,
  KEDI_GATEWAY_ALLOWED_TENANTS: `${TENANT},tenant-b`,
  KEDI_GATEWAY_ALLOWED_ORIGINS: KEDI,
  KEDI_GATEWAY_RETURN_ORIGINS: KEDI
} as unknown as WorkerEnv

let es256!: CryptoKey
let publicJwk = ''

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify'
  ])) as CryptoKeyPair
  es256 = pair.privateKey
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  publicJwk = JSON.stringify({ ...jwk, kid: 'kid-surfaces', alg: 'ES256', ext: true })
  ;(gatewayEnv as unknown as { KEDI_GATEWAY_PUBLIC_JWK: string }).KEDI_GATEWAY_PUBLIC_JWK =
    publicJwk
})

function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'nest-user',
    tid: TENANT,
    hub_role: 'member',
    jti: crypto.randomUUID(),
    rid: 'rid',
    iat: now,
    exp: now + 60,
    ...over
  }
}

async function sign(payload: Record<string, unknown>): Promise<string> {
  const header = { alg: 'ES256', typ: 'JWT', kid: 'kid-surfaces' }
  const h = b64urlEncode(new TextEncoder().encode(JSON.stringify(header)))
  const p = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)))
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    es256,
    new TextEncoder().encode(`${h}.${p}`)
  )
  return `${h}.${p}.${b64urlEncode(new Uint8Array(sig))}`
}

function request(path: string, init: RequestInit = {}, target: WorkerEnv = gatewayEnv) {
  return app.request(`${BASE}${path}`, init, target, createExecutionContext())
}

function bearer(token: string, extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${token}`, ...extra }
}

async function authed(path: string, payload: Record<string, unknown>, init: RequestInit = {}) {
  const token = await sign(claims(payload))
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${token}`)
  return request(path, { ...init, headers })
}

describe('gateway jti is consumed once per request', () => {
  it('serves doc editors, tags, and git behind stacked routers', async () => {
    const created = await authed(
      '/api/docs',
      { sub: 'stack-user' },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Stacked' })
      }
    )
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }

    const editors = await authed(`/api/docs/${id}/editors`, {
      sub: 'stack-user',
      jti: 'editors-once'
    })
    expect(editors.status).toBe(200)
    const replay = await authed(`/api/docs/${id}/editors`, {
      sub: 'stack-user',
      jti: 'editors-once'
    })
    expect(replay.status).toBe(401)

    expect((await authed(`/api/docs/${id}/tags`, { sub: 'stack-user' })).status).toBe(200)
    const git = await authed(`/api/docs/${id}/git`, { sub: 'stack-user' })
    expect(git.status).toBe(404)
    expect(await git.json()).toEqual({ error: 'not_a_git_doc' })
  })

  it('lets requireAdmin run after requireUser on attachment writes', async () => {
    const member = await authed(
      '/api/doc-attachments',
      { sub: 'attach-member', hub_role: 'member' },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      }
    )
    expect(member.status).toBe(403)

    const admin = await authed(
      '/api/doc-attachments',
      { sub: 'attach-admin', hub_role: 'admin' },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      }
    )
    expect(admin.status).toBe(400)

    const skill = await authed(
      '/api/skill-attachments',
      { sub: 'attach-admin', hub_role: 'admin' },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      }
    )
    expect(skill.status).toBe(400)
  })

  it('does not replay jti on oauth start routes', async () => {
    const up = await authed(
      `/api/upstreams/missing/oauth/start?return_origin=${encodeURIComponent(KEDI)}`,
      { sub: 'oauth-start-user' },
      { headers: { 'sec-fetch-site': 'cross-site' } }
    )
    expect(up.status).toBe(404)
    const git = await authed(
      `/api/git-sources/missing/oauth/start?return_origin=${encodeURIComponent(KEDI)}`,
      { sub: 'oauth-start-user', hub_role: 'admin' }
    )
    expect(git.status).toBe(404)
  })
})

describe('gateway profile and role', () => {
  it('shows name and email without linking the address', async () => {
    const seeded = await upsertUser(
      gatewayEnv,
      {
        idp: 'github',
        idpSub: 'gh-ada',
        email: 'ada@example.com',
        name: 'GitHub Ada',
        avatarUrl: null
      },
      'active'
    )
    const me = await authed('/api/me', {
      sub: 'ada-kedi',
      name: 'Ada Lovelace',
      email: 'ada@example.com'
    })
    expect(me.status).toBe(200)
    const body = (await me.json()) as { id: string; email: string; name: string; idp: string }
    expect(body.idp).toBe('kedi')
    expect(body.name).toBe('Ada Lovelace')
    expect(body.email).toBe('ada@example.com')
    expect(body.id).not.toBe(seeded.user.id)

    const stored = await gatewayEnv.DB.prepare(`SELECT email FROM users WHERE id = ?1`)
      .bind(body.id)
      .first<{ email: string }>()
    expect(stored?.email.endsWith('@gateway.invalid')).toBe(true)

    const renamed = await authed('/api/me', {
      sub: 'ada-kedi',
      name: 'Ada L.',
      email: 'ada@example.com'
    })
    expect(((await renamed.json()) as { name: string }).name).toBe('Ada L.')

    const bad = await authed('/api/me', { sub: 'bad-email', email: 'not-an-email' })
    expect(bad.status).toBe(401)

    const listed = await authed('/api/admin/users', {
      sub: 'ada-kedi',
      hub_role: 'admin',
      name: 'Ada L.',
      email: 'ada@example.com'
    })
    expect(listed.status).toBe(200)
    const rows = (await listed.json()) as Array<{ id: string; email: string }>
    expect(rows.find((row) => row.id === body.id)?.email).toBe('ada@example.com')
  })

  it('refuses to change a kedi role and still changes a cookie user', async () => {
    const member = await authed('/api/me', { sub: 'role-member', name: 'Member' })
    const memberId = ((await member.json()) as { id: string }).id
    const locked = await authed(
      `/api/admin/users/${memberId}`,
      { sub: 'role-admin', hub_role: 'admin' },
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'admin' })
      }
    )
    expect(locked.status).toBe(409)
    expect(await locked.json()).toMatchObject({ error: 'kedi_role_locked' })

    const { user: admin } = await upsertUser(
      gatewayEnv,
      {
        idp: 'github',
        idpSub: 'gh-role-admin',
        email: 'role-admin@example.com',
        name: null,
        avatarUrl: null
      },
      'active'
    )
    const { user: target } = await upsertUser(
      gatewayEnv,
      {
        idp: 'github',
        idpSub: 'gh-role-target',
        email: 'role-target@example.com',
        name: null,
        avatarUrl: null
      },
      'active'
    )
    await gatewayEnv.DB.prepare(`UPDATE users SET role = 'admin' WHERE id = ?1`)
      .bind(admin.id)
      .run()
    const cookie = await signSession(
      { userId: admin.id, role: 'admin', epoch: admin.session_epoch },
      SESSION_SECRET
    )
    const csrf = newCsrfToken()
    const patched = await request(`/api/admin/users/${target.id}`, {
      method: 'PATCH',
      headers: {
        cookie: `__Host-ctx_session=${cookie}; __Host-ctx_csrf=${csrf}`,
        origin: BASE,
        'x-csrf': csrf,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ role: 'admin' })
    })
    expect(patched.status).toBe(204)
  })
})

describe('collab ticket', () => {
  function roomEnv(capture: { user?: string; edit?: string }) {
    const fake = {
      idFromName: () => 'room',
      get: () => ({
        fetch: async (req: Request) => {
          capture.user = req.headers.get('x-ctx-user-id') ?? ''
          capture.edit = req.headers.get('x-ctx-can-edit') ?? ''
          const pair = new WebSocketPair()
          return new Response(null, { status: 101, webSocket: pair[0] })
        }
      })
    }
    return new Proxy(gatewayEnv, {
      get(target, prop, receiver) {
        if (prop === 'DOC_ROOM_DO') return fake
        return Reflect.get(target, prop, receiver)
      }
    }) as unknown as WorkerEnv
  }

  async function docId(sub: string, tid = TENANT): Promise<string> {
    const res = await authed(
      '/api/docs',
      { sub, tid },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: `Doc ${sub}` })
      }
    )
    expect(res.status).toBe(201)
    return ((await res.json()) as { id: string }).id
  }

  it('accepts a query ticket from an allowlisted origin and isolates tenants', async () => {
    const id = await docId('collab-owner')
    const capture: { user?: string; edit?: string } = {}
    const token = await sign(claims({ sub: 'collab-owner', jti: 'collab-ticket-1' }))
    const ok = await request(
      `/collab/${id}?ticket=${encodeURIComponent(token)}`,
      { headers: { upgrade: 'websocket', origin: KEDI } },
      roomEnv(capture)
    )
    expect(ok.status).toBe(101)
    expect(capture.edit).toBe('1')
    expect(capture.user).toBeTruthy()

    const other = await sign(
      claims({ sub: 'collab-other', tid: 'tenant-b', jti: 'collab-ticket-b' })
    )
    const hidden = await request(
      `/collab/${id}?ticket=${encodeURIComponent(other)}`,
      { headers: { upgrade: 'websocket', origin: KEDI } },
      roomEnv({})
    )
    expect(hidden.status).toBe(404)
  })

  it('accepts the ticket as a websocket protocol and echoes the public name', async () => {
    const id = await docId('collab-proto')
    const token = await sign(claims({ sub: 'collab-proto' }))
    const res = await request(
      `/collab/${id}`,
      {
        headers: {
          upgrade: 'websocket',
          origin: KEDI,
          'sec-websocket-protocol': `ctxlayer.kedi-ticket, ${token}`
        }
      },
      roomEnv({})
    )
    expect(res.status).toBe(101)
    expect(res.headers.get('sec-websocket-protocol')).toBe('ctxlayer.kedi-ticket')
  })

  it('rejects a long-lived ticket, a bad origin, and a replay', async () => {
    const id = await docId('collab-reject')
    const now = Math.floor(Date.now() / 1000)
    const longLived = await sign(
      claims({
        sub: 'collab-reject',
        iat: now,
        exp: now + COLLAB_TICKET_MAX_LIFETIME_SECONDS + 1
      })
    )
    const tooLong = await request(`/collab/${id}?ticket=${encodeURIComponent(longLived)}`, {
      headers: { upgrade: 'websocket', origin: KEDI }
    })
    expect(tooLong.status).toBe(401)
    // The same lifetime is still valid on the REST surface.
    expect((await request('/api/me', { headers: bearer(longLived) })).status).toBe(200)

    const token = await sign(claims({ sub: 'collab-reject', jti: 'collab-replay' }))
    const badOrigin = await request(`/collab/${id}?ticket=${encodeURIComponent(token)}`, {
      headers: { upgrade: 'websocket', origin: 'https://evil.example' }
    })
    expect(badOrigin.status).toBe(403)
    const first = await request(
      `/collab/${id}?ticket=${encodeURIComponent(token)}`,
      {
        headers: { upgrade: 'websocket', origin: KEDI }
      },
      roomEnv({})
    )
    expect(first.status).toBe(101)
    const again = await request(`/collab/${id}?ticket=${encodeURIComponent(token)}`, {
      headers: { upgrade: 'websocket', origin: KEDI }
    })
    expect(again.status).toBe(401)
  })

  it('keeps the cookie handshake on PUBLIC_BASE_URL only', async () => {
    const { user } = await upsertUser(
      gatewayEnv,
      {
        idp: 'github',
        idpSub: 'gh-collab-cookie',
        email: 'collab-cookie@example.com',
        name: null,
        avatarUrl: null
      },
      'active'
    )
    const cookie = await signSession(
      { userId: user.id, role: user.role, epoch: user.session_epoch },
      SESSION_SECRET
    )
    const csrf = newCsrfToken()
    const created = await request('/api/docs', {
      method: 'POST',
      headers: {
        cookie: `__Host-ctx_session=${cookie}; __Host-ctx_csrf=${csrf}`,
        origin: BASE,
        'x-csrf': csrf,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ title: 'Cookie doc' })
    })
    expect(created.status).toBe(201)
    const id = ((await created.json()) as { id: string }).id
    const session = `__Host-ctx_session=${cookie}`
    const foreign = await request(`/collab/${id}`, {
      headers: { upgrade: 'websocket', origin: KEDI, cookie: session }
    })
    expect(foreign.status).toBe(403)
    const capture: { user?: string } = {}
    const ok = await request(
      `/collab/${id}`,
      { headers: { upgrade: 'websocket', origin: BASE, cookie: session } },
      roomEnv(capture)
    )
    expect(ok.status).toBe(101)
    expect(capture.user).toBe(user.id)
  })
})

describe('gateway oauth start and callback', () => {
  const oauth = {
    clientId: 'app-123',
    authorizeUrl: 'https://login.microsoftonline.com/tid/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/tid/oauth2/v2.0/token',
    scopes: ['offline_access']
  }

  it('returns authorizeUrl for a gateway start and bounces the callback to Kedi', async () => {
    const me = await authed('/api/me', { sub: 'oauth-owner', hub_role: 'admin' })
    const userId = ((await me.json()) as { id: string }).id
    let sourceId = ''
    await runWithGatewayTenant(TENANT, async () => {
      await gatewayEnv.DB.prepare(
        `INSERT INTO upstream_servers
           (id, slug, display_name, transport, url, auth_strategy, auth_config, created_at, updated_at)
         VALUES ('up-gw', 'up-gw', 'GW', 'streamable_http', 'https://up.example/mcp', 'user_oauth', ?1, 1, 1)`
      )
        .bind(AUTH_CONFIG)
        .run()
      await gatewayEnv.DB.prepare(
        `INSERT INTO upstream_visibility (upstream_id, scope_kind, scope_id) VALUES ('up-gw', 'everyone', '')`
      ).run()
      const source = await createGitSource(gatewayEnv, {
        slug: 'repo-gw',
        displayName: 'GW',
        provider: 'github',
        repo: 'repo',
        createdBy: userId
      })
      sourceId = source.id
      await setGitConnectionAuthConfig(gatewayEnv, source.connection_id, JSON.stringify({ oauth }))
    })

    const missingOrigin = await authed('/api/upstreams/up-gw/oauth/start', {
      sub: 'oauth-owner',
      hub_role: 'admin'
    })
    expect(missingOrigin.status).toBe(400)

    const start = await authed(
      `/api/upstreams/up-gw/oauth/start?return_to=admin&return_origin=${encodeURIComponent(KEDI)}`,
      { sub: 'oauth-owner', hub_role: 'admin' },
      { headers: { 'sec-fetch-site': 'cross-site' } }
    )
    expect(start.status).toBe(200)
    const body = (await start.json()) as { authorizeUrl: string }
    const authorize = new URL(body.authorizeUrl)
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${BASE}/api/upstreams/oauth/callback`)
    expect(body.authorizeUrl).not.toContain(KEDI)
    const state = authorize.searchParams.get('state')
    expect(state).toBeTruthy()

    const callback = await request(
      `/api/upstreams/oauth/callback?error=access_denied&state=${state}`
    )
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe(
      `${KEDI}/app/admin/upstreams?oauth_error=access_denied`
    )

    const gitStart = await authed(
      `/api/git-sources/${sourceId}/oauth/start?doc=doc-1&return_origin=${encodeURIComponent(KEDI)}`,
      { sub: 'oauth-owner', hub_role: 'admin' }
    )
    expect(gitStart.status).toBe(200)
    const gitBody = (await gitStart.json()) as { authorizeUrl: string }
    const gitAuthorize = new URL(gitBody.authorizeUrl)
    expect(gitAuthorize.searchParams.get('redirect_uri')).toBe(
      `${BASE}/api/git-sources/oauth/callback`
    )
    const gitState = gitAuthorize.searchParams.get('state')
    const gitCallback = await request(
      `/api/git-sources/oauth/callback?error=access_denied&state=${gitState}`
    )
    expect(gitCallback.status).toBe(302)
    expect(gitCallback.headers.get('location')).toBe(
      `${KEDI}/app/docs/doc-1?git_oauth_error=access_denied`
    )
  })

  it('keeps cookie oauth start as a 302 and rejects a cookieless callback', async () => {
    await gatewayEnv.DB.prepare(
      `INSERT INTO upstream_servers
         (id, slug, display_name, transport, url, auth_strategy, auth_config, created_at, updated_at)
       VALUES ('up-cookie', 'up-cookie', 'Cookie', 'streamable_http', 'https://up.example/mcp', 'user_oauth', ?1, 1, 1)`
    )
      .bind(AUTH_CONFIG)
      .run()
    await gatewayEnv.DB.prepare(
      `INSERT INTO upstream_visibility (upstream_id, scope_kind, scope_id) VALUES ('up-cookie', 'everyone', '')`
    ).run()
    const { user } = await upsertUser(
      gatewayEnv,
      {
        idp: 'github',
        idpSub: 'gh-oauth-cookie',
        email: 'oauth-cookie@example.com',
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
    const cross = await request('/api/upstreams/up-cookie/oauth/start', {
      headers: { cookie: session, 'sec-fetch-site': 'cross-site' }
    })
    expect(cross.status).toBe(403)

    const start = await request('/api/upstreams/up-cookie/oauth/start', {
      headers: { cookie: session }
    })
    expect(start.status).toBe(302)
    const location = start.headers.get('location') ?? ''
    expect(location.startsWith('https://login.microsoftonline.com/')).toBe(true)
    const state = new URL(location).searchParams.get('state')
    const callback = await request(
      `/api/upstreams/oauth/callback?error=access_denied&state=${state}`
    )
    expect(callback.status).toBe(401)
    const done = await request(`/api/upstreams/oauth/callback?error=access_denied&state=${state}`, {
      headers: { cookie: session }
    })
    expect(done.status).toBe(302)
    expect(done.headers.get('location')).toBe(`${BASE}/app/upstreams?oauth_error=access_denied`)
  })
})
