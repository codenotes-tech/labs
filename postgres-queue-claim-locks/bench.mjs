#!/usr/bin/env node
// Run the claim-strategy benchmark matrix and record one CSV row per run.
//
// Requires Docker (with the compose plugin) and Node.js 18+. No npm packages.
//
//   node bench.mjs                                   # main matrix, results/main/
//   node bench.mjs --tag checksums --versions 15 18 --checksums both --clients 8 64
//   node bench.mjs --tag smoke --versions 18 --clients 1 64 --reps 1 --duration 5
//   node bench.mjs --tag pg18-cause --variant pg17=17 --variant pg18-sync=18,io_method=sync \
//     --variant pg18-nochecksums=18,checksums=off --strategies skip_locked --clients 1 8 32
//
// A "variant" is one Postgres container: a major version plus a data-checksums
// setting (the version's default, forced on, or forced off), and optionally
// extra server settings. --variant name=version[,checksums=on|off][,setting=value...]
// defines variants explicitly and replaces --versions/--checksums. Every variant runs
// side by side, and all runs execute in one seeded shuffle, so slow drift on
// the host cannot line up with a version, setting, or strategy.
//
// Each run: reseed the queue, start a wait-event sampler, run pgbench for
// --duration seconds, pull the per-transaction latency log, count claimed rows.
// Re-running the same command skips runs already recorded in runs.csv.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMPOSE = join(HERE, 'docker-compose.yml')

const FIELDS = [
  'started_at', 'variant', 'pg_major', 'pg_version', 'data_checksums', 'strategy', 'clients',
  'threads', 'rep', 'duration_s', 'seed_rows', 'tx_processed', 'tx_failed', 'tps', 'claims_per_s',
  'lat_avg_ms', 'p50_ms', 'p95_ms', 'p99_ms', 'max_ms', 'done_rows', 'empty_claims', 'empty_pct',
  'queue_drained', 'tps_first_quarter', 'tps_last_quarter', 'avg_active', 'avg_lock_wait',
  'avg_lwlock_wait', 'avg_io_wait', 'top_waits', 'wait_samples',
]

function parseArgs(argv) {
  const opts = {
    tag: 'main',
    versions: [15, 16, 17, 18],
    checksums: 'default', // default | on | off | both
    strategies: ['for_update', 'skip_locked', 'advisory'],
    clients: [1, 4, 8, 16, 32, 64],
    reps: 3,
    duration: 20,
    seedRows: 1_000_000,
    maxThreads: 4,
    shuffleSeed: 2026,
    variants: [],
  }
  const lists = { '--versions': 'versions', '--strategies': 'strategies', '--clients': 'clients' }
  const numbers = {
    '--reps': 'reps', '--duration': 'duration', '--seed-rows': 'seedRows',
    '--max-threads': 'maxThreads', '--shuffle-seed': 'shuffleSeed',
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--tag') opts.tag = argv[++i]
    else if (flag === '--checksums') opts.checksums = argv[++i]
    else if (flag === '--variant') opts.variants.push(argv[++i])
    else if (numbers[flag]) opts[numbers[flag]] = Number(argv[++i])
    else if (lists[flag]) {
      const values = []
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) values.push(argv[++i])
      opts[lists[flag]] = flag === '--strategies' ? values : values.map(Number)
    } else {
      console.error(`Unknown option: ${flag}`)
      process.exit(2)
    }
  }
  if (!['default', 'on', 'off', 'both'].includes(opts.checksums)) {
    console.error('--checksums must be default, on, off, or both')
    process.exit(2)
  }
  return opts
}

function initdbArgsFor(version, mode) {
  // --no-data-checksums exists only from PostgreSQL 18; before that, off is the default.
  return mode === 'on' ? '--data-checksums' : mode === 'off' && version >= 18 ? '--no-data-checksums' : ''
}

