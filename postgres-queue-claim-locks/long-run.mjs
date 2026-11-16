#!/usr/bin/env node
// Does autovacuum keep a busy queue fast? One long run per setting, sampling
// claims per second, dead rows, and autovacuum activity every --interval seconds.
//
//   node long-run.mjs                     # Postgres 17, SKIP LOCKED, 16 workers, 180 s
//   node long-run.mjs --version 18 --clients 32 --duration 300
//
// Settings compared:
//   default  PostgreSQL defaults throughout: autovacuum checks each table every
//            60 s (autovacuum_naptime) and vacuums after 50 + 20% of rows change.
//   tuned    autovacuum_naptime = 1s (server), and on the jobs table
//            autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 20000,
//            autovacuum_vacuum_cost_delay = 0: vacuum every ~20k dead rows, unthrottled.
// The queue holds 5,000,000 jobs so neither setting drains it within the run.

import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMPOSE = join(HERE, 'docker-compose.yml')
const opts = { version: 17, strategy: 'skip_locked', clients: 16, duration: 150, interval: 5, seedRows: 5_000_000 }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 2) {
  const key = { '--version': 'version', '--strategy': 'strategy', '--clients': 'clients', '--duration': 'duration',
    '--interval': 'interval', '--seed-rows': 'seedRows' }[argv[i]]
  if (!key) {
    console.error(`Unknown option: ${argv[i]}`)
    process.exit(2)
  }
  opts[key] = key === 'strategy' ? argv[i + 1] : Number(argv[i + 1])
}

const SETTINGS = {
  default: {
    server: 'ALTER SYSTEM RESET autovacuum_naptime',
    table: 'RESET (autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold, autovacuum_vacuum_cost_delay)',
  },
  tuned: {
    server: "ALTER SYSTEM SET autovacuum_naptime = '1s'",
    table: 'SET (autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 20000, autovacuum_vacuum_cost_delay = 0)',
  },
}
const project = `claimbench-longrun-pg${opts.version}`
const env = { ...process.env, PG_VERSION: String(opts.version), INITDB_ARGS: '', PG_EXTRA: '' }

function compose(args) {
  const result = spawnSync('docker', ['compose', '-p', project, '-f', COMPOSE, ...args], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`docker compose ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`)
  return result.stdout.trim()
}
const psql = (sql, variables = {}) =>
  compose(['exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'bench', '-v', 'ON_ERROR_STOP=1', '-tAq',
    ...Object.entries(variables).flatMap(([k, v]) => ['-v', `${k}=${v}`]), ...(sql.startsWith('/') ? ['-f', sql] : ['-c', sql])])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const STATS = `SELECT (SELECT count(*) FROM jobs WHERE status = 'done'), n_dead_tup, autovacuum_count,
  (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'autovacuum worker')
FROM pg_stat_user_tables WHERE relname = 'jobs'`

const series = []
compose(['up', '-d', '--pull', 'missing', '--wait'])
try {
  for (let i = 0; i < 60; i++) {
    try {
      psql('SELECT 1')
      break
    } catch {
      await sleep(1000)
    }
  }
  psql('/sql/setup.sql')
  const server = psql('SHOW server_version')
  for (const [name, setting] of Object.entries(SETTINGS)) {
    psql(setting.server)
    psql('SELECT pg_reload_conf()')
    psql(`ALTER TABLE jobs ${setting.table}`)
    psql('/sql/reseed.sql', { rows: opts.seedRows })
    const naptime = psql('SHOW autovacuum_naptime')
    const bench = spawn('docker', ['compose', '-p', project, '-f', COMPOSE, 'exec', '-T', 'db', 'pgbench', '-U', 'postgres', '-n',
      '-c', String(opts.clients), '-j', String(Math.min(opts.clients, 4)), '-T', String(opts.duration),
      '-f', `/sql/workloads/${opts.strategy}.sql`, 'bench'], { env, stdio: 'ignore' })
    const finished = new Promise((resolve) => bench.on('close', resolve))
    const start = Date.now()
    let lastDone = 0
    let lastT = 0
    while (Date.now() - start < opts.duration * 1000) {
      await sleep(opts.interval * 1000)
      const t = Math.round((Date.now() - start) / 1000)
      const [done, dead, autovacuums, vacuumRunning] = psql(STATS).split('|').map(Number)
      if (done >= opts.seedRows) throw new Error('Queue drained; rerun with a larger --seed-rows')
      const row = {
        setting: name, version: server, naptime, t_s: t, claimed_total: done,
        claims_per_s: Math.round((done - lastDone) / (t - lastT)), dead_rows: dead,
        autovacuum_runs: autovacuums, autovacuum_active: vacuumRunning,
      }
      series.push(row)
      console.log(JSON.stringify(row))
      lastDone = done
      lastT = t
    }
    await finished
  }
} finally {
  spawnSync('docker', ['compose', '-p', project, '-f', COMPOSE, 'down', '-v'], { env })
}

const out = join(HERE, 'results', 'long-run')
mkdirSync(out, { recursive: true })
const cols = Object.keys(series[0])
writeFileSync(join(out, `pg${opts.version}-${opts.strategy}-c${opts.clients}.csv`),
  [cols.join(','), ...series.map((r) => cols.map((c) => r[c]).join(','))].join('\n') + '\n')
