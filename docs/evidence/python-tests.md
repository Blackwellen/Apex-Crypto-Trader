# Python researcher service: test evidence

Service: `services/researcher` (Python 3.13.16). Base commit when run: `58b402c` (working tree; nothing committed by this work).
Environment: Linux, PostgreSQL 16.15 at `localhost:54329` (trust auth), outbound HTTPS through the agent proxy.
Pinned deps (`.venv`): numpy 2.5.4, polars 2.0.0, pandas 3.0.6 (test/optional), pyarrow 26.0.0 (parquet), pytest 9.1.1, hypothesis 6.169.0, fastapi 0.143.0, uvicorn 0.54.0, psycopg[binary] 3.3.6, httpx 0.28.1, jsonschema 4.26.0.

Status vocabulary: PASS / FAIL / BLOCKED / NOT RUN. Nothing below is hidden or excluded.

## 1. Commands and real results

```
cd services/researcher
python3 -m venv .venv && .venv/bin/pip install numpy polars pandas pytest hypothesis fastapi uvicorn "psycopg[binary]" httpx pyarrow jsonschema && .venv/bin/pip install -e . --no-deps
.venv/bin/python -m pytest -v --durations=5 -p no:cacheprovider --hypothesis-show-statistics
```

### Run A (2026-10-13T19:3x, first full run): 100 passed, **2 FAILED**
Failures: `tests/test_compounding_pg.py::test_insufficient_available_balance_matches_sql` and
`::test_sql_rejects_unreconciled_profit_python_has_no_such_state`. Cause: `packages/db/migrate.sh` exited 3 while building the fresh DB,
because other workers were editing `packages/db/migrations/*.sql` at that moment (the main property test had used a DB built a few
seconds earlier and passed). It was an environment race, not a logic failure. A direct `migrate.sh` run seconds later exited 0 with all
21 migrations applied. I then added a 3x retry-on-clean-DB to `tests/pgworld.py` (it does not hide failures: after 3 tries it raises).

### Run B (final): started 2026-10-13T19:40:54Z, finished 2026-10-13T19:41:40Z
```
======================= 102 passed, 1 warning in 44.86s ========================
```
0 failed, 0 skipped, 0 blocked in this run (the network test ran because Coinbase public candles were reachable; it self-skips as BLOCKED otherwise).
The 1 warning is a Starlette deprecation notice about `httpx` in `TestClient` (cosmetic).

| file | tests | what it covers |
|---|---|---|
| test_no_lookahead_engine.py | 15 | injected lookahead features (future close, whole-sample normalisation, centred window) are detected; engine refuses to run a leaky strategy; validation cannot be disabled; every library strategy's features are causal; signal at close t fills at OPEN t+1; strategies see read-only prefix views; data after `end` cannot influence results |
| test_costs_accounting.py | 11 | integer-only money; accounting identity + non-negative cash (hypothesis, CEX and DEX); failed tx burns gas and never fills; cost monotonicity; gas spike; round-trip estimate; participation cap partial fills; zero-volume no fill; cost gate; buy/sell basis conservation (hypothesis); delisting write-off and survivors-only bias |
| test_netting_regime.py | 10 | opposing signals net to zero and trade nothing; agreeing signals do not stack past the cap; partial cancellation exact; risk-off multiplier; netting invariants (hypothesis); regime classifier causal + deterministic + labels constructed segments; grid regime gating; 7 strategies each have research and paper versions; all run end-to-end with zero sleeve errors |
| test_data_validation_report.py | 15 | synthetic determinism, fat tails, regimes, rugs; survivors-only declaration; CSV and parquet loader round trip (small GENERATED file); loader refuses missing provenance/survivorship; bad files; early-ending series treated as delisted; fold structure + embargo; walk-forward selects on train only; bootstrap CI behaviour and widening on short samples; noise has no significant edge (PSR/DSR); stress ordering; report refuses undeclared survivorship; report labelled SYNTHETIC and flags survivorship |
| test_compounding.py | 9 | SQL-mirror unit checks, hand-computed example, deficit-first, min ticket, error cases, policy CHECK mirror, parts-sum property (hypothesis), target tracking vs forecast separation, forecast withheld for synthetic/unvalidated data |
| test_compounding_pg.py | 3 | **bit-for-bit cross-validation against the real Postgres `apply_waterfall`** (see 2); insufficient-available error parity; SQL-only RECONCILED gate |
| test_token_safety.py | 16 | honeypot, mint authority (EVM + Solana), freeze authority, Token-2022 delegate/hook/fee, proxy, concentrated holders, sybil, fake/short/partial/deployer-controlled LP lock, serial rugger, low liquidity, fail-closed unknowns, stale findings, vendor scores additive-only, two-stage admission, determinism, hazard monotonicity (hypothesis) |
| test_llm_plane.py | 13 | Disabled default; Kimi/OpenAI-compatible provider OFF without env keys; injection detection + redaction; execution-like schemas refused; static check that llm.py imports no execution/DB code. **Tests marked `protocol` (7) use a FAKE local HTTP server and prove only our client/validation behaviour, not any real model.** |
| test_api.py | 9 | /health; no execution/sign/withdraw routes exist; /backtests labelled SYNTHETIC with uncertainty + survivorship; request validation; DB-less workspace request reported (not silently dropped); /compounding/simulate separation; bad policy 422; /token-safety rejects mint authority; **/backtests records into the real `simulation_runs` table in a fresh Postgres** (404 for unknown workspace, 422 for bad UUID) |
| test_public_data.py | 1 | real public candles fetch (BTC-USD, ETH-USD); labelled REAL_PUBLIC_API and survivorship-biased |

