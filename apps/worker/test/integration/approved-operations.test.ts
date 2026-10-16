import { createExecutionContext, env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import { requestOperation, getOperation } from '../../src/operations/requests'
import { decideOperation } from '../../src/operations/decisions'
import { executeOperation } from '../../src/operations/execute'
import { findOperation } from '../../src/db/queries/operations'
import { putInvocationPolicy } from '../../src/db/queries/invocation-policies'
import { authorizeInvocation } from '../../src/policy/authorize-invocation'
import { app } from '../../src/app'
import { signSession } from '../../src/auth/session'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'
import { registerOperationTools } from '../../src/mcp/operation-tools'
import { UpstreamProxyRegistry } from '../../src/mcp/proxy-registry'
import type { UpstreamConnection } from '../../src/db/queries/upstreams'
import { seal } from '../../src/crypto/aead'
import { upsertSharedCredential } from '../../src/db/queries/upstream-credentials'

const BASE = 'https://operations.test'
const testEnv: Env = {
  ...(env as unknown as Env),
  PUBLIC_BASE_URL: BASE,
  SESSION_COOKIE_SECRET: 'operation-test-secret',
  ENCRYPTION_KEY: 'JxQK0aw3pPRtKwhsoa3J9wQVcYAvkjbqcCpPjC4Sh7M='
}
const input = {
  requestId: 'intent-001',
  upstream: 'up-op',
  tool: 'orders',
  args: { action: 'create', shop_id: 'shop-a', amount: 100 }
}
const policy = {
  productId: 'op-project',
  rules: [
    {
      tool: 'orders',
      action: 'create',
      principals: [{ principalKind: 'everyone' as const, principalId: null }],
      resources: [{ argument: 'shop_id', values: ['shop-a'] }],
      effect: 'approval_required' as const
    }
  ]
}

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare(`INSERT INTO users (id, email, idp, idp_sub, role, created_at) VALUES
      ('op-user','requester@op.test','github','op-user','user',0),
      ('op-admin','approver@op.test','github','op-admin','admin',0),
      ('op-outsider','outsider@op.test','github','op-outsider','admin',0)`),
    testEnv.DB.prepare(
      `INSERT INTO teams (id,slug,display_name,created_at,updated_at) VALUES ('op-team','op-team','Team',0,0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO products (id,slug,display_name,created_at,updated_at) VALUES ('op-project','op-project','Project',0,0)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO team_members (team_id,user_id,created_at) VALUES ('op-team','op-user',0),('op-team','op-admin',0)`
    ),
    testEnv.DB.prepare(`INSERT INTO team_products VALUES ('op-team','op-project')`),
    testEnv.DB.prepare(`INSERT INTO upstream_servers (id,slug,display_name,transport,url,auth_strategy,auth_config,created_at,updated_at)
      VALUES ('op-up','up-op','Operations','streamable_http','https://op-up.test/mcp','none','{}',0,0)`),
    testEnv.DB.prepare(`INSERT INTO upstream_visibility VALUES ('op-up','everyone','')`),
    testEnv.DB.prepare(`INSERT INTO upstream_tools (upstream_id,tool_name,input_schema,cached_at) VALUES
      ('op-up','orders',?1,0)`).bind(
      JSON.stringify({
        type: 'object',
        properties: {
          action: { type: 'string' },
          shop_id: { type: 'string' },
          amount: { type: 'number' }
        },
        required: ['action', 'shop_id', 'amount']
      })
    )
  ])
  await putInvocationPolicy(testEnv, 'op-up', policy, 0)
})

afterEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `DELETE FROM operation_events WHERE operation_id IN (SELECT id FROM upstream_operations WHERE upstream_id = 'op-up')`
    ),
    testEnv.DB.prepare(`DELETE FROM upstream_operations WHERE upstream_id = 'op-up'`),
    testEnv.DB.prepare(`DELETE FROM upstream_servers WHERE id = 'op-up'`),
    testEnv.DB.prepare(`DELETE FROM users WHERE id IN ('op-user','op-admin','op-outsider')`),
    testEnv.DB.prepare(`DELETE FROM teams WHERE id = 'op-team'`),
    testEnv.DB.prepare(`DELETE FROM products WHERE id = 'op-project'`)
  ])
})

