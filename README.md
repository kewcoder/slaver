# Slaver

Full-stack on Cloudflare: **API + MCP in Rust** (Workers via `workers-rs`), **React SPA** (Vite) served as Workers Static Assets. One Worker, one deploy.

- `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/me` — JWT (HS256) + D1.
- `POST /api/chat` — persisted chat (`{chat_id?, message, model?, stream?}`). Non-streaming returns reply + cost + credit inline; streaming returns SSE with an `X-Chat-Id` header, then the client calls `POST /api/chat/finish` with the final text so usage is logged and credit deducted.
- `GET /api/chats`, `GET /api/chats/:id` — saved chat history (never deleted).
- `GET /api/usage` — token/cost ledger + remaining credit. Every account starts with **$10 demo credit**; costs are estimated from provider token usage (Spark contributor tier).
- Groups: `GET/POST /api/groups`, `GET/PUT/DELETE /api/groups/:id`, member add/remove, `POST /api/groups/:id/chat` (one task fans out to every member, each reply billed), `POST /api/groups/:id/broadcast` (info to the thread, optionally appended to every member's memory), `POST /api/slavebots/:id/memory` (append one fact).
- `POST /api/voice/transcribe` — push-to-talk voice chat. The browser records the mic, converts to 16 kHz mono WAV, and uploads it; the server transcribes via Muse Voice Transcribe (`$3/1000 min`, language auto-detected) and bills the seconds to the same credit. Assistant replies are spoken back with the browser's built-in voice (Indonesian preferred, toggleable).
- `POST /api/chat` and the MCP `chat` tool return 402 when credit runs out.
- `POST /mcp` — MCP Streamable HTTP (JSON-RPC): `initialize`, `tools/list`, `tools/call` (`chat`, `models`).

## Prerequisites

- Rust + the `wasm32-unknown-unknown` target: `rustup target add wasm32-unknown-unknown`
- `cargo install worker-build`
- Node 20+, a Cloudflare account + `wrangler login`

## Run locally

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in JWT_SECRET (random) + META_API_KEY from dev.meta.ai
npm run db:migrate:local
./node_modules/.bin/wrangler dev --port 8787  # use the project's wrangler (4.156.2)
```

Open http://localhost:8787 in your browser. (An older global wrangler may fail on the runtime compatibility date.)

## Deploy to Cloudflare

```sh
wrangler login
wrangler d1 create slaver_db   # copy database_id into wrangler.jsonc
npm run db:migrate:remote
wrangler secret put META_API_KEY   # key from dev.meta.ai
wrangler secret put JWT_SECRET     # random string, min 32 chars
npm run deploy
```

## Quick checks

```sh
curl localhost:8787/api/health
curl -X POST localhost:8787/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Note: without a real `META_API_KEY`, `/api/chat` returns a 502 carrying the Meta API error — that means the proxy works and only the key is missing.
