-- SlaveBot ownership: the team member this bot partners with.
-- Owners/admins can transfer it; creators start as the owner.
ALTER TABLE slavebots ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT '';
UPDATE slavebots SET owner_user_id = user_id WHERE owner_user_id = '';
