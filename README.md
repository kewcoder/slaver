# Slaver

Self-hosted full-stack AI chat — zero Cloudflare. **API + MCP in Rust** (axum + rusqlite), **React SPA** (Vite + Tailwind) served by the same server, **Codex-like harness** with local tool execution. Slack-style UI. One Docker image, one deploy (Fly.io or any VPS).

- SlaveBots with identity, memory, per-bot model/avatar/voice, sub-bots, schedules, archive, pin.
- Teams with owner/admin/staff roles, per-staff bot grants, per-bot partnership (owner), team activity feed.
- Each team brings its own AI provider (Meta default, Baseten, Modal, OpenRouter, OpenCode, Ollama, custom) configured in Teams settings — the only env secret is `JWT_SECRET`; spoken replies use the browser voice.
- Groups (channels) with one-input broadcast + optional memory save, huddles with self-select join, voice dictation + hands-free mode, daily/weekly/monthly summaries, usage ledger + $10 demo credit.
- Bots can consult peer bots on their own before replying (toggle per bot).
- Harness runs: agentic coding runs with shell/file tools in per-run workspaces, streamed to the UI.
- `POST /mcp` — MCP Streamable HTTP: chat, models, bot archive/pin/role/spawn/send, teams, schedules, huddles.

## Prerequisites

- Rust 1.84+, Node 20+
- Docker (for the container build) or Fly.io (`flyctl`) for hosting

## Run locally (Docker Compose)

```sh
cp .env.example .env   # fill in JWT_SECRET (random, min 32 chars)
docker compose up --build
```

Open http://localhost:8080 in your browser. Register, open Teams settings, and add your team's provider key — bots need it to chat. SQLite lives in the `slaver_data` volume; migrations in `migrations/` run automatically on boot.

## Run locally (bare metal)

```sh
npm install
npm run build:frontend
export JWT_SECRET="random-string-min-32-chars" PORT=8080
cargo run
```

## Deploy to Fly.io

```sh
fly launch --no-deploy          # reuse fly.toml (app name, region sin)
fly volumes create slaver_data --size 3 -r sin
fly secrets set JWT_SECRET=$(openssl rand -hex 32)
fly deploy
```

## Quick checks

```sh
curl localhost:8080/ping
curl -X POST localhost:8080/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Without a team provider key, chat returns an error pointing at Teams settings — that means the server works and only the key is missing. Voice transcription needs the team's provider set to Meta; spoken replies use the built-in browser voice.
