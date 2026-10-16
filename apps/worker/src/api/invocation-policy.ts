import { Hono } from 'hono'
import {
  InvocationPolicy,
  PutInvocationPolicyRequest,
  type InvocationPolicyResponse
} from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireAdmin, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import { getUpstreamForAdmin } from '../db/queries/upstreams'
import { getProductById } from '../db/queries/products'
import { getInvocationPolicy, putInvocationPolicy } from '../db/queries/invocation-policies'
import { audit } from '../audit/log'
import { notFound, parseJsonBody } from './respond'

export const invocationPolicyRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
invocationPolicyRoute.use('*', requireAdmin)
invocationPolicyRoute.use('*', requireCsrf)

invocationPolicyRoute.get('/', async (c) => {
  const id = c.req.param('id') ?? ''
  if (!(await getUpstreamForAdmin(c.env, id, c.get('user').userId))) return notFound(c)
  const stored = await getInvocationPolicy(c.env, id)
  const body: InvocationPolicyResponse = {
    policy: stored ? InvocationPolicy.parse(JSON.parse(stored.policy_json)) : null,
    version: stored?.version ?? 0
  }
  return c.json(body)
})

invocationPolicyRoute.put('/', async (c) => {
  const id = c.req.param('id') ?? ''
  const userId = c.get('user').userId
  if (!(await getUpstreamForAdmin(c.env, id, userId))) return notFound(c)
  const input = await parseJsonBody(c, PutInvocationPolicyRequest)
  if (!input.ok) return input.res
  if (!(await getProductById(c.env, input.data.policy.productId))) {
    return c.json({ error: 'unknown_project' }, 400)
  }
  if (!(await putInvocationPolicy(c.env, id, input.data.policy, input.data.expectedVersion))) {
    return c.json({ error: 'policy_conflict', message: 'Reload the policy before saving.' }, 409)
  }
  await audit(c.env, {
    actorId: userId,
    action: 'upstream.invocation_policy_set',
    target: id,
    meta: { version: input.data.expectedVersion + 1, productId: input.data.policy.productId }
  })
  return c.json({
    policy: input.data.policy,
    version: input.data.expectedVersion + 1
  } satisfies InvocationPolicyResponse)
})
