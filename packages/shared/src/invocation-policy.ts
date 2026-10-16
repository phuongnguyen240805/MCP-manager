import { z } from 'zod'
import { ToolAccessRule } from './tool-access'

const ArgumentName = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)

export const InvocationRule = z.strictObject({
  tool: z.string().min(1).max(256),
  action: z.string().min(1).max(100).optional(),
  principals: z.array(ToolAccessRule).min(1).max(100),
  resources: z
    .array(
      z.strictObject({
        argument: ArgumentName,
        values: z.array(z.string().min(1).max(256)).min(1).max(100)
      })
    )
    .max(20),
  effect: z.enum(['allow', 'deny', 'approval_required'])
})
export type InvocationRule = z.infer<typeof InvocationRule>

export const InvocationPolicy = z
  .strictObject({
    // Reuse the existing product/team membership model for project scope.
    productId: z.string().min(1),
    rules: z.array(InvocationRule).max(500)
  })
  .superRefine((policy, ctx) => {
    const keys = new Set<string>()
    for (const [i, rule] of policy.rules.entries()) {
      const key = JSON.stringify([rule.tool, rule.action ?? null])
      if (keys.has(key))
        ctx.addIssue({ code: 'custom', path: ['rules', i], message: 'Duplicate tool/action' })
      keys.add(key)
      for (const [j, principal] of rule.principals.entries()) {
        if (principal.principalKind !== 'everyone' && !principal.principalId) {
          ctx.addIssue({
            code: 'custom',
            path: ['rules', i, 'principals', j],
            message: 'Principal ID required'
          })
        }
      }
    }
  })
export type InvocationPolicy = z.infer<typeof InvocationPolicy>

export const InvocationPolicyResponse = z.object({
  policy: InvocationPolicy.nullable(),
  version: z.number().int().nonnegative()
})
export type InvocationPolicyResponse = z.infer<typeof InvocationPolicyResponse>

export const PutInvocationPolicyRequest = z.strictObject({
  expectedVersion: z.number().int().nonnegative(),
  policy: InvocationPolicy
})
export type PutInvocationPolicyRequest = z.infer<typeof PutInvocationPolicyRequest>
