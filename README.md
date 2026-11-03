# Slaver

Full-stack on Cloudflare: **API + MCP in Rust** (Workers via `workers-rs`), **React SPA** (Vite) served as Workers Static Assets. One Worker, one deploy.

- `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/me` — JWT (HS256) + D1.
- `POST /api/chat` — streaming proxy (SSE) to the Meta Model API (`https://api.meta.ai/v1`, OpenAI-compatible). Upstream bytes are forwarded without buffering.
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
