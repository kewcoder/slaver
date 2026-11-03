-- Teams with roles, per-bot staff grants, and per-user AI provider config.
-- Legacy rows keep team_id '' (personal): resolved to an explicit personal
-- team on demand by ensure_personal_team() in the backend.
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  personal INTEGER NOT NULL DEFAULT 0,
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

ALTER TABLE slavebots ADD COLUMN team_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_slavebots_team ON slavebots(team_id);
ALTER TABLE groups ADD COLUMN team_id TEXT NOT NULL DEFAULT '';
ALTER TABLE huddles ADD COLUMN team_id TEXT NOT NULL DEFAULT '';

-- Per-user AI provider. Default is Meta (hackathon); OpenRouter stays as
-- the last-resort preset; Baseten/Modal/custom need the user's own key+URL.
ALTER TABLE users ADD COLUMN provider TEXT NOT NULL DEFAULT 'meta';
ALTER TABLE users ADD COLUMN provider_base_url TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN provider_api_key TEXT NOT NULL DEFAULT '';
-- Carry over OpenRouter BYOK keys into the new generic column.
UPDATE users SET provider = 'openrouter', provider_api_key = openrouter_key WHERE openrouter_key <> '';
