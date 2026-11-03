/**
 * Inject a gateway tenant predicate into D1 SQL.
 *
 * Cookie, MCP, queue, and cron calls never enter a gateway scope, so they
 * keep the statement they wrote. A gateway request rewrites every read and
 * write of a partitioned table before prepare(), which is the only way a
 * new query cannot forget the filter. Parameters stay bound — tenant id is
 * never concatenated into the SQL text.
 *
 * Child tables (revisions, tags, credentials, …) are not partitioned.
 * Routes reach them through a parent row that is.
 */

export const TENANT_TABLES: ReadonlySet<string> = new Set([
  'async_jobs',
  'audit_log',
  'documents',
  'external_identities',
  'git_connections',
  'git_sources',
  'invites',
  'job_runs',
  'join_codes',
  'oauth_grant_activity',
  'products',
  'roles',
  'skills',
  'teams',
  'upstream_operations',
  'upstream_servers',
  'usage_events',
  'usage_rollups_daily',
  'users'
])

export class TenantSqlError extends Error {
  constructor(code: string) {
    super(code)
    this.name = 'TenantSqlError'
  }
}

export interface RewrittenSql {
  sql: string
  /** Extra binds, appended after the caller's binds. All equal the tenant id. */
  extra: number
}

const CLAUSE_END = new Set([
  'group',
  'order',
  'limit',
  'having',
  'window',
  'union',
  'except',
  'intersect',
  'offset'
])

const JOIN_START = new Set(['left', 'right', 'inner', 'full', 'cross', 'natural', 'join'])

const ALIAS_BLOCK = new Set([
  ...CLAUSE_END,
  ...JOIN_START,
  'select',
  'from',
  'where',
  'on',
  'as',
  'and',
  'or',
  'set',
  'values',
  'insert',
  'into',
  'update',
  'delete',
  'with',
  'recursive',
  'by',
  'distinct',
  'all',
  'exists',
  'case',
  'when',
  'then',
  'else',
  'end',
  'is',
  'not',
  'null',
  'in',
  'like',
  'between',
  'escape',
  'using',
  'returning',
  'conflict',
  'ignore',
  'replace',
  'abort',
  'fail',
  'rollback',
  'do',
  'nothing',
  'outer'
])

interface Tok {
  k: 'word' | 'param' | 'punct'
  v: string
  i: number
  depth: number
  /** Set for `?` (null) and `?N`. */
  param: number | null
}

export function rewriteTenantSql(sql: string, tenantId: string): RewrittenSql {
  if (!tenantId) throw new TenantSqlError('tenant_sql_empty')
  const tokens = tokenize(sql)
  if (tokens.some((t) => t.k === 'punct' && t.v === ';')) {
    throw new TenantSqlError('tenant_sql_semicolon')
  }
  if (!tokens.some((t) => t.k === 'word' && TENANT_TABLES.has(t.v.toLowerCase()))) {
    return { sql, extra: 0 }
  }

  const normalized = normalizeParams(sql, tokens)
  let next = normalized.sql
  let max = normalized.max
  let extra = 0

  const inserted = injectInsertTenant(next, max)
  if (inserted) {
    next = inserted.sql
    max = inserted.max
    extra += inserted.extra
  }

  const filtered = injectFilters(next, max)
  return { sql: filtered.sql, extra: extra + filtered.extra }
}

function tokenize(sql: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  let depth = 0
  while (i < sql.length) {
    const c = sql[i]!
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? sql.length : nl + 1
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 2
      continue
    }
    if (c === "'") {
      i++
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }
    if (c === '"') {
      i++
      while (i < sql.length && sql[i] !== '"') i++
      i++
      continue
    }
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '(') {
      out.push({ k: 'punct', v: '(', i, depth, param: null })
      depth++
      i++
      continue
    }
    if (c === ')') {
      depth = Math.max(0, depth - 1)
      out.push({ k: 'punct', v: ')', i, depth, param: null })
      i++
      continue
    }
    if (c === '?') {
      let j = i + 1
      while (j < sql.length && sql[j]! >= '0' && sql[j]! <= '9') j++
      const raw = sql.slice(i, j)
      const param = raw.length === 1 ? null : Number(raw.slice(1))
      out.push({ k: 'param', v: raw, i, depth, param })
      i = j
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j]!)) j++
      out.push({ k: 'word', v: sql.slice(i, j), i, depth, param: null })
      i = j
      continue
    }
    out.push({ k: 'punct', v: c, i, depth, param: null })
    i++
  }
  return out
}

