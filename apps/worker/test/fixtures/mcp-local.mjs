import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'

// A loopback-only, fake-data service. This public fixture token is not a provider credential.
const token = 'kedi-local-fixture'
const port = Number(process.argv[2] ?? 3101)
const name = process.argv[3] ?? 'fixture-pos'
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid fixture port')
const state = { service: name, reads: 0, writes: 0, orders: [] }

Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/health') return Response.json({ service: name, localFixture: true })
    if (request.headers.get('authorization') !== `Bearer ${token}`)
      return new Response('Unauthorized', { status: 401 })
    if (url.pathname === '/fixture/state') return Response.json(state)
    if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 })
    const server = new McpServer({ name, version: '0.1.0' })
    server.registerTool(
      'manage_orders',
      {
        description:
          'Fake local orders. simulate_timeout applies a fake write, then reports an ambiguous error.',
        inputSchema: {
          action: z.enum(['list', 'create', 'simulate_timeout']),
          shop_id: z.literal('shop-local'),
          amount: z.number().positive().optional()
        }
      },
      async (args) => {
        if (args.action === 'list') {
          state.reads++
          return { content: [{ type: 'text', text: JSON.stringify(state.orders) }] }
        }
        if (!args.amount)
          return { isError: true, content: [{ type: 'text', text: 'amount_required' }] }
        state.writes++
        const order = { id: `${name}-${state.writes}`, amount: args.amount, shop_id: args.shop_id }
        state.orders.push(order)
        return args.action === 'simulate_timeout'
          ? {
              isError: true,
              content: [{ type: 'text', text: 'simulated_ambiguous_provider_error' }]
            }
          : { content: [{ type: 'text', text: JSON.stringify(order) }], structuredContent: order }
      }
    )
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    })
    await server.connect(transport)
    // The SDK owns the returned stream; do not close its server before it has drained.
    return transport.handleRequest(request)
  }
})
console.log(`Local MCP fixture ${name}: http://127.0.0.1:${port}/mcp (fake data only)`)
