#!/usr/bin/env bun
import { readFileSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { signSession } from '../apps/worker/src/auth/session.ts'

// This harness only creates fake local identities/data and only sends cookies to loopback HTTPS.
const root = resolve(import.meta.dirname, '..')
const base = new URL(process.argv[2] ?? 'https://localhost:8787')
if (
  base.protocol !== 'https:' ||
  !['localhost', '127.0.0.1'].includes(base.hostname) ||
  base.pathname !== '/'
) {
  throw new Error('Use a loopback HTTPS Worker origin only')
}
const fixtures = ['http://127.0.0.1:3101', 'http://127.0.0.1:3102']
const fixtureHeaders = { authorization: 'Bearer kedi-local-fixture' }
const tls = { rejectUnauthorized: false }
let passed = 0
function check(condition, label) {
  if (!condition) throw new Error(`Local acceptance failed: ${label}`)
  passed++
  console.log(`✓ ${label}`)
}
for (const url of fixtures) {
  const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) }).then((r) =>
    r.json()
  )
  check(health.localFixture === true, `fake MCP available at ${url}`)
}
check(
  (await fetch(`${base.origin}/api/health`, { tls, signal: AbortSignal.timeout(5000) })).ok,
  'local Worker available'
)

const vars = parseEnv(readFileSync(join(root, '.dev.vars'), 'utf8'))
if (!vars.SESSION_COOKIE_SECRET)
  throw new Error('Configure SESSION_COOKIE_SECRET in ignored .dev.vars first')
