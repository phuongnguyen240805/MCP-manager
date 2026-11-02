#!/usr/bin/env bun
/**
 * Dev-only ES256 key + a short-lived gateway assertion for curl.
 *
 * Writes the PRIVATE key to `.dev-kedi-gateway-key.json` (gitignored) and
 * prints only the public JWK plus one signed JWT. Reuses the key on later
 * runs so `.dev.vars` does not need a new JWK each time. `--rotate` mints
 * a new pair.
 *
 *   bun scripts/kedi-gateway-assertion.mjs
 *   bun scripts/kedi-gateway-assertion.mjs --role admin --sub user_admin --tid tenant_placeholder
 *
 * Defaults match the placeholders in `.dev.vars.example`. Paste the printed
 * KEDI_GATEWAY_PUBLIC_JWK over that placeholder. Do not commit the key file
 * and do not pass production secrets on the command line.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const keyPath = join(repoRoot, '.dev-kedi-gateway-key.json')

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx === -1) return fallback
  const value = process.argv[idx + 1]
  if (!value || value.startsWith('--')) {
    console.error(`missing value for --${name}`)
    process.exit(1)
  }
  return value
}

const issuer = arg('issuer', 'https://kedi-gateway.example')
const audience = arg('audience', 'ctxlayer')
const sub = arg('sub', 'user_dev')
const tid = arg('tid', 'tenant_placeholder')
const role = arg('role', 'member')
const oid = arg('oid', '')
const ttlRaw = Number(arg('ttl', '60'))
const rotate = process.argv.includes('--rotate')

if (role !== 'member' && role !== 'admin') {
  console.error('--role must be member or admin')
  process.exit(1)
}
if (!Number.isInteger(ttlRaw) || ttlRaw < 1 || ttlRaw > 120) {
  console.error('--ttl must be an integer from 1 to 120 (the worker rejects longer assertions)')
  process.exit(1)
}

function b64url(bytes) {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function publicJwkOf(jwk, kid) {
  return {
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
    alg: 'ES256',
    kid,
    ext: true,
    key_ops: ['verify']
  }
}

async function loadOrCreate() {
  if (!rotate && existsSync(keyPath)) {
    const stored = JSON.parse(readFileSync(keyPath, 'utf8'))
    if (stored?.privateJwk?.kty !== 'EC' || !stored.privateJwk.d) {
      console.error(`refusing to use ${keyPath}: expected an ES256 private JWK`)
      process.exit(1)
    }
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      stored.privateJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    )
    return { privateKey, publicJwk: stored.publicJwk, kid: stored.kid }
  }

  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify'
  ])
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const kid = `dev-${crypto.randomUUID().slice(0, 8)}`
  privateJwk.kid = kid
  privateJwk.alg = 'ES256'
  const publicJwk = publicJwkOf(privateJwk, kid)
  const body = JSON.stringify({ kid, publicJwk, privateJwk }, null, 2)
  writeFileSync(keyPath, `${body}\n`, { mode: 0o600 })
  chmodSync(keyPath, 0o600)
  return { privateKey: pair.privateKey, publicJwk, kid }
}

const { privateKey, publicJwk, kid } = await loadOrCreate()
const now = Math.floor(Date.now() / 1000)
const payload = {
  iss: issuer,
  aud: audience,
  sub,
  tid,
  hub_role: role,
  jti: crypto.randomUUID(),
  rid: `dev-${now}`,
  iat: now,
  exp: now + ttlRaw
}
if (oid) payload.oid = oid

const header = { alg: 'ES256', typ: 'JWT', kid }
const h = b64url(new TextEncoder().encode(JSON.stringify(header)))
const p = b64url(new TextEncoder().encode(JSON.stringify(payload)))
const sig = await crypto.subtle.sign(
  { name: 'ECDSA', hash: 'SHA-256' },
  privateKey,
  new TextEncoder().encode(`${h}.${p}`)
)
const jwt = `${h}.${p}.${b64url(new Uint8Array(sig))}`
const publicLine = JSON.stringify(publicJwk)

console.log(`# private key stays in ${keyPath} (not printed)`)
console.log(`KEDI_GATEWAY_ISSUER=${issuer}`)
console.log(`KEDI_GATEWAY_AUDIENCE=${audience}`)
console.log(`KEDI_GATEWAY_ALLOWED_TENANTS=${tid}`)
console.log(`KEDI_GATEWAY_PUBLIC_JWK=${publicLine}`)
console.log('')
console.log(jwt)
console.log('')
console.log(`curl -k https://localhost:8787/api/me -H 'Authorization: Bearer ${jwt}'`)
