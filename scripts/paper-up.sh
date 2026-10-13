#!/usr/bin/env bash
# Starts the PAPER engine processes: `apex-execution serve` and `python -m researcher.paper_feed loop`.
# Both are SYNTHETIC/paper only. PID files live in .run/ (no pkill by pattern: paper-down.sh signals exactly the recorded PIDs).
# Env: APEX_ENGINE_DATABASE_URL (service-role connection; default postgres://postgres@localhost:54329/apex),
#      APEX_PAPER_SEED (venue seed, default 42), APEX_FEED_INTERVAL (seconds per tick, default 1.0), APEX_FEED_BARS_PER_TICK (default 1).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
mkdir -p .run
export DATABASE_URL="${APEX_ENGINE_DATABASE_URL:-postgres://postgres@localhost:54329/apex}"
alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null && tr '\0' ' ' < "/proc/$(cat "$1")/cmdline" | grep -q "$2"; }
cargo build -q -p apex-execution
EXEC="$ROOT/target/debug/apex-execution"
if alive .run/execution.pid "apex-execution"; then echo "execution already running (pid $(cat .run/execution.pid))"; else
  APEX_SERVE_INSTANCE="exec-$$-$(date +%s)" setsid nohup "$EXEC" serve > .run/execution.log 2>&1 < /dev/null &
  echo $! > .run/execution.pid; echo "execution started (pid $(cat .run/execution.pid))"
fi
if alive .run/paper_feed.pid "researcher.paper_feed"; then echo "paper_feed already running (pid $(cat .run/paper_feed.pid))"; else
  (cd services/researcher && APEX_FEED_INSTANCE="feed-$$-$(date +%s)" setsid nohup .venv/bin/python -m researcher.paper_feed loop > "$ROOT/.run/paper_feed.log" 2>&1 < /dev/null &
   echo $! > "$ROOT/.run/paper_feed.pid")
  echo "paper_feed started (pid $(cat .run/paper_feed.pid))"
fi
sleep 2
for n in execution paper_feed; do alive ".run/$n.pid" "$( [ $n = execution ] && echo apex-execution || echo researcher.paper_feed )" && echo "$n: up" || { echo "$n: FAILED to start, see .run/$n.log"; exit 1; }; done
echo "NOTE: paper only, SYNTHETIC market data. Start a workspace's engine from the console (Start paper engine) or api_set_paper_running."
