import { createExecutionContext, env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { newCsrfToken } from '../../src/auth/csrf'
import { signSession } from '../../src/auth/session'
import { listDocRefs } from '../../src/db/queries/docs'
import { ensureTenantAwareDb, runWithGatewayTenant } from '../../src/db/tenant-db'
import { upsertUser } from '../../src/db/queries/users'
import type { Env as WorkerEnv } from '../../src/env'
import { b64urlEncode } from '../../src/util/base64url'

/**
 * Gateway requests are partitioned by the assertion `tid`. Tenant A must
 * not read, list, search, update, or delete tenant B. Cookie sessions stay
 * on the unpartitioned deployment org.
 */

const BASE = 'https://ctxlayer-tenant-isolation.test'
const SESSION_SECRET = 'tenant-isolation-integration-secret'
const ISSUER = 'https://kedi-gateway.example'
const AUDIENCE = 'ctxlayer'
const TENANTS = 'tenant-a,tenant-b'

const rawDb = (env as unknown as WorkerEnv).DB

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
}

let es256!: SigningKey
let gatewayEnv!: WorkerEnv

beforeAll(async () => {
  es256 = await generateEs256('kid-tenant')
  const pub: ExportedJwk = { ...es256.publicJwk, kid: es256.kid, alg: 'ES256', ext: true }
  delete pub.d
  gatewayEnv = {
    ...(bareEnv as unknown as Record<string, unknown>),
    KEDI_GATEWAY_ISSUER: ISSUER,
    KEDI_GATEWAY_AUDIENCE: AUDIENCE,
    KEDI_GATEWAY_PUBLIC_JWK: JSON.stringify({ keys: [pub] }),
    KEDI_GATEWAY_ALLOWED_TENANTS: TENANTS
  } as unknown as WorkerEnv
  ensureTenantAwareDb(gatewayEnv)
})

async function generateEs256(kid: string): Promise<SigningKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify'
  ])) as CryptoKeyPair
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as ExportedJwk
  return { kid, privateKey: pair.privateKey, publicJwk }
}

function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'iso-user',
    tid: 'tenant-a',
    hub_role: 'admin',
    jti: crypto.randomUUID(),
    rid: 'rid-iso',
    iat: now,
    exp: now + 60,
    ...over
  }
}

async function signAssertion(payload: Record<string, unknown>): Promise<string> {
  const header = { alg: 'ES256', typ: 'JWT', kid: es256.kid }
  const h = b64urlEncode(new TextEncoder().encode(JSON.stringify(header)))
  const p = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)))
  const data = new TextEncoder().encode(`${h}.${p}`)
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, es256.privateKey, data)
  return `${h}.${p}.${b64urlEncode(new Uint8Array(sig))}`
}

function request(path: string, init: RequestInit = {}) {
  return app.request(`${BASE}${path}`, init, gatewayEnv, createExecutionContext())
}