/** Give every anonymous `?` its SQLite number so a later `?N` cannot renumber it. */
function normalizeParams(sql: string, tokens: Tok[]): { sql: string; max: number } {
  let largest = 0
  const replacements: Array<{ i: number; len: number; text: string }> = []
  for (const t of tokens) {
    if (t.k !== 'param') continue
    const num = t.param ?? largest + 1
    if (num > largest) largest = num
    if (t.param == null) replacements.push({ i: t.i, len: 1, text: `?${num}` })
  }
  if (replacements.length === 0) return { sql, max: largest }
  let out = ''
  let cursor = 0
  for (const r of replacements) {
    out += sql.slice(cursor, r.i) + r.text
    cursor = r.i + r.len
  }
  out += sql.slice(cursor)
  return { sql: out, max: largest }
}

function injectInsertTenant(
  sql: string,
  max: number
): { sql: string; max: number; extra: number } | null {
  const tokens = tokenize(sql)
  const insertAt = tokens.findIndex(
    (t) => t.k === 'word' && t.v.toLowerCase() === 'insert' && t.depth === 0
  )
  if (insertAt < 0) return null

  let i = insertAt + 1
  if (wordIs(tokens[i], 'or')) {
    i++
    const mode = tokens[i]?.v.toLowerCase()
    if (
      mode !== 'ignore' &&
      mode !== 'replace' &&
      mode !== 'abort' &&
      mode !== 'fail' &&
      mode !== 'rollback'
    ) {
      throw new TenantSqlError('tenant_sql_insert')
    }
    i++
  }
  if (!wordIs(tokens[i], 'into')) return null
  i++
  const tableTok = tokens[i]
  if (!tableTok || tableTok.k !== 'word') throw new TenantSqlError('tenant_sql_insert')
  const table = tableTok.v.toLowerCase()
  if (!TENANT_TABLES.has(table)) return null
  i++
  if (!punctIs(tokens[i], '(')) throw new TenantSqlError('tenant_sql_insert')
  const cols: string[] = []
  i++
  while (i < tokens.length && !punctIs(tokens[i], ')')) {
    if (tokens[i]?.k === 'word') cols.push(tokens[i]!.v.toLowerCase())
    i++
  }
  const colClose = tokens[i]
  if (!colClose || !punctIs(colClose, ')')) throw new TenantSqlError('tenant_sql_insert')
  if (cols.includes('tenant_id')) return null
  i++
  if (!wordIs(tokens[i], 'values')) throw new TenantSqlError('tenant_sql_insert')
  i++
  if (!punctIs(tokens[i], '(')) throw new TenantSqlError('tenant_sql_insert')
  const valuesOpen = tokens[i]!
  let depth = valuesOpen.depth + 1
  i++
  while (i < tokens.length && depth > valuesOpen.depth) {
    if (punctIs(tokens[i], '(')) depth++
    if (punctIs(tokens[i], ')')) depth--
    if (depth === valuesOpen.depth) break
    i++
  }
  const valuesClose = tokens[i]
  if (!valuesClose || !punctIs(valuesClose, ')')) throw new TenantSqlError('tenant_sql_insert')

  const param = max + 1
  let out = sql
  out = out.slice(0, valuesClose.i) + `, ?${param}` + out.slice(valuesClose.i)
  out = out.slice(0, colClose.i) + ', tenant_id' + out.slice(colClose.i)
  return { sql: out, max: param, extra: 1 }
}

