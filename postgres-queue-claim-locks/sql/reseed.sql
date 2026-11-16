-- Identical starting state for every run: a full queue, fresh statistics,
-- no dead tuples, and a checkpoint so no checkpoint lands mid-run.
-- Usage: psql -v rows=2000000 -f reseed.sql
TRUNCATE jobs RESTART IDENTITY;

INSERT INTO jobs (run_at)
SELECT now() - interval '1 hour' + (i * interval '1 millisecond')
FROM generate_series(1, :rows) i;

VACUUM ANALYZE jobs;
CHECKPOINT;
