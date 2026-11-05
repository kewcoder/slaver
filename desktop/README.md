# Slaver Desktop

Same Slaver, same data, same login — the window loads your Slaver server
(default `https://slaver.fly.dev`, override with `SLAVER_SERVER_URL`).
The only difference from the web version: **running** apps and **customize
previews** execute on your own machine instead of a rented server.

## How it works

- The web UI is reused 100% (served by the server, not bundled).
  The app injects a tiny `window.SlaverLocal` bridge; when present, the
  Run and Customize panels clone the repo from the server over git and
  manage it locally with your Bun.
- No sync feature, no separate database: everything (market, teams,
  licenses, projects, AI edits) lives in Slaver as usual.

## Requirements on the user's machine

- **Bun** — runs the apps: `curl -fsSL https://bun.sh/install | bash`
  (or `brew install oven-sh/bun/bun`).
- **git** — app source control (Xcode CLT on macOS already has it).
- **cloudflared** (optional) — one-click public links: `brew install cloudflared`.

## Flows

- **Run locally** — Apps → ⋯ → Run locally. The repo's HEAD is cloned to
  the desktop data dir, built, and served on a stable localhost port.
  Data stays in the app folder, untouched by rebuilds.
- **Publish** — in the same panel: quick Cloudflare tunnel (no account,
  URL changes every restart) or a named tunnel on the user's own domain
  (tutorial included in the UI).
- **Customize** — same chat UI as web. The desktop sends with `ship: none`:
  the server only edits + commits to the `staging` branch, and the desktop
  runs that branch locally for the live preview. No Sprites account needed.

## Dev

```bash
cd desktop
cargo tauri dev                                    # window → SLAVER_SERVER_URL
SLAVER_SERVER_URL=http://localhost:8091 cargo tauri dev   # local server
cargo test -p slaver-desktop                       # runner unit + fixture test
```

Web UI changes (Run panel, Customize preview) live in `frontend/src` and
deploy with the server — the desktop picks them up automatically.
