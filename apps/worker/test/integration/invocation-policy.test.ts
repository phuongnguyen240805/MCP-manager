import { createExecutionContext, env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../../src/env'
import type { InvocationPolicy } from '@ctxlayer/shared'
import { authorizeInvocation } from '../../src/policy/authorize-invocation'
import { putInvocationPolicy } from '../../src/db/queries/invocation-policies'
import { UpstreamProxyRegistry } from '../../src/mcp/proxy-registry'
import { hashJobKey } from '../../src/mcp/async-submit'
import { runJob } from '../../src/queues/jobs-consumer'
import { findJobById, insertRunningJob } from '../../src/db/queries/async-jobs'
import { seal } from '../../src/crypto/aead'
import { upsertSharedCredential } from '../../src/db/queries/upstream-credentials'
import { app } from '../../src/app'
import { signSession } from '../../src/auth/session'
import { canReadJob } from '../../src/policy/job-access'
import { visiblePolicyTools } from '../../src/policy/visible-tools'
import { resolveUserPrincipals } from '../../src/db/queries/tool-access'

const BASE = 'https://policy.test'
const testEnv: Env = {
  ...(env as unknown as Env),
  PUBLIC_BASE_URL: BASE,
  SESSION_COOKIE_SECRET: 'policy-test-secret',
  ENCRYPTION_KEY: 'JxQK0aw3pPRtKwhsoa3J9wQVcYAvkjbqcCpPjC4Sh7M='
}
const policy: InvocationPolicy = {
  productId: 'project',
  rules: [
    {
      tool: 'orders',
      action: 'list',
      effect: 'allow',
      principals: [{ principalKind: 'everyone', principalId: null }],
      resources: [{ argument: 'shop_id', values: ['shop-a'] }]
    }
  ]
}
const args = { action: 'list', shop_id: 'shop-a' }
const authorize = (input: unknown = args) =>
  authorizeInvocation(testEnv, 'user', 'upstream', 'orders', input)

afterEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare(`DELETE FROM upstream_servers WHERE id IN ('upstream', 'other')`),
    testEnv.DB.prepare(`DELETE FROM async_jobs WHERE id = 'job'`),
    testEnv.DB.prepare(`DELETE FROM users WHERE id = 'user'`),
    testEnv.DB.prepare(`DELETE FROM teams WHERE id = 'team'`),
    testEnv.DB.prepare(`DELETE FROM products WHERE id = 'project'`)
  ])
})

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare(`INSERT INTO users (id, email, idp, idp_sub, role, created_at)
      VALUES ('user', 'policy@test.local', 'github', 'policy-user', 'admin', 0)`),
    testEnv.DB.prepare(`INSERT INTO teams (id, slug, display_name, created_at, updated_at)
      VALUES ('team', 'team', 'Team', 0, 0)`),
    testEnv.DB.prepare(`INSERT INTO products (id, slug, display_name, created_at, updated_at)
      VALUES ('project', 'project', 'Project', 0, 0)`),
    testEnv.DB.prepare(
      `INSERT INTO team_members (team_id, user_id, created_at) VALUES ('team', 'user', 0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO team_products (team_id, product_id) VALUES ('team', 'project')`
    ),
    testEnv.DB.prepare(`INSERT INTO upstream_servers
      (id, slug, display_name, transport, url, auth_strategy, auth_config, created_at, updated_at)
      VALUES ('upstream', 'up-policy', 'Policy', 'streamable_http', 'https://upstream.test/mcp', 'none', '{}', 0, 0)`),
    testEnv.DB.prepare(`INSERT INTO upstream_visibility (upstream_id, scope_kind, scope_id)
      VALUES ('upstream', 'everyone', '')`),
    testEnv.DB.prepare(`INSERT INTO upstream_tools (upstream_id, tool_name, input_schema, cached_at)
      VALUES ('upstream', 'orders', '{}', ?1)`).bind(Math.floor(Date.now() / 1000))
  ])
})