function makeVariants(opts) {
  if (opts.variants.length) {
    return opts.variants.map((spec) => {
      const [name, rest] = spec.split('=', 2).length === 2 ? [spec.slice(0, spec.indexOf('=')), spec.slice(spec.indexOf('=') + 1)] : [spec, '']
      const [versionText, ...pairs] = rest.split(',')
      const version = Number(versionText)
      if (!version) throw new Error(`Bad --variant ${spec}; expected name=version[,checksums=on|off][,setting=value]`)
      let mode = 'default'
      const extra = []
      for (const pair of pairs) {
        const [key, value] = pair.split('=')
        if (key === 'checksums') mode = value
        else extra.push(`-c ${key}=${value}`)
      }
      return { name, version, initdbArgs: initdbArgsFor(version, mode), pgExtra: extra.join(' '), project: `claimbench-${name}` }
    })
  }
  const modes = opts.checksums === 'both' ? ['on', 'off'] : [opts.checksums]
  const variants = []
  for (const version of opts.versions) {
    for (const mode of modes) {
      const initdbArgs = initdbArgsFor(version, mode)
      const name = mode === 'default' ? `pg${version}` : `pg${version}-checksums-${mode}`
      variants.push({ name, version, initdbArgs, pgExtra: '', project: `claimbench-${name}` })
    }
  }
  return variants
}

function compose(variant, args, { check = true } = {}) {
  const result = spawnSync('docker', ['compose', '-p', variant.project, '-f', COMPOSE, ...args], {
    env: { ...process.env, PG_VERSION: String(variant.version), INITDB_ARGS: variant.initdbArgs, PG_EXTRA: variant.pgExtra },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
  })
  const output = (result.stdout || '') + (result.stderr || '')
  if (check && result.status !== 0) throw new Error(`docker compose ${args.join(' ')} failed:\n${output}`)
  return { status: result.status, stdout: result.stdout || '', output }
}

function composeAsync(variant, args) {
  return new Promise((resolve) => {
    const child = spawn('docker', ['compose', '-p', variant.project, '-f', COMPOSE, ...args], {
      env: { ...process.env, PG_VERSION: String(variant.version), INITDB_ARGS: variant.initdbArgs, PG_EXTRA: variant.pgExtra },
    })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (out += chunk))
    child.on('close', (status) => resolve({ status, out }))
  })
}

