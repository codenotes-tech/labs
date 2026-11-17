-- migrate:no-transaction
CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  org_id BIGINT NOT NULL,
  user_id BIGINT,
  project_id BIGINT,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX CONCURRENTLY events_org_created_idx ON events (org_id, created_at DESC);
