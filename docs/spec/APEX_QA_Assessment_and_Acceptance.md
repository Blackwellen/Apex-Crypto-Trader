# APEX — Architecture QA, Gap Assessment and Release Gates
**Review date:** 13 October 2026  |  **Assessment stage:** Design + interactive dashboard prototype only

## Executive assessment
The APEX specification is implementable as a staged system, but **is not production trading ready**. The highest-risk concerns are accounting over multiple wallets/buckets, cross-chain settlement finality, unknown or duplicate orders, real fee/slippage economics, key custody and incident survival. These are P0 acceptance gates; strategy profitability comes after them. The dashboard prototype is a functional *local demonstration* and not evidence that any wallet integration, exchange or chain execution works live.

## What is already materially strengthened
- Global financial ledger; portfolio -> bucket -> basket/strategy budget -> wallet/chain asset attribution, with genuine physical versus merely logical segregation.
- Multiple public wallets allocated to a single bucket; wallet chain families and multichain balance attribution.
- Per-wallet-chain native gas reserve, signed withdrawal approvals and protected-vault isolation.
- Realized-net-profit compounding policy, multiple target periods, dynamic risk ceilings, high-watermark restrictions and optional cross-bucket allocation.
- Fast deterministic Rust/Python market processes, separate optional LLM intelligence jobs, batch priorities, and no LLM on the hot path.
- Realistic chain adapters for EVM, Solana, Sui, Aptos, TRON, Cosmos/IBC, Bitcoin, TON and NEAR, with independent readiness tests.
- Execution economics including fees, priority tips, failed transaction probability, adverse selection, liquidity depth, maker/taker and round-trip exit costs.
- Explicit transaction and order state machines; no assumed finality; unknown submission => reconcile before retry.
- Dedicated operational dashboards for status, fee costs, jobs, wallet permissions, transfers and emergency safety.

## Acceptance-gate matrix

| Priority | Domain | Required acceptance evidence | Current system status |
|---|---|---|---|
| P0 | Real funds segregation | Wallet/chain/bucket balance conservation with 100 competing spends | NOT IMPLEMENTED |
| P0 | Protected funds | Trading signer demonstrably unable to transfer protected vault assets | NOT IMPLEMENTED |
| P0 | Key custody | No raw key/seed entry, audited KMS/MPC or external signing | NOT IMPLEMENTED |
| P0 | Wallet authority | Scoped transaction/withdrawal policy and audited revocation | NOT IMPLEMENTED |
| P0 | Duplicate trade prevention | Crash/replay test produces one economic fill per intent | NOT IMPLEMENTED |
| P0 | Exchange unknown outcomes | Timeout never retries before authoritative reconciliation | NOT IMPLEMENTED |
| P0 | On-chain finality | Reorg/blockhash/IBC timeout tests, pending funds remain unavailable | NOT IMPLEMENTED |
| P0 | Portfolio risk veto | Parent limits cannot be weakened by strategy or AI | NOT IMPLEMENTED |
| P0 | Emergency stop | Stops new entries; retains settlement and risk-reducing supervision | NOT IMPLEMENTED |
| P0 | Quote economics | Fees/slippage/exit capacity invalidate unprofitable order | NOT IMPLEMENTED |
| P0 | Suspicious token checks | Contract and sell-path simulation reject known scam cases | NOT IMPLEMENTED |
| P0 | Regulated product scope | Allowed UK-accessible spot venue/product checks | NOT IMPLEMENTED |
| P0 | Environment isolation | Paper fills can never affect a real wallet | NOT IMPLEMENTED |
| P1 | Multi-chain registry | Correct IDs/network status and documented execution capability | PROTOTYPE UI ONLY |
| P1 | Native reserve models | EVM/Solana/Sui/Aptos/TRON/Cosmos/Bitcoin fee tests | NOT IMPLEMENTED |
| P1 | Sui coin contention | 100 simultaneous requests can't double spend one object | NOT IMPLEMENTED |
| P1 | Compounding eligibility | No reinvest of unconfirmed/unrealized profits | PROTOTYPE POLICY ONLY |
| P1 | Tax & PnL | Reconcile external contributions and internal transfers | NOT IMPLEMENTED |
| P1 | Regime-sensitive strategies | Out-of-sample costs and drawdown measured | NOT IMPLEMENTED |
| P1 | Data quality | Stale/orderbook sequence gaps lead to closed entry gate | NOT IMPLEMENTED |
| P1 | Provider limits | Rate-limit backoff, reconnect, jitter, redundant provider policy | NOT IMPLEMENTED |
| P1 | AI security | Unverified sources/LLM output cannot submit a trade | DESIGN SPEC ONLY |
| P1 | Cross-chain bridging | Message/packet finality plus asset identity verified | NOT IMPLEMENTED |
| P1 | Secrets and RLS | SAST, secret scanning, cross-owner negative access tests | NOT IMPLEMENTED |
| P2 | Dashboard keyboard operation | Accessible nav, controls, clear inactive states | LOCAL TEST PASS |
| P2 | Dashboard responsive screens | 390, 768, 1280, 1440 px browser render | LOCAL TEST PASS |
| P2 | Watch-only wallet adding | Validate EVM public address and register with bucket | LOCAL TEST PASS (DEMO) |
| P2 | Demo compounding policy | Reject invalid waterfall, persist approved demo settings | LOCAL INTERACTION TESTED |
| P2 | Paper controls | Start/stop simulation, synthetic trade, emergency stop | LOCAL TEST PASS (DEMO) |

## Hard release gates
A production-live flag is prohibited unless all P0 items pass with recorded evidence; every execution-capable chain/venue has its own signed-off certification; wallet signer scopes are approved; a separate independent security review is complete; paper/replay models show no balance integrity issues; an incident runbook exists; and the user has opted in to real-money execution. No automated test can guarantee absence of losses.

## Actual prototype test evidence
- Vanilla JS parsed successfully with Node.js.
- Browser interaction automated with Chromium + Playwright: wallet added, bucket assignment, target policy updated, paper simulation started, a synthetic trade logged, emergency stop pressed. **No JavaScript errors.**
- Responsive navigation and compounding/chain screens checked at 390/768/1280 pixels, plus 1440 desktop screenshot.
- Optional EVM/Solana browser-provider public-account authorisation added but **not verified against a genuine installed wallet extension**. No signing or trading implemented.
- HTML operates as a self-contained demonstrator and can save demo state to browser local storage when supported. This storage must NOT be used for production custody or authoritative portfolio state.

## Recommended product-building order
1. Implement owner isolation and authoritative transactional treasury ledger.
2. Build verified read-only chain/exchange adapters and wallet onboarding with scoped provider authorisation.
3. Implement paper execution, strategy API, independent risk engine and compounding policies against the same ledger.
4. Build production UI around actual API statuses. Do not present disabled adapters as live.
5. Validate security, scenarios and financial accounting independently.
6. Enable explicitly authorised, narrowly scoped real-money spot trading only after separate chain/venue certification.
7. Test advanced HFT and cross-chain strategies only when net performance and operational safety are measured.

**Bottom line:** The architecture is significantly richer, and the UI prototype has been browser tested. The trading backend, wallets, integrations and profitability have **not** been built or certified. The separate 560-line Claude Code prompt is the implementation and QA contract for doing that properly.
