import type { Env } from '../env'
import { findOperation, transitionOperation } from '../db/queries/operations'
import { createUpstreamClient } from '../upstream/create-client'
import { resolveUserUpstreamBearer } from '../upstream/bearer'
import { runUpstreamCall } from '../mcp/upstream-call-runner'
import { approvalSnapshot, assertApprover, OperationError } from './access'
import { getOperation } from './requests'
import { sha256 } from './canonical'

/** A running/unknown invocation is never dispatched again, even after a crash or client retry. */
export async function executeOperation(
  env: Env,
  userId: string,
  id: string,
  makeClient = createUpstreamClient
) {
  const row = await getOperation(env, userId, id)
  if (row.state !== 'approved') return row
  if (!row.approved_by) throw new OperationError('approval_missing')
  await assertApprover(env, row.approved_by, row)
  const args = JSON.parse(row.args_json) as Record<string, unknown>
  if (
    (await sha256(JSON.stringify([row.upstream_id, row.tool, row.args_json]))) !== row.request_hash
  ) {
    throw new OperationError('request_changed', 409)
  }
  const snapshot = await approvalSnapshot(env, userId, row.upstream_id, row.tool, args)
  const bearer = await resolveUserUpstreamBearer(env, snapshot.row, snapshot.conn, userId)
  if (snapshot.conn.authStrategy !== 'none' && bearer === null)
    throw new OperationError('credential_revoked')
  // Token refresh, policy changes and connector upgrades can happen during preparation.
  const current = await approvalSnapshot(env, userId, row.upstream_id, row.tool, args)
  await assertApprover(env, row.approved_by, row)
  if (
    current.version !== row.policy_version ||
    current.connectionHash !== row.connection_hash ||
    current.connectionHash !== snapshot.connectionHash
  )
    throw new OperationError('approval_snapshot_changed', 409)
  if (!(await transitionOperation(env, id, 'approved', 'running', userId))) {
    const latest = await findOperation(env, id)
    if (!latest) throw new OperationError('not_found', 404)
    return latest
  }
  try {
    const client = makeClient(current.conn, bearer)
    try {
      const outcome = await runUpstreamCall({
        slug: current.conn.slug,
        toolName: row.tool,
        upstreamUrl: current.conn.url,
        maxResponseBytes: current.conn.authConfig.maxResponseBytes,
        run: () => client.callTool(row.tool, args)
      })
      await transitionOperation(
        env,
        id,
        'running',
        outcome.status === 'ok' ? 'succeeded' : 'unknown',
        userId,
        {
          result: JSON.stringify(outcome.surface),
          errorCode: outcome.status === 'ok' ? undefined : 'outcome_unknown'
        }
      )
    } finally {
      await client.close().catch(() => {})
    }
  } catch {
    // A failed result commit is ambiguous too. If D1 remains unavailable the running lease
    // expires to unknown on the next read; neither case authorizes an automatic retry.
    await transitionOperation(env, id, 'running', 'unknown', userId, {
      errorCode: 'outcome_unknown'
    })
  }
  const updated = await findOperation(env, id)
  if (!updated) throw new OperationError('not_found', 404)
  return updated
}