describe('invocation authorization with real D1', () => {
  it('allows explicit project/action/resource and rejects write, unknown, missing and forged scope', async () => {
    await putInvocationPolicy(testEnv, 'upstream', policy, 0)
    expect((await authorize()).allowed).toBe(true)
    for (const input of [
      {},
      { action: 'delete', shop_id: 'shop-a' },
      { ...args, shop_id: 'shop-b' },
      { ...args, shop_id: ['shop-a'] },
      { action: 'list' }
    ]) {
      expect((await authorize(input)).allowed).toBe(false)
    }
  })

  it('revokes project membership without reconnecting or relying on tool visibility', async () => {
    await putInvocationPolicy(testEnv, 'upstream', policy, 0)
    expect((await authorize()).allowed).toBe(true)
    await testEnv.DB.prepare(`DELETE FROM team_members WHERE user_id = 'user'`).run()
    expect(await authorize()).toMatchObject({ allowed: false, code: 'scope_denied' })
  })

  it('does not let admin status bypass project scope or a revoked tool ACL', async () => {
    await testEnv.DB.prepare(`INSERT INTO tool_access (upstream_id, tool_name, principal_kind, principal_id, created_at)
      VALUES ('upstream', 'orders', 'team', 'other-team', 0)`).run()
    expect(await authorize()).toMatchObject({ allowed: false, code: 'access_denied' })
  })

  it.each([
    'pending',
    'suspended'
  ])('rejects a %s principal in an existing session', async (status) => {
    await testEnv.DB.prepare(`UPDATE users SET status = ?1 WHERE id = 'user'`).bind(status).run()
    expect((await authorize()).allowed).toBe(false)
  })

  it('fails closed for malformed persisted policy and does not inherit legacy access', async () => {
    await putInvocationPolicy(testEnv, 'upstream', policy, 0)
    await testEnv.DB.prepare(
      `UPDATE upstream_invocation_policies SET policy_json = '{broken'`
    ).run()
    expect(await authorize()).toMatchObject({ allowed: false, code: 'policy_invalid' })
  })

  it('requires approval instead of executing approval-required actions', async () => {
    await putInvocationPolicy(
      testEnv,
      'upstream',
      {
        ...policy,
        rules: [{ ...policy.rules[0]!, effect: 'approval_required' }]
      },
      0
    )
    expect(await authorize()).toMatchObject({ allowed: false, code: 'approval_required' })
  })

  it('uses compare-and-swap and protects the referenced project against deletion', async () => {
    expect(await putInvocationPolicy(testEnv, 'upstream', policy, 0)).toBe(true)
    expect(await putInvocationPolicy(testEnv, 'upstream', { ...policy, rules: [] }, 0)).toBe(false)
    expect(await putInvocationPolicy(testEnv, 'upstream', { ...policy, rules: [] }, 1)).toBe(true)
    expect((await authorize()).allowed).toBe(false)
    await expect(
      testEnv.DB.prepare(`DELETE FROM products WHERE id = 'project'`).run()
    ).rejects.toThrow()
  })
})

function transport() {
  const bearers: (string | null)[] = []
  const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }))
  const make = vi.fn((_conn: unknown, bearer: string | null) => {
    bearers.push(bearer)
    return { listTools: async () => [], callTool, close: async () => {} }
  })
  return { make, callTool, bearers }
}

async function oldHandler(factory: ReturnType<typeof transport>) {
  const handlers = new Map<string, (args: unknown) => Promise<{ isError?: boolean }>>()
  const server = {
    registerTool: (
      name: string,
      _schema: unknown,
      handler: (args: unknown) => Promise<{ isError?: boolean }>
    ) => handlers.set(name, handler)
  }
  await new UpstreamProxyRegistry(testEnv, 'user', async () => {}, 'session', factory.make).init(
    server as unknown as McpServer
  )
  const handler = handlers.get('up-policy__orders')
  if (!handler) throw new Error('Expected orders tool')
  return handler
}

describe('old sessions and independent connectors', () => {
  it.each([
    'disabled',
    'visibility',
    'tool-acl'
  ])('blocks %s without a reload and never calls upstream', async (change) => {
    const factory = transport()
    const handler = await oldHandler(factory)
    await handler(args)
    expect(factory.callTool).toHaveBeenCalledOnce()
    if (change === 'disabled')
      await testEnv.DB.prepare(`UPDATE upstream_servers SET enabled = 0`).run()
    if (change === 'visibility') await testEnv.DB.prepare(`DELETE FROM upstream_visibility`).run()
    if (change === 'tool-acl')
      await testEnv.DB.prepare(`INSERT INTO tool_access
      (upstream_id, tool_name, principal_kind, principal_id, created_at)
      VALUES ('upstream', 'orders', 'team', 'missing-team', 0)`).run()
    expect((await handler(args)).isError).toBe(true)
    expect(factory.callTool).toHaveBeenCalledOnce()
  })

  it('rotates shared credentials in the same second and refuses a deleted credential', async () => {
    await testEnv.DB.prepare(`UPDATE upstream_servers SET auth_strategy = 'shared_bearer'`).run()
    const save = async (token: string) => {
      const sealed = await seal(token, testEnv.ENCRYPTION_KEY)
      await upsertSharedCredential(testEnv, 'upstream', {
        kind: 'bearer',
        ...sealed,
        createdBy: 'user'
      })
    }
    await save('first-token')
    const factory = transport()
    const handler = await oldHandler(factory)
    await handler(args)
    await save('second-token')
    await handler(args)
    expect(factory.bearers).toEqual(['first-token', 'second-token'])
    await testEnv.DB.prepare(`DELETE FROM upstream_shared_credentials`).run()
    expect((await handler(args)).isError).toBe(true)
    expect(factory.callTool).toHaveBeenCalledTimes(2)
  })

  it('adds a second standard MCP without routing changes and isolates its kill switch', async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(`INSERT INTO upstream_servers
        (id, slug, display_name, transport, url, auth_strategy, auth_config, created_at, updated_at)
        VALUES ('other', 'up-other', 'Other', 'sse', 'https://other.test/mcp', 'none', '{}', 0, 0)`),
      testEnv.DB.prepare(`INSERT INTO upstream_visibility VALUES ('other', 'everyone', '')`)
    ])
    await testEnv.DB.prepare(`UPDATE upstream_servers SET enabled = 0 WHERE id = 'upstream'`).run()
    expect((await authorizeInvocation(testEnv, 'user', 'other', 'read', {})).allowed).toBe(true)
    expect((await authorize()).allowed).toBe(false)
  })
})

