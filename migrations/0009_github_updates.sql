-- GitHub connector (creator side): a team connects GitHub and links a repo;
-- Slaver mirrors that branch into its own git. Buyers never touch GitHub.
CREATE TABLE IF NOT EXISTS github_accounts (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  login TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_github_team ON github_accounts(team_id, created_at DESC);

ALTER TABLE repos ADD COLUMN github_account_id TEXT NOT NULL DEFAULT '';
ALTER TABLE repos ADD COLUMN github_repo TEXT NOT NULL DEFAULT '';
ALTER TABLE repos ADD COLUMN github_branch TEXT NOT NULL DEFAULT '';
ALTER TABLE repos ADD COLUMN github_synced_at TEXT NOT NULL DEFAULT '';
ALTER TABLE repos ADD COLUMN github_error TEXT NOT NULL DEFAULT '';
