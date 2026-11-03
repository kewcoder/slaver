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
