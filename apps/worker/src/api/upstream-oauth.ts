/**
 * Outbound OAuth flow for `user_oauth` upstreams (e.g. Notion MCP).
 *
 * - `GET /api/upstreams/:id/oauth/start` — required-user. Builds a per-
 *   request `UpstreamOAuthProvider`, hands it to the SDK's `auth(...)`
 *   orchestrator with `serverUrl = upstream.url`. The SDK runs discovery,
 *   DCR if needed, generates PKCE, and calls
 *   `provider.redirectToAuthorization(url)` — we capture the URL and
 *   return a 302 to it. If `auth()` returns `'AUTHORIZED'` (tokens
 *   already valid) we just redirect back to `/upstreams` — no flow
 *   needed.
 *
 * - `GET /api/upstreams/oauth/callback?code=&state=` — no session
 *   middleware. The one-time KV state names the user. A cookie start
 *   still requires that browser session to match. A gateway start
 *   stores `tenantId` + an allowlisted `returnOrigin` and the callback
 *   runs in that tenant (the IdP redirect has no ctxlayer cookie).
 *
 * The callback path is GLOBAL (not per-upstream) so we only need one
 * redirect_uri registered per ctxlayer deployment. That redirect_uri
 * stays this Worker's `/api/upstreams/oauth/callback`. It is not a
 * Nest URL: the IdP sends the browser here, and we bounce to Kedi.
 */

import { Hono, type Context } from 'hono'
import { auth as mcpAuth } from '@modelcontextprotocol/sdk/client/auth.js'
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { Env } from '../env'
import { decideGateway, type GatewayOAuthBind } from '../auth/kedi-gateway'
import {
  requireUser,
  resolveBrowserUser,
  skipGatewayOauthCallback,
  type AuthedVariables
} from '../auth/middleware'
import {
  getUpstreamVisibleToUser,
  parseAuthConfig,
  type UpstreamServerRow
} from '../db/queries/upstreams'
import { deleteUserCredential } from '../db/queries/upstream-credentials'
import {
  UpstreamOAuthProvider,
  deleteVerifierState,
  readVerifierState,
  type OAuthReturnTarget
} from '../upstream/oauth-provider'
import {
  buildAuthorizeRedirect,
  exchangeCode,
  refreshStatic,
  staticOAuth
} from '../upstream/oauth-static'
import { refreshCatalogueByUpstreamId, warmCatalogueAndLog } from '../upstream/catalogue'
import { notFound } from './respond'
import { errMessage } from '../util/errors'
import { newCorrelationId } from '../mcp/upstream-error'
import { gatewayReturnOrigin, listedOrigin } from '../util/origin'
import { isGatewayTenantId, runWithGatewayTenant } from '../db/tenant-db'

// SPA paths we're allowed to bounce the user back to after the OAuth
// dance — `return_to=admin` lands them on the admin upstreams page
// instead of /upstreams, so admin onboarding flows don't context-switch.
const RETURN_PATHS: Record<OAuthReturnTarget, string> = {
  user: '/app/upstreams',
  admin: '/app/admin/upstreams'
}

function parseReturnTo(raw: string | undefined): OAuthReturnTarget {
  return raw === 'admin' ? 'admin' : 'user'
}

function spaReturnUrl(env: Env, target: OAuthReturnTarget, returnOrigin?: string): string {
  return new URL(RETURN_PATHS[target], returnOrigin ?? env.PUBLIC_BASE_URL).toString()
}

function authorizeBody(url: string): Response {
  return Response.json({ authorizeUrl: url })
}

export const upstreamOauthStartRoute = new Hono<{
  Bindings: Env
  Variables: AuthedVariables
}>()
upstreamOauthStartRoute.use('*', skipGatewayOauthCallback(requireUser))

