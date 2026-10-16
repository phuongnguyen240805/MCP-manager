import type { OperationView } from '@ctxlayer/shared'
import type { Env } from '../env'
import { authorizeInvocation } from '../policy/authorize-invocation'
import { getUpstreamForAdmin } from '../db/queries/upstreams'
import { getSharedCredential, getUserCredential } from '../db/queries/upstream-credentials'
import { listCachedTools } from '../db/queries/upstream-tools'
import { resolveUserPrincipals } from '../db/queries/tool-access'
import { findById } from '../db/queries/users'
import type { OperationRow } from '../db/queries/operations'
import { clientCacheKey } from '../upstream/client-cache-key'
import { jsonSchemaToZod } from '../mcp/json-schema-to-zod'
import { sanitizeUntrustedStructured } from '../mcp/provenance'

export class OperationError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 = 403
  ) {
    super(code)
  }
}

export async function approvalSnapshot(
  env: Env,
  userId: string,
  upstreamId: string,
  tool: string,
  args: Record<string, unknown>
) {
  const decision = await authorizeInvocation(env, userId, upstreamId, tool, args)
  if (!('approval' in decision) || !decision.approval) {
    throw new OperationError(decision.allowed ? 'approval_not_required' : decision.code)
  }
  const context = decision.approval
  const cached = (await listCachedTools(env, upstreamId)).find((row) => row.tool_name === tool)
  if (!cached) throw new OperationError('tool_not_cached', 409)
  let schema: unknown
  try {
    schema = JSON.parse(cached.input_schema)
  } catch {
    throw new OperationError('invalid_tool_schema', 409)
  }
  if (
    !schema ||
    typeof schema !== 'object' ||
    !jsonSchemaToZod(schema).zod.safeParse(args).success
  ) {
    throw new OperationError('invalid_tool_args', 400)
  }
  const credential =
    context.conn.authStrategy === 'shared_bearer'
      ? await getSharedCredential(env, upstreamId)
      : context.conn.authStrategy === 'none'
        ? null
        : await getUserCredential(env, userId, upstreamId)
  const stamp = credential
    ? JSON.stringify([
        credential.key_version,
        Array.from(credential.iv),
        Array.from(credential.ciphertext)
      ])
    : null
  const connectionHash = await clientCacheKey(
    context.conn,
    JSON.stringify([stamp, cached.input_schema])
  )
  return { ...context, connectionHash }
}

export async function assertApprover(
  env: Env,
  actorId: string,
  operation: OperationRow
): Promise<void> {
  const [user, upstream, principals] = await Promise.all([
    findById(env, actorId),
    getUpstreamForAdmin(env, operation.upstream_id, actorId),
    resolveUserPrincipals(env, actorId)
  ])
  if (
    !user ||
    user.status !== 'active' ||
    user.role !== 'admin' ||
    actorId === operation.requester_id ||
    !upstream ||
    !principals.products.has(operation.product_id)
  )
    throw new OperationError('approver_required')
}

export async function assertRequester(
  env: Env,
  userId: string,
  operation: OperationRow
): Promise<void> {
  if (operation.requester_id !== userId) throw new OperationError('not_found', 404)
  const decision = await authorizeInvocation(
    env,
    userId,
    operation.upstream_id,
    operation.tool,
    JSON.parse(operation.args_json)
  )
  const principals = await resolveUserPrincipals(env, userId)
  if (
    (!decision.allowed && (!('approval' in decision) || !decision.approval)) ||
    !principals.products.has(operation.product_id)
  )
    throw new OperationError('access_denied')
}

export function operationView(row: OperationRow): OperationView {
  return {
    id: row.id,
    requesterId: row.requester_id,
    requesterLabel: row.requester_email,
    upstreamId: row.upstream_id,
    tool: row.tool,
    args: JSON.parse(row.args_json),
    state: row.state,
    policyVersion: row.policy_version,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    approvedBy: row.approved_by,
    result: row.result_json ? sanitizeUntrustedStructured(JSON.parse(row.result_json)) : null,
    errorCode: row.error_code,
    resolution: row.resolution_json ? JSON.parse(row.resolution_json) : null
  }
}
