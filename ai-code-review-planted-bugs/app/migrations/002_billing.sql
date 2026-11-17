CREATE TABLE invoices (
  id BIGSERIAL PRIMARY KEY,
  org_id BIGINT NOT NULL REFERENCES organizations(id),
  amount BIGINT NOT NULL,            -- in cents
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'open',
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX invoices_org_id_idx ON invoices (org_id, id DESC);

CREATE TABLE coupons (
  code TEXT PRIMARY KEY,
  percent_off INT NOT NULL CHECK (percent_off BETWEEN 1 AND 100),
  max_redemptions INT NOT NULL,
  redemptions INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ
);

CREATE TABLE coupon_redemptions (
  code TEXT NOT NULL REFERENCES coupons(code),
  org_id BIGINT NOT NULL REFERENCES organizations(id),
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (code, org_id)
);
