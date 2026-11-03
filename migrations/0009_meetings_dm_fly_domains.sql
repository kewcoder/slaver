-- Meeting rename (was: huddles) + user DMs + mixed group members.
ALTER TABLE huddles RENAME TO meetings;
ALTER TABLE huddle_participants RENAME TO meeting_participants;
ALTER TABLE huddle_messages RENAME TO meeting_messages;
ALTER TABLE meeting_participants RENAME COLUMN huddle_id TO meeting_id;
ALTER TABLE meeting_messages RENAME COLUMN huddle_id TO meeting_id;

-- User-to-user direct messages (cross-user, same team).
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

-- Groups can include users (mixed human + AI channels), not just bots.
ALTER TABLE group_members ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
ALTER TABLE group_messages ADD COLUMN user_id TEXT NOT NULL DEFAULT '';

-- Per-project deployed/dev URLs (iframe home + custom domains).
ALTER TABLE projects ADD COLUMN prod_url TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN dev_url TEXT NOT NULL DEFAULT '';

-- Team-owned Fly.io accounts (teams bring their own Fly org + API key).
CREATE TABLE IF NOT EXISTS fly_accounts (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  name TEXT NOT NULL DEFAULT 'fly',
  org TEXT NOT NULL DEFAULT '',
  api_token TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_fly_team ON fly_accounts(team_id, created_at DESC);

-- Provisioned Fly machines: one prod + one dev/harness per team.
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

-- Custom domains on our Cloudflare zone (e.g. {uuid}.slaver.app).
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
