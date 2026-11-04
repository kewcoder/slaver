-- One-click install of marketplace apps onto the buyer's own hosting.
-- Fly.io tokens keep living in fly_accounts; other providers live here.
CREATE TABLE IF NOT EXISTS hosting_accounts (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  provider TEXT NOT NULL,              -- vercel | netlify | cloudflare
  name TEXT NOT NULL DEFAULT '',
  account_ref TEXT NOT NULL DEFAULT '', -- vercel team id / cloudflare account id
  api_token TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_hosting_team ON hosting_accounts(team_id, created_at DESC);

CREATE TABLE IF NOT EXISTS installs (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  project_id TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  account_id TEXT NOT NULL DEFAULT '',
  site_name TEXT NOT NULL DEFAULT '',
  external_id TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued', -- queued | running | live | failed
  log TEXT NOT NULL DEFAULT '',
  commit_sha TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_installs_team ON installs(team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_installs_project ON installs(project_id, created_at DESC);

ALTER TABLE repos ADD COLUMN category TEXT NOT NULL DEFAULT '';
