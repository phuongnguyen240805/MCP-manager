/**
 * Map a trusted-gateway (issuer, subject) onto a local user.
 *
 * Lookup is the external_identities primary key (issuer, subject, tenant).
 * The same Nest subject in two tenants is two local users, so a role flip
 * cannot cross tenants. Email is a synthetic `kedi.<hash>@gateway.invalid`
 * (the hash includes the tenant) so UNIQUE(users.email) cannot attach this
 * subject to a human who signed in with Google, GitHub, or Access, or to
 * the same subject in another tenant.
 * `hub_role` is applied on every assertion: admin only while the claim
 * says admin. A locally suspended row stays suspended.
 */

import type { Role } from '@ctxlayer/shared'
import type { Env } from '../../env'
import { isUniqueViolation, newId } from './util'
import { updateUserRole, type UserRow } from './users'

const USER_COLUMNS = `id, email, name, avatar_url, idp, idp_sub, role, status, created_at, last_seen_at, session_epoch`

export async function resolveGatewayUser(
  env: Env,
  input: {
    issuer: string
    subject: string
    tenantId: string
    hubRole: 'member' | 'admin'
    /** Display only. Omitted claims leave the stored value alone. */
    name: string | null
    email: string | null
  }
): Promise<{ user: UserRow } | { inactive: true }> {
  const role: Role = input.hubRole === 'admin' ? 'admin' : 'user'
  const existing = await findGatewayUser(env, input.issuer, input.subject, input.tenantId)
  if (existing) return activateRole(env, existing, role, input)

  try {
    await insertGatewayUser(env, input, role)
  } catch (err) {
    // Two assertions for a brand-new subject can insert together. The loser
    // re-reads. Any other unique hit (email) is NOT treated as a match —
    // the synthetic users.email is what keeps a display address from linking.
    if (!isUniqueViolation(err)) throw err
  }
  const row = await findGatewayUser(env, input.issuer, input.subject, input.tenantId)
  if (!row) throw new Error('gateway_user_insert_failed')
  return activateRole(env, row, role, input)
}

async function activateRole(
  env: Env,
  row: UserRow,
  role: Role,
  input: {
    issuer: string
    subject: string
    tenantId: string
    name: string | null
    email: string | null
  }
): Promise<{ user: UserRow } | { inactive: true }> {
  if (row.status !== 'active') return { inactive: true }
  if (row.role !== role) {
    await updateUserRole(env, row.id, role)
    row.role = role
  }
  return { user: await syncGatewayProfile(env, row, input) }
}

async function syncGatewayProfile(
  env: Env,
  row: UserRow,
  input: {
    issuer: string
    subject: string
    tenantId: string
    name: string | null
    email: string | null
  }
): Promise<UserRow> {
  if (input.name && input.name !== row.name) {
    await env.DB.prepare(`UPDATE users SET name = ?1 WHERE id = ?2`).bind(input.name, row.id).run()
    row.name = input.name
  }
  // display_email is not users.email. Invites and IdP upsert match the
  // synthetic address, so this claim cannot attach a second account.
  if (input.email && input.email !== row.display_email) {
    await env.DB.prepare(
      `UPDATE external_identities SET display_email = ?1
       WHERE issuer = ?2 AND subject = ?3 AND tenant_id = ?4`
    )
      .bind(input.email, input.issuer, input.subject, input.tenantId)
      .run()
    row.display_email = input.email
  }
  return row
}

async function findGatewayUser(
  env: Env,
  issuer: string,
  subject: string,
  tenantId: string
): Promise<UserRow | null> {
  const row = await env.DB.prepare(
    `SELECT ${USER_COLUMNS}, (
       SELECT display_email FROM external_identities
       WHERE issuer = ?1 AND subject = ?2 AND tenant_id = ?3
     ) AS display_email
     FROM users
     WHERE id = (
       SELECT user_id FROM external_identities
       WHERE issuer = ?1 AND subject = ?2 AND tenant_id = ?3
     )`
  )
    .bind(issuer, subject, tenantId)
    .first<UserRow>()
  return row ?? null
}

async function insertGatewayUser(
  env: Env,
  input: {
    issuer: string
    subject: string
    tenantId: string
    name: string | null
    email: string | null
  },
  role: Role
): Promise<void> {
  const id = newId()
  // Tenant is part of the hash so two tenants cannot collide on users.email
  // and cannot attach to each other's row. The human email stays on
  // external_identities.display_email and is never this column.
  const key = await sha256Hex(`${input.issuer}\n${input.subject}\n${input.tenantId}`)
  const now = Math.floor(Date.now() / 1000)
  const email = `kedi.${key}@gateway.invalid`
  const name = input.name ?? displaySubject(input.subject)
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users
         (id, email, name, avatar_url, idp, idp_sub, role, status, created_at, last_seen_at, tenant_id)
       VALUES (?1, ?2, ?3, NULL, 'kedi', ?4, ?5, 'active', ?6, ?6, ?7)`
    ).bind(id, email, name, key, role, now, input.tenantId),
    env.DB.prepare(
      `INSERT INTO external_identities
         (issuer, subject, tenant_id, user_id, created_at, display_email)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(input.issuer, input.subject, input.tenantId, id, now, input.email)
  ])
}

function displaySubject(subject: string): string {
  return subject.slice(0, 80)
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
