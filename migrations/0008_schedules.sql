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
