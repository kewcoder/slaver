-- AI review of a marketplace listing request. One row per review run; the latest
-- row for the repo's current HEAD decides whether the listing may go live.
CREATE TABLE IF NOT EXISTS listing_reviews (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  commit_sha TEXT NOT NULL DEFAULT '',
  verdict TEXT NOT NULL DEFAULT 'changes',   -- approved | changes
  score REAL,
  model TEXT NOT NULL DEFAULT '',
  review_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_listing_reviews_repo ON listing_reviews(repo_id, created_at DESC);
