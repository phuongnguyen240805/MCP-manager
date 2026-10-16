import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../env'
import { findById } from '../db/queries/users'

/** Lets background clients pin a grant to a configured integration user, without decoding opaque tokens. */
export function registerIntegrationIdentity(server: McpServer, env: Env, userId: string) {
  server.registerResource(
    'integration-identity',
    'ctxlayer://identity',
    {
      mimeType: 'application/json',
      description: 'Authenticated integration identity; no credentials.'
    },
    async () => {
      const user = await findById(env, userId)
      if (!user || user.status !== 'active') throw new Error('access_denied')
      return {
        contents: [
          {
            uri: 'ctxlayer://identity',
            mimeType: 'application/json',
            text: JSON.stringify({ userId: user.id })
          }
        ]
      }
    }
  )
}
