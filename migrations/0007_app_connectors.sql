-- App connectors: installed Slaver apps expose MCP outward (/mcp), and the
-- team registers each deployed app here. AI agents reach app features only
-- through these connectors — no external/outbound integrations.
CREATE TABLE IF NOT EXISTS app_connectors (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  project_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT 'app',
  base_url TEXT NOT NULL DEFAULT '',
  api_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_connectors_team ON app_connectors(team_id, created_at DESC);