describe('queued work', () => {
  async function submit() {
    const argsJson = JSON.stringify(args)
    await insertRunningJob(testEnv, {
      id: 'job',
      userId: 'user',
      sessionId: 'session',
      upstreamId: 'upstream',
      tool: 'orders',
      jobKey: await hashJobKey('user', 'upstream', 'orders', argsJson),
      argsJson,
      createdAt: 1
    })
    return {
      jobId: 'job',
      userId: 'user',
      sessionId: 'session',
      upstreamId: 'upstream',
      tool: 'orders',
      argsJson
    }
  }

  it('blocks a queued job disabled after submission', async () => {
    const message = await submit()
    await testEnv.DB.prepare(`UPDATE upstream_servers SET enabled = 0`).run()
    const factory = transport()
    await runJob(testEnv, message, factory.make)
    expect(factory.callTool).not.toHaveBeenCalled()
    expect(await findJobById(testEnv, 'job')).toMatchObject({
      status: 'error',
      error_code: 'access_denied'
    })
  })

  it('rejects forged queue arguments without executing or changing the legitimate job', async () => {
    const message = await submit()
    const factory = transport()
    await runJob(testEnv, { ...message, argsJson: '{"action":"delete"}' }, factory.make)
    expect(factory.make).not.toHaveBeenCalled()
    expect((await findJobById(testEnv, 'job'))?.status).toBe('running')
  })

  it('removes access to results and discovery after project membership is revoked', async () => {
    await putInvocationPolicy(testEnv, 'upstream', policy, 0)
    await submit()
    const job = await findJobById(testEnv, 'job')
    if (!job) throw new Error('Missing job')
    expect(await canReadJob(testEnv, 'user', job)).toBe(true)
    expect(
      await visiblePolicyTools(testEnv, 'upstream', await resolveUserPrincipals(testEnv, 'user'))
    ).toEqual(new Set(['orders']))
    await testEnv.DB.prepare(`DELETE FROM team_members WHERE user_id = 'user'`).run()
    expect(await canReadJob(testEnv, 'user', job)).toBe(false)
    expect(
      await visiblePolicyTools(testEnv, 'upstream', await resolveUserPrincipals(testEnv, 'user'))
    ).toEqual(new Set())
  })
})

describe('policy admin API', () => {
  async function request(method: string, body?: unknown, role: 'admin' | 'user' = 'admin') {
    await testEnv.DB.prepare(`UPDATE users SET role = ?1 WHERE id = 'user'`).bind(role).run()
    const session = await signSession(
      { userId: 'user', role, epoch: 0 },
      testEnv.SESSION_COOKIE_SECRET
    )
    return app.request(
      `${BASE}/api/admin/upstreams/upstream/invocation-policy`,
      {
        method,
        headers: {
          cookie: `__Host-ctx_session=${session}; __Host-ctx_csrf=csrf`,
          origin: BASE,
          'x-csrf': 'csrf',
          'content-type': 'application/json'
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      },
      testEnv,
      createExecutionContext()
    )
  }

  it('persists a policy and rejects stale edits and unknown projects', async () => {
    expect((await request('PUT', { expectedVersion: 0, policy })).status).toBe(200)
    expect(await (await request('GET')).json()).toEqual({ version: 1, policy })
    expect((await request('PUT', { expectedVersion: 0, policy })).status).toBe(409)
    expect(
      (await request('PUT', { expectedVersion: 1, policy: { ...policy, productId: 'missing' } }))
        .status
    ).toBe(400)
  })

  it('requires admin and rejects ambiguous or malformed rules', async () => {
    expect((await request('PUT', { expectedVersion: 0, policy }, 'user')).status).toBe(403)
    expect(
      (
        await request('PUT', {
          expectedVersion: 0,
          policy: { ...policy, rules: [...policy.rules, ...policy.rules] }
        })
      ).status
    ).toBe(400)
  })
})
