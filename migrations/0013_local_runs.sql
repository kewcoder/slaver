-- Local runs: owned apps running on this machine (desktop, or any self-hosted
-- server with Bun). One row per project; the process itself lives in memory.
CREATE TABLE IF NOT EXISTS local_runs (
  project_id TEXT PRIMARY KEY,
  port INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'stopped',
  log TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
