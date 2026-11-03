-- HitPay checkout: payment requests, per-template prices.
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  repo_id TEXT NOT NULL DEFAULT '',
  hitpay_request_id TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'pending',
  license_id TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'hitpay',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_payments_hitpay ON payments(hitpay_request_id);
CREATE INDEX IF NOT EXISTS idx_payments_team ON payments(team_id, created_at DESC);

ALTER TABLE repos ADD COLUMN price_cents INTEGER NOT NULL DEFAULT 4900;
