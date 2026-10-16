import type { Env } from '../../env'
import type { z } from 'zod'
import type { OperationState } from '@ctxlayer/shared'

export interface OperationRow {
  id: string
  requester_id: string
  requester_email?: string | null
  request_id: string
  upstream_id: string
  product_id: string
  tool: string
  args_json: string
  request_hash: string
  connection_hash: string
  policy_version: number
  state: z.infer<typeof OperationState>
  created_at: number
  expires_at: number
  updated_at: number
  updated_by: string
  approved_by: string | null
  started_at: number | null
  result_json: string | null
  error_code: string | null
  resolution_json: string | null
}

export async function findOperation(env: Env, id: string): Promise<OperationRow | null> {
  return env.DB.prepare(`SELECT o.*, u.email AS requester_email FROM upstream_operations o
    LEFT JOIN users u ON u.id = o.requester_id WHERE o.id = ?1`)
    .bind(id)
    .first<OperationRow>()
}

export async function findOperationRequest(
  env: Env,
  userId: string,
  requestId: string
): Promise<OperationRow | null> {
  return env.DB.prepare(`SELECT o.*, u.email AS requester_email FROM upstream_operations o
    LEFT JOIN users u ON u.id = o.requester_id WHERE o.requester_id = ?1 AND o.request_id = ?2`)
    .bind(userId, requestId)
    .first<OperationRow>()
}

export async function insertOperation(env: Env, row: OperationRow): Promise<void> {
  await env.DB.prepare(`INSERT INTO upstream_operations
    (id, requester_id, request_id, upstream_id, product_id, tool, args_json, request_hash,
     connection_hash, policy_version, state, created_at, expires_at, updated_at, updated_by)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'pending',?11,?12,?11,?2)
    ON CONFLICT (requester_id, request_id) DO NOTHING`)
    .bind(
      row.id,
      row.requester_id,
      row.request_id,
      row.upstream_id,
      row.product_id,
      row.tool,
      row.args_json,
      row.request_hash,
      row.connection_hash,
      row.policy_version,
      row.created_at,
      row.expires_at
    )
    .run()
}

export async function listOperations(env: Env, upstreamId: string): Promise<OperationRow[]> {
  const result =
    await env.DB.prepare(`SELECT o.*, u.email AS requester_email FROM upstream_operations o
    LEFT JOIN users u ON u.id = o.requester_id WHERE o.upstream_id = ?1 ORDER BY o.created_at DESC, o.id LIMIT 50`)
      .bind(upstreamId)
      .all<OperationRow>()
  return result.results ?? []
}

/** All transitions are conditional; a replay cannot claim an already dispatched operation. */
export async function transitionOperation(
  env: Env,
  id: string,
  from: OperationRow['state'],
  to: OperationRow['state'],
  actorId: string,
  values: { result?: string; errorCode?: string; resolution?: string } = {}
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  const result =
    await env.DB.prepare(`UPDATE upstream_operations SET state = ?3, updated_by = ?4, updated_at = ?5,
    approved_by = CASE WHEN ?3 = 'approved' THEN ?4 ELSE approved_by END,
    started_at = CASE WHEN ?3 = 'running' THEN ?5 ELSE started_at END,
    result_json = ?6, error_code = ?7, resolution_json = ?8
    WHERE id = ?1 AND state = ?2 AND (?3 NOT IN ('approved','running') OR expires_at > ?5)
    RETURNING id`)
      .bind(
        id,
        from,
        to,
        actorId,
        now,
        values.result ?? null,
        values.errorCode ?? null,
        values.resolution ?? null
      )
      .first<{ id: string }>()
  // Audit triggers also write rows; their change count must not decide the execution claim.
  return result !== null
}
