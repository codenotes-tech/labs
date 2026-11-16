-- Idempotency records, as described in the article
-- (https://codenotes.tech/blog/api-idempotency-keys-prevent-duplicate-requests).
CREATE TABLE idempotency_keys (
  id BIGSERIAL PRIMARY KEY,
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,              -- in_progress | completed | ambiguous
  response_status INT,
  response_body JSONB,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (scope, idempotency_key)
);
