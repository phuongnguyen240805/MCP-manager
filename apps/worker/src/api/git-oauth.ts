/**
 * Friendly git OAuth (static / pre-registered) — the connect flow users hit
 * instead of pasting a PAT.
 *
 *   GET /api/git-sources/:id/oauth/start  — build a provider, try a refresh;
 *     if nothing usable, 302 to the provider's authorize endpoint. A gateway
 *     call returns JSON `{ authorizeUrl }` instead of that 302.
 *   GET /api/git-sources/oauth/callback   — exchange ?code= for tokens (sealed
 *     into git_user_credentials), then bounce back to the doc / admin page.
 *     No session middleware: a cookie start still requires the browser
 *     session to match the KV user; a gateway start stores tenant_id and
 *     runs the exchange in that tenant.
 *
 * The callback is GLOBAL (not per-source) so one redirect_uri is registered
 * per provider app. redirect_uri stays this Worker's
 * `/api/git-sources/oauth/callback` (not a Nest URL). These are GETs, so no
 * CSRF middleware — the one-shot KV `state` is the anti-replay guard.
 */

import { Hono, type Context } from 'hono'
import type { Env } from '../env'
import { decideGateway, type GatewayOAuthBind } from '../auth/kedi-gateway'
import {
  requireUser,
  resolveBrowserUser,
  skipGatewayOauthCallback,
  type AuthedVariables
} from '../auth/middleware'
import { getGitSourceIfVisible } from '../db/queries/git-sources'
import { getGitConnectionForSource } from '../db/queries/git-connections'
import {
  GitOAuthFlowProvider,
  deleteGitVerifierState,
  gitStaticOAuth,
  readGitVerifierState,
  type GitOAuthReturn
} from '../git/git-oauth'
import { buildAuthorizeRedirect, exchangeCode, refreshStatic } from '../upstream/oauth-static'
import { notFound } from './respond'
import { errMessage } from '../util/errors'
import { gatewayReturnOrigin, listedOrigin } from '../util/origin'
import { isGatewayTenantId, runWithGatewayTenant } from '../db/tenant-db'
import { findById } from '../db/queries/users'

/** Build the SPA URL to bounce back to — always from a fixed prefix (no open redirect). */
function returnUrl(
  env: Env,
  ret: GitOAuthReturn | undefined,
  params: string,
  returnOrigin?: string
): string {
  const path = ret?.docId
    ? `/app/docs/${encodeURIComponent(ret.docId)}`
    : ret?.admin
      ? '/app/admin/git-sources'
      : '/app/docs'
  return `${new URL(path, returnOrigin ?? env.PUBLIC_BASE_URL).toString()}?${params}`
}

export const gitOauthStartRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
gitOauthStartRoute.use('*', skipGatewayOauthCallback(requireUser))

gitOauthStartRoute.get('/:id/oauth/start', async (c) => {
  const actor = c.get('user')
  const userId = actor.userId
  const gateway = await decideGateway(c.req.raw, c.env)
  let bind: GatewayOAuthBind | undefined
  if (gateway.kind === 'ok') {
    const returnOrigin = gatewayReturnOrigin(c.req.raw, c.env.KEDI_GATEWAY_RETURN_ORIGINS)
    if (!returnOrigin) return c.json({ error: 'return_origin_rejected' }, 400)
    bind = { tenantId: gateway.claims.tid, returnOrigin }
  }
  // Same gate as the PAT path (PUT /:id/credentials): sources are
  // invisible-until-granted, so connecting needs a visibility grant too.
  const access = await getGitSourceIfVisible(c.env, c.req.param('id'), actor)
  if (!access.ok) {
    return access.reason === 'not_found' ? notFound(c) : c.json({ error: 'forbidden' }, 403)
  }
  const source = access.source
  const connection = await getGitConnectionForSource(c.env, source.id)
  const oauth = gitStaticOAuth(connection?.auth_config ?? null)
  if (!oauth) return c.json({ error: 'oauth_not_configured' }, 400)

  const ret: GitOAuthReturn = {
    docId: c.req.query('doc') || undefined,
    admin: c.req.query('return_to') === 'admin'
  }
  const provider = new GitOAuthFlowProvider(c.env, source, userId, undefined, ret, bind)
  try {
    // Already connected with a still-valid (or refreshable) token → done.
    const access = await refreshStatic(c.env, provider, oauth)
    if (access) {
      if (bind) return c.json({ connected: true })
      return c.redirect(
        returnUrl(c.env, ret, `git_oauth_connected=${encodeURIComponent(source.slug)}`),
        302
      )
    }
    const url = await buildAuthorizeRedirect(provider, oauth)
    return bind ? c.json({ authorizeUrl: url }) : c.redirect(url, 302)
  } catch (err) {
    console.error(`[git-oauth] ${source.slug}: start failed: ${msg(err)}`)
    return c.json({ error: 'oauth_start_failed' }, 502)
  }
})

