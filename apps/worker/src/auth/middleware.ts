import type { Context, MiddlewareHandler } from 'hono'
import type { Env } from '../env'
import {
  readSessionCookie,
  sessionClearCookie,
  sessionSetCookie,
  signSession,
  verifySession
} from './session'
import { csrfSetCookie, newCsrfToken } from './csrf'
import { accessTrustConfigured, verifyCfAccessJwt } from './cf-access'
import { consumeGatewayJti, decideGateway, safeRid } from './kedi-gateway'
import { resolveGatewayUser } from '../db/queries/external-identities'
import { runWithGatewayTenant } from '../db/tenant-db'
import { EmailOnOtherIdpError, findById, upsertUser, type UserRow } from '../db/queries/users'
import { errMessage } from '../util/errors'
import type { Role } from '@ctxlayer/shared'

export interface SessionUser {
  userId: string
  role: Role
}

// `userRow` is the full DB row the per-request lifecycle re-check already
// fetched — exposed so handlers that need it (/api/me) don't re-query.
export type AuthedVariables = { user: SessionUser; userRow: UserRow }

/** A route context behind requireUser/requireAdmin — exported for helpers
 * (e.g. `auditFromCtx`) that read the acting user off the context. */
export type AuthedContext = Context<{ Bindings: Env; Variables: AuthedVariables }>

type Ctx = AuthedContext

/**
 * Resolve the signed-in user for a request: verify the session cookie, then
 * re-check the DB row every request (plan L). The cookie is a 30-day bearer,
 * so without this re-check a suspended or deleted user would keep full access
 * until it expired. A non-active / missing row yields a 401 that ALSO clears
 * the cookie, so the browser drops it and the SPA bounces to /sign-in (where
 * a fresh sign-in surfaces the real `suspended` reason).
 *
 * The role is taken from the DB, not the cookie, so an admin demote/promote
 * also takes effect immediately.
 */
async function resolveActiveUser(
  c: Ctx
): Promise<{ user: SessionUser; row: UserRow; tenantId?: string } | { error: Response }> {
  // 0. Trusted gateway bearer. Only when KEDI_GATEWAY_* is configured AND
  //    the request presents Authorization: Bearer. No cookie is minted.
  //    A presented bearer that fails does not fall through to the cookie.
  const gateway = await resolveFromGateway(c)
  if (gateway) return gateway
  return resolveBrowserUser(c)
}

/**
 * Cookie session, then Cloudflare Access. No gateway bearer. OAuth callbacks
 * use this for the cookie dance so an IdP redirect is not treated as a
 * gateway call and a bad assertion cannot satisfy the callback.
 */
export async function resolveBrowserUser(
  c: Ctx
): Promise<{ user: SessionUser; row: UserRow } | { error: Response }> {
  const cookie = readSessionCookie(c.req.raw)
  const payload = await verifySession(cookie, c.env.SESSION_COOKIE_SECRET)
  if (payload) {
    const row = await findById(c.env, payload.userId)
    // A7: a cookie minted under an older epoch is dead — sign-out and admin
    // suspend bump users.session_epoch, which invalidates every outstanding
    // cookie server-side (the 30-day exp alone can't). Same 401+clear as a
    // missing row so the SPA lands on /sign-in.
    if (!row || row.status !== 'active' || payload.epoch !== row.session_epoch) {
      const res = c.json({ error: 'not_signed_in' }, 401)
      res.headers.append('Set-Cookie', sessionClearCookie())
      return { error: res }
    }
    return { user: { userId: row.id, role: row.role }, row }
  }

  // No session yet — when deployed behind Cloudflare Access, mint one from
  // the edge-asserted identity. Only the first request of a session reaches
  // here; the cookie set below short-circuits every request after it.
  if (accessTrustConfigured(c.env)) {
    const established = await establishFromAccess(c)
    if (established) return established
  }

  return { error: c.json({ error: 'not_signed_in' }, 401) }
}

/**
 * Nest called `/api/*` on behalf of a user. Identity comes from the
 * assertion, not from a browser cookie. `null` means this request is not
 * a gateway call (mode off, or no bearer) and the cookie path should run.
 */
async function resolveFromGateway(
  c: Ctx
): Promise<{ user: SessionUser; row: UserRow; tenantId: string } | { error: Response } | null> {
  const decision = await decideGateway(c.req.raw, c.env)
  if (decision.kind === 'skip') return null
  if (decision.kind === 'reject') {
    console.warn(`[kedi-gateway] reject reason=${decision.reason}`)
    return { error: c.json({ error: 'not_signed_in' }, 401) }
  }

  let resolved: Awaited<ReturnType<typeof resolveGatewayUser>>
  try {
    resolved = await resolveGatewayUser(c.env, {
      issuer: decision.claims.iss,
      subject: decision.claims.sub,
      tenantId: decision.claims.tid,
      hubRole: decision.claims.hubRole,
      name: decision.claims.name,
      email: decision.claims.email
    })
  } catch (err) {
    console.error(`[kedi-gateway] identity failed: ${errMessage(err)}`)
    return { error: c.json({ error: 'not_signed_in' }, 401) }
  }
  if ('inactive' in resolved) {
    console.warn(`[kedi-gateway] reject reason=inactive rid=${safeRid(decision.claims.rid)}`)
    return { error: c.json({ error: 'not_signed_in' }, 401) }
  }

  const consumed = await consumeGatewayJti(c.env, decision.claims, undefined, c.req.raw)
  if (consumed !== 'ok') {
    console.warn(`[kedi-gateway] reject reason=${consumed} rid=${safeRid(decision.claims.rid)}`)
    return { error: c.json({ error: 'not_signed_in' }, 401) }
  }
  const row = resolved.user
  return { user: { userId: row.id, role: row.role }, row, tenantId: decision.claims.tid }
}