upstreamOauthStartRoute.get('/:id/oauth/start', async (c) => {
  const gateway = await decideGateway(c.req.raw, c.env)
  // Two inner branches below delete stored credentials, and SameSite=Lax does
  // not stop a forced TOP-LEVEL cross-site navigation to a GET. Legit entries
  // are the SPA (same-origin navigation) or a hand-typed URL (none); reject
  // what the browser itself labels cross-site. An absent header (older
  // browsers, curl) passes — defense-in-depth on top of requireUser.
  // A verified gateway call is server-side or cross-site from Kedi; the
  // assertion is the credential, so Sec-Fetch-Site is not a signal here.
  if (gateway.kind !== 'ok') {
    const fetchSite = c.req.header('sec-fetch-site')
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      return c.json({ error: 'cross_site_navigation' }, 403)
    }
  }
  let bind: GatewayOAuthBind | undefined
  if (gateway.kind === 'ok') {
    const returnOrigin = gatewayReturnOrigin(c.req.raw, c.env.KEDI_GATEWAY_RETURN_ORIGINS)
    if (!returnOrigin) return c.json({ error: 'return_origin_rejected' }, 400)
    bind = { tenantId: gateway.claims.tid, returnOrigin }
  }
  const userId = c.get('user').userId
  const id = c.req.param('id')
  // Visibility-gated, matching the git equivalent (`api/git-oauth.ts`): an
  // ungranted caller must not be able to start an OAuth dance against — or
  // even confirm the existence of — an upstream scoped to another team.
  const upstream = await getUpstreamVisibleToUser(c.env, userId, { id })
  if (!upstream) return notFound(c)
  if (upstream.auth_strategy !== 'user_oauth') {
    return c.json({ error: 'auth_strategy_mismatch', expected: 'user_oauth' }, 400)
  }
  const returnTo = parseReturnTo(c.req.query('return_to'))
  // `?renew=1`: force a fresh interactive authorization even though a working
  // credential is on file — the only way to restart a provider's absolute
  // grant lifetime before it runs out (see UpstreamOAuthProvider.forceInteractive).
  const renew = c.req.query('renew') === '1'

  try {
    return await runStart(c, upstream, userId, returnTo, true, renew, bind)
  } catch (err) {
    // OAuth error during the refresh attempt — most commonly Notion (or
    // any upstream) rotating / revoking / expiring our stored
    // refresh_token. The SDK re-throws non-ServerError OAuthErrors
    // instead of falling through to startAuthorization, which leaves
    // the user stuck in a 502 loop unless we wipe the bad creds and
    // start a fresh dance. Self-heal once.
    if (err instanceof OAuthError) {
      console.warn(
        `[oauth] ${upstream.slug}: refresh rejected (${err.errorCode ?? 'unknown'}); clearing stored creds and retrying`
      )
      await deleteUserCredential(c.env, userId, upstream.id)
      try {
        return await runStart(c, upstream, userId, returnTo, true, false, bind)
      } catch (retryErr) {
        return oauthStartFailed(c, upstream.slug, retryErr, 'retry after wipe failed')
      }
    }
    return oauthStartFailed(c, upstream.slug, err, 'start failed')
  }
})

/**
 * 502 for a failed OAuth start. SDK/upstream exception text can carry internal
 * hostnames or endpoint detail, so the browser gets a generic code + a `ref`
 * correlation id and the real message stays in the server log — the same
 * stance `git-oauth.ts` and the agent-facing `formatUpstreamError` take.
 */
function oauthStartFailed(c: StartCtx, slug: string, err: unknown, what: string): Response {
  const ref = newCorrelationId()
  console.error(`[oauth] [ref=${ref}] ${slug}: ${what}: ${errMessage(err)}`)
  return c.json(
    { error: 'oauth_start_failed', hint: `OAuth start failed upstream (ref=${ref}).` },
    502
  )
}

type StartCtx = Context<{ Bindings: Env; Variables: AuthedVariables }>