async function approved() {
  const operation = await requestOperation(testEnv, 'op-user', input)
  await decideOperation(testEnv, 'op-admin', operation.id, { action: 'approve' })
  return operation
}

function fakeTransport(failure = false) {
  const callTool = vi.fn(async () => {
    if (failure) throw new Error('Provider timed out after dispatch')
    return { content: [{ type: 'text', text: 'created order 123' }] }
  })
  const makeClient = vi.fn(() => ({ callTool, listTools: async () => [], close: async () => {} }))
  return { callTool, makeClient }
}

describe('approved operations with real D1', () => {
  it('invalidates an approved operation after same-second shared credential rotation', async () => {
    await testEnv.DB.prepare(
      `UPDATE upstream_servers SET auth_strategy = 'shared_bearer' WHERE id = 'op-up'`
    ).run()
    const save = async (token: string) => {
      const sealed = await seal(token, testEnv.ENCRYPTION_KEY)
      await upsertSharedCredential(testEnv, 'op-up', {
        kind: 'bearer',
        ...sealed,
        createdBy: 'op-admin'
      })
    }
    await save('first-fixture-token')
    const operation = await approved()
    await save('second-fixture-token')
    const transport = fakeTransport()
    await expect(
      executeOperation(testEnv, 'op-user', operation.id, transport.makeClient)
    ).rejects.toThrow('approval_snapshot_changed')
    expect(transport.callTool).not.toHaveBeenCalled()
  })
  it('does not dispatch when the atomic execution claim cannot be audited', async () => {
    const operation = await approved()
    await testEnv.DB.prepare(`CREATE TRIGGER fail_running_audit BEFORE INSERT ON audit_log
      WHEN NEW.action = 'operation.running' BEGIN SELECT RAISE(ABORT, 'simulated claim audit failure'); END`).run()
    const transport = fakeTransport()
    try {
      await expect(
        executeOperation(testEnv, 'op-user', operation.id, transport.makeClient)
      ).rejects.toThrow()
      expect(transport.callTool).not.toHaveBeenCalled()
      expect((await findOperation(testEnv, operation.id))?.state).toBe('approved')
    } finally {
      await testEnv.DB.prepare(`DROP TRIGGER fail_running_audit`).run()
    }
  })

  it('never resends after provider success followed by a failed result commit', async () => {
    const operation = await approved()
    await testEnv.DB.prepare(`CREATE TRIGGER fail_operation_finish BEFORE UPDATE OF state ON upstream_operations
      WHEN NEW.state = 'succeeded' BEGIN SELECT RAISE(ABORT, 'simulated result commit failure'); END`).run()
    const transport = fakeTransport()
    try {
      const result = await executeOperation(testEnv, 'op-user', operation.id, transport.makeClient)
      expect(result.state).toBe('unknown')
      await executeOperation(testEnv, 'op-user', operation.id, transport.makeClient)
      expect(transport.callTool).toHaveBeenCalledOnce()
    } finally {
      await testEnv.DB.prepare(`DROP TRIGGER fail_operation_finish`).run()
    }
  })
  it('completes a real MCP SDK request → approval → execute → replay round trip', async () => {
    await putInvocationPolicy(
      testEnv,
      'op-up',
      {
        ...policy,
        rules: [...policy.rules, { ...policy.rules[0]!, action: 'list', effect: 'allow' }]
      },
      1
    )
    let writes = 0
    const connections: Array<{ close: () => Promise<void> }> = []
    const makeClient = (_conn: UpstreamConnection, _bearer: string | null) => {
      let pending: Promise<Client> | undefined
      async function connect() {
        if (!pending)
          pending = (async () => {
            const leaf = new McpServer({ name: 'fake-pos', version: '0.1.0' })
            leaf.registerTool(
              'orders',
              {
                inputSchema: {
                  action: z.enum(['list', 'create']),
                  shop_id: z.string(),
                  amount: z.number().optional()
                }
              },
              async (args) => {
                if (args.action === 'create') writes++
                return {
                  content: [
                    { type: 'text', text: JSON.stringify({ orderId: 'fixture-123', writes }) }
                  ]
                }
              }
            )
            const client = new Client({ name: 'hub-upstream', version: '0.1.0' })
            connections.push(leaf, client)
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
            await Promise.all([leaf.connect(serverTransport), client.connect(clientTransport)])
            return client
          })()
        return pending
      }
      return {
        listTools: async () =>
          (await (await connect()).listTools()).tools.map((tool) => ({
            toolName: tool.name,
            description: tool.description ?? null,
            inputSchema: tool.inputSchema
          })),
        callTool: async (name: string, args: unknown) => {
          const result = await (await connect()).callTool({
            name,
            arguments: args as Record<string, unknown>
          })
          return {
            content: result.content,
            isError: result.isError === true,
            structuredContent: result.structuredContent
          }
        },
        close: async () => {
          if (pending) await (await pending).close()
        }
      }
    }
    const hub = new McpServer({ name: 'kedi-local-hub', version: '0.1.0' })
    const client = new Client({ name: 'local-ai-client', version: '0.1.0' })
    connections.push(hub, client)
    try {
      await new UpstreamProxyRegistry(
        testEnv,
        'op-user',
        async () => {},
        'local-session',
        makeClient
      ).init(hub)
      registerOperationTools(
        hub,
        testEnv,
        (_tool, _args, run) => run(),
        () => 'op-user',
        makeClient
      )
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await Promise.all([hub.connect(serverTransport), client.connect(clientTransport)])
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
        'request_operation'
      )
      const read = await client.callTool({
        name: 'up-op__orders',
        arguments: { action: 'list', shop_id: 'shop-a' }
      })
      expect(read.isError).not.toBe(true)
      expect(writes).toBe(0)
      const blocked = await client.callTool({ name: 'up-op__orders', arguments: input.args })
      expect(blocked.isError).toBe(true)
      expect(writes).toBe(0)
      const response = await client.callTool({ name: 'request_operation', arguments: input })
      const content = response.content as Array<{ text: string }>
      const operation = JSON.parse(content[0]!.text) as { id: string; state: string }
      expect(operation.state).toBe('pending')
      await decideOperation(testEnv, 'op-admin', operation.id, { action: 'approve' })
      for (let i = 0; i < 2; i++) {
        const executed = await client.callTool({
          name: 'execute_operation',
          arguments: { operation_id: operation.id }
        })
        expect(executed.isError).not.toBe(true)
        expect(JSON.parse((executed.content as Array<{ text: string }>)[0]!.text).state).toBe(
          'succeeded'
        )
      }
      expect(writes).toBe(1)
      await testEnv.DB.prepare(`UPDATE upstream_servers SET enabled = 0 WHERE id = 'op-up'`).run()
      expect(
        (
          await client.callTool({
            name: 'get_operation',
            arguments: { operation_id: operation.id }
          })
        ).isError
      ).toBe(true)
    } finally {
      await Promise.allSettled(connections.map((connection) => connection.close()))
    }
  })

  it('rolls back the operation when its security audit cannot commit', async () => {
    await testEnv.DB.prepare(`CREATE TRIGGER fail_operation_audit BEFORE INSERT ON audit_log
      WHEN NEW.action LIKE 'operation.%' BEGIN SELECT RAISE(ABORT, 'simulated audit failure'); END`).run()
    try {
      await expect(requestOperation(testEnv, 'op-user', input)).rejects.toThrow()
      const row = await testEnv.DB.prepare(
        `SELECT COUNT(*) AS n FROM upstream_operations WHERE requester_id = 'op-user'`
      ).first<{ n: number }>()
      expect(row?.n).toBe(0)
    } finally {
      await testEnv.DB.prepare(`DROP TRIGGER fail_operation_audit`).run()
    }
  })
  it('requires approval on the ordinary direct/queue invocation path', async () => {
    expect(
      await authorizeInvocation(testEnv, 'op-user', 'op-up', 'orders', input.args)
    ).toMatchObject({ allowed: false, code: 'approval_required' })
    const pending = await requestOperation(testEnv, 'op-user', input)
    const transport = fakeTransport()
    expect(
      (await executeOperation(testEnv, 'op-user', pending.id, transport.makeClient)).state
    ).toBe('pending')
    expect(transport.callTool).not.toHaveBeenCalled()
  })

  it('reuses a request ID with canonical arguments and rejects changed intent', async () => {
    const first = await requestOperation(testEnv, 'op-user', input)
    const retry = await requestOperation(testEnv, 'op-user', {
      ...input,
      args: { amount: 100, shop_id: 'shop-a', action: 'create' }
    })
    expect(retry.id).toBe(first.id)
    await expect(
      requestOperation(testEnv, 'op-user', { ...input, args: { ...input.args, amount: 101 } })
    ).rejects.toThrow('request_id_conflict')
  })

  it('does not accept invalid types or an out-of-scope resource', async () => {
    await expect(
      requestOperation(testEnv, 'op-user', { ...input, args: { ...input.args, amount: 'bad' } })
    ).rejects.toThrow('invalid_tool_args')
    await expect(
      requestOperation(testEnv, 'op-user', { ...input, args: { ...input.args, shop_id: 'shop-b' } })
    ).rejects.toThrow('scope_denied')
  })

  it('requires a different admin with project access', async () => {
    const operation = await requestOperation(testEnv, 'op-user', input)
    await testEnv.DB.prepare(`UPDATE users SET role = 'admin' WHERE id = 'op-user'`).run()
    await expect(
      decideOperation(testEnv, 'op-user', operation.id, { action: 'approve' })
    ).rejects.toThrow('approver_required')
    await expect(
      decideOperation(testEnv, 'op-outsider', operation.id, { action: 'approve' })
    ).rejects.toThrow('approver_required')
  })

  it('executes only once under simultaneous retries and durably records each transition', async () => {
    const operation = await approved()
    const transport = fakeTransport()
    await Promise.all([
      executeOperation(testEnv, 'op-user', operation.id, transport.makeClient),
      executeOperation(testEnv, 'op-user', operation.id, transport.makeClient)
    ])
    expect(transport.callTool).toHaveBeenCalledOnce()
    const repeat = await executeOperation(testEnv, 'op-user', operation.id, transport.makeClient)
    expect(repeat.state).toBe('succeeded')
    expect(repeat.result_json).toContain('created order 123')
    expect(transport.callTool).toHaveBeenCalledOnce()
    const events = await testEnv.DB.prepare(
      `SELECT state FROM operation_events WHERE operation_id = ?1 ORDER BY id`
    )
      .bind(operation.id)
      .all<{ state: string }>()
    expect(events.results.map((event) => event.state)).toEqual([
      'pending',
      'approved',
      'running',
      'succeeded'
    ])
  })

  it.each(['policy', 'catalog', 'url'])('invalidates approval when %s changes', async (change) => {
    const operation = await approved()
    if (change === 'policy') await putInvocationPolicy(testEnv, 'op-up', policy, 1)
    if (change === 'catalog')
      await testEnv.DB.prepare(
        `UPDATE upstream_tools SET input_schema = ?1 WHERE upstream_id = 'op-up'`
      )
        .bind(JSON.stringify({ type: 'object' }))
        .run()
    if (change === 'url')
      await testEnv.DB.prepare(
        `UPDATE upstream_servers SET url = 'https://changed.test/mcp' WHERE id = 'op-up'`
      ).run()
    const transport = fakeTransport()
    await expect(
      executeOperation(testEnv, 'op-user', operation.id, transport.makeClient)
    ).rejects.toThrow('approval_snapshot_changed')
    expect(transport.callTool).not.toHaveBeenCalled()
  })

  it.each([
    'disabled',
    'requester',
    'approver'
  ])('blocks execution after %s revocation', async (change) => {
    const operation = await approved()
    if (change === 'disabled')
      await testEnv.DB.prepare(`UPDATE upstream_servers SET enabled = 0 WHERE id = 'op-up'`).run()
    if (change === 'requester')
      await testEnv.DB.prepare(`DELETE FROM team_members WHERE user_id = 'op-user'`).run()
    if (change === 'approver')
      await testEnv.DB.prepare(`UPDATE users SET status = 'suspended' WHERE id = 'op-admin'`).run()
    const transport = fakeTransport()
    await expect(
      executeOperation(testEnv, 'op-user', operation.id, transport.makeClient)
    ).rejects.toThrow()
    expect(transport.callTool).not.toHaveBeenCalled()
  })

  it('expires approvals and never dispatches an already-running or unknown operation again', async () => {
    const operation = await approved()
    await testEnv.DB.prepare(`UPDATE upstream_operations SET expires_at = 0 WHERE id = ?1`)
      .bind(operation.id)
      .run()
    const transport = fakeTransport()
    expect(
      (await executeOperation(testEnv, 'op-user', operation.id, transport.makeClient)).state
    ).toBe('expired')
    expect(transport.callTool).not.toHaveBeenCalled()
    const running = await approvedWithNewRequest('intent-running')
    await testEnv.DB.prepare(
      `UPDATE upstream_operations SET state = 'running', started_at = 0 WHERE id = ?1`
    )
      .bind(running.id)
      .run()
    expect(
      (await executeOperation(testEnv, 'op-user', running.id, transport.makeClient)).state
    ).toBe('unknown')
    expect(transport.callTool).not.toHaveBeenCalled()
  })

  it('records an ambiguous provider timeout and permits human reconciliation without resending', async () => {
    const operation = await approved()
    const transport = fakeTransport(true)
    expect(
      (await executeOperation(testEnv, 'op-user', operation.id, transport.makeClient)).state
    ).toBe('unknown')
    await executeOperation(testEnv, 'op-user', operation.id, transport.makeClient)
    expect(transport.callTool).toHaveBeenCalledOnce()
    const resolved = await decideOperation(testEnv, 'op-admin', operation.id, {
      action: 'resolve',
      outcome: 'succeeded',
      note: 'Verified order exists in provider records',
      reference: 'order-123'
    })
    expect(resolved.state).toBe('succeeded')
    expect(resolved.resolution_json).toContain('order-123')
    await executeOperation(testEnv, 'op-user', operation.id, transport.makeClient)
    expect(transport.callTool).toHaveBeenCalledOnce()
  })

  it('requires current ownership and scope when reading recorded results', async () => {
    const operation = await approved()
    await executeOperation(testEnv, 'op-user', operation.id, fakeTransport().makeClient)
    await expect(getOperation(testEnv, 'op-outsider', operation.id)).rejects.toThrow('not_found')
    await testEnv.DB.prepare(`DELETE FROM team_members WHERE user_id = 'op-user'`).run()
    await expect(getOperation(testEnv, 'op-user', operation.id)).rejects.toThrow('access_denied')
  })

  it('rejects a changed persisted request before sending it', async () => {
    const operation = await approved()
    await testEnv.DB.prepare(`UPDATE upstream_operations SET args_json = ?1 WHERE id = ?2`)
      .bind(JSON.stringify({ ...input.args, amount: 999 }), operation.id)
      .run()
    const transport = fakeTransport()
    await expect(
      executeOperation(testEnv, 'op-user', operation.id, transport.makeClient)
    ).rejects.toThrow('request_changed')
    expect(transport.callTool).not.toHaveBeenCalled()
  })
})

