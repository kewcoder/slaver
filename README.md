# Slaver

**Don't just connect software. Own it.**

Slaver is an app marketplace where small business owners buy software once, own the source code, run it on their own server, and customize it in plain language. Meta's models (Muse Spark via Meta Model API) do two jobs:

- **Review every submission.** Static checks (leaked secrets, README, runnable, tests) run first, then Muse Spark scores the app and lists must-fix items. A listing only goes live when the current commit is approved (`src/review.rs`, `scripts/review-app.ts`, PR workflow in `.github/workflows/app-review.yml`).
- **Customize apps for owners.** The owner types what to change, Muse Spark picks the files and rewrites them, Slaver commits to a `staging` branch, rebuilds a live preview in the owner's own sandbox, and the owner applies it to production (`src/customize.rs`).

Buyers pay once (HitPay), get their own repo copy, and install with one click on their own Fly.io account (`src/hosting.rs`). First marketplace app: **F&B Suite** (`apps/fnb-suite/`). Hackathon submission details: [`SUBMISSION.md`](SUBMISSION.md).

**Stack:** API + MCP in Rust (axum + rusqlite), React SPA (Vite + Tailwind) served by the same server, git service, team chat with AI bots. One Docker image, one deploy (Fly.io or any VPS). Each team brings its own AI provider (Meta by default) in Teams settings; the only env secret is `JWT_SECRET` (plus optional `MODEL_API_KEY` for platform-wide reviews).

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
