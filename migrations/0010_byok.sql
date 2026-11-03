-- BYOK: each user can store their own OpenRouter key. When set, all of
-- that user's model calls use it (and their key pays OpenRouter directly,
-- so those calls skip demo-credit deduction). Never returned by any API.
ALTER TABLE users ADD COLUMN openrouter_key TEXT NOT NULL DEFAULT '';
