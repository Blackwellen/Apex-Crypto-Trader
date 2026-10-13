# Rust execution + risk: test evidence

Scope: Cargo workspace (`/Cargo.toml`) with `services/risk` (`apex-risk`, lib + bin) and `services/execution`
(`apex-execution`, lib + bin), plus migration `packages/db/migrations/0140_execution_support.sql`.
Everything below was actually run; nothing is estimated. Paper/synthetic only: **no live trading code exists**.

## Environment
- rustc 1.97.0 (2d8144b78 2026-07-07), Linux 6.18.44 x86_64, 4 vCPU Xeon @ 2.80GHz, 16 GB (shared VM, other work running concurrently)
- PostgreSQL 16.15 on localhost:54329 (user postgres, trust). Each test creates a FRESH database
  (`apex_rs_<pid>_<n>_<rand>`), applies `infra/local/auth_shim.sql` then `packages/db/migrate.sh` (ALL migrations present
  in the repo at run time, 0001..0262 incl. 0140), and drops the database afterwards.
- Repo HEAD at run time: 754197b (working tree contains other agents' uncommitted migrations/UI; the tests applied whatever migrations existed).

## Command and result (full suite)
```
cd /home/user/Apex-Crypto-Trader && cargo test --workspace
```
Started 2026-10-13T19:52:15Z, finished 2026-10-13T19:52:56Z (wall 40.6 s incl. incremental compile).

| test binary | tests | passed | failed | time |
|---|---|---|---|---|
| apex-risk `tests/risk_tests.rs` (unit + proptest) | 18 | 18 | 0 | 2.82 s |
| apex-execution `tests/economics.rs` (unit + proptest) | 6 | 6 | 0 | 0.10 s |
| apex-execution `tests/paper.rs` (unit + proptest, no DB) | 10 | 10 | 0 | 5.19 s |
| apex-execution `tests/integration.rs` (real Postgres) | 15 | 15 | 0 | 30.71 s |
| apex-execution `tests/bench.rs` | 1 | ignored by default (run separately, see rust-benchmarks.md) | | |
| **total executed** | **49** | **49** | **0** | |

Individual run history honesty: during development the first integration runs FAILED (SQL syntax in my own
migration, a pool-exhaustion deadlock, wrong test expectations, and a drift detection against migration 0244, see
"Defects found and fixed"). The table above is the final green run.

## What each required case proves (all in `services/execution/tests/integration.rs` unless noted)
| requirement | test | what is asserted |
|---|---|---|
| Rust state table == SQL | `state_machine_table_equals_migration_0003_and_live_db` | Rust `ALLOWED` (52 pairs) == union of every `insert into allowed_transitions` parsed out of all migration files == rows of `allowed_transitions` in a freshly migrated DB; exhaustive 23x23 check that `can_transition_to` matches; `UNKNOWN->SUBMITTING` illegal; migration 0003 alone defines 45 pairs, migration 0244 adds 7 pre-submit CANCELLED moves |
| 100 concurrent intents, one bucket | `hundred_concurrent_intents_one_bucket_no_overspend` | 100 tokio tasks race risk+reservation for funds sized for exactly 20 (budget*20 + budget/2): exactly 20 reserve, exactly 80 FAIL with `failed:insufficient_funds`; reserved == 20*budget; available >= 0; conservation (sum of all balances per asset == 0, no negative non-contra account); then the 20 run to completion concurrently: reserved == 0, available == funds - sum(fills), ETH balance == sum(fill qty) |
| same, fully concurrent end-to-end | `hundred_concurrent_full_flows_invariants_hold` | 100 intents run risk->fill concurrently with funds for ~20: total spend <= funds, conservation, every reservation settled, every intent in an outcome state |
| duplicate fill delivery | `duplicate_fill_delivery_is_one_economic_fill` | each venue fill delivered 10x concurrently, then whole-flow replays: one `fills` row and one `fill_buy` ledger entry per venue fill; balances exact; `apply_fill_checked` refuses overfill |
| crash/replay identical ledger | `crash_at_every_checkpoint_then_replay_gives_identical_final_ledger` | 24 sequential intents (IOC buys, resting GTC buys joining the queue, sells) run twice with the same venue seed: once uncrashed, once with a simulated process crash injected after a different durable action (checkpoints 1-16, 22 crashes actually fired) followed by a brand-new dispatcher + `recover()`. Equal: per-intent outcomes, per-account balances, fills, ledger entry counts per kind, every `order_events` row, positions, AND the paper venue's event-log hash (so the venue saw the identical operation sequence, no duplicate submit). Venue log hash for this scenario (seed 99): `fd3ca31c57292d4a776a86b08781a2de0bd8dab3b2e69e7d3d3411b3dbed2cbd` |
| crash in the SUBMITTING window | `crash_in_submitting_window_goes_unknown_never_resubmits` | state committed as SUBMITTING, process dies before the venue call: recovery finds no venue record -> UNKNOWN (NOT resubmitted, submit calls == 0), funds stay reserved; reconciliation (authoritative absence) -> FAILED, funds released. By design this window does NOT converge to the uncrashed ledger (that would require resubmitting), so checkpoint 9 is excluded from the identical-ledger test and covered here |
| UNKNOWN never resubmitted | `unknown_outcome_is_never_resubmitted_only_reconciliation_resolves_it` | venue timeout AFTER accept and BEFORE accept: both -> UNKNOWN; 5 rounds of drive/recover/new dispatcher: `submit_calls` stays 1, reservation unchanged, SQL refuses `UNKNOWN->SUBMITTING`; an UNKNOWN order vetoes new entries in the bucket (`UNKNOWN_ORDERS_OPEN`); `reconcile` adopts the found order (-> FILLED) or fails the absent one and releases funds; submit still 1 each |
| non-authoritative "not found" | `non_authoritative_not_found_keeps_unknown` | a venue that cannot prove absence leaves the order UNKNOWN |
| exits allowed while halted | `exits_allowed_while_halted_entries_blocked` | for each of `halt_new_entries`, `exit_only`, `emergency_stopped`: a new BUY is VETOed (`GLOBAL_STATE_BLOCKS_ENTRIES`), a position-covered SELL is admitted (`ADMIT_EXIT_PATH`) and FILLED with exact ETH balance; an uncovered oversell is vetoed; SQL defence in depth: a forged ADMIT row for a BUY cannot pass `advance_intent` while halted; resuming `active` re-allows entries |
| risk veto is final | `risk_veto_is_final_and_enforced_in_sql` | VETO row persisted with reasons; a later forged ADMIT row cannot advance the intent (SQL `risk gate`); `record_decision` never inserts an ADMIT over an existing VETO; ADMITTED without any ADMIT is refused |
| degraded inputs deny entries | `each_degraded_input_denies_entry` | degraded data, slippage, fee ceiling, failed-tx rate, oversize order, blacklist each produce the specific veto code; zero submissions |
| unprofitable quote rejected | `unprofitable_quote_rejected_with_reasons_and_funds_released` | edge 100 bps vs round-trip costs 110 bps -> FAILED with `NetEvNotPositive`, reservation released, zero submissions |
| live disabled | `live_path_is_disabled_everywhere` | `LiveVenue` returns `Err(LiveDisabled)` for every call; `live_allowed(ws)` is false on a fresh workspace; creating a `live` intent is rejected by the DB guard trigger |
| end to end ledger | `buy_then_sell_flow_end_to_end_ledger_exact` | exact balances after buy and sell (available, reserved, ETH, fees_expense, position qty and cost basis, realised-PnL event), conservation, exact state trail SIGNAL..ACKNOWLEDGED..FILLED |
| fills bounded by reservation | `fill_cannot_exceed_reservation_or_steal_other_reservations` | an oversize fill on intent A is refused; it cannot consume intent B's reserved money |
| paper determinism | `paper.rs::same_seed_is_byte_identical_*`, `determinism_for_arbitrary_seeds` (proptest) | same seed => identical SHA-256 of the canonical event log AND identical line-for-line log AND identical fills; different seed => different hash |
| matcher | `paper.rs` | price-time priority, better-price-first, limit respected, partial fills across levels with IOC remainder expiry, exact maker/taker fee integers, FIFO queue position (no fill until the queue ahead is consumed), self-trade prevention (no wash trades), tick/lot filters, client-id dedup; proptest: quantity conservation and never-crossed book over random op sequences, our fills never exceed order qty or trade through the limit |
| risk policy hierarchy | `risk_tests.rs` proptests (2000 cases each) | merged policy never looser than parent; hierarchy monotone; tighten commutative+idempotent; a tighter policy never admits what the parent vetoes; halted state never admits an entry; stale never admitted; degraded never admits an entry; fresh risk-reducing exits always admitted |
| economics | `economics.rs` | hand-computed example (net 1,097,000 = 109 bps); rounding always conservative (exact unrounded value is an upper bound, tight within 7 units); raising any cost never raises net EV; accepted quotes clear every bar |

## Defects found and fixed while writing the tests (kept for honesty)
1. `0140` first draft had a plpgsql parse error (`CASE ... THEN` inside an `IF` condition); fixed.
2. Dispatcher pinned one pooled connection per driver for the advisory lock while needing a second for its transactions;
   with 100 tasks and a 40-connection pool all connections were held by lock-holders => hang. Fixed by bounding concurrent
   drivers to pool/2 with a semaphore (`Db::drive_permit`).
3. Migration 0003 as written blocks EVERY `ADMITTED` transition when `global_state <> 'active'`, including risk-reducing
   exits, contradicting spec section 8. `0140` replaces `advance_intent` with a version that is identical except that a
   SELL fully covered by the recorded position may still be ADMITTED while halted. **This is an override of a function owned
   by 0003; the lead should review/merge it.**
4. `release_reservation()` (0002) is only correct when nothing was consumed through `apply_fill`; after fills it would
   release more than remains and could eat another intent's reserved money (the `reserved` account is shared per
   bucket/wallet/asset). `0140` adds `settle_intent_reservation()` (unspent remainder only, idempotent) and
   `apply_fill_checked()` (bounds cumulative fills by the reservation and the intent quantity) and the dispatcher uses those.
