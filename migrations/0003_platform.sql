-- Slaver platform: projects/kanban, git repos, marketplace licenses, VPS targets.
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  repo_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT 'Project',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_projects_team ON projects(team_id, created_at DESC);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'backlog',
  assignee_bot_id TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'medium',
  labels TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id, created_at ASC);

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  name TEXT NOT NULL DEFAULT 'repo',
  description TEXT NOT NULL DEFAULT '',
  template INTEGER NOT NULL DEFAULT 0,
  fork_of TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_repos_team ON repos(team_id, created_at DESC);

CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  repo_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'perpetual',
  support_until TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  provider TEXT NOT NULL DEFAULT 'mock',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_licenses_team ON licenses(team_id, created_at DESC);

CREATE TABLE IF NOT EXISTS vps_targets (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  name TEXT NOT NULL DEFAULT 'vps',
  host TEXT NOT NULL DEFAULT '',
  ssh_user TEXT NOT NULL DEFAULT 'root',
  ssh_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_vps_team ON vps_targets(team_id, created_at DESC);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  vps_target_id TEXT NOT NULL DEFAULT '',
  commit_sha TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  log TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_deploy_project ON deployments(project_id, id DESC);

-- Harness runs link to issues/repos/branches (table created in 0002).
ALTER TABLE runs ADD COLUMN issue_id TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN repo_id TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN branch TEXT NOT NULL DEFAULT '';