const run = crypto.randomUUID().slice(0, 8)
const userId = `fixture-user-${run}`
const adminId = `fixture-admin-${run}`
const projectId = `fixture-project-${run}`
const teamId = `fixture-team-${run}`
const sqlValue = (value) => `'${value.replaceAll("'", "''")}'`
const sql = `INSERT INTO users (id,email,idp,idp_sub,role,created_at) VALUES
  (${sqlValue(userId)},${sqlValue(`requester-${run}@kedi-local.test`)},'github',${sqlValue(userId)},'user',0),
  (${sqlValue(adminId)},${sqlValue(`approver-${run}@kedi-local.test`)},'github',${sqlValue(adminId)},'admin',0);
INSERT INTO teams (id,slug,display_name,created_at,updated_at)
  VALUES (${sqlValue(teamId)},${sqlValue(`tm-local-${run}`)},'KEDI local fixture',0,0);
INSERT INTO products (id,slug,display_name,created_at,updated_at)
  VALUES (${sqlValue(projectId)},${sqlValue(`pr-local-${run}`)},'KEDI local fixture',0,0);
INSERT INTO team_members(team_id,user_id,created_at) VALUES
  (${sqlValue(teamId)},${sqlValue(userId)},0),(${sqlValue(teamId)},${sqlValue(adminId)},0);
INSERT INTO team_products VALUES (${sqlValue(teamId)},${sqlValue(projectId)});`
const directory = mkdtempSync(join(tmpdir(), 'kedi-local-'))
const seed = join(directory, 'seed.sql')
try {
  writeFileSync(seed, sql)
  const result = Bun.spawnSync(
    [process.execPath, 'x', 'wrangler', 'd1', 'execute', 'DB', '--local', '--file', seed],
    {
      // Match the dev Worker's pinned Wrangler/workerd instead of the root CLI version.
      cwd: join(root, 'apps/worker'),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...Bun.env, WRANGLER_SEND_METRICS: 'false' }
    }
  )
  if (result.exitCode !== 0) {
    let detail = `${result.stdout.toString()}\n${result.stderr.toString()}`.slice(-4000)
    for (const value of Object.values(vars))
      if (value.length > 8) detail = detail.replaceAll(value, '[redacted]')
    console.error(detail)
    throw new Error('Local seed failed. Start dev:worker:local to apply migrations first.')
  }
} finally {
  unlinkSync(seed)
  rmdirSync(directory)
}
const cookies = new Map()
for (const [id, role] of [
  [userId, 'user'],
  [adminId, 'admin']
]) {
  const token = await signSession({ userId: id, role, epoch: 0 }, vars.SESSION_COOKIE_SECRET)
  cookies.set(id, `__Host-ctx_session=${token}; __Host-ctx_csrf=local-fixture`)
}
async function api(actor, path, method = 'GET', body, expected = 200) {
  const response = await fetch(`${base.origin}${path}`, {
    method,
    tls,
    signal: AbortSignal.timeout(20000),
    headers: {
      cookie: cookies.get(actor),
      origin: base.origin,
      'x-csrf': 'local-fixture',
      'content-type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const value = response.status === 204 ? null : await response.json()
  if (response.status !== expected)
    throw new Error(
      `${method} ${path}: expected ${expected}, got ${response.status} (${value?.error ?? 'error'})`
    )
  return value
}
const rules = ['list', 'create', 'simulate_timeout'].map((action) => ({
  tool: 'manage_orders',
  action,
  effect: action === 'list' ? 'allow' : 'approval_required',
  principals: [{ principalKind: 'everyone', principalId: null }],
  resources: [{ argument: 'shop_id', values: ['shop-local'] }]
}))
const upstreams = []
for (const [i, fixture] of fixtures.entries()) {
  const upstream = await api(
    adminId,
    '/api/admin/upstreams',
    'POST',
    {
      slug: `up-local-${i}-${run}`,
      displayName: `Local fixture ${i + 1} (${run})`,
      transport: 'streamable_http',
      url: `${fixture}/mcp`,
      authStrategy: 'shared_bearer',
      enabled: false
    },
    201
  )
  upstreams.push(upstream)
  const path = `/api/admin/upstreams/${upstream.id}`
  await api(
    adminId,
    `${path}/visibility`,
    'PUT',
    { rules: [{ scopeKind: 'everyone', scopeId: null }] },
    204
  )
  await api(adminId, `${path}/shared-credentials`, 'PUT', { token: 'kedi-local-fixture' }, 204)
  const catalog = await api(adminId, `${path}/refresh-tools`, 'POST')
  check(catalog.toolsCount === 1, `connector ${i + 1}: catalog discovered through HTTP adapter`)
  await api(adminId, `${path}/invocation-policy`, 'PUT', {
    expectedVersion: 0,
    policy: { productId: projectId, rules }
  })
  await api(adminId, path, 'PATCH', { enabled: true }, 204)
}
const [first, second] = upstreams
const state = (i) =>
  fetch(`${fixtures[i]}/fixture/state`, { headers: fixtureHeaders }).then((r) => r.json())
const request = (upstream, action, amount = 100, requestId = crypto.randomUUID()) =>
  api(userId, '/api/operations', 'POST', {
    requestId,
    upstream: upstream.slug,
    tool: 'manage_orders',
    args: { action, shop_id: 'shop-local', amount }
  })
const approve = (upstream, operation) =>
  api(adminId, `/api/admin/upstreams/${upstream.id}/operations/${operation.id}/decision`, 'POST', {
    action: 'approve'
  })
const execute = (operation) => api(userId, `/api/operations/${operation.id}/execute`, 'POST')
const before = await state(0)
const requestId = crypto.randomUUID()
const pending = await request(first, 'create', 100, requestId)
check(pending.state === 'pending', 'write creates a pending operation')
check(
  (await execute(pending)).state === 'pending' && (await state(0)).writes === before.writes,
  'unapproved operation cannot write'
)
check(
  (await request(first, 'create', 100, requestId)).id === pending.id,
  'same request ID recovers the same operation'
)
await api(
  userId,
  '/api/operations',
  'POST',
  {
    requestId,
    upstream: first.slug,
    tool: 'manage_orders',
    args: { action: 'create', shop_id: 'shop-local', amount: 999 }
  },
  409
)
check(true, 'changed intent cannot reuse a request ID')
await approve(first, pending)
await Promise.all([execute(pending), execute(pending)])
check(
  (await state(0)).writes === before.writes + 1,
  'simultaneous approved retries dispatch exactly one fake write'
)
check(
  (await execute(pending)).state === 'succeeded' && (await state(0)).writes === before.writes + 1,
  'completed operation replays without dispatch'
)
await api(
  userId,
  '/api/operations',
  'POST',
  {
    requestId: crypto.randomUUID(),
    upstream: first.slug,
    tool: 'manage_orders',
    args: { action: 'create', shop_id: 'other-shop', amount: 100 }
  },
  403
)
check(true, 'wrong shop is blocked')

const ambiguous = await request(first, 'simulate_timeout')
await approve(first, ambiguous)
check(
  (await execute(ambiguous)).state === 'unknown',
  'applied write plus ambiguous provider error becomes unknown'
)
const afterAmbiguous = await state(0)
await execute(ambiguous)
check(
  (await state(0)).writes === afterAmbiguous.writes,
  'unknown operation is never automatically resent'
)
await api(adminId, `/api/admin/upstreams/${first.id}/operations/${ambiguous.id}/decision`, 'POST', {
  action: 'resolve',
  outcome: 'succeeded',
  note: 'Verified fake order in the local fixture state',
  reference: afterAmbiguous.orders.at(-1).id
})
check(
  (await execute(ambiguous)).state === 'succeeded' &&
    (await state(0)).writes === afterAmbiguous.writes,
  'manual reconciliation records outcome without resending'
)

const queuedIntent = await request(first, 'create')
await approve(first, queuedIntent)
await api(adminId, `/api/admin/upstreams/${first.id}`, 'PATCH', { enabled: false }, 204)
await api(userId, `/api/operations/${queuedIntent.id}/execute`, 'POST', undefined, 403)
const otherBefore = await state(1)
const independent = await request(second, 'create')
await approve(second, independent)
check(
  (await execute(independent)).state === 'succeeded' &&
    (await state(1)).writes === otherBefore.writes + 1,
  'second MCP works while first MCP is disabled'
)
check(
  (await state(0)).writes === afterAmbiguous.writes,
  'disabled connection did not dispatch the waiting operation'
)
console.log(
  `Local KEDI acceptance passed: ${passed} checks. Fake fixture run ${run}; no provider APIs used.`
)
