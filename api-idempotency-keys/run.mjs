#!/usr/bin/env node
// Fire duplicate payment requests at each idempotency implementation and count,
// from the mock provider's ledger, how many payments were charged more than once.
//
// Requires Docker (with the compose plugin) and Node.js 18+ on the host; the
// runner itself uses no npm packages.
//
//   node run.mjs                                   # full matrix, results/main/
//   node run.mjs --tag smoke --orders 40 --reps 1  # quick check
//   node run.mjs --impls reserve redis_lock --scenarios slow_provider
//
// Each run: reset the provider (latency, faults) and the API (truncate keys,
// flush Redis, timeouts), send --orders payments with --inflight in parallel
// following the scenario's client behavior, wait until the provider is idle,
// then read the provider's ledger. Runs execute in one seeded random order;
// re-running the same command skips runs already in runs.csv.

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const API = 'http://localhost:8080'
const PROVIDER = 'http://localhost:8081'

const IMPLS = ['none', 'check_then_insert', 'redis_lock', 'reserve', 'reserve_release', 'reserve_provider_key']

// Provider latency is mean ± jitter in ms. API defaults: provider timeout 5000 ms, Redis lock TTL 2000 ms.
const SCENARIOS = {
  // N identical requests with the same key, sent at the same moment.
  concurrent_2: { provider: { latencyMs: 100, jitterMs: 50 }, api: {}, client: { kind: 'burst', copies: 2 } },
  concurrent_10: { provider: { latencyMs: 100, jitterMs: 50 }, api: {}, client: { kind: 'burst', copies: 10 } },
  // The client gives up after 300 ms while the provider takes about 1 s, then retries.
  client_retry: {
    provider: { latencyMs: 1000, jitterMs: 100 }, api: {},
    client: { kind: 'retry', timeoutMs: 300, backoffMs: 250, maxAttempts: 10 },
  },
  // The provider takes longer (2.5 s) than the Redis lock lives (2 s).
  slow_provider: {
    provider: { latencyMs: 2500, jitterMs: 250 }, api: { lockTtlMs: 2000 },
    client: { kind: 'retry', timeoutMs: 1000, backoffMs: 500, maxAttempts: 5 },
  },
  // The provider makes the charge, but its first response for each order is lost; the API times out after 1 s.
  lost_response: {
    provider: { latencyMs: 100, jitterMs: 50, loseFirstResponse: true }, api: { providerTimeoutMs: 1000 },
    client: { kind: 'retry', timeoutMs: 3000, backoffMs: 300, maxAttempts: 5 },
  },
  // The same key reused for a different payment (different order and amount).
  key_reuse: { provider: { latencyMs: 100, jitterMs: 50 }, api: {}, client: { kind: 'reuse' } },
}
// Two identical requests, the second sent N ms after the first (a double click or an early retry).
// Run separately: node run.mjs --tag gap --impls check_then_insert --scenarios gap_0 gap_25 ...
for (const gap of [0, 25, 50, 100, 150, 200, 400])
  SCENARIOS[`gap_${gap}`] = { provider: { latencyMs: 100, jitterMs: 50 }, api: {}, client: { kind: 'gap', gapMs: gap } }
const DEFAULT_SCENARIOS = ['concurrent_2', 'concurrent_10', 'client_retry', 'slow_provider', 'lost_response', 'key_reuse']

const FIELDS = [
  'started_at', 'impl', 'scenario', 'rep', 'orders', 'requests', 'charges', 'duplicate_charges',
  'orders_double_charged', 'orders_not_charged', 'max_charges_per_order', 'final_success', 'final_pending',
  'final_conflict', 'final_rejected', 'final_error', 'wrong_payment_returned', 'reuse_rejected',
  'reuse_wrong_replay', 'reuse_charged_new', 'reuse_other', 'p50_ms', 'p95_ms', 'status_counts',
]

function parseArgs(argv) {
  const opts = { tag: 'main', impls: IMPLS, scenarios: DEFAULT_SCENARIOS, reps: 3, orders: 200, inflight: 25, shuffleSeed: 2026 }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const list = () => {
      const values = []
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) values.push(argv[++i])
      return values
    }
    if (flag === '--tag') opts.tag = argv[++i]
    else if (flag === '--impls') opts.impls = list()
    else if (flag === '--scenarios') opts.scenarios = list()
    else if (flag === '--reps') opts.reps = Number(argv[++i])
    else if (flag === '--orders') opts.orders = Number(argv[++i])
    else if (flag === '--inflight') opts.inflight = Number(argv[++i])
    else if (flag === '--shuffle-seed') opts.shuffleSeed = Number(argv[++i])
    else {
      console.error(`Unknown option: ${flag}`)
      process.exit(2)
    }
  }
  for (const s of opts.scenarios) if (!SCENARIOS[s]) throw new Error(`Unknown scenario ${s}`)
  for (const s of opts.impls) if (!IMPLS.includes(s)) throw new Error(`Unknown implementation ${s}`)
  return opts
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function compose(args) {
  const result = spawnSync('docker', ['compose', '-p', 'idempotency-lab', '-f', join(HERE, 'docker-compose.yml'), ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`docker compose ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`)
  return result.stdout.trim()
}

async function post(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return response.json()
}

// One API request; returns {status, body, ms} or {status: 'timeout'} / {status: 'network_error'}.
async function payment(impl, key, body, timeoutMs) {
  const started = performance.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${API}/${impl}/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const json = await response.json().catch(() => ({}))
    return { status: response.status, body: json, ms: Math.round(performance.now() - started) }
  } catch (error) {
    return { status: error.name === 'AbortError' ? 'timeout' : 'network_error', ms: Math.round(performance.now() - started) }
  } finally {
    clearTimeout(timer)
  }
}