async function runStart(
  c: StartCtx,
  upstream: UpstreamServerRow,
  userId: string,
  returnTo: OAuthReturnTarget,
  // When true (the normal entry), an AUTHORIZED token that turns out to be
  // dead at the upstream's MCP layer triggers a wipe + a forced interactive
  // re-auth. The recursive call passes false to stop after one heal.
  selfHeal = true,
  // Skip the refresh-first shortcut and go straight to the provider's
  // authorize page (renewing a still-healthy grant).
  renew = false,
  bind?: GatewayOAuthBind
) {
  const provider = new UpstreamOAuthProvider(c.env, upstream, userId, undefined, returnTo, bind)
  provider.forceInteractive = renew

  // Resolve a usable access token (`access`) via one of two paths, or 302 to
  // the IdP when an interactive authorization is needed.
  let access: string | null
  const staticCfg = staticOAuth(parseAuthConfig(upstream.auth_config))
  if (staticCfg) {
    // Pre-registered (Entra) client — no SDK discovery/DCR. Try a refresh;
    // if there's nothing usable (or this is a renew), bounce to the
    // authorize endpoint.
    access = renew ? null : await refreshStatic(c.env, provider, staticCfg)
    if (!access) {
      const url = await buildAuthorizeRedirect(provider, staticCfg)
      return bind ? authorizeBody(url) : c.redirect(url, 302)
    }
  } else {
    const result = await mcpAuth(provider, {
      serverUrl: upstream.url ?? '',
      fetchFn: provider.capturingFetch
    })
    if (result !== 'AUTHORIZED') {
      if (!provider.capturedRedirect) {
        // SDK returned 'REDIRECT' but didn't hand us a URL. Defensive: bail.
        return c.json({ error: 'oauth_redirect_missing' }, 500)
      }
      const url = provider.capturedRedirect.toString()
      return bind ? authorizeBody(url) : c.redirect(url, 302)
    }
    access = (await provider.tokens())?.access_token ?? null
  }

  // Tokens on file and accepted (possibly just refreshed). Reconnect doubles
  // as a force-refresh, so re-warm the catalogue — but SYNCHRONOUSLY, because
  // a user_oauth token can be accepted here yet still be rejected by the
  // upstream at the MCP layer with "session expired / re-authenticate"
  // (Linear's -32002). That rejection is invisible to auth()/refresh, so the
  // reconnect silently loops on the refresh path and never prompts a real
  // login. If the probe shows the token is dead, wipe it and fall through to
  // a full interactive authorization (once).
  const probe = await refreshCatalogueByUpstreamId(c.env, upstream.id, access)
  if (probe.ok) {
    console.log(
      `[catalogue] ${probe.slug}: re-warmed ${probe.toolsCount} tools after AUTHORIZED reconnect`
    )
  } else if (selfHeal && isReauthSignal(probe.message)) {
    console.warn(
      `[oauth] ${upstream.slug}: token accepted but rejected at MCP layer (${probe.reason}); wiping creds + forcing interactive re-auth`
    )
    await deleteUserCredential(c.env, userId, upstream.id)
    return runStart(c, upstream, userId, returnTo, false, false, bind)
  } else {
    console.warn(
      `[catalogue] ${upstream.slug}: reconnect-AUTHORIZED refresh failed (${probe.reason})${
        probe.message ? `: ${probe.message}` : ''
      }`
    )
  }
  if (bind) return c.json({ connected: true })
  return c.redirect(
    `${spaReturnUrl(c.env, returnTo)}?oauth_connected=${encodeURIComponent(upstream.slug)}`,
    302
  )
}

export const upstreamOauthCallbackRoute = new Hono<{
  Bindings: Env
  Variables: AuthedVariables
}>()

upstreamOauthCallbackRoute.get('/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const errParam = c.req.query('error')
  const stored = state ? await readVerifierState(c.env, state) : null

  // returnTo isn't known yet if state is missing/expired; default to
  // the user-side page in that degenerate path so we still land
  // somewhere sensible.
  const returnTo: OAuthReturnTarget = stored?.returnTo ?? 'user'
  const gatewayFinish = stored?.tenantId
    ? checkedGatewayBind(c.env, stored.tenantId, stored.returnOrigin)
    : null
  if (gatewayFinish instanceof Response) return gatewayFinish

  const identity = gatewayFinish
    ? { userId: stored!.userId, bind: gatewayFinish }
    : await browserCallbackUser(c, stored?.userId)
  if (identity instanceof Response) return identity
  const userId = identity.userId
  const returnOrigin = identity.bind?.returnOrigin

  if (errParam) {
    // Forward only the enumerable IdP error CODE; the free-text
    // error_description lands in browser history + access logs, so it stays
    // in the server log (matching git-oauth's stricter stance).
    const desc = c.req.query('error_description') ?? ''
    if (desc) console.warn(`[oauth] callback error ${errParam}: ${desc}`)
    if (state) await deleteVerifierState(c.env, state)
    return c.redirect(
      `${spaReturnUrl(c.env, returnTo, returnOrigin)}?oauth_error=${encodeURIComponent(errParam)}`,
      302
    )
  }
  if (!code || !state) return c.json({ error: 'oauth_callback_missing_params' }, 400)
  if (!stored) return c.json({ error: 'oauth_state_unknown_or_expired' }, 400)

  const finish = () =>
    completeUpstreamCallback(c, {
      userId,
      code,
      state,
      stored,
      returnTo,
      returnOrigin
    })
  if (identity.bind) return runWithGatewayTenant(identity.bind.tenantId, finish)
  return finish()
})

