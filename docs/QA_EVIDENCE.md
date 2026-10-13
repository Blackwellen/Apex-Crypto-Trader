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
| 2026-10-13T19:43:09Z | python: researcher full suite | **FAIL** | 58b402c | 22 | `.venv/bin/python -m pytest -q` | docs/evidence/runs/20261013T194309Z-python__researcher_full_suite.log |
| 2026-10-13T19:43:20Z | python: researcher full suite | **PASS** | 58b402c | 24 | `bash -c cd services/researcher && .venv/bin/python -m pytest -q` | docs/evidence/runs/20261013T194320Z-python__researcher_full_suite.log |
| 2026-10-13T19:50:52Z | chains: registry (35 chains, 9 families) + seed in sync | **PASS** | bd5fe10 | 72 | `pnpm --filter @apex/chain-registry test` | docs/evidence/runs/20261013T195052Z-chains__registry__35_chains__9_families____seed_in_sync.log |
| 2026-10-13T19:50:57Z | chains-a: chain-evm | **PASS** | bd5fe10 | 73 | `pnpm --filter @apex/chain-evm test` | docs/evidence/runs/20261013T195057Z-chains_a__chain_evm.log |
| 2026-10-13T19:51:06Z | chains-a: chain-solana | **PASS** | bd5fe10 | 73 | `pnpm --filter @apex/chain-solana test` | docs/evidence/runs/20261013T195106Z-chains_a__chain_solana.log |
| 2026-10-13T19:51:08Z | chains-a: chain-sui | **PASS** | bd5fe10 | 73 | `pnpm --filter @apex/chain-sui test` | docs/evidence/runs/20261013T195108Z-chains_a__chain_sui.log |
| 2026-10-13T19:51:13Z | chains-a: chain-aptos | **PASS** | bd5fe10 | 74 | `pnpm --filter @apex/chain-aptos test` | docs/evidence/runs/20261013T195113Z-chains_a__chain_aptos.log |
| 2026-10-13T19:51:22Z | db: full suite incl. all migrations | **FAIL** | bd5fe10 | 77 | `pnpm --filter @apex/db test` | docs/evidence/runs/20261013T195122Z-db__full_suite_incl__all_migrations.log |
| 2026-10-13T19:52:02Z | db: full suite incl. all migrations | **FAIL** | bd5fe10 | 81 | `pnpm --filter @apex/db test` | docs/evidence/runs/20261013T195202Z-db__full_suite_incl__all_migrations.log |
| 2026-10-13T19:52:33Z | db: full suite incl. all migrations | **PASS** | 754197b | 1 | `pnpm --filter @apex/db test` | docs/evidence/runs/20261013T195234Z-db__full_suite_incl__all_migrations.log |
| 2026-10-13T19:52:59Z | db: full suite incl. all migrations | **PASS** | 754197b | 8 | `pnpm --filter @apex/db test` | docs/evidence/runs/20261013T195259Z-db__full_suite_incl__all_migrations.log |
| 2026-10-13T19:56:54Z | rust: cargo test --workspace | **PASS** | 137f862 | 35 | `cargo test --workspace` | docs/evidence/runs/20261013T195654Z-rust__cargo_test___workspace.log |
