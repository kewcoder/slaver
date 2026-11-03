-- Public support groups (cross-team customer service) + repo-linked groups.
ALTER TABLE groups ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;
ALTER TABLE groups ADD COLUMN repo_id TEXT NOT NULL DEFAULT '';
