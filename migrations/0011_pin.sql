-- Pinned bot: each user pins their own auto-open bot (pinned_by tracks whose
-- pin it is, so teammates don't clobber each other). Archiving clears it.
ALTER TABLE slavebots ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE slavebots ADD COLUMN pinned_by TEXT NOT NULL DEFAULT '';
