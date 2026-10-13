# QA Evidence Ledger

Every row is produced by scripts/evidence.sh from a real run; logs are stored under docs/evidence/runs/. Statuses: PASS / FAIL / BLOCKED / NOT RUN.

| Time (UTC) | Suite | Status | Commit | Dirty files | Command | Log |
|---|---|---|---|---|---|---|
| 2026-10-13T19:20:12Z | db: ledger/RLS/state-machine/compounding | **PASS** | 4db9d7a | 13 | `pnpm --filter @apex/db test` | docs/evidence/runs/20261013T192012Z-db__ledger_RLS_state_machine_compounding.log |
| 2026-10-13T19:23:34Z | api: auth/RLS/commands/concurrency/headers | **PASS** | 4db9d7a | 27 | `pnpm --filter @apex/api test` | docs/evidence/runs/20261013T192334Z-api__auth_RLS_commands_concurrency_headers.log |
