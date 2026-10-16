import { isToolAllowed, type InvocationPolicy, type UserPrincipals } from '@ctxlayer/shared'

export type InvocationDenial =
  | 'access_denied'
  | 'action_denied'
  | 'scope_denied'
  | 'approval_required'

/** Only explicit rules match. Missing action never grants an action-bearing request. */
export function evaluateInvocation(
  policy: InvocationPolicy,
  principals: UserPrincipals,
  tool: string,
  args: unknown
): InvocationDenial | null {
  if (!principals.products.has(policy.productId)) return 'scope_denied'
  const record =
    args !== null && typeof args === 'object' && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {}
  const action = Object.hasOwn(record, 'action') ? record.action : undefined
  const rule = policy.rules.find((r) => r.tool === tool && r.action === action)
  if (!rule || rule.effect === 'deny') return 'action_denied'
  if (
    !isToolAllowed(
      rule.principals.map((p) => ({
        principalKind: p.principalKind,
        principalId: p.principalId ?? ''
      })),
      principals
    )
  )
    return 'access_denied'
  for (const resource of rule.resources) {
    const value = Object.hasOwn(record, resource.argument) ? record[resource.argument] : undefined
    if (
      (typeof value !== 'string' && typeof value !== 'number') ||
      !resource.values.includes(String(value))
    )
      return 'scope_denied'
  }
  return rule.effect === 'approval_required' ? 'approval_required' : null
}