function continueAuthed(
  c: Ctx,
  resolved: { user: SessionUser; row: UserRow; tenantId?: string },
  next: () => Promise<void>
): Promise<void> {
  c.set('user', resolved.user)
  c.set('userRow', resolved.row)
  // Scope only the gateway request. Cookie and Access sessions stay on the
  // unpartitioned deployment org, which is every row that existed before
  // tenant_id was added.
  if (resolved.tenantId) return runWithGatewayTenant(resolved.tenantId, () => next())
  return next()
}

/**
 * Establish a session from a Cloudflare Access token (Cf-Access-Jwt-Assertion).
 * On success returns the resolved user AND appends fresh session + CSRF cookies
 * to the response — exactly like the IdP sign-in tail (idp/flow.ts) — so the
 * SPA behaves identically afterwards. Returns an error Response for a
 * known-but-inactive account, or null when there's no usable Access token (the
 * caller then falls through to a 401).
 *
 * Cloudflare Access has already decided WHO may reach the app (its own policy /
 * group rules), so this admits the verified identity directly: it does NOT run
 * the local IdP allowlist/admission. A user suspended IN THE APP is still
 * blocked (stored status wins), and ADMIN_EMAILS still confers admin.
 */
async function establishFromAccess(
  c: Ctx
): Promise<{ user: SessionUser; row: UserRow } | { error: Response } | null> {
  const token = c.req.header('cf-access-jwt-assertion')
  if (!token) return null
  const identity = await verifyCfAccessJwt(token, c.env)
  if (!identity) return null

  let user: UserRow
  try {
    ;({ user } = await upsertUser(
      c.env,
      {
        idp: 'access',
        idpSub: identity.sub,
        email: identity.email,
        name: identity.name,
        avatarUrl: null
      },
      'active'
    ))
  } catch (err) {
    // Existing user on another IdP reached via Access with the same email —
    // a distinguished 403 (identity linking is a deliberate operator action),
    // not the 500 this used to be.
    if (err instanceof EmailOnOtherIdpError) {
      console.warn('[access] email belongs to a user on another idp; refusing session')
      return { error: c.json({ error: 'email_other_idp' }, 403) }
    }
    throw err
  }
  if (user.status !== 'active') {
    const res = c.json({ error: 'not_signed_in' }, 401)
    res.headers.append('Set-Cookie', sessionClearCookie())
    return { error: res }
  }

  const session = await signSession(
    { userId: user.id, role: user.role, epoch: user.session_epoch },
    c.env.SESSION_COOKIE_SECRET
  )
  c.header('Set-Cookie', sessionSetCookie(session), { append: true })
  c.header('Set-Cookie', csrfSetCookie(newCsrfToken()), { append: true })
  return { user: { userId: user.id, role: user.role }, row: user }
}

/**
 * Hono middleware that requires a valid, active session. On failure returns
 * 401. On success exposes the user via `c.get('user')`.
 *
 * Example:
 *   const route = new Hono<{ Bindings: Env, Variables: AuthedVariables }>()
 *   route.use('*', requireUser)
 *   route.get('/', (c) => c.json({ userId: c.get('user').userId }))
 */
function alreadyAuthed(c: Ctx): { user: SessionUser; row: UserRow } | null {
  const user = c.get('user') as SessionUser | undefined
  const row = c.get('userRow') as UserRow | undefined
  if (!user?.userId || !row?.id) return null
  return { user, row }
}

const OAUTH_CALLBACK_PATHS = new Set([
  '/api/upstreams/oauth/callback',
  '/api/git-sources/oauth/callback'
])

/**
 * IdP redirects land on these GETs with no ctxlayer cookie and no bearer.
 * Parent routers mounted on the same prefix must not run requireUser there;
 * the callback identifies the user from the one-time KV state.
 */
export function skipGatewayOauthCallback<E extends { Bindings: Env; Variables: AuthedVariables }>(
  mw: MiddlewareHandler<E>
): MiddlewareHandler<E> {
  return async (c, next) => {
    if (OAUTH_CALLBACK_PATHS.has(c.req.path)) return next()
    return mw(c, next)
  }
}

export const requireUser: MiddlewareHandler<{
  Bindings: Env
  Variables: AuthedVariables
}> = async (c, next) => {
  // A second router on the same prefix (docs + editors/tags/git, upstreams
  // + oauth start) would otherwise verify the assertion again and burn jti.
  if (alreadyAuthed(c)) return next()
  const resolved = await resolveActiveUser(c)
  if ('error' in resolved) return resolved.error
  return continueAuthed(c, resolved, next)
}

/** Same as requireUser, but additionally requires role==='admin'. */
export const requireAdmin: MiddlewareHandler<{
  Bindings: Env
  Variables: AuthedVariables
}> = async (c, next) => {
  const existing = alreadyAuthed(c)
  if (existing) {
    if (existing.user.role !== 'admin') return c.json({ error: 'forbidden' }, 403)
    return next()
  }
  const resolved = await resolveActiveUser(c)
  if ('error' in resolved) return resolved.error
  if (resolved.user.role !== 'admin') return c.json({ error: 'forbidden' }, 403)
  return continueAuthed(c, resolved, next)
}