function checkedGatewayBind(
  env: Env,
  tenantId: string,
  returnOrigin: string | undefined
): GatewayOAuthBind | Response {
  if (!isGatewayTenantId(tenantId))
    return Response.json({ error: 'oauth_state_unknown_or_expired' }, { status: 400 })
  const origin = listedOrigin(returnOrigin, env.KEDI_GATEWAY_RETURN_ORIGINS)
  if (!origin) return Response.json({ error: 'return_origin_rejected' }, { status: 400 })
  return { tenantId, returnOrigin: origin }
}

async function browserCallbackUser(
  c: StartCtx,
  expectedUserId: string | undefined
): Promise<{ userId: string; bind?: undefined } | Response> {
  const session = await resolveBrowserUser(c)
  if ('error' in session) return session.error
  if (expectedUserId && session.user.userId !== expectedUserId) {
    return c.json({ error: 'oauth_user_mismatch' }, 403)
  }
  return { userId: session.user.userId }
}

async function completeUpstreamCallback(
  c: StartCtx,
  input: {
    userId: string
    code: string
    state: string
    stored: NonNullable<Awaited<ReturnType<typeof readVerifierState>>>
    returnTo: OAuthReturnTarget
    returnOrigin?: string
  }
): Promise<Response> {
  const { userId, code, state, stored, returnTo, returnOrigin } = input
  // Re-check visibility at token time, matching the git twin
  // (`api/git-oauth.ts`): a grant revoked mid-dance must not still land
  // a credential.
  const upstream = await getUpstreamVisibleToUser(c.env, userId, { id: stored.upstreamId })
  if (!upstream) return notFound(c)

  const provider = new UpstreamOAuthProvider(c.env, upstream, userId, state)
  const staticCfg = staticOAuth(parseAuthConfig(upstream.auth_config))
  try {
    if (staticCfg) {
      await exchangeCode(c.env, provider, staticCfg, code)
    } else {
      const result = await mcpAuth(provider, {
        serverUrl: upstream.url ?? '',
        authorizationCode: code,
        fetchFn: provider.capturingFetch
      })
      if (result !== 'AUTHORIZED') {
        return c.json({ error: 'oauth_exchange_did_not_authorize' }, 502)
      }
    }
  } catch (err) {
    const ref = newCorrelationId()
    console.error(`[oauth] [ref=${ref}] callback exchange failed for ${upstream.slug}:`, err)
    return c.redirect(
      `${spaReturnUrl(c.env, returnTo, returnOrigin)}?oauth_error=exchange&desc=${encodeURIComponent(`ref:${ref}`)}`,
      302
    )
  } finally {
    // One-shot use — drop the verifier even on error so a replay can't
    // reuse it.
    await deleteVerifierState(c.env, state)
  }

  const access = (await provider.tokens())?.access_token ?? null
  c.executionCtx.waitUntil(
    warmCatalogueAndLog(c.env, {
      upstreamId: upstream.id,
      slug: upstream.slug,
      bearerToken: access,
      okContext: 'after OAuth',
      failLabel: 'post-OAuth refresh'
    })
  )

  return c.redirect(
    `${spaReturnUrl(c.env, returnTo, returnOrigin)}?oauth_connected=${encodeURIComponent(upstream.slug)}`,
    302
  )
}

/**
 * Does an upstream catalogue-refresh error message signal that the token
 * was rejected for AUTH reasons (so a wipe + re-auth is warranted) vs a
 * transient network/5xx (where wiping creds would be wrong)? Narrow on
 * purpose — we delete stored creds on a match. Linear surfaces a JSON-RPC
 * -32002 "Session expired. Please re-authenticate." at the MCP layer; the
 * generic auth phrases cover other upstreams.
 */
export function isReauthSignal(msg: string | undefined | null): boolean {
  if (!msg) return false
  return /(-32002|session expired|re-?authenticate|invalid[_ ]token|unauthorized|\b401\b)/i.test(
    msg
  )
}
