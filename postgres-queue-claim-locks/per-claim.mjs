#!/usr/bin/env node
// Work done per claimed row, from PostgreSQL's own statistics: shared buffer
// pages touched (pg_stat_database), WAL records, full-page images, and bytes
// (pg_stat_wal). Used to compare versions after bench.mjs found a throughput gap.
//
//   node per-claim.mjs                    # Postgres 17 vs 18, SKIP LOCKED, 1/8/32 workers
//   node per-claim.mjs --versions 16 17 18 --strategy for_update --clients 8
//
// For each version and client count: reseed (truncate, refill, vacuum, analyze,
// checkpoint), snapshot the counters, run pgbench for --duration seconds,
// snapshot again, and divide the deltas by the number of rows claimed.

import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMPOSE = join(HERE, 'docker-compose.yml')

const opts = { versions: [17, 18], strategy: 'skip_locked', clients: [1, 8, 32], duration: 15, seedRows: 1_000_000, reps: 2 }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const take = () => {
    const values = []
    while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) values.push(argv[++i])
    return values
  }
  if (argv[i] === '--versions') opts.versions = take().map(Number)
  else if (argv[i] === '--clients') opts.clients = take().map(Number)
  else if (argv[i] === '--strategy') opts.strategy = argv[++i]
  else if (argv[i] === '--duration') opts.duration = Number(argv[++i])
  else if (argv[i] === '--reps') opts.reps = Number(argv[++i])
  else {
    console.error(`Unknown option: ${argv[i]}`)
    process.exit(2)
  }
}

function compose(version, args) {
  const result = spawnSync('docker', ['compose', '-p', `claimbench-perclaim-pg${version}`, '-f', COMPOSE, ...args], {
    env: { ...process.env, PG_VERSION: String(version), INITDB_ARGS: '', PG_EXTRA: '' },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`docker compose ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`)
  return result.stdout.trim()
}

const psql = (version, sql, variables = {}) =>
  compose(version, ['exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'bench', '-v', 'ON_ERROR_STOP=1', '-tAq',
    ...Object.entries(variables).flatMap(([k, v]) => ['-v', `${k}=${v}`]), ...(sql.startsWith('/') ? ['-f', sql] : ['-c', sql])])

const SNAPSHOT = `SELECT d.blks_hit + d.blks_read, d.xact_commit, w.wal_records, w.wal_fpi, w.wal_bytes,
  (SELECT count(*) FROM jobs WHERE status = 'done')
FROM pg_stat_database d, pg_stat_wal w WHERE d.datname = 'bench'`

const snapshot = (version) => psql(version, SNAPSHOT).split('|').map(Number)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const rows = []
for (const version of opts.versions) {
  compose(version, ['up', '-d', '--pull', 'missing', '--wait'])
  try {
    for (let i = 0; i < 60; i++) {
      try {
        psql(version, 'SELECT 1')
        break
      } catch {
        await sleep(1000)
      }
    }
    psql(version, '/sql/setup.sql')
    const server = psql(version, 'SHOW server_version')
    for (const clients of opts.clients) {
      for (let rep = 1; rep <= opts.reps; rep++) {
        psql(version, '/sql/reseed.sql', { rows: opts.seedRows })
        await sleep(1500) // let backends flush their statistics
        const before = snapshot(version)
        compose(version, ['exec', '-T', 'db', 'pgbench', '-U', 'postgres', '-n', '-c', String(clients),
          '-j', String(Math.min(clients, 4)), '-T', String(opts.duration), '-f', `/sql/workloads/${opts.strategy}.sql`, 'bench'])
        await sleep(1500)
        const after = snapshot(version)
        const [buffers, commits, walRecords, walFpi, walBytes, claimed] = after.map((v, i) => v - before[i])
        const row = {
          version: server, strategy: opts.strategy, clients, rep, claimed,
          claims_per_s: Math.round(claimed / opts.duration),
          buffers_per_claim: +(buffers / claimed).toFixed(2),
          wal_records_per_claim: +(walRecords / claimed).toFixed(2),
          wal_fpi_per_1000_claims: +((walFpi / claimed) * 1000).toFixed(1),
          wal_bytes_per_claim: Math.round(walBytes / claimed),
          commits_per_claim: +(commits / claimed).toFixed(3),
        }
        rows.push(row)
        console.log(JSON.stringify(row))
      }
    }
  } finally {
    spawnSync('docker', ['compose', '-p', `claimbench-perclaim-pg${version}`, '-f', COMPOSE, 'down', '-v'],
      { env: { ...process.env, PG_VERSION: String(version) } })
  }
}

const out = join(HERE, 'results', 'per-claim')
mkdirSync(out, { recursive: true })
const cols = Object.keys(rows[0])
writeFileSync(join(out, `${opts.strategy}.csv`), [cols.join(','), ...rows.map((r) => cols.map((c) => r[c]).join(','))].join('\n') + '\n')