const isPayment = (r) => (r.status === 200 || r.status === 201) && r.body?.payment_id

function finalOutcome(attempts) {
  const success = attempts.find(isPayment)
  if (success) return 'success'
  const last = attempts.at(-1)
  if (last.status === 202) return 'pending'
  if (last.status === 409) return 'conflict'
  if (last.status === 422) return 'rejected'
  return 'error'
}

async function runOrder(impl, scenario, index) {
  const key = randomUUID()
  const orderId = `order_${index}`
  const body = { order_id: orderId, amount: 100, currency: 'usd' }
  const client = scenario.client
  const started = performance.now()
  const attempts = []

  if (client.kind === 'burst') {
    attempts.push(...(await Promise.all(Array.from({ length: client.copies }, () => payment(impl, key, body, 10_000)))))
  } else if (client.kind === 'gap') {
    const first = payment(impl, key, body, 10_000)
    await sleep(client.gapMs)
    attempts.push(...(await Promise.all([first, payment(impl, key, body, 10_000)])))
  } else if (client.kind === 'retry') {
    for (let attempt = 1; attempt <= client.maxAttempts; attempt++) {
      const result = await payment(impl, key, body, client.timeoutMs)
      attempts.push(result)
      if (isPayment(result) || result.status === 422) break
      if (attempt < client.maxAttempts) await sleep(client.backoffMs)
    }
  } else if (client.kind === 'reuse') {
    const first = await payment(impl, key, body, 10_000)
    const second = await payment(impl, key, { order_id: `${orderId}_other`, amount: 999, currency: 'usd' }, 10_000)
    attempts.push(first, second)
    let reuse = 'other'
    if (second.status === 409 || second.status === 422) reuse = 'rejected'
    else if (isPayment(second) && isPayment(first) && second.body.payment_id === first.body.payment_id) reuse = 'wrong_replay'
    else if (isPayment(second)) reuse = 'charged_new'
    return { key, orderId, attempts, final: finalOutcome([first]), reuse, ms: Math.round(performance.now() - started) }
  }
  const success = attempts.find(isPayment)
  return { key, orderId, attempts, final: finalOutcome(attempts), paymentId: success?.body.payment_id, ms: Math.round(performance.now() - started) }
}

async function waitForProviderIdle() {
  const deadline = Date.now() + 30_000
  let idleSince = null
  while (Date.now() < deadline) {
    const state = await (await fetch(`${PROVIDER}/admin/state`)).json()
    if (state.inflight === 0) {
      idleSince ??= Date.now()
      if (Date.now() - idleSince >= 1000) return
    } else idleSince = null
    await sleep(100)
  }
  throw new Error('provider did not become idle')
}

const percentile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1)))] : null)

