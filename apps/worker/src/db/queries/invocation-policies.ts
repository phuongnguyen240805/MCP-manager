import type { Env } from '../../env'
import type { InvocationPolicy } from '@ctxlayer/shared'

export interface InvocationPolicyRow {
  product_id: string
  policy_json: string
  version: number
}

export async function projectHasInvocationPolicies(env: Env, productId: string): Promise<boolean> {
  return !!(await env.DB.prepare(
    `SELECT 1 AS found FROM upstream_invocation_policies WHERE product_id = ?1 LIMIT 1`
  )
    .bind(productId)
    .first())
}

export async function getInvocationPolicy(
  env: Env,
  upstreamId: string
): Promise<InvocationPolicyRow | null> {
  return env.DB.prepare(
    `SELECT product_id, policy_json, version FROM upstream_invocation_policies WHERE upstream_id = ?1`
  )
    .bind(upstreamId)
    .first<InvocationPolicyRow>()
}

/** Compare-and-swap prevents a stale admin tab from overwriting a newer policy. */
export async function putInvocationPolicy(
  env: Env,
  upstreamId: string,
  policy: InvocationPolicy,
  expectedVersion: number
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  const sql =
    expectedVersion === 0
      ? `INSERT INTO upstream_invocation_policies (upstream_id, product_id, policy_json, version, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4) ON CONFLICT (upstream_id) DO NOTHING`
      : `UPDATE upstream_invocation_policies SET product_id = ?2, policy_json = ?3,
         version = version + 1, updated_at = ?4 WHERE upstream_id = ?1 AND version = ?5`
  const stmt = env.DB.prepare(sql)
  const values = [upstreamId, policy.productId, JSON.stringify(policy), now]
  const result = await (expectedVersion === 0
    ? stmt.bind(...values)
    : stmt.bind(...values, expectedVersion)
  ).run()
  return result.meta.changes === 1
}
