import { Hono } from 'hono'
import { RequestOperation, OperationId } from '@ctxlayer/shared'
import type { Env } from '../env'
import { requireUser, type AuthedVariables } from '../auth/middleware'
import { requireCsrf } from '../auth/csrf'
import { requestOperation, getOperation } from '../operations/requests'
import { executeOperation } from '../operations/execute'
import { OperationError, operationView } from '../operations/access'
import { parseJsonBody, notFound } from './respond'

export const operationsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
operationsRoute.use('*', requireUser)
operationsRoute.use('*', requireCsrf)
operationsRoute.onError((err, c) => {
  if (err instanceof OperationError) return c.json({ error: err.code }, err.status)
  throw err
})

operationsRoute.post('/', async (c) => {
  const body = await parseJsonBody(c, RequestOperation)
  if (!body.ok) return body.res
  return c.json(operationView(await requestOperation(c.env, c.get('user').userId, body.data)))
})
operationsRoute.get('/:id', async (c) => {
  const id = OperationId.safeParse(c.req.param('id'))
  if (!id.success) return notFound(c)
  return c.json(operationView(await getOperation(c.env, c.get('user').userId, id.data)))
})
operationsRoute.post('/:id/execute', async (c) => {
  const id = OperationId.safeParse(c.req.param('id'))
  if (!id.success) return notFound(c)
  return c.json(operationView(await executeOperation(c.env, c.get('user').userId, id.data)))
})
