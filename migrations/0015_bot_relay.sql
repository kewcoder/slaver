-- Agent-initiated relay: when 1, the bot may consult peer bots on its own
-- before replying (recorded in both histories, billed normally).
ALTER TABLE slavebots ADD COLUMN relay INTEGER NOT NULL DEFAULT 1;
