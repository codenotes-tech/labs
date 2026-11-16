# Postgres queue claims: FOR UPDATE vs SKIP LOCKED vs advisory locks

**Question:** when many workers pull jobs from one PostgreSQL table at the same time, how many jobs per second can they actually claim with each of the three common claim patterns, and what are they waiting on when it stops scaling?

Article: [SKIP LOCKED vs FOR UPDATE vs Advisory Locks in Postgres Queues](https://codenotes.tech/blog/skip-locked-vs-for-update-vs-advisory-locks)

## Findings (November 2026)

Medians of 3 runs, PostgreSQL 17 unless noted; full tables in [`results/main/summary.md`](results/main/summary.md).

| Workers | `FOR UPDATE` | `SKIP LOCKED` | Advisory (claimed) | Advisory calls with no job |
| ------: | -----------: | ------------: | -----------------: | -------------------------: |
|       1 |        3,628 |         3,549 |              4,184 |                         0% |
|       4 |        6,219 |         7,463 |              8,317 |                         0% |
|       8 |        5,773 |        10,920 |             11,794 |                         0% |
|      16 |        3,931 |        12,163 |             13,348 |                         0% |
|      32 |        2,891 |        10,642 |             13,066 |                        13% |
|      64 |        2,719 |         8,290 |              8,668 |                        58% |

- `FOR UPDATE` peaks at 4 to 8 workers and gets slower with every worker after that; at 64 workers, 57 of 64 sessions wait on row locks.
- `SKIP LOCKED` scales about 3.5x to 16 workers, limited by WAL writes, then by `LWLock:BufferContent` on the queue's head pages.
- Advisory claims return no job for 58 to 69% of calls at 64 workers; pgbench `tps` overstates rows claimed by 2.4 to 3.2x.
- Throughput falls 28 to 57% within a 20-second run as dead index entries pile up at the queue head; each `SKIP LOCKED` claim touched 117 to 395 buffer pages ([`per-claim.mjs`](per-claim.mjs), [`results/per-claim/`](results/per-claim/)).
- In 150-second runs on a 5,000,000-job queue, default autovacuum never ran and throughput fell from 15,231 to about 3,100 claims/s; tuned autovacuum held about 15,800 ([`long-run.mjs`](long-run.mjs), [`results/long-run/`](results/long-run/)).
- PostgreSQL 18 claimed 18 to 46% fewer rows than 17 with `SKIP LOCKED` at 8 to 64 workers. Data checksums and `io_method` do not explain it ([`results/pg18-cause/summary.md`](results/pg18-cause/summary.md)); the cause is not identified.

## What is measured

Each run drains a pre-filled queue of 1,000,000 jobs for 20 seconds with `pgbench`, using one of three claim functions ([`sql/setup.sql`](sql/setup.sql)):

| Strategy | Claim |
| --- | --- |
| `for_update` | `SELECT ... ORDER BY run_at, id LIMIT 1 FOR UPDATE`, then mark the row done |
| `skip_locked` | the same with `FOR UPDATE SKIP LOCKED` |
| `advisory` | read 32 candidates without row locks, `pg_try_advisory_xact_lock` each, re-check, mark done; returns `NULL` if all 32 are taken |

Per run, [`bench.mjs`](bench.mjs) records:

- **claims per second**: rows actually marked done, divided by run time. This is the main number. pgbench's own `tps` also counts advisory calls that returned no job, so it overstates the advisory strategy.
- **empty claims**: transactions that claimed nothing (`tx_processed - done_rows`).
- **latency**: p50, p95, p99, and max from pgbench's per-transaction log.
- **what sessions wait on**: `pg_stat_activity` sampled every 0.25 s ([`sql/waits.sql`](sql/waits.sql)), split into heavyweight locks (row, transaction, advisory), LWLocks (for example buffer content locks), and I/O, plus the most common wait events.
- **drift within a run**: mean per-second throughput of the first and last quarter of the run (`pgbench -P 1`).

Every run starts from the same state: the queue is truncated and refilled, vacuumed, analyzed, and checkpointed ([`sql/reseed.sql`](sql/reseed.sql)).

## Design choices

- **Versions:** PostgreSQL 15, 16, 17, and 18, the major versions supported in November 2026, using the official `postgres` Docker images. Exact versions and image digests are in `results/*/environment.json`.
- **Default settings where they matter:** `fsync` and `synchronous_commit` stay on, so every claim is a durable commit. Data checksums follow each version's default (off before 18, on in 18), which is what a fresh install gets. Only memory and checkpoint spacing are raised, identically for every version (see [`docker-compose.yml`](docker-compose.yml)).
- **Interleaved runs:** all versions run as separate containers at once, and every run in the matrix executes in one seeded random order, so slow drift on the host cannot line up with one version or strategy.
- **Repeats:** 3 runs per cell; reports use the median and show the spread.
- **Client threads:** `pgbench -j` is `min(clients, 4)`; pgbench runs inside the database container.

## Run it

Requires Docker with the compose plugin and Node.js 18 or newer. No npm packages.

```bash
node bench.mjs                    # main matrix: 4 versions x 3 strategies x 6 client counts x 3 repeats
node analyze.mjs main             # medians, results/main/summary.md, charts (full matrix takes about 1.5 hours)
```

Smaller runs:

```bash
node bench.mjs --tag smoke --versions 18 --clients 1 8 64 --reps 1 --duration 5
node bench.mjs --tag checksums --versions 15 18 --checksums both --clients 8 64
```

Interrupted runs resume: rerunning the same command skips runs already in `runs.csv`.

Follow-up experiments:

```bash
# PostgreSQL 18 controls: checksums and io_method
node bench.mjs --tag pg18-cause --variant pg17=17 --variant pg18=18 \
  --variant pg18-checksums-off=18,checksums=off --variant pg18-io-sync=18,io_method=sync \
  --variant pg18-both-off=18,checksums=off,io_method=sync --strategies skip_locked --clients 1 8 32
node analyze.mjs pg18-cause

# Buffer pages and WAL per claimed row (pg_stat_database, pg_stat_wal)
node per-claim.mjs --versions 17 18

# 150-second runs with default vs tuned autovacuum, 5,000,000 jobs
node long-run.mjs --version 17
node analyze.mjs long-run
```

## Results

- [`results/main/summary.md`](results/main/summary.md): medians per version, strategy, and client count
- [`results/main/runs.csv`](results/main/runs.csv): one row per run
- [`results/main/raw/`](results/main/raw/): full pgbench output for every run
- [`results/main/charts/`](results/main/charts/): SVG charts
- [`results/main/excluded-runs.csv`](results/main/excluded-runs.csv): five runs set aside for host interference (all collapsed together in one three-minute window across unrelated versions and strategies), with their raw output in `raw-excluded/`; they were rerun
- [`results/pg18-cause/`](results/pg18-cause/), [`results/per-claim/`](results/per-claim/), [`results/long-run/`](results/long-run/): the follow-up experiments

Per-transaction latency logs are not committed (hundreds of MB); rerunning regenerates them.

## Limits

- **Docker Desktop on macOS** runs Postgres in a Linux VM, with pgbench in the same container. Compare strategies and versions against each other; absolute numbers will differ on a dedicated Linux server.
- **Claims only.** Jobs do no work after being claimed. With real jobs taking milliseconds or more, the claim is a smaller share of total time.
- **No producers.** The queue is pre-filled; concurrent inserts would add index contention for every strategy.
- **One table shape.** One partial index on `(run_at, id) WHERE status = 'queued'`, 1,000,000 rows.
