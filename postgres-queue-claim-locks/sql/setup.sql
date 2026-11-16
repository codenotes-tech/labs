-- Queue table and the three claim strategies compared in this experiment.
-- The claim functions mark jobs 'done' directly, so a run measures claim
-- throughput only, with no simulated job execution.

DROP TABLE IF EXISTS jobs;

CREATE TABLE jobs (
  id bigserial PRIMARY KEY,
  status text NOT NULL DEFAULT 'queued',
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX jobs_runnable_idx ON jobs (run_at, id) WHERE status = 'queued';

-- Strategy 1: plain FOR UPDATE. Every worker targets the same first row.
CREATE OR REPLACE FUNCTION claim_for_update() RETURNS bigint AS $$
  WITH picked AS (
    SELECT id FROM jobs
    WHERE status = 'queued'
    ORDER BY run_at, id
    LIMIT 1
    FOR UPDATE
  )
  UPDATE jobs j SET status = 'done', locked_at = now()
  FROM picked WHERE j.id = picked.id
  RETURNING j.id;
$$ LANGUAGE sql;

-- Strategy 2: FOR UPDATE SKIP LOCKED. Locked rows are skipped, not waited on.
CREATE OR REPLACE FUNCTION claim_skip_locked() RETURNS bigint AS $$
  WITH picked AS (
    SELECT id FROM jobs
    WHERE status = 'queued'
    ORDER BY run_at, id
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE jobs j SET status = 'done', locked_at = now()
  FROM picked WHERE j.id = picked.id
  RETURNING j.id;
$$ LANGUAGE sql;

-- Strategy 3: advisory locks. Read up to 32 candidates without row locks,
-- try-lock each id, re-check status, and give up (NULL) after 32 misses.
CREATE OR REPLACE FUNCTION claim_advisory() RETURNS bigint AS $$
DECLARE
  candidate bigint;
BEGIN
  FOR candidate IN
    SELECT id FROM jobs
    WHERE status = 'queued'
    ORDER BY run_at, id
    LIMIT 32
  LOOP
    IF pg_try_advisory_xact_lock(candidate) THEN
      UPDATE jobs SET status = 'done', locked_at = now()
      WHERE id = candidate AND status = 'queued';
      IF FOUND THEN
        RETURN candidate;
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
