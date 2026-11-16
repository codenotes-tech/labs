-- Sampled every 0.25 s during a run: how many benchmark backends are
-- active, waiting on a heavyweight lock (row, transaction, or advisory lock),
-- on a lightweight lock (LWLock, for example a buffer content lock), or on
-- I/O, plus the exact wait events behind those waits.
SELECT
  count(*) FILTER (WHERE state = 'active')            AS active,
  count(*) FILTER (WHERE wait_event_type = 'Lock')    AS lock_wait,
  count(*) FILTER (WHERE wait_event_type = 'LWLock')  AS lwlock_wait,
  count(*) FILTER (WHERE wait_event_type = 'IO')      AS io_wait,
  coalesce(string_agg(wait_event_type || ':' || wait_event, ';')
           FILTER (WHERE wait_event_type IN ('Lock', 'LWLock', 'IO')), '') AS events
FROM pg_stat_activity
WHERE datname = 'bench'
  AND backend_type = 'client backend'
  AND pid <> pg_backend_pid()
\watch 0.25
