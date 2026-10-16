import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { builtinToolMeta, RequestOperation } from '@ctxlayer/shared'
import type { Env } from '../env'
import { createUpstreamClient } from '../upstream/create-client'
import type { RecWrap } from './skill-mcp'
import { BUILTIN_INPUT_SHAPES } from './builtin-schemas'
import { requestOperation, getOperation } from '../operations/requests'
import { executeOperation } from '../operations/execute'
import { OperationError, operationView } from '../operations/access'
import type { OperationRow } from '../db/queries/operations'
import { callWithHeartbeat } from './upstream-call-runner'
import { errText } from './tool-result'
import { sanitizeUntrustedStructured } from './provenance'

export function registerOperationTools(
  server: McpServer,
  env: Env,
  rec: RecWrap,
  getUserId: () => string | undefined,
  makeClient = createUpstreamClient
) {
  async function run(exec: (userId: string) => Promise<OperationRow>) {
    const userId = getUserId()
    if (!userId) return errText('not_signed_in')
    try {
      const view = operationView(await exec(userId))
      // The model already supplied the arguments; the admin review API retains the full request.
      const operation = sanitizeUntrustedStructured({
        id: view.id,
        state: view.state,
        tool: view.tool,
        expiresAt: view.expiresAt,
        errorCode: view.errorCode,
        result: view.result,
        resolution: view.resolution
      })
      return { content: [{ type: 'text' as const, text: JSON.stringify(operation) }] }
    } catch (err) {
      return errText(err instanceof OperationError ? err.code : 'operation_unavailable')
    }
  }
  server.registerTool(
    'request_operation',
    {
      ...builtinToolMeta('request_operation'),
      inputSchema: BUILTIN_INPUT_SHAPES.request_operation
    },
    (args) =>
      rec('request_operation', args, () =>
        run((userId) => requestOperation(env, userId, RequestOperation.parse(args)))
      )
  )
  server.registerTool(
    'get_operation',
    {
      ...builtinToolMeta('get_operation'),
      inputSchema: BUILTIN_INPUT_SHAPES.get_operation
    },
    (args) =>
      rec('get_operation', args, () =>
        run((userId) => getOperation(env, userId, args.operation_id))
      )
  )
  server.registerTool(
    'execute_operation',
    {
      ...builtinToolMeta('execute_operation'),
      inputSchema: BUILTIN_INPUT_SHAPES.execute_operation
    },
    (args, extra) =>
      rec('execute_operation', args, () =>
        callWithHeartbeat(extra, () =>
          run((userId) => executeOperation(env, userId, args.operation_id, makeClient))
        )
      )
  )
}
