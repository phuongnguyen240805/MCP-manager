import { env } from 'cloudflare:test'
import { expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Env } from '../../src/env'
import { UpstreamProxyRegistry } from '../../src/mcp/proxy-registry'
import { registerIntegrationIdentity } from '../../src/mcp/integration-identity'
import { putInvocationPolicy } from '../../src/db/queries/invocation-policies'
import { z } from 'zod'

it('serves integration identity and a catalog contract through live Gateway ACL; OFF blocks an existing session', async () => {
  const testEnv = env as unknown as Env
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      "INSERT INTO users(id,email,idp,idp_sub,role,created_at) VALUES('catalog-user','sync@catalog.test','github','catalog','user',0)"
    ),
    testEnv.DB.prepare(
      "INSERT INTO teams(id,slug,display_name,created_at,updated_at) VALUES('catalog-team','catalog-team','Catalog',0,0)"
    ),
    testEnv.DB.prepare(
      "INSERT INTO products(id,slug,display_name,created_at,updated_at) VALUES('catalog-project','catalog-project','Catalog',0,0)"
    ),
    testEnv.DB.prepare("INSERT INTO team_members VALUES('catalog-team','catalog-user','member',0)"),
    testEnv.DB.prepare("INSERT INTO team_products VALUES('catalog-team','catalog-project')"),
    testEnv.DB.prepare(
      "INSERT INTO upstream_servers(id,slug,display_name,transport,url,auth_strategy,auth_config,created_at,updated_at) VALUES('catalog-up','up-catalog','Catalog','streamable_http','https://catalog.test/mcp','none','{}',0,0)"
    ),
    testEnv.DB.prepare("INSERT INTO upstream_visibility VALUES('catalog-up','everyone','')"),
    testEnv.DB.prepare(
      "INSERT INTO upstream_tools(upstream_id,tool_name,input_schema,cached_at) VALUES('catalog-up','read_catalog_snapshot',?,0)"
    ).bind(
      JSON.stringify({
        type: 'object',
        properties: {
          action: { type: 'string' },
          warehouse_id: { type: 'string' },
          page_number: { type: 'number' }
        },
        required: ['action', 'warehouse_id', 'page_number']
      })
    )
  ])
  await putInvocationPolicy(
    testEnv,
    'catalog-up',
    {
      productId: 'catalog-project',
      rules: [
        {
          tool: 'read_catalog_snapshot',
          action: 'page',
          principals: [{ principalKind: 'everyone', principalId: null }],
          resources: [{ argument: 'warehouse_id', values: ['w1'] }],
          effect: 'allow'
        }
      ]
    },
    0
  )
  let reads = 0
  const servers: McpServer[] = []
  const makeClient = () => {
    let pending: Promise<Client> | undefined
    const connect = () =>
      (pending ??= (async () => {
        const leaf = new McpServer({ name: 'pancake', version: '1' })
        servers.push(leaf)
        leaf.registerTool(
          'read_catalog_snapshot',
          {
            inputSchema: {
              action: z.literal('page'),
              warehouse_id: z.string(),
              page_number: z.number()
            }
          },
          async () => {
            reads++
            const data = {
              schema_version: 1,
              shop_id: '1',
              warehouse: { id: 'w1', name: 'Main' },
              success: true,
              data: [
                {
                  id: 'v1',
                  product_id: 'p1',
                  retail_price: 99000,
                  display_id: 'SKU',
                  product: { name: 'Fruit' },
                  variations_warehouses: [{ warehouse_id: 'w1', remain_quantity: 8 }]
                }
              ],
              total_entries: 1,
              total_pages: 1,
              page_number: 1
            }
            return {
              structuredContent: data,
              content: [{ type: 'text', text: JSON.stringify(data) }]
            }
          }
        )
        const client = new Client({ name: 'hub-upstream', version: '1' })
        const [a, b] = InMemoryTransport.createLinkedPair()
        await leaf.connect(b)
        await client.connect(a)
        return client
      })())
    return {
      listTools: async () =>
        (await (await connect()).listTools()).tools.map((t) => ({
          toolName: t.name,
          description: t.description ?? null,
          inputSchema: t.inputSchema
        })),
      callTool: async (name: string, args: unknown) => {
        const r = await (await connect()).callTool({
          name,
          arguments: args as Record<string, unknown>
        })
        return {
          content: r.content,
          isError: r.isError === true,
          structuredContent: r.structuredContent
        }
      },
      close: async () => {
        if (pending) await (await pending).close()
      }
    }
  }
  const hub = new McpServer({ name: 'ctxlayer', version: '1' }),
    client = new Client({ name: 'fufuni', version: '1' })
  try {
    await new UpstreamProxyRegistry(
      testEnv,
      'catalog-user',
      async () => {},
      'catalog-session',
      makeClient
    ).init(hub)
    registerIntegrationIdentity(hub, testEnv, 'catalog-user')
    const [a, b] = InMemoryTransport.createLinkedPair()
    await hub.connect(b)
    await client.connect(a)
    const identity = await client.readResource({ uri: 'ctxlayer://identity' })
    expect(identity.contents[0]).toMatchObject({ text: JSON.stringify({ userId: 'catalog-user' }) })
    const read = () =>
      client.callTool({
        name: 'up-catalog__read_catalog_snapshot',
        arguments: { action: 'page', warehouse_id: 'w1', page_number: 1 }
      })
    const result = await read()
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      schema_version: 1,
      shop_id: '1',
      data: [{ retail_price: 99000 }]
    })
    const before = reads
    await testEnv.DB.prepare("UPDATE upstream_servers SET enabled=0 WHERE id='catalog-up'").run()
    expect((await read()).isError).toBe(true)
    expect(reads).toBe(before)
    await testEnv.DB.prepare("UPDATE users SET status='suspended' WHERE id='catalog-user'").run()
    await expect(client.readResource({ uri: 'ctxlayer://identity' })).rejects.toThrow()
  } finally {
    await Promise.allSettled([client.close(), hub.close(), ...servers.map((s) => s.close())])
  }
})
