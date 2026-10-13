#!/usr/bin/env bash
# Gracefully stops the PAPER engine processes recorded in .run/*.pid (SIGTERM, wait up to 15s, then SIGKILL that exact PID only).
# Never uses pkill/killall. A PID is only signalled if its command line still matches the expected program.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
stop() {
  local name="$1" pat="$2" f=".run/$1.pid"
  [ -f "$f" ] || { echo "$name: no pid file"; return; }
  local pid; pid="$(cat "$f")"
  if kill -0 "$pid" 2>/dev/null && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q "$pat"; then
    kill -TERM "$pid"
    for _ in $(seq 1 75); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
    if kill -0 "$pid" 2>/dev/null; then echo "$name: did not stop in 15s, SIGKILL pid $pid"; kill -KILL "$pid"; else echo "$name: stopped (graceful)"; fi
  else echo "$name: not running (stale pid file)"; fi
  rm -f "$f"
}
stop paper_feed researcher.paper_feed
stop execution apex-execution