async function runOne(impl, scenarioName, rep, opts, rawDir) {
  const scenario = SCENARIOS[scenarioName]
  const startedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  await post(`${PROVIDER}/admin/reset`, scenario.provider)
  await post(`${API}/admin/reset`, scenario.api)

  const results = []
  let next = 0
  await Promise.all(
    Array.from({ length: opts.inflight }, async () => {
      while (next < opts.orders) {
        const index = next++
        results[index] = await runOrder(impl, scenario, index)
      }
    }),
  )
  await waitForProviderIdle()
  await sleep(500) // let the API finish its last database writes
  const ledger = await (await fetch(`${PROVIDER}/admin/ledger`)).json()

  const chargesByKey = new Map()
  for (const c of ledger) chargesByKey.set(c.client_key, [...(chargesByKey.get(c.client_key) || []), c.id])
  const counts = results.map((r) => (chargesByKey.get(r.key) || []).length)
  const statusCounts = {}
  for (const r of results) for (const a of r.attempts) statusCounts[a.status] = (statusCounts[a.status] || 0) + 1
  const successMs = results.filter((r) => r.final === 'success').map((r) => r.ms).sort((a, b) => a - b)
  const reuse = (kind) => results.filter((r) => r.reuse === kind).length
  const isReuse = scenario.client.kind === 'reuse'

  const row = {
    started_at: startedAt, impl, scenario: scenarioName, rep, orders: opts.orders,
    requests: results.reduce((n, r) => n + r.attempts.length, 0),
    charges: ledger.length,
    // For key reuse a second charge is a different payment, so duplicates are not counted there.
    duplicate_charges: isReuse ? '' : counts.reduce((n, c) => n + Math.max(0, c - 1), 0),
    orders_double_charged: isReuse ? '' : counts.filter((c) => c >= 2).length,
    orders_not_charged: counts.filter((c) => c === 0).length,
    max_charges_per_order: Math.max(...counts),
    final_success: results.filter((r) => r.final === 'success').length,
    final_pending: results.filter((r) => r.final === 'pending').length,
    final_conflict: results.filter((r) => r.final === 'conflict').length,
    final_rejected: results.filter((r) => r.final === 'rejected').length,
    final_error: results.filter((r) => r.final === 'error').length,
    // A success response whose payment id is not a charge the provider made for that key.
    wrong_payment_returned: isReuse ? '' : results.filter((r) => r.paymentId && !(chargesByKey.get(r.key) || []).includes(r.paymentId)).length,
    reuse_rejected: isReuse ? reuse('rejected') : '',
    reuse_wrong_replay: isReuse ? reuse('wrong_replay') : '',
    reuse_charged_new: isReuse ? reuse('charged_new') : '',
    reuse_other: isReuse ? reuse('other') : '',
    p50_ms: percentile(successMs, 0.5),
    p95_ms: percentile(successMs, 0.95),
    status_counts: Object.entries(statusCounts).map(([s, n]) => `${s}=${n}`).join(';'),
  }
  writeFileSync(join(rawDir, `${impl}-${scenarioName}-r${rep}.json`),
    JSON.stringify({ row, scenario, orders: results.map((r, i) => ({ ...r, charges: counts[i] })) }))
  return row
}

function seededShuffle(items, seed) {
  let a = seed >>> 0
  const random = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const outDir = join(HERE, 'results', opts.tag)
  const rawDir = join(outDir, 'raw')
  mkdirSync(rawDir, { recursive: true })
  const csvPath = join(outDir, 'runs.csv')
  const done = new Set()
  if (existsSync(csvPath)) {
    const [header, ...lines] = readFileSync(csvPath, 'utf8').trim().split('\n')
    const cols = header.split(',')
    for (const line of lines) {
      const row = Object.fromEntries(line.split(',').map((v, i) => [cols[i], v]))
      done.add(`${row.impl}|${row.scenario}|${row.rep}`)
    }
  }

  compose(['up', '-d', '--build', '--wait'])
  try {
    for (let i = 0; i < 60; i++) {
      try {
        await fetch(`${API}/`)
        await fetch(`${PROVIDER}/admin/state`)
        break
      } catch {
        await sleep(1000)
      }
    }
    const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }).stdout?.trim() ?? ''
    writeFileSync(join(outDir, 'environment.json'), JSON.stringify({
      host: {
        os: process.platform === 'darwin' ? `macOS ${sh('sw_vers', ['-productVersion'])}` : os.version(),
        cpu: os.cpus()[0]?.model, cpu_count: os.cpus().length, memory_gb: Math.round(os.totalmem() / 1024 ** 3),
        node: process.version,
        docker: sh('docker', ['info', '--format', '{{.ServerVersion}} | VM cpus {{.NCPU}} | VM mem {{.MemTotal}}']),
      },
      containers: {
        postgres: compose(['exec', '-T', 'db', 'psql', '-U', 'postgres', '-tAc', 'SHOW server_version']),
        redis: compose(['exec', '-T', 'redis', 'redis-server', '--version']),
        node: compose(['exec', '-T', 'api', 'node', '--version']),
        packages: JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).dependencies,
      },
      matrix: opts,
      scenarios: SCENARIOS,
    }, null, 2) + '\n')

    let plan = []
    for (const impl of opts.impls)
      for (const scenario of opts.scenarios)
        for (let rep = 1; rep <= opts.reps; rep++) plan.push({ impl, scenario, rep })
    plan = seededShuffle(plan.filter((p) => !done.has(`${p.impl}|${p.scenario}|${p.rep}`)), opts.shuffleSeed)
    console.log(`${plan.length} runs to go`)

    for (const [i, { impl, scenario, rep }] of plan.entries()) {
      const row = await runOne(impl, scenario, rep, opts, rawDir)
      if (!existsSync(csvPath)) appendFileSync(csvPath, FIELDS.join(',') + '\n')
      appendFileSync(csvPath, FIELDS.map((f) => row[f] ?? '').join(',') + '\n')
      const summary = scenario === 'key_reuse'
        ? `rejected=${row.reuse_rejected} wrong_replay=${row.reuse_wrong_replay} charged_new=${row.reuse_charged_new}`
        : `dup_charges=${row.duplicate_charges} double_charged=${row.orders_double_charged} success=${row.final_success} pending=${row.final_pending} error=${row.final_error}`
      console.log(`[${i + 1}/${plan.length}] ${impl.padEnd(20)} ${scenario.padEnd(14)} rep=${rep} ${summary} p95=${row.p95_ms}ms`)
    }
  } finally {
    compose(['down', '-v'])
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