interface Ref {
  alias: string
  insertAt: number
  where: boolean
}

function injectFilters(sql: string, max: number): { sql: string; extra: number } {
  const tokens = tokenize(sql)
  const refs = findRefs(tokens, sql)
  if (refs.length === 0) return { sql, extra: 0 }
  refs.sort((a, b) => a.insertAt - b.insertAt || (a.where === b.where ? 0 : a.where ? 1 : -1))
  const edits: Array<{ at: number; text: string }> = []
  refs.forEach((ref, idx) => {
    const param = max + 1 + idx
    const pred = `${ref.alias}.tenant_id = ?${param}`
    // Trailing space: the insertion point is the first character of the next
    // keyword, so without it `?3` glues onto `WHERE` / `ORDER` / `UNION`.
    edits.push({ at: ref.insertAt, text: ref.where ? ` WHERE ${pred} ` : ` AND ${pred} ` })
  })
  const merged: Array<{ at: number; text: string }> = []
  for (const e of edits) {
    const prev = merged[merged.length - 1]
    if (prev && prev.at === e.at) {
      // ON-clause ANDs share this spot with a new WHERE when the statement
      // has no WHERE yet (both land on ORDER/LIMIT). Keep the WHERE keyword
      // so the driving table is not filtered only inside the LEFT JOIN.
      if (prev.text.includes(' WHERE ') || e.text.startsWith(' AND ')) {
        prev.text += e.text.replace(/^ WHERE /, ' AND ')
      } else {
        prev.text += e.text
      }
    } else merged.push({ ...e })
  }
  let out = sql
  for (let n = merged.length - 1; n >= 0; n--) {
    const e = merged[n]!
    out = out.slice(0, e.at) + e.text + out.slice(e.at)
  }
  return { sql: out, extra: refs.length }
}

function findRefs(tokens: Tok[], sql: string): Ref[] {
  const refs: Ref[] = []
  for (let n = 0; n < tokens.length; n++) {
    const t = tokens[n]!
    if (t.k !== 'word') continue
    const word = t.v.toLowerCase()
    if (word === 'update') {
      const ref = tableAfter(tokens, n + 1, t.depth)
      if (!ref || !TENANT_TABLES.has(ref.table)) continue
      refs.push(driveRef(tokens, ref.end, ref.alias, t.depth, sql))
      continue
    }
    if (word === 'delete') {
      let p = n + 1
      if (wordIs(tokens[p], 'from')) p++
      const ref = tableAfter(tokens, p, t.depth)
      if (!ref || !TENANT_TABLES.has(ref.table)) continue
      refs.push(driveRef(tokens, ref.end, ref.alias, t.depth, sql))
      continue
    }
    if (word === 'from') {
      const prev = previousWord(tokens, n)
      if (prev === 'delete' || prev === 'extract') continue
      const ref = tableAfter(tokens, n + 1, t.depth)
      if (!ref || !TENANT_TABLES.has(ref.table)) continue
      refs.push(driveRef(tokens, ref.end, ref.alias, t.depth, sql))
      continue
    }
    if (word === 'join') {
      const kind = joinKind(tokens, n)
      const ref = tableAfter(tokens, n + 1, t.depth)
      if (!ref || !TENANT_TABLES.has(ref.table)) continue
      if (kind === 'left') refs.push(leftRef(tokens, ref.end, ref.alias, t.depth, sql))
      else refs.push(driveRef(tokens, ref.end, ref.alias, t.depth, sql))
    }
  }
  return refs
}

function driveRef(tokens: Tok[], from: number, alias: string, depth: number, sql: string): Ref {
  const end = blockEnd(tokens, from, depth, sql)
  const whereIdx = tokens.findIndex(
    (t, idx) =>
      idx >= from &&
      idx < end &&
      t.k === 'word' &&
      t.v.toLowerCase() === 'where' &&
      t.depth === depth
  )
  const clauseIdx = tokens.findIndex(
    (t, idx) =>
      idx >= (whereIdx === -1 ? from : whereIdx + 1) &&
      idx < end &&
      t.depth === depth &&
      t.k === 'word' &&
      CLAUSE_END.has(t.v.toLowerCase())
  )
  const at = clauseIdx === -1 ? tokenIndex(tokens, end, sql) : tokens[clauseIdx]!.i
  return { alias, insertAt: at, where: whereIdx === -1 }
}

