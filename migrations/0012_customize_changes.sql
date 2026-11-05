-- AI customize history per owned app (was in memory only, so it vanished on
-- every restart/deploy). status: working | done | failed | discarded.
-- applied = merged into production by "Apply to production".
CREATE TABLE IF NOT EXISTS customize_changes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'working',
  summary TEXT NOT NULL DEFAULT '',
  files_json TEXT NOT NULL DEFAULT '[]',
  commit_sha TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  applied INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_customize_changes_project ON customize_changes(project_id, created_at);
