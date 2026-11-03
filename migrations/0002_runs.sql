-- Harness runs: Codex-like agent sessions backed by Sandbox containers.
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_runs_user ON runs(user_id, id DESC);

CREATE TABLE IF NOT EXISTS run_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL DEFAULT 'text',
  name TEXT NOT NULL DEFAULT '',
  output TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps(run_id, id);
