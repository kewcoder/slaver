-- AI skill marketplace: reusable role+memory packs that teams install onto bots.
-- Template skills (template = 1) are public; team skills belong to one team.
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  name TEXT NOT NULL DEFAULT 'skill',
  category TEXT NOT NULL DEFAULT 'Layanan',
  description TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  memory TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL DEFAULT 0,
  template INTEGER NOT NULL DEFAULT 0,
  fork_of TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_skills_team ON skills(team_id, created_at DESC);
