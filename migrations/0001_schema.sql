-- Slaver schema (single file, SQLite).
-- Fresh databases apply this once; every statement is IF NOT EXISTS so
-- re-running is safe. No credit system: teams bring their own provider keys.

-- ---- users ----
-- Email+password auth. Passwords are salted SHA-256 (demo grade).
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---- slavebots ----
-- Named agents with owner-set memory/role. team_id '' = legacy pre-team row.
CREATE TABLE IF NOT EXISTS slavebots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  memory TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  parent_id TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  pinned_by TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  relay INTEGER NOT NULL DEFAULT 1,
  avatar_key TEXT NOT NULL DEFAULT '',
  voice TEXT NOT NULL DEFAULT 'luna',
  active_days TEXT NOT NULL DEFAULT 'all',
  active_start TEXT NOT NULL DEFAULT '',
  active_end TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_slavebots_user ON slavebots(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_slavebots_team ON slavebots(team_id);
CREATE INDEX IF NOT EXISTS idx_slavebots_parent ON slavebots(parent_id);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slavebot_id TEXT NOT NULL REFERENCES slavebots(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_bot ON messages(slavebot_id, id);

-- Token/cost telemetry per call (no balances, no deductions).
CREATE TABLE IF NOT EXISTS usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  slavebot_id TEXT REFERENCES slavebots(id),
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  estimated INTEGER NOT NULL DEFAULT 0,
  audio_seconds REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_logs(user_id, id DESC);

-- ---- summaries / schedules ----
CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slavebot_id TEXT NOT NULL REFERENCES slavebots(id),
  period TEXT NOT NULL,
  period_key TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (slavebot_id, period, period_key)
);
CREATE INDEX IF NOT EXISTS idx_summaries_bot ON summaries(slavebot_id, period, period_key);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  slavebot_id TEXT NOT NULL REFERENCES slavebots(id),
  name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'daily',
  time_hhmm TEXT NOT NULL DEFAULT '07:00',
  days TEXT NOT NULL DEFAULT 'all',
  interval_minutes INTEGER NOT NULL DEFAULT 0,
  prompt TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT NOT NULL DEFAULT '',
  last_run_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(active, next_run_at);
CREATE INDEX IF NOT EXISTS idx_schedules_bot ON schedules(slavebot_id);

-- ---- groups (channels: bots and/or users) ----
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT 'New group',
  is_public INTEGER NOT NULL DEFAULT 0,
  repo_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_groups_user ON groups(user_id, updated_at DESC);

-- One row per member; bot members use slavebot_id, human members use user_id.
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES groups(id),
  slavebot_id TEXT REFERENCES slavebots(id),
  user_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_group_members ON group_members(group_id);

-- user_id '' = bot message (slavebot_id set); slavebot_id NULL = human message.
CREATE TABLE IF NOT EXISTS group_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL REFERENCES groups(id),
  slavebot_id TEXT REFERENCES slavebots(id),
  user_id TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_group_messages ON group_messages(group_id, id);

-- ---- meetings (Slack-style: bots decide to join) ----
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT NOT NULL DEFAULT '',
  topic TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_meetings_user ON meetings(user_id);

CREATE TABLE IF NOT EXISTS meeting_participants (
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  slavebot_id TEXT NOT NULL REFERENCES slavebots(id),
  decision TEXT NOT NULL DEFAULT 'pending',
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (meeting_id, slavebot_id)
);

CREATE TABLE IF NOT EXISTS meeting_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  slavebot_id TEXT REFERENCES slavebots(id),
  bot_name TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_meeting_messages ON meeting_messages(meeting_id, id);

-- ---- user-to-user direct messages (same team) ----
CREATE TABLE IF NOT EXISTS direct_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL DEFAULT '',
  from_user_id TEXT NOT NULL,
  to_user_id TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_dm_pair ON direct_messages(team_id, from_user_id, to_user_id, id);
CREATE INDEX IF NOT EXISTS idx_dm_pair_rev ON direct_messages(team_id, to_user_id, from_user_id, id);

-- ---- teams ----
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  personal INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL DEFAULT 'meta',
  provider_base_url TEXT NOT NULL DEFAULT '',
  provider_api_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'staff',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);

-- Staff see only granted bots; owner/admin see every team bot.
CREATE TABLE IF NOT EXISTS bot_grants (
  bot_id TEXT NOT NULL REFERENCES slavebots(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (bot_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_bot_grants_user ON bot_grants(user_id);

-- ---- harness runs ----
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  issue_id TEXT NOT NULL DEFAULT '',
  repo_id TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
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

-- ---- platform: projects / kanban / repos / marketplace ----
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  repo_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT 'Project',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  prod_url TEXT NOT NULL DEFAULT '',
  dev_url TEXT NOT NULL DEFAULT '',
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
  price_cents INTEGER NOT NULL DEFAULT 4900,
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

-- ---- VPS targets & deployments ----
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

-- ---- HitPay checkout ----
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  repo_id TEXT NOT NULL DEFAULT '',
  hitpay_request_id TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'pending',
  license_id TEXT NOT NULL DEFAULT '',
  fork_repo_id TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'hitpay',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_payments_hitpay ON payments(hitpay_request_id);
CREATE INDEX IF NOT EXISTS idx_payments_team ON payments(team_id, created_at DESC);

-- ---- OAuth: Login with Slaver ----
CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  name TEXT NOT NULL DEFAULT 'app',
  secret_hash TEXT NOT NULL DEFAULT '',
  redirect_uris TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_oauth_clients_team ON oauth_clients(team_id, created_at DESC);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT NOT NULL DEFAULT '',
  redirect_uri TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id, created_at DESC);

-- ---- team Fly.io accounts & provisioned machines ----
CREATE TABLE IF NOT EXISTS fly_accounts (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  name TEXT NOT NULL DEFAULT 'fly',
  org TEXT NOT NULL DEFAULT '',
  api_token TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_fly_team ON fly_accounts(team_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fly_machines (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  role TEXT NOT NULL DEFAULT 'dev',
  app_name TEXT NOT NULL DEFAULT '',
  machine_id TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  cpus INTEGER NOT NULL DEFAULT 1,
  memory_mb INTEGER NOT NULL DEFAULT 512,
  status TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_fly_machines_team ON fly_machines(team_id, role);

-- ---- custom domains on our Cloudflare zone (e.g. {uuid}.slaver.app) ----
CREATE TABLE IF NOT EXISTS custom_domains (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  project_id TEXT NOT NULL DEFAULT '',
  subdomain TEXT NOT NULL DEFAULT '',
  hostname TEXT NOT NULL DEFAULT '',
  target TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'CNAME',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_domains_team ON custom_domains(team_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_domains_host ON custom_domains(hostname);
