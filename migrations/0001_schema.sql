-- Slaver D1 schema (single file).
-- Fresh databases: `wrangler d1 migrations apply slaver_db [--local|--remote]`.
-- All statements are IF NOT EXISTS / additive; apply exactly once on an empty database.

-- ---- 0001_users.sql ----
-- Users table for simple email+password auth (hackathon skeleton).
-- Passwords stored as salted SHA-256 (demo grade; swap to bcrypt/scrypt for production).
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---- 0002_credits_history.sql ----
-- Demo credit ledger + persisted chat history.
ALTER TABLE users ADD COLUMN credit_usd REAL NOT NULL DEFAULT 10.0;

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL DEFAULT 'New chat',
  model TEXT NOT NULL DEFAULT 'muse-spark-1.3',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_chats_user ON chats(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);

CREATE TABLE IF NOT EXISTS usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  chat_id TEXT REFERENCES chats(id),
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  estimated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_logs(user_id, id DESC);

-- ---- 0003_voice_usage.sql ----
-- Voice transcription cost tracking (seconds of audio).
ALTER TABLE usage_logs ADD COLUMN audio_seconds REAL NOT NULL DEFAULT 0;

-- ---- 0004_slavebots.sql ----
-- SlaveBots: named agents with user-set memory (previously: chats).
ALTER TABLE chats RENAME TO slavebots;
ALTER TABLE slavebots ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE slavebots ADD COLUMN memory TEXT NOT NULL DEFAULT '';
ALTER TABLE messages RENAME COLUMN chat_id TO slavebot_id;
ALTER TABLE usage_logs RENAME COLUMN chat_id TO slavebot_id;
UPDATE slavebots SET name = substr(title, 1, 30) WHERE name = '';
DROP INDEX IF EXISTS idx_chats_user;
DROP INDEX IF EXISTS idx_messages_chat;
DROP INDEX IF EXISTS idx_usage_user;
CREATE INDEX IF NOT EXISTS idx_slavebots_user ON slavebots(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_bot ON messages(slavebot_id, id);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_logs(user_id, id DESC);

-- ---- 0005_summaries_avatars.sql ----
-- Conversation summaries (daily / weekly / monthly rollups per slaveBot).
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

-- Avatar object key in R2 (empty = initial-letter fallback).
ALTER TABLE slavebots ADD COLUMN avatar_key TEXT NOT NULL DEFAULT '';

-- ---- 0006_groups.sql ----
-- Group missions: one task to many slaveBots, shared discussion thread.
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL DEFAULT 'New group',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES groups(id),
  slavebot_id TEXT NOT NULL REFERENCES slavebots(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (group_id, slavebot_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_groups_user ON groups(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS group_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL REFERENCES groups(id),
  slavebot_id TEXT REFERENCES slavebots(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_group_messages ON group_messages(group_id, id);

-- ---- 0007_archive_voice.sql ----
-- Archive flag: archived bots are hidden and skipped, never deleted.
ALTER TABLE slavebots ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE slavebots ADD COLUMN voice TEXT NOT NULL DEFAULT 'luna';
ALTER TABLE slavebots ADD COLUMN active_days TEXT NOT NULL DEFAULT 'all';
ALTER TABLE slavebots ADD COLUMN active_start TEXT NOT NULL DEFAULT '';
ALTER TABLE slavebots ADD COLUMN active_end TEXT NOT NULL DEFAULT '';

-- ---- 0008_schedules.sql ----
-- Bot-managed schedules: reminders and briefings the bot runs by itself.
-- Times are wall-clock in the bot's timezone (default Asia/Jakarta, WIB, no DST).
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

-- ---- 0009_huddles.sql ----
-- Personal identity (role), manager/sub-bot hierarchy, and Slack-style huddles.
ALTER TABLE slavebots ADD COLUMN role TEXT NOT NULL DEFAULT '';
ALTER TABLE slavebots ADD COLUMN parent_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_slavebots_parent ON slavebots(parent_id);

-- A huddle: one topic broadcast to bots, each deciding by itself to join.
CREATE TABLE IF NOT EXISTS huddles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  topic TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_huddles_user ON huddles(user_id);

CREATE TABLE IF NOT EXISTS huddle_participants (
  huddle_id TEXT NOT NULL REFERENCES huddles(id),
  slavebot_id TEXT NOT NULL REFERENCES slavebots(id),
  decision TEXT NOT NULL DEFAULT 'pending',
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (huddle_id, slavebot_id)
);

CREATE TABLE IF NOT EXISTS huddle_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  huddle_id TEXT NOT NULL REFERENCES huddles(id),
  slavebot_id TEXT REFERENCES slavebots(id),
  bot_name TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_huddle_messages ON huddle_messages(huddle_id, id);

-- ---- 0010_byok.sql ----
-- BYOK: each user can store their own OpenRouter key. When set, all of
-- that user's model calls use it (and their key pays OpenRouter directly,
-- so those calls skip demo-credit deduction). Never returned by any API.
ALTER TABLE users ADD COLUMN openrouter_key TEXT NOT NULL DEFAULT '';

-- ---- 0011_pin.sql ----
-- Pinned bot: each user pins their own auto-open bot (pinned_by tracks whose
-- pin it is, so teammates don't clobber each other). Archiving clears it.
ALTER TABLE slavebots ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE slavebots ADD COLUMN pinned_by TEXT NOT NULL DEFAULT '';

-- ---- 0012_teams_providers.sql ----
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

-- ---- 0013_team_providers.sql ----
-- AI provider config moves from per-user/per-env to per-team.
-- Every team owns its preset + base URL + key; only JWT_SECRET stays in env.
ALTER TABLE teams ADD COLUMN provider TEXT NOT NULL DEFAULT 'meta';
ALTER TABLE teams ADD COLUMN provider_base_url TEXT NOT NULL DEFAULT '';
ALTER TABLE teams ADD COLUMN provider_api_key TEXT NOT NULL DEFAULT '';

-- Carry existing personal-team keys forward where a personal team already exists.
UPDATE teams SET provider = (SELECT u.provider FROM users u WHERE u.id = teams.owner_user_id),
                provider_base_url = (SELECT u.provider_base_url FROM users u WHERE u.id = teams.owner_user_id),
                provider_api_key = (SELECT u.provider_api_key FROM users u WHERE u.id = teams.owner_user_id)
WHERE personal = 1;

-- User-level provider columns are no longer read; drop them.
ALTER TABLE users DROP COLUMN provider;
ALTER TABLE users DROP COLUMN provider_base_url;
ALTER TABLE users DROP COLUMN provider_api_key;
ALTER TABLE users DROP COLUMN openrouter_key;

-- ---- 0014_bot_ownership.sql ----
-- SlaveBot ownership: the team member this bot partners with.
-- Owners/admins can transfer it; creators start as the owner.
ALTER TABLE slavebots ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT '';
UPDATE slavebots SET owner_user_id = user_id WHERE owner_user_id = '';

-- ---- 0015_bot_relay.sql ----
-- Agent-initiated relay: when 1, the bot may consult peer bots on its own
-- before replying (recorded in both histories, billed normally).
ALTER TABLE slavebots ADD COLUMN relay INTEGER NOT NULL DEFAULT 1;
