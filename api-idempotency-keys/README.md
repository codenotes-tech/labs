# API idempotency keys: which implementations still charge twice?

**Question:** when the same payment request arrives more than once (a double click, a client retry after a timeout, a lost response from the payment provider), which common idempotency-key implementations still charge the customer twice, and what does the client get back?

Articles:
- [API Idempotency Keys: Prevent Duplicate Requests Safely](https://codenotes.tech/blog/api-idempotency-keys-prevent-duplicate-requests)
- [Webhook Idempotency and Retries in Production](https://codenotes.tech/blog/webhook-idempotency-and-retries-in-production)

## Findings (November 2026)

Share of payments charged more than once, medians of 3 runs of 200 payments; full tables in [`results/summary.md`](results/summary.md).

| Implementation | 2 at once | 10 at once | Client timeout + retry | Provider slower than lock | Lost provider response | Same key, different payment |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `none` | 100% | 100% | 100% | 100% | 100% | charged the new payment |
| `check_then_insert` | 100% | 100% | 100% | 100% | 100% | replayed the first payment |
| `redis_lock` | 0% | 0% | 0% (1 of 600) | 100% | 100% | replayed the first payment |
| `reserve` | 0% | 0% | 0% | 0% | 0%, all left `pending` | rejected (`422`) |
| `reserve_release` | 0% | 0% | 0% | 0% | 100% | rejected (`422`) |
| `reserve_provider_key` | 0% | 0% | 0% | 0% | 0%, all resolved | rejected (`422`) |

- With `check_then_insert`, a duplicate sent 0 to 50 ms after the first request was charged twice 99 to 100% of the time, 56.5% at 100 ms, 2% at 150 ms, and never from 200 ms (provider latency 100 ± 50 ms).
- The one `redis_lock` double charge in the plain retry scenario came from the gap between reading the stored response and taking the lock: the retry read just before the first request saved its response, and locked just after it released the lock.
- Outcomes were identical across repeats in 26 of 30 cells and differed by at most 11 of 200 payments in the rest.

## Setup

[`docker-compose.yml`](docker-compose.yml) starts four containers:

- **provider** ([`src/provider.mjs`](src/provider.mjs)): a mock payment provider. Every charge it makes goes into an in-memory ledger, which is the ground truth for this experiment, whatever the API or the client saw. Latency and faults are set per run. Like Stripe, it honors an `Idempotency-Key` header: the same key returns the first result without a new charge.
- **api** ([`src/api.mjs`](src/api.mjs)): the same `POST /<impl>/payments` endpoint implemented six ways (below).
- **db**: PostgreSQL 17 with the idempotency table from the article ([`sql/schema.sql`](sql/schema.sql)).
- **redis**: Redis 8, for the lock-based implementation.

| Implementation | What it does |
| --- | --- |
| `none` | Charges on every request. The baseline. |
| `check_then_insert` | Looks up the key; if absent, charges, then inserts the key and the response (unique constraint; a conflict replays the stored response). |
| `redis_lock` | `SET lock NX PX 2000`; if acquired, charges, stores the response in Redis for 24 h, deletes the lock. A held lock returns `409`. |
| `reserve` | The article's design: `INSERT ... ON CONFLICT DO NOTHING` reserves the key as `in_progress` before the charge; completed keys replay the stored response; a different request body with the same key gets `422`; a failed or timed-out provider call marks the key `ambiguous` and later requests get `202 pending`. |
| `reserve_release` | The same, but a failed provider call deletes the reservation so the client can retry, a common shortcut. |
| `reserve_provider_key` | The same as `reserve`, and it also sends the key to the provider. A retry that finds an `ambiguous` key takes ownership and asks the provider again with the same key. |

The runner, [`run.mjs`](run.mjs), runs on the host with Node.js 18+ and no npm packages. The API container uses two pinned packages (`pg` 8.23.1, `redis` 6.3.1).

## Scenarios

Each run sends 200 payments, 25 at a time, each with its own idempotency key; each scenario is repeated 3 times per implementation, in one seeded random order.

| Scenario | Provider | Client |
| --- | --- | --- |
| `concurrent_2` | 100 ± 50 ms | sends 2 identical requests at the same moment |
| `concurrent_10` | 100 ± 50 ms | sends 10 identical requests at the same moment |
| `client_retry` | 1,000 ± 100 ms | gives up after 300 ms, retries after 250 ms, up to 10 attempts |
| `slow_provider` | 2,500 ± 250 ms (longer than the 2 s Redis lock) | gives up after 1 s, retries after 500 ms, up to 5 attempts |
| `lost_response` | 100 ± 50 ms, but the first response for each payment never arrives; the API gives up after 1 s | waits up to 3 s, retries after 300 ms, up to 5 attempts |
| `key_reuse` | 100 ± 50 ms | pays order A with key K, then sends a different payment (order B, amount 999) with the same key K |
| `gap_<N>` | 100 ± 50 ms | sends a duplicate N ms after the first request (0 to 400 ms), against `check_then_insert` only |

Per run the runner records, from the provider's ledger: payments charged more than once and extra charges; and from the client side: the final outcome of each payment (a payment response, `202 pending`, `409`, `422`, or an error or timeout), whether a success response named a charge that belongs to another key, and latency.

## Run it

Requires Docker with the compose plugin and Node.js 18 or newer.

```bash
node run.mjs                     # 6 implementations x 6 scenarios x 3 repeats, about 30 minutes
node run.mjs --tag gap --impls check_then_insert \
  --scenarios gap_0 gap_25 gap_50 gap_100 gap_150 gap_200 gap_400
node analyze.mjs                 # results/summary.md, results/summary.csv, results/charts/gap.svg
```

Smaller check: `node run.mjs --tag smoke --orders 30 --reps 1`. Interrupted runs resume: rerunning the same command skips runs already in `runs.csv`.

## Results

- [`results/summary.md`](results/summary.md): the tables
- [`results/main/runs.csv`](results/main/runs.csv), [`results/gap/runs.csv`](results/gap/runs.csv): one row per run
- `results/*/raw/`: every request of every payment in every run, with the number of provider charges for its key
- `results/*/environment.json`: host, container versions, and scenario settings

## Limits

- **Mock provider.** Real providers differ in latency, retry behavior, and how their own idempotency keys expire.
- **One API process.** The races here need only two requests; several API instances behind a load balancer make them more likely, not less.
- **The lock and timeout values are choices.** A 2-second Redis lock and a 1-second provider timeout are reasonable defaults, not the only ones; the scenarios show what happens when real latency crosses them.
- **No reconciliation job.** The `reserve` implementation leaves ambiguous payments as `pending`, as the article recommends; a production system would also run a job that asks the provider what happened.