export const gitOauthCallbackRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()

gitOauthCallbackRoute.get('/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const errParam = c.req.query('error')
  const stored = state ? await readGitVerifierState(c.env, state) : null
  const gatewayFinish = stored?.tenantId
    ? checkedGitBind(c.env, stored.tenantId, stored.returnOrigin)
    : null
  if (gatewayFinish instanceof Response) return gatewayFinish

  const identity = gatewayFinish
    ? { userId: stored!.userId, bind: gatewayFinish }
    : await browserGitUser(c, stored?.userId)
  if (identity instanceof Response) return identity
  const returnOrigin = identity.bind?.returnOrigin

  if (errParam) {
    if (state) await deleteGitVerifierState(c.env, state)
    return c.redirect(
      returnUrl(
        c.env,
        stored?.return,
        `git_oauth_error=${encodeURIComponent(errParam)}`,
        returnOrigin
      ),
      302
    )
  }
  if (!code || !state) return c.json({ error: 'oauth_callback_missing_params' }, 400)
  if (!stored) return c.json({ error: 'oauth_state_unknown_or_expired' }, 400)

  const finish = () => completeGitCallback(c, identity.userId, code, state, stored, returnOrigin)
  if (identity.bind) return runWithGatewayTenant(identity.bind.tenantId, finish)
  return finish()
})

function checkedGitBind(
  env: Env,
  tenantId: string,
  returnOrigin: string | undefined
): GatewayOAuthBind | Response {
  if (!isGatewayTenantId(tenantId)) {
    return Response.json({ error: 'oauth_state_unknown_or_expired' }, { status: 400 })
  }
  const origin = listedOrigin(returnOrigin, env.KEDI_GATEWAY_RETURN_ORIGINS)
  if (!origin) return Response.json({ error: 'return_origin_rejected' }, { status: 400 })
  return { tenantId, returnOrigin: origin }
}

type GitCtx = Context<{ Bindings: Env; Variables: AuthedVariables }>

async function browserGitUser(
  c: GitCtx,
  expectedUserId: string | undefined
): Promise<{ userId: string; bind?: undefined } | Response> {
  const session = await resolveBrowserUser(c)
  if ('error' in session) return session.error
  if (expectedUserId && session.user.userId !== expectedUserId) {
    return c.json({ error: 'oauth_user_mismatch' }, 403)
  }
  return { userId: session.user.userId }
}

async function completeGitCallback(
  c: GitCtx,
  userId: string,
  code: string,
  state: string,
  stored: NonNullable<Awaited<ReturnType<typeof readGitVerifierState>>>,
  returnOrigin: string | undefined
): Promise<Response> {
  const row = await findById(c.env, userId)
  if (!row || row.status !== 'active') return c.json({ error: 'not_signed_in' }, 401)
  const access = await getGitSourceIfVisible(c.env, stored.gitSourceId, { userId, role: row.role })
  if (!access.ok) {
    if (access.reason === 'not_found') return notFound(c)
    await deleteGitVerifierState(c.env, state)
    return c.json({ error: 'forbidden' }, 403)
  }
  const source = access.source
  const connection = await getGitConnectionForSource(c.env, source.id)
  const oauth = gitStaticOAuth(connection?.auth_config ?? null)
  if (!oauth) return c.json({ error: 'oauth_not_configured' }, 400)

  const provider = new GitOAuthFlowProvider(c.env, source, userId, state)
  try {
    await exchangeCode(c.env, provider, oauth, code)
  } catch (err) {
    console.error(`[git-oauth] callback exchange failed for ${source.slug}: ${msg(err)}`)
    return c.redirect(
      returnUrl(c.env, stored.return, 'git_oauth_error=exchange', returnOrigin),
      302
    )
  } finally {
    await deleteGitVerifierState(c.env, state)
  }
  return c.redirect(
    returnUrl(
      c.env,
      stored.return,
      `git_oauth_connected=${encodeURIComponent(source.slug)}`,
      returnOrigin
    ),
    302
  )
}

function msg(err: unknown): string {
  return errMessage(err)
}
