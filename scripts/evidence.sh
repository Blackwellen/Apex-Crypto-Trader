#!/usr/bin/env bash
# Usage: scripts/evidence.sh <suite> <command...>
# Runs the command, stores the full output under docs/evidence/runs/, appends a PASS/FAIL row to docs/QA_EVIDENCE.md.
set -uo pipefail
suite="$1"; shift
root="$(cd "$(dirname "$0")/.." && pwd)"; cd "$root"
mkdir -p docs/evidence/runs
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ); sha=$(git rev-parse --short HEAD 2>/dev/null || echo none)
dirty=$(git status --porcelain | wc -l)
log="docs/evidence/runs/$(date -u +%Y%m%dT%H%M%SZ)-${suite//[^a-zA-Z0-9]/_}.log"
{ echo "# $suite"; echo "# command: $*"; echo "# commit: $sha (uncommitted files: $dirty)"; echo "# started: $ts"; echo "# host: $(uname -srm), node $(node -v 2>/dev/null)"; } > "$log"
"$@" >> "$log" 2>&1; rc=$?
status=PASS; [ $rc -ne 0 ] && status=FAIL
[ -f docs/QA_EVIDENCE.md ] || printf '# QA Evidence Ledger\n\nEvery row is produced by scripts/evidence.sh from a real run; logs are stored under docs/evidence/runs/. Statuses: PASS / FAIL / BLOCKED / NOT RUN.\n\n| Time (UTC) | Suite | Status | Commit | Dirty files | Command | Log |\n|---|---|---|---|---|---|---|\n' > docs/QA_EVIDENCE.md
echo "| $ts | $suite | **$status** | $sha | $dirty | \`$*\` | $log |" >> docs/QA_EVIDENCE.md
echo "$status ($suite) -> $log"; tail -n 8 "$log"; exit $rc
