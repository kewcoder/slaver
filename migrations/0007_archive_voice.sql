-- Archive flag: archived bots are hidden and skipped, never deleted.
ALTER TABLE slavebots ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE slavebots ADD COLUMN voice TEXT NOT NULL DEFAULT 'luna';
ALTER TABLE slavebots ADD COLUMN active_days TEXT NOT NULL DEFAULT 'all';
ALTER TABLE slavebots ADD COLUMN active_start TEXT NOT NULL DEFAULT '';
ALTER TABLE slavebots ADD COLUMN active_end TEXT NOT NULL DEFAULT '';
