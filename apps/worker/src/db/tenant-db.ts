/**
 * Per-request gateway tenant scope.
 *
 * The worker `env` object is shared across concurrent requests, so the
 * scope lives in AsyncLocalStorage and the D1 binding is a proxy: with no
 * scope, `prepare` is the real one (cookie, MCP, queues, cron). Inside
 * `runWithGatewayTenant`, partitioned tables gain `tenant_id = ?`.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import { rewriteTenantSql, TenantSqlError } from './tenant-sql'

const scope = new AsyncLocalStorage<string>()
const BRAND = Symbol.for('ctxlayer.tenantAwareDb')

const MAX_TENANT_CHARS = 256

export function currentGatewayTenant(): string | null {
  return scope.getStore() ?? null
}

/** `tid` from a verified assertion. Rejects anything that claim parser would. */
export function isGatewayTenantId(value: string): boolean {
  if (value.length === 0 || value.length > MAX_TENANT_CHARS) return false
  if (value !== value.trim()) return false
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false
  }
  return true
}

export function runWithGatewayTenant<T>(tenantId: string, fn: () => T): T {
  if (!isGatewayTenantId(tenantId)) throw new TenantSqlError('tenant_sql_empty')
  return scope.run(tenantId, fn)
}

export function isTenantAwareDb(db: D1Database): boolean {
  return (db as { [BRAND]?: boolean })[BRAND] === true
}

/**
 * Install the proxy on a mutable env (tests, and any caller that holds a
 * plain object). Production bindings are immutable; `withTenantAwareEnv`
 * wraps those instead.
 */
export function ensureTenantAwareDb(env: { DB: D1Database }): void {
  if (isTenantAwareDb(env.DB)) return
  const aware = tenantAwareDb(env.DB)
  try {
    Object.defineProperty(env, 'DB', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: aware
    })
  } catch (err) {
    console.error('[tenant] db bind failed', err instanceof Error ? err.name : 'error')
  }
}

export function withTenantAwareEnv<T extends { DB: D1Database }>(env: T): T {
  if (isTenantAwareDb(env.DB)) return env
  const aware = tenantAwareDb(env.DB)
  return new Proxy(env, {
    get(target, prop, _receiver) {
      if (prop === 'DB') return aware
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value
    }
  }) as T
}

function tenantAwareDb(raw: D1Database): D1Database {
  const aware = new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === BRAND) return true
      if (prop === 'prepare') {
        return (sql: string) => prepareScoped(target, sql)
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value
    }
  })
  return aware as D1Database
}

function prepareScoped(raw: D1Database, sql: string): D1PreparedStatement {
  const tenantId = currentGatewayTenant()
  if (!tenantId) return raw.prepare(sql)
  let rewritten: { sql: string; extra: number }
  try {
    rewritten = rewriteTenantSql(sql, tenantId)
  } catch (err) {
    console.error(
      '[tenant] query rejected',
      err instanceof TenantSqlError ? err.message : 'tenant_sql'
    )
    throw new Error('internal')
  }
  const stmt = raw.prepare(rewritten.sql)
  if (rewritten.extra === 0) return stmt
  const extra = Array.from({ length: rewritten.extra }, () => tenantId)
  return withExtraBinds(stmt, extra)
}

const RUNNERS = new Set(['first', 'all', 'run', 'raw'])

function withExtraBinds(stmt: D1PreparedStatement, extra: unknown[]): D1PreparedStatement {
  return new Proxy(stmt, {
    get(target, prop, receiver) {
      if (prop === 'bind') {
        return (...args: unknown[]) => target.bind(...args, ...extra)
      }
      if (typeof prop === 'string' && RUNNERS.has(prop)) {
        const bound = target.bind(...extra)
        const fn = bound[prop as 'first'] as (...args: unknown[]) => unknown
        return (...args: unknown[]) => fn.apply(bound, args)
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value
    }
  }) as D1PreparedStatement
}