## 2. Compounding cross-validation against Postgres (bit-for-bit)

* A fresh database is created per module (`apex_py_xxxxxx`): `infra/local/auth_shim.sql`, then `packages/db/migrate.sh` (all migrations present at run time), then a paper world seeded through the same API functions as `packages/db/tests/helpers.mjs`.
* Each hypothesis example inserts a RECONCILED intent, a `profit_eligibility_events` row, a `compounding_policies` row (random bps split summing to 10000, random tax bps, random `min_ticket` up to 1e20) and a `bucket_deficits` row (up to 1e22), calls the real `apply_waterfall`, and compares `gross, deficit_recovered, eligible, tax_provision, to_reinvest, to_vault, to_cross, to_reserve`, the resulting deficit, and the `restricted` / `fee_reserve` ledger balances with `researcher.compounding.apply_waterfall`. Error cases must raise the same message. A second call must return the same execution (idempotency). Every example is rolled back.
* 150 passing examples, 0 failing, 6 discarded as invalid by hypothesis, PASS. Outcome mix reported by hypothesis (percentages over 156 generated cases): 42.95% distributed, 12.82% nothing eligible (below min ticket / absorbed by deficit), 40.38% `no net realised profit to distribute`.
* Mirror is pinned to the CURRENT migration text (`div()` truncating integer split, remainder to reinvest). While I worked, `0004_compounding_ops.sql` was modified by someone else (my first read showed `/` numeric division; the file now uses `div(...)`). If it drifts again this test fails, which is its purpose.
* Boundary stated honestly: the RECONCILED-state gate and the ledger posting live only in SQL; the Python simulator takes already-eligible profit. `test_sql_rejects_unreconciled...` documents that.

## 3. No-lookahead evidence

* Mechanism: before every run the engine calls `validate_feature_fn` on the market-regime function and on each sleeve's feature function. At 8 sampled bars it checks that the value computed on the full data equals the value computed (a) on data truncated at that bar and (b) on data whose future bars are replaced by random garbage. Strategies only ever receive read-only prefix views `features[:t+1]`; orders decided at close t fill at the open of t+1.
* Test with teeth (mutation check, run 2026-10-13T19:3xZ): with the validator active the leaky strategy raises `LookaheadError: LOOKAHEAD detected in feature 'tomorrow' at bar 50 (truncation)`; with `validate_feature_fn` monkey-patched to a no-op the same strategy ran and produced 6 trades. So `test_engine_refuses_to_run_a_leaky_strategy` fails if the guard is removed.
* Limits (not a proof): detection is by sampled checkpoints; a feature that leaks only at unsampled bars, or a signal function that closes over the full panel by capturing it from outside, is not caught by this check. Strategies in the library do not do this.

