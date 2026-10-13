# Go-live checklist — CURRENT RECOMMENDATION: **DO NOT GO LIVE**
Live execution is disabled by database constraint until every row below is PASS with evidence (commit SHA + artefact) and the workspace owner opts in and an operator sets the live flag. A passing checklist is necessary, not sufficient: no test can guarantee absence of losses.

| Gate key | Requirement | Status |
|---|---|---|
| ledger_conservation | 100 competing spends conserve balances | Evidence exists for paper ledger (db + http concurrency tests) — **not signed off** (no live adapter) |
| protected_vault | Trading signer cannot move vault funds | DB-level proven; **signer does not exist** → NOT_RUN |
| key_custody | KMS/MPC/external signing audited | NOT BUILT |
| wallet_authority | Scoped policy + audited revocation | Partial (watch-only) |
| duplicate_trade_prevention | Crash/replay → one economic fill | Paper DB-level tested; venue-level NOT_RUN |
| exchange_unknown_outcomes | Timeout → reconcile before retry | State machine + reconciler unit-tested; real venue NOT_RUN |
| onchain_finality | Reorg/blockhash/IBC tests | Simulated only |
| portfolio_risk_veto | Parent limits cannot be weakened | DB-level tested |
| emergency_stop | Entries stop, settlement continues | DB-level + e2e tested (paper) |
| quote_economics | Net-of-cost rejection | Rust/Python unit-tested; no live quotes |
| suspicious_token_checks | Scam/sell-path rejection | Rule-level only |
| regulated_product_scope | UK spot venue/product check | UNVERIFIED (human) |
| environment_isolation | Paper never affects real wallet | DB-level tested |
| external_security_review | Independent review | NOT_RUN |
| incident_runbook | Drilled runbook | Draft only |
| venue_chain_certification | Per chain/venue sign-off | NONE certified |
