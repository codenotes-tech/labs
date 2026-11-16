// Payment API with the same endpoint implemented six ways.
//
// POST /<impl>/payments   body {order_id, amount, currency}, header Idempotency-Key
//   none                  charge on every request
//   check_then_insert     look up the key, charge, then store the key and response
//   redis_lock            SET NX PX lock, charge, store the response in Redis
//   reserve               INSERT ... ON CONFLICT DO NOTHING reservation with in_progress,
//                         completed, and ambiguous states (the article's design)
//   reserve_release       the same, but a failed provider call deletes the reservation so
//                         the client can retry (a common shortcut)
//   reserve_provider_key  the same as reserve, also sending the key to the provider; a retry
//                         that finds an ambiguous record re-asks the provider with that key
// POST /admin/reset       truncate idempotency records, flush Redis, set timeouts

import http from 'node:http'
import crypto from 'node:crypto'
import pg from 'pg'
import { createClient } from 'redis'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 60 })
const redis = createClient({ url: process.env.REDIS_URL })
await redis.connect()
const PROVIDER = process.env.PROVIDER_URL
const SCOPE = 'account:demo:payments'

let config = { providerTimeoutMs: 5000, lockTtlMs: 2000 }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function send(res, status, body, headers = {}) {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

const fingerprint = (body) =>
  crypto.createHash('sha256').update(JSON.stringify([body.order_id, body.amount, body.currency])).digest('hex')

// Call the provider. Throws with kind 'timeout' when no response arrives in time.
async function charge(body, key, providerKey) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.providerTimeoutMs)
  try {
    const response = await fetch(`${PROVIDER}/charges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(providerKey ? { 'idempotency-key': providerKey } : {}) },
      body: JSON.stringify({ order_id: body.order_id, amount: body.amount, currency: body.currency, client_key: key }),
      signal: controller.signal,
    })
    if (!response.ok) throw Object.assign(new Error(`provider status ${response.status}`), { kind: 'failed' })
    return await response.json()
  } catch (error) {
    if (error.name === 'AbortError') error.kind = 'timeout'
    throw error
  } finally {
    clearTimeout(timer)
  }
}

const paymentBody = (result) => ({ payment_id: result.id, status: result.status, amount: result.amount, order_id: result.order_id })

// --- Implementations -------------------------------------------------------

async function none(res, body, key) {
  const result = await charge(body, key)
  send(res, 201, paymentBody(result))
}

async function checkThenInsert(res, body, key) {
  const lookup = () =>
    pool.query('SELECT response_status, response_body FROM idempotency_keys WHERE scope = $1 AND idempotency_key = $2', [SCOPE, key])
  const existing = await lookup()
  if (existing.rowCount) return send(res, existing.rows[0].response_status, existing.rows[0].response_body)

  const result = await charge(body, key)
  const responseBody = paymentBody(result)
  try {
    await pool.query(
      `INSERT INTO idempotency_keys (scope, idempotency_key, request_fingerprint, status, response_status, response_body, expires_at)
       VALUES ($1, $2, $3, 'completed', 201, $4, now() + interval '24 hours')`,
      [SCOPE, key, fingerprint(body), responseBody],
    )
  } catch (error) {
    if (error.code !== '23505') throw error
    // Another request stored the key first; replay its response. The second charge already happened.
    const stored = (await lookup()).rows[0]
    return send(res, stored.response_status, stored.response_body)
  }
  send(res, 201, responseBody)
}

async function redisLock(res, body, key) {
  const lockKey = `idem:lock:${SCOPE}:${key}`
  const responseKey = `idem:resp:${SCOPE}:${key}`
  const cached = await redis.get(responseKey)
  if (cached) {
    const stored = JSON.parse(cached)
    return send(res, stored.status, stored.body)
  }
  const acquired = await redis.sendCommand(['SET', lockKey, '1', 'NX', 'PX', String(config.lockTtlMs)])
  if (acquired !== 'OK') return send(res, 409, { error: 'in_progress' }, { 'retry-after': '1' })
  try {
    const result = await charge(body, key)
    const responseBody = paymentBody(result)
    await redis.sendCommand(['SET', responseKey, JSON.stringify({ status: 201, body: responseBody }), 'EX', '86400'])
    send(res, 201, responseBody)
  } finally {
    await redis.del(lockKey)
  }
}

async function reserve(res, body, key, variant) {
  const fp = fingerprint(body)
  const providerKey = variant === 'provider_key' ? `${SCOPE}:${key}` : undefined
  const won = await pool.query(
    `INSERT INTO idempotency_keys (scope, idempotency_key, request_fingerprint, status, locked_until, expires_at)
     VALUES ($1, $2, $3, 'in_progress', now() + interval '30 seconds', now() + interval '24 hours')
     ON CONFLICT (scope, idempotency_key) DO NOTHING
     RETURNING id`,
    [SCOPE, key, fp],
  )

  if (!won.rowCount) {
    const row = (
      await pool.query(
        'SELECT request_fingerprint, status, response_status, response_body FROM idempotency_keys WHERE scope = $1 AND idempotency_key = $2',
        [SCOPE, key],
      )
    ).rows[0]
    if (!row) return send(res, 409, { error: 'in_progress' }, { 'retry-after': '1' }) // deleted between insert and read
    if (row.request_fingerprint !== fp) return send(res, 422, { error: 'idempotency_key_reused_with_different_request' })
    if (row.status === 'completed') return send(res, row.response_status, row.response_body)
    if (row.status === 'ambiguous') {
      if (variant !== 'provider_key') return send(res, 202, { status: 'pending' })
      // Take ownership of the ambiguous record, then ask the provider again with the same key.
      const claimed = await pool.query(
        `UPDATE idempotency_keys SET status = 'in_progress', updated_at = now()
         WHERE scope = $1 AND idempotency_key = $2 AND status = 'ambiguous' RETURNING id`,
        [SCOPE, key],
      )
      if (!claimed.rowCount) return send(res, 409, { error: 'in_progress' }, { 'retry-after': '1' })
      return finish(res, body, key, variant, providerKey)
    }
    return send(res, 409, { error: 'in_progress' }, { 'retry-after': '1' })
  }
  return finish(res, body, key, variant, providerKey)
}

async function finish(res, body, key, variant, providerKey) {
  try {
    const result = await charge(body, key, providerKey)
    const responseBody = paymentBody(result)
    await pool.query(
      `UPDATE idempotency_keys SET status = 'completed', response_status = 201, response_body = $3, updated_at = now()
       WHERE scope = $1 AND idempotency_key = $2`,
      [SCOPE, key, responseBody],
    )
    send(res, 201, responseBody)
  } catch (error) {
    if (variant === 'release') {
      await pool.query('DELETE FROM idempotency_keys WHERE scope = $1 AND idempotency_key = $2', [SCOPE, key])
      return send(res, 502, { error: 'provider_error_retry' })
    }
    // The charge may or may not exist: keep the key and record that we do not know.
    await pool.query(
      `UPDATE idempotency_keys SET status = 'ambiguous', updated_at = now() WHERE scope = $1 AND idempotency_key = $2`,
      [SCOPE, key],
    )
    send(res, 202, { status: 'pending' })
  }
}

const IMPLEMENTATIONS = {
  none,
  check_then_insert: checkThenInsert,
  redis_lock: redisLock,
  reserve: (res, body, key) => reserve(res, body, key, 'plain'),
  reserve_release: (res, body, key) => reserve(res, body, key, 'release'),
  reserve_provider_key: (res, body, key) => reserve(res, body, key, 'provider_key'),
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/admin/reset') {
      const body = JSON.parse((await readBody(req)) || '{}')
      config = { providerTimeoutMs: 5000, lockTtlMs: 2000, ...body }
      await pool.query('TRUNCATE idempotency_keys RESTART IDENTITY')
      await redis.flushDb()
      return send(res, 200, { ok: true, config })
    }
    const match = req.method === 'POST' && req.url.match(/^\/([a-z_]+)\/payments$/)
    const impl = match && IMPLEMENTATIONS[match[1]]
    if (!impl) return send(res, 404, { error: 'not_found' })
    const key = req.headers['idempotency-key']
    if (!key) return send(res, 400, { error: 'idempotency_key_required' })
    const body = JSON.parse(await readBody(req))
    await impl(res, body, key)
  } catch (error) {
    send(res, error.kind === 'timeout' ? 504 : 502, { error: error.kind || 'error', message: String(error.message) })
  }
})

server.keepAliveTimeout = 60_000
server.listen(8080, () => console.log('api listening on 8080'))
