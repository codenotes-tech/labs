# CodeNotes labs

Experiments behind [CodeNotes](https://codenotes.tech) articles. Each folder is one self-contained experiment: a Docker setup, the scripts that ran it, the raw results, and a README with exact versions, hardware, and how to rerun it.

| Experiment | Question | Article |
| --- | --- | --- |
| [`postgres-queue-claim-locks`](postgres-queue-claim-locks/) | How many jobs per second do `FOR UPDATE`, `SKIP LOCKED`, and advisory-lock claims handle on PostgreSQL 15 to 18, and what limits them? | [SKIP LOCKED vs FOR UPDATE vs Advisory Locks: A Postgres Benchmark](https://codenotes.tech/blog/skip-locked-vs-for-update-vs-advisory-locks) |
| [`api-idempotency-keys`](api-idempotency-keys/) | Which idempotency-key implementations still charge a payment twice under concurrent duplicates, client retries, slow providers, and lost responses? | [API Idempotency Keys: Prevent Duplicate Requests Safely](https://codenotes.tech/blog/api-idempotency-keys-prevent-duplicate-requests) |
