import { z } from 'zod'

export const OperationState = z.enum([
  'pending',
  'approved',
  'rejected',
  'running',
  'succeeded',
  'failed',
  'unknown',
  'expired'
])
export const RequestOperation = z.strictObject({
  requestId: z
    .string()
    .min(8)
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/),
  upstream: z.string().min(1).max(24),
  tool: z.string().min(1).max(256),
  args: z.record(z.string(), z.unknown())
})
export type RequestOperation = z.infer<typeof RequestOperation>
export const OperationId = z.string().uuid()
export const OperationDecision = z.discriminatedUnion('action', [
  z.strictObject({ action: z.enum(['approve', 'reject']) }),
  z.strictObject({
    action: z.literal('resolve'),
    outcome: z.enum(['succeeded', 'failed']),
    note: z.string().min(10).max(1000),
    reference: z.string().min(1).max(200)
  })
])
export type OperationDecision = z.infer<typeof OperationDecision>
export const OperationView = z.object({
  id: OperationId,
  requesterId: z.string(),
  requesterLabel: z.string().nullish(),
  upstreamId: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  state: OperationState,
  policyVersion: z.number().int(),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  approvedBy: z.string().nullish(),
  result: z.unknown().nullish(),
  errorCode: z.string().nullish(),
  resolution: z.object({ note: z.string(), reference: z.string() }).nullish()
})
export type OperationView = z.infer<typeof OperationView>
export const OperationsResponse = z.object({ operations: z.array(OperationView) })
export type OperationsResponse = z.infer<typeof OperationsResponse>
