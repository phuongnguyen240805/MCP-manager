import { InvocationPolicy, isToolAllowed, type UserPrincipals } from '@ctxlayer/shared'
import type { Env } from '../env'
import { getInvocationPolicy } from '../db/queries/invocation-policies'

/** null preserves legacy discovery; an invalid scoped policy exposes no tools. */
export async function visiblePolicyTools(
  env: Env,
  upstreamId: string,
  principals: UserPrincipals
): Promise<Set<string> | null> {
  const stored = await getInvocationPolicy(env, upstreamId)
  if (!stored) return null
  let json: unknown
  try {
    json = JSON.parse(stored.policy_json)
  } catch {
    return new Set()
  }
  const parsed = InvocationPolicy.safeParse(json)
  if (
    !parsed.success ||
    parsed.data.productId !== stored.product_id ||
    !principals.products.has(stored.product_id)
  )
    return new Set()
  return new Set(
    parsed.data.rules
      .filter(
        (r) =>
          r.effect !== 'deny' &&
          isToolAllowed(
            r.principals.map((p) => ({
              principalKind: p.principalKind,
              principalId: p.principalId ?? ''
            })),
            principals
          )
      )
      .map((r) => r.tool)
  )
}
