import { describe, expect, it } from 'vitest'
import { rewriteTenantSql, TenantSqlError } from './tenant-sql'

const TID = 'tenant-a'

function rewrite(sql: string) {
  return rewriteTenantSql(sql, TID)
}

describe('rewriteTenantSql', () => {
  it('leaves statements that do not touch a partitioned table alone', () => {
    const sql = `DELETE FROM doc_tags WHERE doc_id = ?1`
    expect(rewrite(sql)).toEqual({ sql, extra: 0 })
  })

  it('filters a single-table read and keeps the caller binds numbered', () => {
    const out = rewrite(
      `SELECT id, slug, title FROM documents WHERE id IN (?1, ?2) AND deleted_at IS NULL`
    )
    expect(out.extra).toBe(1)
    expect(out.sql).toContain('documents.tenant_id = ?3')
    expect(out.sql).toContain('id IN (?1, ?2)')
  })

  it('puts the tenant bind after a trailing LIMIT parameter', () => {
    const out = rewrite(
      `SELECT tool FROM usage_rollups_daily
       WHERE day >= ?
       GROUP BY tool
       ORDER BY calls DESC
       LIMIT ?`
    )
    expect(out.extra).toBe(1)
    expect(out.sql).toContain('day >= ?1')
    expect(out.sql).toContain('usage_rollups_daily.tenant_id = ?3')
    expect(out.sql).toMatch(/LIMIT \?2/)
    expect(out.sql.indexOf('tenant_id')).toBeLessThan(out.sql.indexOf('GROUP BY'))
  })

  it('adds the tenant column on insert without renumbering existing params', () => {
    const out = rewrite(
      `INSERT INTO documents (id, title, slug, folder, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`
    )
    expect(out.extra).toBe(1)
    expect(out.sql).toContain('updated_at, tenant_id)')
    expect(out.sql).toContain('?6, ?6, ?7)')
  })

  it('does not add tenant_id twice when the insert already sets it', () => {
    const sql = `INSERT INTO usage_events (id, user_id, tenant_id) VALUES (?1, ?2, (SELECT tenant_id FROM users WHERE id = ?2))`
    const out = rewrite(sql)
    expect(out.sql.match(/tenant_id/g)?.length).toBeGreaterThanOrEqual(2)
    expect(out.sql).not.toContain('tenant_id, tenant_id')
    expect(out.sql).toContain('users.tenant_id = ?')
  })

  it('keeps a left join nullable and still partitions the driving table', () => {
    const out = rewrite(
      `SELECT a.id, u.email AS actor_email
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.ts < ?1
       ORDER BY a.ts DESC
       LIMIT ?2`
    )
    expect(out.extra).toBe(2)
    expect(out.sql).toMatch(/ON u\.id = a\.actor_id\s+AND u\.tenant_id = \?3 /)
    expect(out.sql).toContain('AND a.tenant_id = ?4 ')
    expect(out.sql).toContain('LIMIT ?2')
  })

  it('partitions each arm of a union', () => {
    const out = rewrite(
      `SELECT 1 AS hit FROM (
         SELECT 1 FROM users WHERE id = ?1 AND role = 'admin'
         UNION ALL
         SELECT 1 FROM documents WHERE id = ?2 AND created_by = ?1 AND deleted_at IS NULL
       ) LIMIT 1`
    )
    expect(out.sql).toMatch(/role = 'admin'\s+AND users\.tenant_id = \?3 /)
    expect(out.sql).toMatch(/deleted_at IS NULL\s+AND documents\.tenant_id = \?4 /)
    expect(out.extra).toBe(2)
  })

  it('filters an update and a delete', () => {
    const updated = rewrite(
      `UPDATE documents SET title = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL`
    )
    expect(updated.sql).toContain('deleted_at IS NULL AND documents.tenant_id = ?4')
    const deleted = rewrite(`DELETE FROM upstream_servers WHERE id = ?1`)
    expect(deleted.sql).toContain('WHERE id = ?1 AND upstream_servers.tenant_id = ?2')
  })

  it('filters the main select of a visibility CTE', () => {
    const out = rewrite(
      `WITH user_teams AS (SELECT team_id FROM team_members WHERE user_id = ?1)
       SELECT u.id FROM upstream_servers u
       LEFT JOIN upstream_visibility v ON v.upstream_id = u.id
       WHERE u.enabled = 1
       ORDER BY u.display_name`
    )
    expect(out.extra).toBe(1)
    expect(out.sql).toMatch(/u\.enabled = 1\s+AND u\.tenant_id = \?2 /)
    expect(out.sql).not.toContain('team_members.tenant_id')
  })

  it('does not hide a driving-table filter inside a left join ON', () => {
    const out = rewrite(
      `SELECT i.id, u.email AS invited_by_email
       FROM invites i
       LEFT JOIN users u ON u.id = i.invited_by
       ORDER BY i.created_at DESC`
    )
    expect(out.sql).toMatch(
      /ON u\.id = i\.invited_by\s+AND u\.tenant_id = \?1\s+WHERE i\.tenant_id = \?2\s+ORDER BY/
    )
  })

  it('inserts WHERE before ORDER BY when the statement has no WHERE', () => {
    const out = rewrite(`SELECT id, email FROM users ORDER BY LOWER(email)`)
    expect(out.sql).toMatch(/FROM users\s+WHERE users\.tenant_id = \?1 ORDER BY LOWER\(email\)$/)
    expect(out.extra).toBe(1)
  })

  it('rejects a multi-statement string', () => {
    expect(() => rewrite(`SELECT id FROM documents; SELECT id FROM skills`)).toThrow(TenantSqlError)
  })
})
