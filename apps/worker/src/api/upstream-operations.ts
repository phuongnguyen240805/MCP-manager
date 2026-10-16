import { Hono } from 'hono'
import { OperationDecision, OperationId, type OperationsResponse } from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireAdmin, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import { getUpstreamForAdmin } from '../db/queries/upstreams'
import { listOperations, findOperation } from '../db/queries/operations'
import { resolveUserPrincipals } from '../db/queries/tool-access'
import { operationView, OperationError } from '../operations/access'
import { decideOperation } from '../operations/decisions'
import { expireOperation } from '../operations/requests'
import { parseJsonBody, notFound } from './respond'

export const upstreamOperationsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
upstreamOperationsRoute.use('*', requireAdmin)
upstreamOperationsRoute.use('*', requireCsrf)

upstreamOperationsRoute.get('/', async (c) => {
  const id = c.req.param('id') ?? ''
  const userId = c.get('user').userId
  if (!(await getUpstreamForAdmin(c.env, id, userId))) return notFound(c)
  const principals = await resolveUserPrincipals(c.env, userId)
  const rows = (await listOperations(c.env, id)).filter((row) =>
    principals.products.has(row.product_id)
  )
  const operations = await Promise.all(
    rows.map(async (row) => operationView(await expireOperation(c.env, row)))
  )
  return c.json({ operations } satisfies OperationsResponse)
})

upstreamOperationsRoute.post('/:operationId/decision', async (c) => {
  const id = c.req.param('id') ?? ''
  const actorId = c.get('user').userId
  if (!(await getUpstreamForAdmin(c.env, id, actorId))) return notFound(c)
  const operationId = OperationId.safeParse(c.req.param('operationId'))
  if (!operationId.success) return notFound(c)
  const operation = await findOperation(c.env, operationId.data)
  if (!operation || operation.upstream_id !== id) return notFound(c)
  const body = await parseJsonBody(c, OperationDecision)
  if (!body.ok) return body.res
  try {
    return c.json(operationView(await decideOperation(c.env, actorId, operation.id, body.data)))
  } catch (err) {
    if (err instanceof OperationError) return c.json({ error: err.code }, err.status)
    throw err
  }
})