async function approvedWithNewRequest(requestId: string) {
  const operation = await requestOperation(testEnv, 'op-user', { ...input, requestId })
  return decideOperation(testEnv, 'op-admin', operation.id, { action: 'approve' })
}

describe('approval admin API', () => {
  async function api(userId: string, path: string, method = 'GET', body?: unknown) {
    const role = userId === 'op-user' ? 'user' : 'admin'
    const session = await signSession({ userId, role, epoch: 0 }, testEnv.SESSION_COOKIE_SECRET)
    return app.request(
      `${BASE}/api/admin/upstreams/op-up/operations${path}`,
      {
        method,
        headers: {
          cookie: `__Host-ctx_session=${session}; __Host-ctx_csrf=csrf`,
          origin: BASE,
          'x-csrf': 'csrf',
          'content-type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
      },
      testEnv,
      createExecutionContext()
    )
  }

  it('lists only project-scoped requests and records approval without executing', async () => {
    const operation = await requestOperation(testEnv, 'op-user', input)
    expect((await api('op-user', '')).status).toBe(403)
    expect(await (await api('op-outsider', '')).json()).toEqual({ operations: [] })
    const response = await api('op-admin', `/${operation.id}/decision`, 'POST', {
      action: 'approve'
    })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { state: string }).state).toBe('approved')
    expect((await findOperation(testEnv, operation.id))?.started_at).toBeNull()
    expect(
      (await api('op-admin', `/${operation.id}/decision`, 'POST', { action: 'approve' })).status
    ).toBe(409)
  })
})
