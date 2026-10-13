#!/usr/bin/env bash
# Starts the local dev stack: API (dev auth ON, local only) + console. Postgres must already be running on :54329 with the `apex` DB migrated.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
mkdir -p .run
for s in api web; do [ -f .run/$s.pid ] && kill "$(cat .run/$s.pid)" 2>/dev/null || true; done
(cd services/api && APEX_DEV_AUTH=1 DATABASE_URL=postgres://apex_app:apex_app@localhost:54329/apex setsid nohup pnpm exec tsx src/server.ts > "$ROOT/.run/api.log" 2>&1 & echo $! > "$ROOT/.run/api.pid")
(cd apps/console && setsid nohup pnpm exec next dev -p 3000 > $ROOT/.run/web.log 2>&1 & echo $! > $ROOT/.run/web.pid)
until curl -sf localhost:4000/health >/dev/null; do sleep 1; done; echo "api up"
