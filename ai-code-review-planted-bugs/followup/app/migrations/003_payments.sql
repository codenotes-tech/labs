CREATE TABLE payments (
  id BIGSERIAL PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES organizations(id),
  invoice_id BIGINT NOT NULL REFERENCES invoices(id),
  provider_charge_id TEXT,
  amount BIGINT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