## 4. Public data probe (no keys), recorded by `scripts/probe_public_data.py`

| endpoint | UTC | result |
|---|---|---|
| Coinbase Exchange `/products/BTC-USD/candles` | 2026-10-13T19:37:54Z | WORKED (HTTP 200, 21,178 bytes) |
| Kraken `/0/public/OHLC` | 2026-10-13T19:37:55Z | WORKED (HTTP 200) |
| `api.binance.com` klines | 2026-10-13T19:37:55Z | BLOCKED/REFUSED (HTTP 451, region restriction) |
| `data-api.binance.vision` klines | 2026-10-13T19:37:55Z | WORKED (HTTP 200) |
| CoinGecko ping | 2026-10-13T19:37:57Z | WORKED (HTTP 200) |

`researcher.data.public.fetch_public_dataset` (Coinbase only) pulled 3 x 1500 hourly bars; `scripts/real_public_smoke.py` output is in
`docs/evidence/python-real-public-smoke-REAL_PUBLIC_API.md`. It is labelled REAL_PUBLIC_API, survivors-only (currently listed majors, so the survivorship bias flag is raised), about 62 days of data, and is a plumbing smoke test, not evidence of edge. It shows what the report does on real data: negative point Sharpe with a bootstrap interval that straddles zero.

## 5. Sample report

`docs/evidence/python-sample-backtest-report-SYNTHETIC.md` (seed 7, 4000 hourly bars, 7 strategies netted, walk-forward 4 folds, frozen holdout, bootstrap CIs, stress Monte Carlo, survivorship demonstration). Reproduce: `.venv/bin/python scripts/make_sample_report.py <out.md>` (about 25 s). Every number in it is SYNTHETIC; the strategies lose money after costs on this fixture and nothing was tuned.

## 6. Requirement map and what is NOT done

Done and tested: items 1 to 8 of the brief as scoped below.

Not done / limits (honest list):
* **Strategies**: implemented the 7 requested (trend/momentum, mean reversion, breakout/vol, statistical pairs, grid/range, BTC/ETH/SOL rotation, risk-off overlay). NOT implemented from spec section 5: scalping/order-book imbalance, maker inventory/queue modelling, CEX-CEX and DEX-DEX arbitrage, cross-chain monitor, launch/graduation/bonding-curve research, smart-wallet clusters, news/sentiment strategies, capital optimiser. Pairs is long-only relative value (spot cannot short).
* **No HFT claim**: the engine uses bar data; there is no order-book ingest, queue simulation, latency histogram, or wire-to-fill measurement (finding 21). Slippage is a stylised linear-depth model on bar volume, not recorded books.
* **No evidence of edge anywhere**: synthetic results are meaningless for edge; the one real-data run is short, survivors-only, and negative. Paper-stage definitions exist, but `deployment_blockers` (synthetic evidence never promotes) is a library function and is not yet wired into any API route or DB gate.
* **Walk-forward/CI caveats**: bootstrap intervals assume within-sample stationarity; hourly Sharpe annualisation is noisy on short windows; deflated Sharpe uses `sr_variance_across_trials=0` (no cross-trial variance estimate) so it is only indicative.
* **Token safety** consumes structured findings only; nothing here produces them (no RPC reads, simulation, locker verification, or GoPlus/RugCheck adapters). Thresholds are defaults, not calibrated. Sui/Aptos/Tron findings are not modelled (EVM + Solana only).
* **LLM plane**: Kimi/OpenAI-compatible HTTP provider has NEVER been run against a real endpoint (no keys); only the fake-server protocol tests exist. Only a news-summary schema is defined; image classification, multilingual handling and TTL cache storage are not built. Injection detection is regex-based and will not catch all attacks; the real defences are the data-only lane (no tools, no execution access, strict schema, `not_a_signal`).
* **API**: synchronous, small jobs only (<=20,000 bars); no job queue, no authentication (internal service, must sit behind the API gateway/network policy), synthetic data only for `/backtests` (real data goes through the library loader). `simulation_runs` rows are written with the connection role in `DATABASE_URL`, which must be the privileged service role.
* **Migrations**: no schema change was needed, so no `0160_*.sql` file was added.
* The `qa_evidence` table was not written to; this file is the evidence record.