5. Migration 0244 (another agent) added 7 pre-submit `CANCELLED` transitions; the drift test caught that my Rust table lacked
   them; the table now mirrors them.

## FAILED / BLOCKED / NOT DONE (honest list)
- No test failed in the final run. Nothing is BLOCKED.
- **Live execution is not implemented** (by design). `LiveVenue` is an inert stub.
- The risk gate runs **in-process inside the dispatcher** (library call) and is enforced a second time by SQL
  (`advance_intent`). `apex-risk` the binary is a stateless JSON evaluator CLI, not a separately deployed daemon; a separate
  risk service process/queue is NOT built.
- Only global + bucket policy layers are loaded from the DB (`workspace_settings.global_limits`, `buckets.policy`).
  Portfolio/wallet/basket/strategy/order layers are accepted on the intent (`IntentContext.layers`, persisted immutably) but
  there are no DB tables for them yet. Tighten-only is enforced for all of them.
- Bucket-level states (`buckets.state = halt_new_entries/exit_only/disabled`): the risk gate vetoes entries, but `reserve_capital`
  (0002) refuses ANY reservation in a non-active bucket, so an exit from a halted *bucket* is blocked in SQL. Global-state exits work
  (tested). Fixing this needs a change to 0002.
- Post-trade states (SETTLING, FINAL, RECONCILED, LEDGER_APPLIED, COMPOUNDING_ELIGIBLE) are not driven by the dispatcher
  (paper has no chain finality); it stops at FILLED/CANCELLED/EXPIRED/FAILED with the reservation settled.
- APPROVAL_WAIT is never entered (no approval policy engine); nonce/sequence reservation, gas-floor management and
  cross-chain/bridge flows are out of scope here.
- Expected edge, slippage, gas, failed-tx probability and adverse selection are INPUTS (`MarketSnapshot`); this crate does not
  model or forecast them. The paper market is synthetic (seeded random walk of adds/cancels/aggressors); it has no latency,
  hidden liquidity or market impact feedback, so paper PnL says nothing about real profitability.
- `failed_tx_rate_bps` is supplied by the caller, not computed from history.
