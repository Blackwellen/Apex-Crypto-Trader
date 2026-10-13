# QA Evidence Ledger

Every row is produced by scripts/evidence.sh from a real run; logs are stored under docs/evidence/runs/. Statuses: PASS / FAIL / BLOCKED / NOT RUN.

| Time (UTC) | Suite | Status | Commit | Dirty files | Command | Log |
|---|---|---|---|---|---|---|
| 2026-10-13T19:20:12Z | db: ledger/RLS/state-machine/compounding | **PASS** | 4db9d7a | 13 | `pnpm --filter @apex/db test` | docs/evidence/runs/20261013T192012Z-db__ledger_RLS_state_machine_compounding.log |
| 2026-10-13T19:23:34Z | api: auth/RLS/commands/concurrency/headers | **PASS** | 4db9d7a | 27 | `pnpm --filter @apex/api test` | docs/evidence/runs/20261013T192334Z-api__auth_RLS_commands_concurrency_headers.log |
| 2026-10-13T19:41:04Z | chains-b: chain-tron unit | **PASS** | fa45df5 | 47 | `pnpm --filter @apex/chain-tron test` | docs/evidence/runs/20261013T194104Z-chains_b__chain_tron_unit.log |
| 2026-10-13T19:41:05Z | chains-b: chain-cosmos unit | **PASS** | fa45df5 | 48 | `pnpm --filter @apex/chain-cosmos test` | docs/evidence/runs/20261013T194105Z-chains_b__chain_cosmos_unit.log |
| 2026-10-13T19:41:06Z | chains-b: chain-bitcoin unit | **PASS** | fa45df5 | 48 | `pnpm --filter @apex/chain-bitcoin test` | docs/evidence/runs/20261013T194106Z-chains_b__chain_bitcoin_unit.log |
| 2026-10-13T19:41:07Z | chains-b: chain-ton unit | **PASS** | fa45df5 | 48 | `pnpm --filter @apex/chain-ton test` | docs/evidence/runs/20261013T194107Z-chains_b__chain_ton_unit.log |
| 2026-10-13T19:41:08Z | chains-b: chain-near unit | **PASS** | fa45df5 | 48 | `pnpm --filter @apex/chain-near test` | docs/evidence/runs/20261013T194108Z-chains_b__chain_near_unit.log |
| 2026-10-13T19:41:09Z | chains-b: exchange-adapters unit | **PASS** | fa45df5 | 48 | `pnpm --filter @apex/exchange-adapters test` | docs/evidence/runs/20261013T194109Z-chains_b__exchange_adapters_unit.log |
