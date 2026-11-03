/**
 * `GET /collab/:docId` upgrade handler. Verifies the session cookie,
 * looks up the doc, decides read/write, and forwards the request to
 * the per-doc `DocRoomDO` instance.
 *
 * Cookie auth is the same-origin path: browsers send `Cookie` on the
 * handshake but refuse `Authorization`, and `Origin` must equal
 * `PUBLIC_BASE_URL`. A Kedi page has neither that cookie nor that
 * origin. It passes a one-time assertion (exp - iat <= 60s) as
 * `?ticket=` or a `Sec-WebSocket-Protocol` JWT, and its Origin must be
 * on `KEDI_GATEWAY_ALLOWED_ORIGINS`. Doc reads for that path run inside
 * the assertion tenant. The `DocRoomDO` itself never accepts
 * state-changing HTTP frames, only `wss://` messages tagged via the
 * per-socket attachment.
 */

import type { Env } from '../env'
import {
  COLLAB_TICKET_MAX_LIFETIME_SECONDS,
  consumeGatewayJti,
  readCollabTicket,
  readGatewayConfig,
  safeRid,
  verifyGatewayAssertion
} from '../auth/kedi-gateway'
import { readSessionCookie, verifySession } from '../auth/session'
import { resolveGatewayUser } from '../db/queries/external-identities'
import { canEditDoc, getDocById } from '../db/queries/docs'
import { findById } from '../db/queries/users'
import { runWithGatewayTenant } from '../db/tenant-db'
import { isAllowedOrigin, listedOrigin } from '../util/origin'
import { errMessage } from '../util/errors'

export async function handleCollabUpgrade(
  req: Request,
  env: Env,
  docId: string | undefined
): Promise<Response> {
  if (req.headers.get('upgrade') !== 'websocket') {
    return new Response('expected websocket upgrade', { status: 426 })
  }
  if (!docId) return new Response('missing docId', { status: 400 })

  const presented = readCollabTicket(req)
  if (presented.attempted) {
    return handleCollabTicket(req, env, docId, presented.ticket)
  }

  if (!isAllowedOrigin(req.headers.get('origin'), env.PUBLIC_BASE_URL)) {
    return new Response('bad_origin', { status: 403 })
  }

  const session = await verifySession(readSessionCookie(req), env.SESSION_COOKIE_SECRET)
  if (!session) return new Response('not_signed_in', { status: 401 })

  // The cookie is a stateless 30-day bearer, so the signature alone proves
  // nothing about the account TODAY. Re-read the row and require `active`,
  // exactly as the REST middleware's `resolveActiveUser` does — without this a
  // suspended or deleted user keeps read+write access to every doc they could
  // edit, over a socket, until the cookie expires. (Role changes are already
  // picked up: `canEditDoc` reads `users.role` live.)
  const user = await findById(env, session.userId)
  if (!user || user.status !== 'active') return new Response('not_signed_in', { status: 401 })

  const doc = await getDocById(env, docId)
  if (!doc) return new Response('not_found', { status: 404 })

  const canEdit = await canEditDoc(env, session.userId, docId)
  return forwardCollab(env, docId, session.userId, canEdit, null)
}

async function handleCollabTicket(
  req: Request,
  env: Env,
  docId: string,
  ticket: { token: string; echoProtocol: string | null } | null
): Promise<Response> {
  if (!ticket) return new Response('not_signed_in', { status: 401 })
  const origin = req.headers.get('origin')
  const originOk =
    isAllowedOrigin(origin, env.PUBLIC_BASE_URL) ||
    listedOrigin(origin, env.KEDI_GATEWAY_ALLOWED_ORIGINS) !== null
  if (!originOk) return new Response('bad_origin', { status: 403 })

  const config = readGatewayConfig(env)
  if (!config) return new Response('not_signed_in', { status: 401 })
  const now = Math.floor(Date.now() / 1000)
  const verified = await verifyGatewayAssertion(
    ticket.token,
    config,
    now,
    COLLAB_TICKET_MAX_LIFETIME_SECONDS
  )
  if (!verified.ok) return new Response('not_signed_in', { status: 401 })

  const consumed = await consumeGatewayJti(env, verified.claims, now, req)
  if (consumed !== 'ok') return new Response('not_signed_in', { status: 401 })

  let resolved: Awaited<ReturnType<typeof resolveGatewayUser>>
  try {
    resolved = await resolveGatewayUser(env, {
      issuer: verified.claims.iss,
      subject: verified.claims.sub,
      tenantId: verified.claims.tid,
      hubRole: verified.claims.hubRole,
      name: verified.claims.name,
      email: verified.claims.email
    })
  } catch (err) {
    console.error(`[kedi-gateway] collab identity failed: ${errMessage(err)}`)
    return new Response('not_signed_in', { status: 401 })
  }
  if ('inactive' in resolved) {
    console.warn(`[kedi-gateway] collab reject reason=inactive rid=${safeRid(verified.claims.rid)}`)
    return new Response('not_signed_in', { status: 401 })
  }

  const userId = resolved.user.id
  try {
    return await runWithGatewayTenant(verified.claims.tid, async () => {
      const doc = await getDocById(env, docId)
      if (!doc) return new Response('not_found', { status: 404 })
      const canEdit = await canEditDoc(env, userId, docId)
      return forwardCollab(env, docId, userId, canEdit, ticket.echoProtocol)
    })
  } catch (err) {
    console.error(`[kedi-gateway] collab failed: ${errMessage(err)}`)
    return new Response('not_signed_in', { status: 401 })
  }
}

function forwardCollab(
  env: Env,
  docId: string,
  userId: string,
  canEdit: boolean,
  echoProtocol: string | null
): Promise<Response> {
  const id = env.DOC_ROOM_DO.idFromName(docId)
  const stub = env.DOC_ROOM_DO.get(id)
  const fwd = new Request(`https://do/?docId=${encodeURIComponent(docId)}`, {
    method: 'GET',
    headers: {
      Upgrade: 'websocket',
      'x-ctx-user-id': userId,
      'x-ctx-can-edit': canEdit ? '1' : '0'
    }
  })
  return stub.fetch(fwd).then((res) => echoProtocolHeader(res, echoProtocol))
}

function echoProtocolHeader(res: Response, protocol: string | null): Response {
  if (!protocol || res.status !== 101) return res
  const headers = new Headers(res.headers)
  headers.set('Sec-WebSocket-Protocol', protocol)
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
    webSocket: res.webSocket
  })
}
