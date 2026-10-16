import { InvocationPolicy, isToolAllowed } from '@ctxlayer/shared'
import type { Env } from '../env'
import { findById } from '../db/queries/users'
import { getUpstreamVisibleToUser, toUpstreamConnection } from '../db/queries/upstreams'
import {
  indexToolAccess,
  accessKey,
  listToolAccessForUpstream,
  resolveUserPrincipals
} from '../db/queries/tool-access'
import { getInvocationPolicy } from '../db/queries/invocation-policies'
import { hasSharedCredential, getUserCredentialStatus } from '../db/queries/upstream-credentials'
import { evaluateInvocation } from './evaluate-invocation'

/** No session ACL cache: revocations apply to old handlers and queued work too. */
export async function authorizeInvocation(
  env: Env,
  userId: string,
  upstreamId: string,
  tool: string,
  args: unknown
) {
  const [user, row] = await Promise.all([
    findById(env, userId),
    getUpstreamVisibleToUser(env, userId, { id: upstreamId })
  ])
  if (!user || user.status !== 'active' || !row)
    return { allowed: false as const, code: 'access_denied' }
  const [principals, rules, stored] = await Promise.all([
    resolveUserPrincipals(env, userId),
    listToolAccessForUpstream(env, upstreamId),
    getInvocationPolicy(env, upstreamId)
  ])
  if (!isToolAllowed(indexToolAccess(rules).get(accessKey(upstreamId, tool)), principals)) {
    return { allowed: false as const, code: 'access_denied' }
  }
  let approvalRequired = false
  if (stored) {
    let json: unknown
    try {
      json = JSON.parse(stored.policy_json)
    } catch {
      return { allowed: false as const, code: 'policy_invalid' }
    }
    const parsed = InvocationPolicy.safeParse(json)
    if (!parsed.success || parsed.data.productId !== stored.product_id) {
      return { allowed: false as const, code: 'policy_invalid' }
    }
    const code = evaluateInvocation(parsed.data, principals, tool, args)
    if (code && code !== 'approval_required') return { allowed: false as const, code }
    approvalRequired = code === 'approval_required'
  }
  const conn = toUpstreamConnection(row)
  if (conn.authStrategy === 'shared_bearer') {
    if (!(await hasSharedCredential(env, upstreamId)))
      return { allowed: false as const, code: 'credential_revoked' }
  }
  if (conn.authStrategy === 'user_bearer' || conn.authStrategy === 'user_oauth') {
    const credential = await getUserCredentialStatus(env, userId, upstreamId)
    if (!credential.present || credential.needsReauth) {
      // The interactive path preserves its existing first-party recovery message.
      return { allowed: false as const, code: 'credential_revoked' }
    }
  }
  if (approvalRequired && stored) {
    return {
      allowed: false as const,
      code: 'approval_required',
      approval: { row, conn, version: stored.version, productId: stored.product_id }
    }
  }
  return { allowed: true as const, row, conn, version: stored?.version ?? 0 }
}