async function bearer(sub: string, tid: string, role: 'member' | 'admin' = 'admin') {
  const token = await signAssertion(claims({ sub, tid, hub_role: role, jti: crypto.randomUUID() }))
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

async function call(
  sub: string,
  tid: string,
  path: string,
  init: RequestInit = {},
  role: 'member' | 'admin' = 'admin'
) {
  const headers = { ...(await bearer(sub, tid, role)), ...(init.headers ?? {}) }
  return request(path, { ...init, headers })
}

function marker(side: 'a' | 'b', kind: string) {
  return `iso-${kind}-${side}`
}

describe('gateway tenant rejection', () => {
  it('rejects a tenant that is not on the allowlist', async () => {
    const token = await signAssertion(claims({ sub: 'iso-foreign', tid: 'tenant-nope' }))
    const res = await request('/api/me', { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'not_signed_in' })
    const row = await rawDb
      .prepare(`SELECT COUNT(*) AS n FROM external_identities WHERE subject = ?1`)
      .bind('iso-foreign')
      .first<{ n: number }>()
    expect(row?.n).toBe(0)
  })

  it.each([
    ['missing', (body: Record<string, unknown>) => delete body.tid],
    [
      'empty',
      (body: Record<string, unknown>) => {
        body.tid = ''
      }
    ],
    [
      'padded',
      (body: Record<string, unknown>) => {
        body.tid = ' tenant-a'
      }
    ],
    [
      'number',
      (body: Record<string, unknown>) => {
        body.tid = 6
      }
    ],
    [
      'null',
      (body: Record<string, unknown>) => {
        body.tid = null
      }
    ]
  ] as const)('rejects an assertion with a %s tid', async (_label, mutate) => {
    const body = claims({ sub: `iso-bad-tid-${_label}` })
    mutate(body)
    const token = await signAssertion(body)
    const res = await request('/api/me', { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'not_signed_in' })
    const row = await rawDb
      .prepare(`SELECT COUNT(*) AS n FROM external_identities WHERE subject = ?1`)
      .bind(`iso-bad-tid-${_label}`)
      .first<{ n: number }>()
    expect(row?.n).toBe(0)
  })
})

describe('gateway tenant partition', () => {
  it('keeps the same Nest subject in two tenants as two users', async () => {
    const a = await call('iso-same-sub', 'tenant-a', '/api/me')
    const b = await call('iso-same-sub', 'tenant-b', '/api/me')
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    const aBody = (await a.json()) as { id: string; email: string }
    const bBody = (await b.json()) as { id: string; email: string }
    expect(aBody.id).not.toBe(bBody.id)
    expect(aBody.email).not.toBe(bBody.email)
  })

  it('isolates docs: list, get, search, update, delete, tags', async () => {
    const createdA = await call('iso-doc-admin', 'tenant-a', '/api/docs', {
      method: 'POST',
      body: JSON.stringify({
        title: marker('a', 'doc'),
        tags: [marker('a', 'tag')],
        folder: '/iso-a'
      })
    })
    expect(createdA.status).toBe(201)
    const docA = (await createdA.json()) as { id: string }

    const createdB = await call('iso-doc-admin', 'tenant-b', '/api/docs', {
      method: 'POST',
      body: JSON.stringify({
        title: marker('b', 'doc'),
        tags: [marker('b', 'tag')],
        folder: '/iso-b'
      })
    })
    expect(createdB.status).toBe(201)
    const docB = (await createdB.json()) as { id: string }

    const listA = await call('iso-doc-member', 'tenant-a', '/api/docs', {}, 'member')
    expect(listA.status).toBe(200)
    const titlesA = JSON.stringify(await listA.json())
    expect(titlesA).toContain(marker('a', 'doc'))
    expect(titlesA).not.toContain(marker('b', 'doc'))

    const getB = await call('iso-doc-admin', 'tenant-a', `/api/docs/${docB.id}`)
    expect(getB.status).toBe(404)
    expect(await getB.json()).toEqual({ error: 'not_found' })

    const rev = await call(
      'iso-doc-admin',
      'tenant-a',
      `/api/docs/${docB.id}/revisions/missing/content`
    )
    expect(rev.status).toBe(404)

    const tags = await call('iso-doc-member', 'tenant-a', '/api/tags', {}, 'member')
    expect(tags.status).toBe(200)
    const tagBody = JSON.stringify(await tags.json())
    expect(tagBody).toContain(marker('a', 'tag'))
    expect(tagBody).not.toContain(marker('b', 'tag'))

    await runWithGatewayTenant('tenant-a', async () => {
      const refs = await listDocRefs(gatewayEnv, [docA.id, docB.id])
      expect(refs.map((r) => r.id)).toEqual([docA.id])
    })
    const search = await call(
      'iso-doc-member',
      'tenant-a',
      '/api/search',
      {
        method: 'POST',
        body: JSON.stringify({ query: marker('b', 'doc') })
      },
      'member'
    )
    // Workers AI is unbound in the test runner, so retrieval 500s before
    // any hit is returned. A 200 must still not contain the other tenant.
    if (search.status === 200) {
      expect(JSON.stringify(await search.json())).not.toContain(marker('b', 'doc'))
    } else {
      expect(search.status).toBe(500)
    }

    const patched = await call('iso-doc-admin', 'tenant-a', `/api/docs/${docB.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'iso-doc-stolen' })
    })
    expect(patched.status).toBe(404)
    const stillB = await call('iso-doc-admin', 'tenant-b', `/api/docs/${docB.id}`)
    expect(stillB.status).toBe(200)
    expect(JSON.stringify(await stillB.json())).toContain(marker('b', 'doc'))

    const removed = await call('iso-doc-admin', 'tenant-a', `/api/docs/${docB.id}`, {
      method: 'DELETE'
    })
    expect(removed.status).toBe(404)
    const afterDelete = await call('iso-doc-admin', 'tenant-b', `/api/docs/${docB.id}`)
    expect(afterDelete.status).toBe(200)
  })

  it('isolates skills', async () => {
    const a = await call('iso-skill-admin', 'tenant-a', '/api/skills', {
      method: 'POST',
      body: JSON.stringify({
        title: marker('a', 'skill'),
        description: 'tenant a playbook'
      })
    })
    const b = await call('iso-skill-admin', 'tenant-b', '/api/skills', {
      method: 'POST',
      body: JSON.stringify({
        title: marker('b', 'skill'),
        description: 'tenant b playbook'
      })
    })
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    const skillB = (await b.json()) as { id: string }

    const list = await call('iso-skill-admin', 'tenant-a', '/api/skills')
    const listed = JSON.stringify(await list.json())
    expect(listed).toContain(marker('a', 'skill'))
    expect(listed).not.toContain(marker('b', 'skill'))

    expect((await call('iso-skill-admin', 'tenant-a', `/api/skills/${skillB.id}`)).status).toBe(404)
    const patched = await call('iso-skill-admin', 'tenant-a', `/api/skills/${skillB.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'iso-skill-stolen' })
    })
    expect(patched.status).toBe(404)
    const removed = await call('iso-skill-admin', 'tenant-a', `/api/skills/${skillB.id}`, {
      method: 'DELETE'
    })
    expect(removed.status).toBe(404)
    const still = await call('iso-skill-admin', 'tenant-b', `/api/skills/${skillB.id}`)
    expect(still.status).toBe(200)
    expect(JSON.stringify(await still.json())).toContain(marker('b', 'skill'))
  })

  it('isolates upstreams', async () => {
    const body = (name: string, slug: string) =>
      JSON.stringify({
        slug,
        displayName: name,
        transport: 'streamable_http',
        url: 'https://example.com/mcp',
        authStrategy: 'user_bearer',
        enabled: false
      })
    const a = await call('iso-up-admin', 'tenant-a', '/api/admin/upstreams', {
      method: 'POST',
      body: body(marker('a', 'upstream'), 'up-iso-a')
    })
    const b = await call('iso-up-admin', 'tenant-b', '/api/admin/upstreams', {
      method: 'POST',
      body: body(marker('b', 'upstream'), 'up-iso-b')
    })
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    const upB = (await b.json()) as { id: string }

    const list = JSON.stringify(
      await (await call('iso-up-admin', 'tenant-a', '/api/admin/upstreams')).json()
    )
    expect(list).toContain(marker('a', 'upstream'))
    expect(list).not.toContain(marker('b', 'upstream'))
    expect((await call('iso-up-admin', 'tenant-a', `/api/admin/upstreams/${upB.id}`)).status).toBe(
      404
    )

    const patched = await call('iso-up-admin', 'tenant-a', `/api/admin/upstreams/${upB.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'iso-upstream-stolen' })
    })
    expect(patched.status).toBe(404)
    await call('iso-up-admin', 'tenant-a', `/api/admin/upstreams/${upB.id}`, { method: 'DELETE' })
    const still = await call('iso-up-admin', 'tenant-b', `/api/admin/upstreams/${upB.id}`)
    expect(still.status).toBe(200)
    expect(JSON.stringify(await still.json())).toContain(marker('b', 'upstream'))
  })

  it('isolates teams, products, and roles', async () => {
    async function make(tid: string, path: string, slug: string, name: string) {
      const res = await call(`iso-org-${tid}`, tid, path, {
        method: 'POST',
        body: JSON.stringify({ slug, displayName: name })
      })
      expect(res.status, `${tid} ${path} ${await res.clone().text()}`).toBe(201)
      return (await res.json()) as { id: string }
    }
    await make('tenant-a', '/api/admin/teams', 'team-iso-a', marker('a', 'team'))
    const teamB = await make('tenant-b', '/api/admin/teams', 'team-iso-b', marker('b', 'team'))
    await make('tenant-a', '/api/admin/products', 'prod-iso-a', marker('a', 'product'))
    const productB = await make(
      'tenant-b',
      '/api/admin/products',
      'prod-iso-b',
      marker('b', 'product')
    )
    await make('tenant-a', '/api/admin/roles', 'role-iso-a', marker('a', 'role'))
    const roleB = await make('tenant-b', '/api/admin/roles', 'role-iso-b', marker('b', 'role'))

    const teams = JSON.stringify(
      await (await call('iso-org-tenant-a', 'tenant-a', '/api/teams')).json()
    )
    expect(teams).toContain(marker('a', 'team'))
    expect(teams).not.toContain(marker('b', 'team'))
    const products = JSON.stringify(
      await (await call('iso-org-tenant-a', 'tenant-a', '/api/products')).json()
    )
    expect(products).toContain(marker('a', 'product'))
    expect(products).not.toContain(marker('b', 'product'))
    const roles = JSON.stringify(
      await (await call('iso-org-tenant-a', 'tenant-a', '/api/roles')).json()
    )
    expect(roles).toContain(marker('a', 'role'))
    expect(roles).not.toContain(marker('b', 'role'))

    expect(
      (
        await call('iso-org-tenant-a', 'tenant-a', `/api/admin/teams/${teamB.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ displayName: 'iso-team-stolen' })
        })
      ).status
    ).toBe(404)
    await call('iso-org-tenant-a', 'tenant-a', `/api/admin/products/${productB.id}`, {
      method: 'DELETE'
    })
    await call('iso-org-tenant-a', 'tenant-a', `/api/admin/roles/${roleB.id}`, { method: 'DELETE' })
    const stillTeam = JSON.stringify(
      await (await call('iso-org-tenant-b', 'tenant-b', '/api/teams')).json()
    )
    expect(stillTeam).toContain(marker('b', 'team'))
    const stillProduct = JSON.stringify(
      await (await call('iso-org-tenant-b', 'tenant-b', '/api/products')).json()
    )
    expect(stillProduct).toContain(marker('b', 'product'))
    const stillRole = JSON.stringify(
      await (await call('iso-org-tenant-b', 'tenant-b', '/api/roles')).json()
    )
    expect(stillRole).toContain(marker('b', 'role'))
  })

  it('isolates the user directory, invites, usage, audit, and jobs', async () => {
    const meA = await call('iso-dir-a', 'tenant-a', '/api/me')
    const meB = await call('iso-dir-b', 'tenant-b', '/api/me')
    const userA = (await meA.json()) as { id: string; email: string }
    const userB = (await meB.json()) as { id: string; email: string }

    const users = JSON.stringify(
      await (await call('iso-dir-a', 'tenant-a', '/api/admin/users')).json()
    )
    expect(users).toContain(userA.email)
    expect(users).not.toContain(userB.email)

    const found = await call(
      'iso-dir-a',
      'tenant-a',
      `/api/users?email=${encodeURIComponent('kedi.')}`
    )
    expect(found.status).toBe(200)
    const foundBody = JSON.stringify(await found.json())
    expect(foundBody).toContain(userA.email)
    expect(foundBody).not.toContain(userB.email)

    const inviteA = await call('iso-dir-a', 'tenant-a', '/api/admin/invites', {
      method: 'POST',
      body: JSON.stringify({ emails: 'iso-invite-a@example.com' })
    })
    const inviteB = await call('iso-dir-b', 'tenant-b', '/api/admin/invites', {
      method: 'POST',
      body: JSON.stringify({ emails: 'iso-invite-b@example.com' })
    })
    expect(inviteA.status).toBe(201)
    expect(inviteB.status).toBe(201)
    const invites = JSON.stringify(
      await (await call('iso-dir-a', 'tenant-a', '/api/admin/invites')).json()
    )
    expect(invites).toContain('iso-invite-a@example.com')
    expect(invites).not.toContain('iso-invite-b@example.com')

    const skill = await call('iso-dir-a', 'tenant-a', '/api/skills', {
      method: 'POST',
      body: JSON.stringify({ title: marker('a', 'audited'), description: 'writes an audit row' })
    })
    expect(skill.status).toBe(201)
    const skillA = (await skill.json()) as { id: string }
    const skillBRes = await call('iso-dir-b', 'tenant-b', '/api/skills', {
      method: 'POST',
      body: JSON.stringify({ title: marker('b', 'audited'), description: 'writes an audit row' })
    })
    const skillB = (await skillBRes.json()) as { id: string }
    const audit = JSON.stringify(
      await (await call('iso-dir-a', 'tenant-a', '/api/admin/audit')).json()
    )
    expect(audit).toContain(skillA.id)
    expect(audit).not.toContain(skillB.id)

    const now = Math.floor(Date.now() / 1000)
    const day = Math.floor(now / 86400) * 86400
    await rawDb.batch([
      rawDb
        .prepare(
          `INSERT INTO usage_events
             (id, ts, user_id, session_id, upstream_id, tool, req_bytes, resp_bytes,
              req_tokens, resp_tokens, latency_ms, status, error_code, error_message, tenant_id)
           VALUES (?1, ?2, ?3, 's', NULL, ?4, 1, 1, 1, 1, 1, 'error', 'upstream_error', ?4, ?5)`
        )
        .bind(`evt-${userA.id}`, now, userA.id, marker('a', 'tool'), 'tenant-a'),
      rawDb
        .prepare(
          `INSERT INTO usage_events
             (id, ts, user_id, session_id, upstream_id, tool, req_bytes, resp_bytes,
              req_tokens, resp_tokens, latency_ms, status, error_code, error_message, tenant_id)
           VALUES (?1, ?2, ?3, 's', NULL, ?4, 1, 1, 1, 1, 1, 'error', 'upstream_error', ?4, ?5)`
        )
        .bind(`evt-${userB.id}`, now, userB.id, marker('b', 'tool'), 'tenant-b'),
      rawDb
        .prepare(
          `INSERT INTO usage_rollups_daily
             (day, user_id, upstream_id, tool, calls, errors, tenant_id)
           VALUES (?1, ?2, '', ?3, 3, 1, 'tenant-a')`
        )
        .bind(day, userA.id, marker('a', 'tool')),
      rawDb
        .prepare(
          `INSERT INTO usage_rollups_daily
             (day, user_id, upstream_id, tool, calls, errors, tenant_id)
           VALUES (?1, ?2, '', ?3, 9, 1, 'tenant-b')`
        )
        .bind(day, userB.id, marker('b', 'tool')),
      rawDb
        .prepare(
          `INSERT INTO job_runs (id, task, started_at, duration_ms, status, tenant_id)
           VALUES (?1, ?2, ?3, 5, 'ok', 'tenant-a')`
        )
        .bind(`job-${userA.id}`, marker('a', 'job'), now),
      rawDb
        .prepare(
          `INSERT INTO job_runs (id, task, started_at, duration_ms, status, tenant_id)
           VALUES (?1, ?2, ?3, 5, 'ok', 'tenant-b')`
        )
        .bind(`job-${userB.id}`, marker('b', 'job'), now)
    ])

    const usage = JSON.stringify(
      await (await call('iso-dir-a', 'tenant-a', '/api/admin/usage?range=all')).json()
    )
    expect(usage).toContain(marker('a', 'tool'))
    expect(usage).not.toContain(marker('b', 'tool'))
    expect(usage).not.toContain(userB.email)

    const errors = JSON.stringify(
      await (await call('iso-dir-a', 'tenant-a', '/api/admin/usage/errors?range=all')).json()
    )
    expect(errors).toContain(marker('a', 'tool'))
    expect(errors).not.toContain(marker('b', 'tool'))

    const jobs = JSON.stringify(
      await (await call('iso-dir-a', 'tenant-a', '/api/admin/jobs?range=all')).json()
    )
    expect(jobs).toContain(marker('a', 'job'))
    expect(jobs).not.toContain(marker('b', 'job'))
  })

  it('does not show a cookie-org doc to a gateway tenant, and cookie login still works', async () => {
    const { user } = await upsertUser(
      gatewayEnv,
      {
        idp: 'github',
        idpSub: 'iso-cookie-user',
        email: 'iso-cookie@example.com',
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
    const session = `__Host-ctx_session=${cookie}`
    const posted = await request('/api/docs', {
      method: 'POST',
      headers: {
        cookie: `${session}; __Host-ctx_csrf=${csrf}`,
        origin: BASE,
        'x-csrf': csrf,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ title: marker('a', 'cookie-doc') })
    })
    expect(posted.status).toBe(201)
    const doc = (await posted.json()) as { id: string }

    const mine = await request(`/api/docs/${doc.id}`, { headers: { cookie: session } })
    expect(mine.status).toBe(200)
    expect(JSON.stringify(await mine.json())).toContain(marker('a', 'cookie-doc'))

    const hidden = await call('iso-cookie-gw', 'tenant-a', `/api/docs/${doc.id}`)
    expect(hidden.status).toBe(404)

    const gw = await call('iso-cookie-gw', 'tenant-a', '/api/docs', {
      method: 'POST',
      body: JSON.stringify({ title: marker('a', 'gw-doc') })
    })
    expect(gw.status).toBe(201)
    const gwDoc = (await gw.json()) as { id: string }
    const cookieList = await request('/api/docs', { headers: { cookie: session } })
    expect(cookieList.status).toBe(200)
    const cookieBody = JSON.stringify(await cookieList.json())
    expect(cookieBody).toContain(marker('a', 'cookie-doc'))
    // The cookie org is not partitioned. The gateway doc is an extra row
    // the operator session can still see; the assertion above is that the
    // cookie session itself still reads what it wrote.
    expect((await request(`/api/docs/${gwDoc.id}`, { headers: { cookie: session } })).status).toBe(
      200
    )
  })
})
