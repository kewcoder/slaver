#!/bin/bash
# Bundle the web frontend + migrations into src-tauri/resources for the installer.
# Apps are NOT bundled: submitted/purchased apps arrive via git (cloud sync).
# Usage: ./scripts/bundle.sh [--force]
set -euo pipefail

DESKTOP="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$DESKTOP/.." && pwd)"
OUT="$DESKTOP/src-tauri/resources"
FORCE="${1:-}"

mkdir -p "$OUT"

if [ "$FORCE" != "--force" ] && [ -f "$OUT/frontend/index.html" ] && [ -f "$OUT/migrations/0001_schema.sql" ]; then
  echo "bundle: fresh, skip (use --force to rebuild)"
  exit 0
fi

echo "bundle: building web frontend ..."
(npm run build:frontend --prefix "$REPO" >/dev/null)
rm -rf "$OUT/frontend" "$OUT/migrations"
cp -r "$REPO/frontend/dist" "$OUT/frontend"
cp -r "$REPO/migrations" "$OUT/migrations"
echo "bundle: frontend $(du -sh "$OUT/frontend" | cut -f1), migrations done"
