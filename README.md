# Slaver

Full-stack AI chat on Cloudflare: **API + MCP in Rust** (Workers via `workers-rs`), **React SPA** (Vite + Tailwind) served as Workers Static Assets. Slack-style UI. One Worker, one deploy.

- SlaveBots with identity, memory, per-bot model/avatar/voice, sub-bots, schedules, archive, pin.
- Teams with owner/admin/staff roles, per-staff bot grants, per-bot partnership (owner), team activity feed.
- Each team brings its own AI provider (Meta default, Baseten, Modal, OpenRouter, custom) configured in Teams settings — the only env secret is `JWT_SECRET`; TTS uses the Workers AI binding.
- Groups (channels) with one-input broadcast + optional memory save, huddles with self-select join, voice chat + hands-free mode, daily/weekly/monthly summaries, usage ledger + $10 demo credit.
- Bots can consult peer bots on their own before replying (toggle per bot).
- `POST /mcp` — MCP Streamable HTTP: chat, models, bot archive/pin/role/spawn/send, teams, schedules, huddles.

## Prerequisites

- Rust + the `wasm32-unknown-unknown` target: `rustup target add wasm32-unknown-unknown`
- `cargo install worker-build`
- Node 20+, a Cloudflare account + `wrangler login`

## Run locally

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in JWT_SECRET (random, min 32 chars)
npm run db:migrate:local          # single file: migrations/0001_schema.sql
./node_modules/.bin/wrangler dev --port 8787  # use the project's wrangler (4.156.2)
```

Open http://localhost:8787 in your browser. Register, open Teams settings, and add your team's provider key (Meta, Baseten, Modal, OpenRouter, or custom) — bots need it to chat.

## Deploy to Cloudflare

```sh
wrangler login
wrangler d1 create slaver_db   # copy database_id into wrangler.jsonc
npm run db:migrate:remote
wrangler secret put JWT_SECRET          # random string, min 32 chars
npm run deploy
```

## Quick checks

```sh
curl localhost:8787/api/health
curl -X POST localhost:8787/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Without a team provider key, `/api/chat` returns a 502 pointing at Teams settings — that means the proxy works and only the key is missing. Voice transcription needs the team's provider set to Meta; spoken replies run on the Workers AI binding (no keys needed).
