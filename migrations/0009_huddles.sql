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
