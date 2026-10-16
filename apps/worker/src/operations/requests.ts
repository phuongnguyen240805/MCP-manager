import type { RequestOperation } from '@ctxlayer/shared'
import type { Env } from '../env'
import { getUpstreamVisibleToUser } from '../db/queries/upstreams'
import {
  findOperation,
  findOperationRequest,
  insertOperation,
  transitionOperation,
  type OperationRow
} from '../db/queries/operations'
import { approvalSnapshot, assertRequester, OperationError } from './access'
import { canonicalArgs, sha256 } from './canonical'

export const OPERATION_LEASE_SECONDS = 10 * 60

export async function requestOperation(
  env: Env,
  userId: string,
  input: RequestOperation
): Promise<OperationRow> {
  const upstream = await getUpstreamVisibleToUser(env, userId, { slug: input.upstream })
  if (!upstream) throw new OperationError('not_found', 404)
  let argsJson: string
  try {
    argsJson = canonicalArgs(input.args)
  } catch {
    throw new OperationError('invalid_operation_args', 400)
  }
  const requestHash = await sha256(JSON.stringify([upstream.id, input.tool, argsJson]))
  const existing = await findOperationRequest(env, userId, input.requestId)
  if (existing) {
    if (existing.request_hash !== requestHash) throw new OperationError('request_id_conflict', 409)
    await assertRequester(env, userId, existing)
    return expireOperation(env, existing)
  }
  const snapshot = await approvalSnapshot(
    env,
    userId,
    upstream.id,
    input.tool,
    JSON.parse(argsJson)
  )
  const now = Math.floor(Date.now() / 1000)
  await insertOperation(env, {
    id: crypto.randomUUID(),
    requester_id: userId,
    request_id: input.requestId,
    upstream_id: upstream.id,
    product_id: snapshot.productId,
    tool: input.tool,
    args_json: argsJson,
    request_hash: requestHash,
    connection_hash: snapshot.connectionHash,
    policy_version: snapshot.version,
    state: 'pending',
    created_at: now,
    expires_at: now + 3600,
    updated_at: now,
    updated_by: userId,
    approved_by: null,
    started_at: null,
    result_json: null,
    error_code: null,
    resolution_json: null
  })
  const row = await findOperationRequest(env, userId, input.requestId)
  if (!row || row.request_hash !== requestHash) throw new OperationError('request_id_conflict', 409)
  return row
}

export async function expireOperation(env: Env, row: OperationRow): Promise<OperationRow> {
  const now = Math.floor(Date.now() / 1000)
  if (['pending', 'approved'].includes(row.state) && row.expires_at <= now) {
    await transitionOperation(env, row.id, row.state, 'expired', 'system', {
      errorCode: 'approval_expired'
    })
  } else if (
    row.state === 'running' &&
    row.started_at !== null &&
    row.started_at + OPERATION_LEASE_SECONDS <= now
  ) {
    await transitionOperation(env, row.id, 'running', 'unknown', 'system', {
      errorCode: 'outcome_unknown'
    })
  }
  return (await findOperation(env, row.id)) ?? row
}

export async function getOperation(env: Env, userId: string, id: string): Promise<OperationRow> {
  const row = await findOperation(env, id)
  if (!row) throw new OperationError('not_found', 404)
  await assertRequester(env, userId, row)
  return expireOperation(env, row)
}
