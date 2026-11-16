// Mock payment provider. Its ledger is the ground truth for the experiment:
// every charge it actually makes is recorded, whatever the API or client saw.
//
// POST /charges            create a charge (honors an Idempotency-Key header like Stripe)
// POST /admin/reset        clear state and set latency / fault behavior for the next run
// GET  /admin/state        in-flight request count and charge count
// GET  /admin/ledger       every charge made since the last reset

import http from 'node:http'

let config = { latencyMs: 100, jitterMs: 50, loseFirstResponse: false }
let ledger = []
let seq = 0
let byProviderKey = new Map() // Idempotency-Key -> Promise of the first result
let answeredOrders = new Set() // orders whose first charge request already got (or lost) a response
let inflight = 0
let hung = new Set()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const latency = () => Math.max(0, config.latencyMs + (Math.random() * 2 - 1) * config.jitterMs)

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function createCharge(body) {
  inflight++
  try {
    await sleep(latency())
    const charge = {
      id: `ch_${++seq}`,
      order_id: body.order_id,
      client_key: body.client_key,
      amount: body.amount,
      at: Date.now(),
    }
    ledger.push(charge)
    return { id: charge.id, status: 'succeeded', amount: body.amount, order_id: body.order_id }
  } finally {
    inflight--
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/charges') {
      const body = JSON.parse(await readBody(req))
      const providerKey = req.headers['idempotency-key']

      // Provider-side idempotency: the same key returns the first result, without a new charge.
      if (providerKey && byProviderKey.has(providerKey)) {
        const result = await byProviderKey.get(providerKey)
        return send(res, 200, { ...result, replayed: true })
      }
      const work = createCharge(body)
      if (providerKey) byProviderKey.set(providerKey, work)
      const result = await work

      // Fault: the charge is made, but the first response for each order never arrives.
      if (config.loseFirstResponse && !answeredOrders.has(body.order_id)) {
        answeredOrders.add(body.order_id)
        hung.add(res)
        setTimeout(() => {
          hung.delete(res)
          res.destroy()
        }, 15_000)
        return
      }
      answeredOrders.add(body.order_id)
      return send(res, 201, result)
    }

    if (req.method === 'POST' && req.url === '/admin/reset') {
      const body = JSON.parse((await readBody(req)) || '{}')
      for (const res of hung) res.destroy()
      hung = new Set()
      config = { latencyMs: 100, jitterMs: 50, loseFirstResponse: false, ...body }
      ledger = []
      seq = 0
      byProviderKey = new Map()
      answeredOrders = new Set()
      return send(res, 200, { ok: true, config })
    }
    if (req.method === 'GET' && req.url === '/admin/state') return send(res, 200, { inflight, charges: ledger.length })
    if (req.method === 'GET' && req.url === '/admin/ledger') return send(res, 200, ledger)
    send(res, 404, { error: 'not_found' })
  } catch (error) {
    send(res, 500, { error: String(error) })
  }
})

server.keepAliveTimeout = 60_000
server.listen(8081, () => console.log('provider listening on 8081'))
