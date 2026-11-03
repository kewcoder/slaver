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