function psql(variant, { sql, file, variables = {} }) {
  const args = ['exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'bench', '-v', 'ON_ERROR_STOP=1', '-tAq']
  for (const [key, value] of Object.entries(variables)) args.push('-v', `${key}=${value}`)
  args.push(...(sql ? ['-c', sql] : ['-f', file]))
  return compose(variant, args).stdout.trim()
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitReady(variant) {
  for (let i = 0; i < 120; i++) {
    const ready = compose(variant, ['exec', '-T', 'db', 'pg_isready', '-U', 'postgres', '-d', 'bench'], { check: false })
    if (ready.status === 0) {
      // pg_isready can pass during the image's init restart; confirm a query works.
      try {
        psql(variant, { sql: 'SELECT 1' })
        return
      } catch {}
    }
    await sleep(1000)
  }
  throw new Error(`${variant.name} did not become ready`)
}

// Small seeded PRNG (mulberry32) so the shuffled run order is reproducible.
function seededRandom(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle(items, seed) {
  const random = seededRandom(seed)
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

function percentile(sorted, q) {
  if (sorted.length === 0) return null
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]
}

function parsePgbench(output) {
  const find = (pattern) => {
    const match = output.match(pattern)
    return match ? Number(match[1]) : null
  }
  return {
    tx_processed: find(/number of transactions actually processed: (\d+)/),
    tx_failed: find(/number of failed transactions: (\d+)/) ?? 0,
    tps: find(/tps = ([\d.]+) \(without initial connection time\)/),
    lat_avg_ms: find(/latency average = ([\d.]+) ms/),
  }
}

async function runOne(variant, run, opts, rawDir) {
  const { strategy, clients, rep } = run
  const threads = Math.min(clients, opts.maxThreads)
  const startedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z')

  psql(variant, { file: '/sql/reseed.sql', variables: { rows: opts.seedRows } })

  const sampler = composeAsync(variant, ['exec', '-T', 'db', 'timeout', String(opts.duration),
    'psql', '-U', 'postgres', '-d', 'bench', '-tAq', '-f', '/sql/waits.sql'])
  const bench = await composeAsync(variant, ['exec', '-T', 'db', 'pgbench', '-U', 'postgres', '-n',
    '-c', String(clients), '-j', String(threads), '-T', String(opts.duration),
    '-f', `/sql/workloads/${strategy}.sql`, '-P', '1', '-l', '--log-prefix=/tmp/lat', 'bench'])
  const waitsOut = (await sampler).out

  writeFileSync(join(rawDir, `${variant.name}-${strategy}-c${clients}-r${rep}.txt`), bench.out)
  if (bench.status !== 0) {
    console.error(bench.out)
    throw new Error(`pgbench failed for ${variant.name} ${strategy} c=${clients} rep=${rep}`)
  }

  const log = compose(variant, ['exec', '-T', 'db', 'sh', '-c', 'cat /tmp/lat.*; rm -f /tmp/lat.*']).stdout
  const latencies = []
  for (const line of log.split('\n')) {
    const parts = line.split(' ')
    if (parts.length >= 3 && /^\d+$/.test(parts[2])) latencies.push(Number(parts[2]))
  }
  latencies.sort((a, b) => a - b)

  const doneRows = Number(psql(variant, { sql: "SELECT count(*) FROM jobs WHERE status = 'done'" }))

  const samples = waitsOut
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+\|\d+\|\d+\|\d+\|/.test(line))
    .map((line) => line.split('|'))
  const avg = (i) =>
    samples.length ? Math.round((samples.reduce((sum, s) => sum + Number(s[i]), 0) / samples.length) * 100) / 100 : null

  // Which wait events were seen, as average sessions per sample, most common first.
  const eventCounts = {}
  for (const s of samples) for (const event of s[4].split(';').filter(Boolean)) eventCounts[event] = (eventCounts[event] || 0) + 1
  const topWaits = Object.entries(eventCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([event, count]) => `${event}=${Math.round((count / samples.length) * 10) / 10}`)
    .join(';')

  // Per-second throughput from pgbench -P 1, to see drift within a run. The first
  // second includes client connection setup and the last one is partial, so both are dropped.
  const perSecond = [...bench.out.matchAll(/progress: [\d.]+ s, ([\d.]+) tps/g)].map((m) => Number(m[1])).slice(1, -1)
  const quarter = Math.max(1, Math.floor(perSecond.length / 4))
  const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null)
  const ms = (us) => (us == null ? null : Math.round(us) / 1000)

  const stats = parsePgbench(bench.out)
  return {
    started_at: startedAt, variant: variant.name, pg_major: variant.version, pg_version: variant.serverVersion,
    data_checksums: variant.dataChecksums, strategy, clients, threads, rep,
    duration_s: opts.duration, seed_rows: opts.seedRows, ...stats,
    claims_per_s: stats.tps == null || !stats.tx_processed ? null : Math.round(stats.tps * (doneRows / stats.tx_processed)),
    p50_ms: ms(percentile(latencies, 0.5)), p95_ms: ms(percentile(latencies, 0.95)),
    p99_ms: ms(percentile(latencies, 0.99)), max_ms: ms(latencies.at(-1)),
    done_rows: doneRows,
    empty_claims: stats.tx_processed == null ? null : stats.tx_processed - doneRows,
    empty_pct: stats.tx_processed ? Math.round(((stats.tx_processed - doneRows) / stats.tx_processed) * 1000) / 10 : null,
    queue_drained: doneRows >= opts.seedRows,
    tps_first_quarter: mean(perSecond.slice(0, quarter)),
    tps_last_quarter: mean(perSecond.slice(-quarter)),
    avg_active: avg(0), avg_lock_wait: avg(1), avg_lwlock_wait: avg(2), avg_io_wait: avg(3),
    top_waits: topWaits, wait_samples: samples.length,
  }
}

function readDone(csvPath) {
  const done = new Set()
  if (!existsSync(csvPath)) return done
  const [header, ...lines] = readFileSync(csvPath, 'utf8').trim().split('\n')
  const cols = header.split(',')
  for (const line of lines) {
    const row = Object.fromEntries(line.split(',').map((value, i) => [cols[i], value]))
    done.add(`${row.variant}|${row.strategy}|${row.clients}|${row.rep}`)
  }
  return done
}

function sh(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8' }).stdout?.trim() ?? ''
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const outDir = join(HERE, 'results', opts.tag)
  const rawDir = join(outDir, 'raw')
  mkdirSync(rawDir, { recursive: true })
  const csvPath = join(outDir, 'runs.csv')
  const done = readDone(csvPath)

  const envPath = join(outDir, 'environment.json')
  const environment = existsSync(envPath) ? JSON.parse(readFileSync(envPath, 'utf8')) : {}
  environment.host ??= {
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    os: process.platform === 'darwin' ? `macOS ${sh('sw_vers', ['-productVersion'])}` : os.version(),
    cpu: os.cpus()[0]?.model,
    cpu_count: os.cpus().length,
    memory_gb: Math.round(os.totalmem() / 1024 ** 3),
    node: process.version,
    docker: sh('docker', ['info', '--format', '{{.ServerVersion}} | VM cpus {{.NCPU}} | VM mem {{.MemTotal}} | {{.OperatingSystem}}']),
  }
  environment.variants ??= {}
  const { tag, ...matrix } = opts
  environment.matrix = matrix

  const variants = makeVariants(opts)
  try {
    for (const variant of variants) {
      compose(variant, ['up', '-d', '--pull', 'missing', '--wait'])
      await waitReady(variant)
      psql(variant, { file: '/sql/setup.sql' })
      variant.serverVersion = psql(variant, { sql: 'SHOW server_version' })
      variant.dataChecksums = psql(variant, { sql: 'SHOW data_checksums' })
      const settings = psql(variant, {
        sql: 'SELECT name, current_setting(name) FROM pg_settings WHERE name IN ' +
          "('shared_buffers','max_connections','max_wal_size','checkpoint_timeout','synchronous_commit'," +
          "'fsync','wal_level','autovacuum','data_checksums','wal_log_hints','full_page_writes','io_method')",
      })
      environment.variants[variant.name] = {
        server_version: variant.serverVersion,
        initdb_args: variant.initdbArgs || '(version default)',
        extra_settings: variant.pgExtra || '(none)',
        image_digest: sh('docker', ['image', 'inspect', `postgres:${variant.version}`, '--format', '{{index .RepoDigests 0}}']),
        settings: Object.fromEntries(settings.split('\n').map((line) => line.split('|'))),
      }
      console.log(`${variant.name}: ${variant.serverVersion}, data_checksums=${variant.dataChecksums}` +
        (variant.pgExtra ? `, ${variant.pgExtra}` : ''))
    }
    writeFileSync(envPath, JSON.stringify(environment, null, 2) + '\n')

    let plan = []
    for (const variant of variants)
      for (const strategy of opts.strategies)
        for (const clients of opts.clients)
          for (let rep = 1; rep <= opts.reps; rep++) plan.push({ variant, strategy, clients, rep })
    plan = shuffle(plan.filter((p) => !done.has(`${p.variant.name}|${p.strategy}|${p.clients}|${p.rep}`)), opts.shuffleSeed)
    console.log(`${plan.length} runs to go`)

    for (const [i, run] of plan.entries()) {
      const row = await runOne(run.variant, run, opts, rawDir)
      if (!existsSync(csvPath)) appendFileSync(csvPath, FIELDS.join(',') + '\n')
      appendFileSync(csvPath, FIELDS.map((f) => row[f] ?? '').join(',') + '\n')
      console.log(`[${i + 1}/${plan.length}] ${run.variant.name} ${run.strategy.padEnd(11)} c=${String(run.clients).padEnd(3)} ` +
        `rep=${run.rep} claims/s=${row.claims_per_s} tps=${Math.round(row.tps)} p95=${row.p95_ms}ms empty=${row.empty_pct}% ` +
        `q1→q4=${row.tps_first_quarter}→${row.tps_last_quarter} waits=${row.top_waits || '-'}`)
    }
  } finally {
    for (const variant of variants) compose(variant, ['down', '-v'], { check: false })
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
