/**
 * Map a trusted-gateway (issuer, subject) onto a local user.
 *
 * Lookup is only the external_identities primary key. Email is a synthetic
 * `kedi.<hash>@gateway.invalid` so UNIQUE(users.email) cannot attach this
 * subject to a human who signed in with Google, GitHub, or Access.
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
  input: { issuer: string; subject: string; hubRole: 'member' | 'admin' }
): Promise<{ user: UserRow } | { inactive: true }> {
  const role: Role = input.hubRole === 'admin' ? 'admin' : 'user'
  const existing = await findGatewayUser(env, input.issuer, input.subject)
  if (existing) return activateRole(env, existing, role)

  try {
    await insertGatewayUser(env, input, role)
  } catch (err) {
    // Two assertions for a brand-new subject can insert together. The loser
    // re-reads. Any other unique hit (email) is NOT treated as a match.
    if (!isUniqueViolation(err)) throw err
  }
  const row = await findGatewayUser(env, input.issuer, input.subject)
  if (!row) throw new Error('gateway_user_insert_failed')
  return activateRole(env, row, role)
}

async function activateRole(
  env: Env,
  row: UserRow,
  role: Role
): Promise<{ user: UserRow } | { inactive: true }> {
  if (row.status !== 'active') return { inactive: true }
  if (row.role !== role) {
    await updateUserRole(env, row.id, role)
    row.role = role
  }
  return { user: row }
}

async function findGatewayUser(env: Env, issuer: string, subject: string): Promise<UserRow | null> {
  const row = await env.DB.prepare(
    `SELECT ${USER_COLUMNS}
     FROM users
     WHERE id = (
       SELECT user_id FROM external_identities WHERE issuer = ?1 AND subject = ?2
     )`
  )
    .bind(issuer, subject)
    .first<UserRow>()
  return row ?? null
}

async function insertGatewayUser(
  env: Env,
  input: { issuer: string; subject: string },
  role: Role
): Promise<void> {
  const id = newId()
  const key = await sha256Hex(`${input.issuer}\n${input.subject}`)
  const now = Math.floor(Date.now() / 1000)
  const email = `kedi.${key}@gateway.invalid`
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users
         (id, email, name, avatar_url, idp, idp_sub, role, status, created_at, last_seen_at)
       VALUES (?1, ?2, ?3, NULL, 'kedi', ?4, ?5, 'active', ?6, ?6)`
    ).bind(id, email, displaySubject(input.subject), key, role, now),
    env.DB.prepare(
      `INSERT INTO external_identities (issuer, subject, user_id, created_at)
       VALUES (?1, ?2, ?3, ?4)`
    ).bind(input.issuer, input.subject, id, now)
  ])
}

function displaySubject(subject: string): string {
  return subject.slice(0, 80)
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