function leftRef(tokens: Tok[], from: number, alias: string, depth: number, sql: string): Ref {
  const on = tokens.findIndex(
    (t, idx) => idx >= from && t.depth === depth && t.k === 'word' && t.v.toLowerCase() === 'on'
  )
  if (on < 0) throw new TenantSqlError('tenant_sql_join')
  const stop = tokens.findIndex(
    (t, idx) =>
      idx > on &&
      t.depth === depth &&
      t.k === 'word' &&
      (JOIN_START.has(t.v.toLowerCase()) ||
        CLAUSE_END.has(t.v.toLowerCase()) ||
        t.v.toLowerCase() === 'where')
  )
  const at = stop === -1 ? sql.length : tokens[stop]!.i
  return { alias, insertAt: at, where: false }
}

function blockEnd(tokens: Tok[], from: number, depth: number, _sql: string): number {
  for (let n = from; n < tokens.length; n++) {
    const t = tokens[n]!
    if (t.depth < depth) return n
    if (
      t.depth === depth &&
      t.k === 'word' &&
      (t.v.toLowerCase() === 'union' ||
        t.v.toLowerCase() === 'except' ||
        t.v.toLowerCase() === 'intersect')
    ) {
      return n
    }
  }
  return tokens.length
}

function tokenIndex(tokens: Tok[], end: number, sql: string): number {
  if (end >= tokens.length) return sql.length
  return tokens[end]!.i
}

function tableAfter(
  tokens: Tok[],
  start: number,
  depth: number
): { table: string; alias: string; end: number } | null {
  const tableTok = tokens[start]
  if (!tableTok || tableTok.k !== 'word' || tableTok.depth !== depth) return null
  if (tableTok.v === '(') return null
  const table = tableTok.v.toLowerCase()
  let end = start + 1
  let alias = table
  const next = tokens[end]
  if (next && next.k === 'word' && next.depth === depth && next.v.toLowerCase() === 'as') {
    const named = tokens[end + 1]
    if (!named || named.k !== 'word') throw new TenantSqlError('tenant_sql_alias')
    alias = named.v
    end += 2
  } else if (
    next &&
    next.k === 'word' &&
    next.depth === depth &&
    !ALIAS_BLOCK.has(next.v.toLowerCase())
  ) {
    alias = next.v
    end += 1
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new TenantSqlError('tenant_sql_alias')
  return { table, alias, end }
}

function joinKind(tokens: Tok[], joinAt: number): 'left' | 'inner' {
  const depth = tokens[joinAt]!.depth
  const words: string[] = []
  for (let n = joinAt - 1; n >= 0 && words.length < 3; n--) {
    const t = tokens[n]!
    if (t.depth !== depth) break
    if (t.k !== 'word') continue
    words.push(t.v.toLowerCase())
  }
  const closest = words[0]
  if (closest === 'left' || closest === 'right' || closest === 'full') return 'left'
  if (closest === 'outer' && (words[1] === 'left' || words[1] === 'right' || words[1] === 'full')) {
    return 'left'
  }
  return 'inner'
}

function previousWord(tokens: Tok[], from: number): string | null {
  const depth = tokens[from]?.depth
  for (let n = from - 1; n >= 0; n--) {
    const t = tokens[n]!
    if (t.depth !== depth) return null
    if (t.k === 'word') return t.v.toLowerCase()
  }
  return null
}

function wordIs(t: Tok | undefined, word: string): boolean {
  return !!t && t.k === 'word' && t.v.toLowerCase() === word
}

function punctIs(t: Tok | undefined, punct: string): boolean {
  return !!t && t.k === 'punct' && t.v === punct
}
