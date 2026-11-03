-- Live chat: per-user read markers so unread badges + notifications work.
-- kind: 'dm' | 'group' | 'meeting' | 'bot'. ref_id: peer / group / meeting / bot id.
CREATE TABLE IF NOT EXISTS read_state (
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'dm',
  team_id TEXT NOT NULL DEFAULT '',
  ref_id TEXT NOT NULL DEFAULT '',
  last_id INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, kind, team_id, ref_id)
);
