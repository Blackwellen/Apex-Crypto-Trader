# APEX — MASTER CLAUDE CODE BUILD PROMPT
**Version:** 2026-10-13 | **Scope:** Complete multi-chain, multi-wallet, multi-strategy, risk-governed crypto trading operating system | **Mode:** Research and paper execution first, production gated | **Primary deployment:** Private, self-directed UK-user spot trading; do not assume permission to manage outside funds

---

## 0. SYSTEM ROLE AND EXECUTION MANDATE

You are the principal architect, quantitative trading engineer, high-performance Rust developer, multi-chain protocol engineer, senior Next.js product designer, Supabase/PostgreSQL security engineer, SRE, red-team reviewer, and technical QA director for **APEX**. Your assignment is to inspect the actual repository, design and implement the complete end-to-end system below, test what you build, report unresolved dependencies honestly, and leave a usable running product with evidence. **Do not pretend an exchange, chain, wallet, order, simulated result, security review, audit, or test is live or passed when it is not.**

The user specifically requires: (a) intelligent compounding and target tracking; (b) true segregated portfolios, buckets, baskets and many wallets per bucket; (c) multiple strategies running simultaneously across multiple chains; (d) meme-token intelligence and graduated-token strategies; (e) fast execution and high-frequency research, with actual cost and latency modelling; (f) gas/priority fee reserve management, liquidity and security checks; (g) world-class premium UI with functional controls; (h) durable, reliable reconciliation and admin controls; and (i) strong QA and pen-test readiness.

### Non-negotiable product requirements
1. Build one integrated platform, **not** disconnected scripts with fictional dashboard data.
2. Integrate front-end controls with real backend configuration, read endpoints, audit and safety policies. Demo/paper data must be visually and technically isolated from live balances.
3. Use **Rust for latency-critical, deterministic execution**, Python for research, statistical modelling, backtests, AI preprocessing and batch intelligence, and TypeScript/Next.js for product UI/control plane. Language selection alone does not make a strategy profitable.
4. LLMs, including optional Kimi K3 or alternatives, are **off the trading hot path**. No LLM decides or sends a live trade autonomously without deterministic precommitted constraints. The risk layer is immutable to LLM outputs.
5. Live trading is **disabled by default**. Production order placement is only possible after provider credentials, user authorization, explicit account scope, exchange/chain readiness, risk policy acknowledgement and end-to-end QA gates. Never flip a feature flag or bypass a failure to obtain a green check.
6. No wallet seed phrase, raw private key, signer secret or unrestricted API key may be pasted into a UI field, logged, transmitted to an LLM or stored unencrypted in application tables. Integrate delegated/KMS/MPC or external-wallet providers, and restrict hot-wallet exposure.
7. Build all major chain **families** from day one as separately implemented adapters with a capability registry. Specific chains are configured and independently certified. An unsupported action must fail closed, **not** silently take a route on a different chain.
8. Avoid market manipulation, coordinated pumps, wash trading, sandwiching unsuspecting users or manipulative spoof orders. Limit MEV to defensive routing, legitimate price discrepancy execution and user-protective execution.
9. No synthetic profit promises, guaranteed compounding, forced trades to catch targets, uncontrolled doubling down, martingale, or unrestricted leverage. The initial jurisdiction policy is spot-only. Unsupported regulated derivatives must not be exposed as actionable.
10. Build in small integration batches, parallelise independent workers and test tasks, but guarantee concurrency correctness around money, signers, nonces, token objects, inventory and pending settlements.

### Repository workflow
- First inspect existing repository, package manager, codebase, settings, migrations, git status, environment templates, tests and runtime. If empty, create monorepo. Do not destructively overwrite code or secrets. Use a feature branch where Git is configured. Read current official SDK docs before selecting package versions, because chain SDKs have changed in 2026.
- Maintain `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md`, `docs/IMPLEMENTATION_LOG.md`, `docs/QA_EVIDENCE.md`, `docs/ADAPTER_MATRIX.md`, `docs/OPEN_RISKS.md`, `docs/OPERATIONAL_RUNBOOK.md` and `docs/GO_LIVE_CHECKLIST.md`.
- Produce explicit acceptance criteria for each service and page. Identify external account credentials, API access, provider plan restrictions, missing on-chain capabilities and UK venue restrictions. Provide setup steps rather than fake completions.
- Do not rely on Vercel or Next.js request handlers to run high-frequency execution or long-running streaming jobs. Deploy workers to dedicated persistent compute with ordered, supervised processes. UI can deploy separately.

---

## 1. REQUIRED DEPLOYABLE MONOREPO

Create or integrate:

```
apps/
  console/                   Next.js App Router, authenticated dashboard
  admin/                     optional privileged ops console or admin routes inside console
services/
  api/                       control plane API, WebSocket/SSE, RBAC, input validation
  ingest/                    streaming subscriptions, dedup, order book, chain events
  signals/                   deterministic strategy runtime and feature calculation
  execution/                 Rust execution router + validated order state machine
  risk/                      independent risk gate, global exposure + kill switch
  treasury/                  authoritative ledger, wallet/bucket budgets, allocations
  settlements/               CEX fill / on-chain finality / bridge reconciliation
  compound/                  profit eligibility, targets, transfers, waterfall
  researcher/                Python backtests, analytics, ML experiments
  intelligence/              optional LLM jobs, news/social/meme/contract investigation
  notifier/                  alerts and escalation
packages/
  contracts/                 typed domain schemas + OpenAPI definitions
  chain-registry/            chain ID, environment, native asset, status, capabilities
  chain-evm/                 EVM adapter and optional rollup overrides
  chain-solana/              Solana adapter
  chain-sui/                 Sui adapter
  chain-aptos/               Aptos adapter
  chain-tron/                TRON adapter
  chain-cosmos/              Cosmos SDK / IBC adapter
  chain-bitcoin/             Bitcoin UTXO transfers and observability
  chain-ton/                 TON adapter
  chain-near/                NEAR adapter
  exchange-adapters/         venue contracts and native/API adapters
  strategy-sdk/              typed strategy interface
  risk-policies/             versioned hard/soft constraints
  db/                        Supabase migrations / generated types
  ui/                        design system, accessible components, charts
  testing/                   simulators, replay feeds, seeded deterministic fixtures
infra/
  docker/                    isolated services and local dev profiles
  observability/             telemetry stack / dashboards
  deployment/                infrastructure-as-code, secrets refs, configs
docs/
```

Recommended technologies: Next.js + TypeScript + Tailwind + shadcn/ui + Framer Motion; Supabase Auth/Postgres/RLS for control data; Rust + Tokio for execution/risk services; Python + Polars/NumPy/PyTorch/scikit-learn for research; NATS JetStream or comparable reliable ordered event bus; Redis for ephemeral cache only; TimescaleDB/ClickHouse for heavy market analytics; S3/R2 for raw data; OpenTelemetry + Prometheus/Grafana; KMS/HSM/MPC for controlled signing; durable task runners with idempotency. Keep the financially authoritative ledger in transactional storage, not Redis.

Use integer token base units, fixed-point Decimal for converted amounts, correct token decimals and deterministic rounding. Never use JavaScript floating-point numbers for monetary ledger state or fee calculations.

---

## 2. FULL CHAIN SUPPORT — NETWORK MATRIX AND CAPABILITY REGISTRY

**Initial registry** (enable monitoring and a chain health view for all configured networks; trading only where the actual adapter tests pass):

- EVM family: Ethereum, Base, Arbitrum One, OP Mainnet, Polygon PoS, BNB Smart Chain, Avalanche C-Chain, Linea, Scroll, zkSync Era, Mantle, Blast. Include configurable extra EVM chains, such as emerging ecosystems, using verified chain IDs and official RPC documentation.
- SVM: Solana mainnet and test/dev configurations.
- Move: Sui and Aptos (separate transaction models; never pretend EVM semantics apply).
- TRON TVM: TRON mainnet/test networks, with bandwidth/Energy model.
- Cosmos: Cosmos Hub/Osmosis plus an extensible Cosmos SDK / IBC configuration and denom resolver.
- UTXO: Bitcoin mainnet/testnet; Bitcoin-native transfer and custody visibility are separate from BTC spot trades on exchanges.
- Additional native families: TON and NEAR (full native adapters if current official SDKs are stable and accessible).
- All applicable major centralised exchanges are *venues*, not chains. Keep a separate venue registry for market data, execution, balances and account restrictions.

Implement a `ChainAdapter` contract with capabilities:
`discoverAssets, subscribeBlocks, subscribeTransactions, subscribePools, getBalances, getAllowances, getTokenMetadata, getFeeQuote, getPriorityFeeQuote, simulate, buildTransaction, signThroughPolicyService, submit, getTransactionStatus, finalityStatus, getLiquidity, buildSwapQuote, swap, transfer, bridgeQuote, bridgeSubmit, nativeReserveRequired, supportsAtomicBundle, supportsPrivateRoute, supportsSponsoredGas, supportsNativeOrderBook`.

Do not declare capabilities supported until exercised. Each registry record includes namespace (eip155, solana, etc.), chain ID, family, mainnet/testnet, native denomination, decimal unit, trusted RPC candidates, finality model, address format, chain explorer, supported DEX protocol set, observed block freshness, quote health, pricing health, signer mode, allowlisted router addresses, permission profile, certification status and error details.

Implement chain-specific protections:
- **EVM:** EIP-1559 fee policies where supported, legacy variants where needed; per chain+signer nonce reservation; receipt/reorg/finality tracking; reverts; simulation; allowance limits; Permit2 exact time/amount limitations; chain-specific fee data (including L2 components); EVM-compatible explorer links; no blind contract calls; no infinite approvals by default.
- **Solana:** base fee + compute unit budget, priority fee, optional Jito tip; v0/v1 transaction differences; account metas and token extensions; blockhash expiry; token-account existence/rent; owner/mint/freeze/permanent delegate; transaction simulation and landing verification; explicit wallet lamports reserve. Protect against misleading Token-2022 transfer semantics.
- **Sui:** object coins, object version locking, owned/shared objects, gas-coin selection, address balances where supported, simulation/effects and sequence concurrency; sponsor support strictly policy-gated; current `@mysten/sui` official APIs.
- **Aptos:** chain ID, sequence number concurrency, Move types, expiration, gas estimation, simulation and reliable status finality.
- **TRON:** TRX balance, Energy, Bandwidth, estimated burn and account status; fee-limit safe bounds; native transfer vs contract calls; current chain parameters queried, not constants assumed.
- **Cosmos / IBC:** chain IDs, denom traces, gas denom and gas price, sequence, memo, channel validation, acknowledgement/timeouts and packet completion; no assumption that an IBC dispatch equals final settlement.
- **Bitcoin:** UTXO management, fee-rate estimates, change outputs, unconfirmed change, RBF/CPFP where appropriate, BTC confirmation depths. Do not implement ERC-20 swaps on Bitcoin or present Bitcoin UTXO transfer as an AMM trade.
- **TON / NEAR:** implement native message/nonce/finality/gas models, signing adapters and wallet/address validation; if current reliable SDK functionality is missing, expose read-only capability and mark execution uncertified, with a documented blocker.

Each chain has separate health (RPC, WebSocket, indexing lag, alternate RPC failover, quote age, provider rate limit, token metadata, gas source, mempool/MEV route where applicable). Provider outage must trip scoped pause and never allow stale prices to pass.

**Source-specific implementation reminders:** Solana priority charges are based on requested CUs for legacy/v0; v1 differs. Jito bundles are atomic within supported conditions and may fail to land. Sui transaction gas/coin object contention differs from EVM nonces. TRON has Energy/Bandwidth instead of plain EVM gas. Uniswap's router and Permit2 deployment addresses are chain/version-specific; never hardcode one cross-chain address.

---

## 3. SEGREGATED PORTFOLIOS / BUCKETS / BASKETS / WALLET MAP

This is the primary product differentiator. Support:

`Owner / Workspace -> Master Treasury -> Portfolio -> Bucket -> Basket / Strategy Budget -> WalletAllocations -> Wallet + Chain + Asset -> Position/Lot`.

An owner can create multiple separate portfolios (e.g. Core, Quant, Meme, Emerging, Arb, Reserves). Each portfolio contains many nested accounting buckets. A bucket contains multiple wallet assignments spanning chains and CEX subaccounts. One wallet can hold many assets and optionally serve several **virtual accounting** buckets. User must be clearly shown if separation is:

1. **Physical/on-chain:** a wallet/address or CEX subaccount belongs exclusively to one bucket; preferred for risk isolation.
2. **Logical:** a wallet is shared between buckets, with explicit allocation and ownership ledger; no claim of wallet-level security segregation. Lock amounts atomically; no overspending.
3. **Protected/cold:** capital cannot be made tradeable without a separate authenticated approval, withdrawal delay or safe workflow.

Each bucket config: type, base reporting currency GBP/USD, eligible chains/venues, allowlisted strategies, eligible asset universe, deposit policies, auto-funding toggle, stop state, leverage prohibition, position concentration limits, per-asset limits, per-wallet limits, per-chain limits, cross-bucket correlation limits, daily/weekly/monthly loss budgets, maximum drawdown, maximum slippage/gas, fee reserve, tax reserve, expected-value threshold, reinvest ceiling, holding time, trading hours if relevant, smart-wallet signals, maximum active trades, maximum open orders, and emergency controls. Inherit stricter global constraints; child policies cannot weaken parent hard limits.

**Wallet onboarding wizard:**
- Step W-01 Choose connector family: EVM browser/hardware, Solana wallet adapter, Sui wallet, Aptos wallet, TRON wallet, Cosmos wallet, Bitcoin watch-only/hardware, TON/NEAR, or CEX.
- W-02 Choose capability: public address watch-only, user-signed order, scoped managed execution signer, CEX view-only key, CEX trading-only key. No withdrawals for standard trading API keys.
- W-03 Authenticate via supported adapter/provider. Do not request seed phrase. For exchange keys use secret-management integration with server-side encryption or KMS references and enforce least privilege; reject withdrawal-permitted keys where verification is supported.
- W-04 Verify chain/network/address/checksum, identity of returned provider and message/signature scope (only with user consent). For watching a public address, no signature required. Anti-phishing domain/chain checks.
- W-05 Assign to portfolio/bucket(s); default exclusive; virtual sharing requires explicit acknowledgement. Set maximum tradable allocation, allowed tokens, daily spend, gas reserve, transfer and approval permissions.
- W-06 Run non-spending read-only balance verification. Optional permitted test transaction is separate, user-authorized, clearly costed.
- W-07 Show wallet health, allowances, token accounts, expiry/renewal, connected chains and CEX subaccount. Confirm and audit.

Add wallet lifecycle: reconnect, rotate, revoke, archive, move bucket (with reservation clearing and reconciliation), pause, watch-only downgrade, privilege review, allowance revoke where supported, address allowlists, withdrawal delays, gas top-up policies, signer attestation, signer status and hardware/MPC policy. Wallets must never auto-create from predictable/low-entropy secrets.

**Wallets per bucket:** unlimited in schema within operational quotas. Add wallet list and cards with current chain, asset inventory, on-chain balance, logical free balance, reserved for orders, unavailable pending settlement, gas reserve, realised/unrealised PnL, allocated strategies, permissions, warnings. A wallet can have multiple network instances: EVM address on Base versus Ethereum is the **same address string, different chain balances**. Correctly canonicalise token identifiers by chain+contract/mint+token programme/version, not ticker text.

**Capital ledger invariants (property tested):**
- `accounted_cash = available + reserved_for_orders + pending_out + fee_reserve + pending_bridge + restricted` for each wallet/account/asset scope, with explicit double-entry contra accounts where relevant.
- `sum(assigned_bucket_exposure) <= reconciled_spendable_wallet_holdings` for logically shared accounts.
- A single confirmed fill never credits more than one owned bucket unless properly split by predeclared allocation fractions and balanced entries.
- In-flight transfer source funds are reserved, not available; destination does not credit available until validated finality.
- Treasury profit vault funds never count as eligible trading capital.
- No wallet selection may bypass a parent risk limit or fee reserve.
- Cross-currency reporting must use marked exchange rates; reporting FX cannot create actual spendable coins.

Treat external deposits/withdrawals separately from trading profit; do not contaminate performance with cash contributions. Deduplicate internal transfers from portfolio totals.

---

## 4. COMPOUNDING TARGETS AND FINANCIAL GOVERNOR

Build an explicit `CompoundingPolicy` per portfolio, bucket, basket and optionally strategy, with override inheritance only where within stronger parent rules.

**Supported modes:**
- Fixed-size/linear reinvestment (fixed cash increment per qualifying cycle).
- Proportional/geometric compounding subject to scaling caps.
- Cross-strategy/cross-bucket waterfall.
- Basket-weighted reallocation and rebalancing.
- Target-volatility sizing; volatility-aware exposure.
- Anti-martingale scaling (only from validated net profits, capped and subject to drawdown limits).
- Defensive decompounding after drawdown.
- Stair-step exposure increases after high-watermark milestones.
- Compounding pause after net target achieved, *optional* user policy; never forced opening to achieve target.

Track user-defined targets by absolute amount and/or percentage, per day/week/month/quarter/year, with base currency, start equity, contribution-adjusted performance (time-/money-weighted), cumulative net realized, estimated unrealized, fees, target progress, fee burden, risk budget, max drawdown and minimum required liquidity. Visually separate target from statistical forecast. Show realistic Monte Carlo outcome ranges only when validated to actual strategy empirical distributions; clear disclaimers and confidence assumptions.

**Waterfall after a trade closes and is reconciled:**
1. Settle direct order fees, gas/priority/bundle tips, bridge costs, third-party data costs attributable by policy, protocol fees, token transfer taxes and partial-fill amounts.
2. Account for open loss reserve/portfolio obligations, pending reimbursements and balance discrepancies; recover deficit before distributing profit.
3. Calculate **eligible net realised profit**, excluding transfers, unrealised gains, inaccessible assets and provisionally/unreliably priced tokens.
4. Calculate tax provision per user settings (accounting provision, not automatic tax advice or an actual tax payment).
5. Respect minimum wallet/chain gas reserves, target protected reserve, maximum tradeable allowance and cash buffer.
6. Distribute according to waterfall, e.g. reinvest 40%, protected vault 35%, cross-bucket allocations 15%, fees/tax reserve 10%; percentages across *eligible* amount total 100. Cross-bucket transfer must be a genuine authorized ledger movement plus real transfer if wallets differ.
7. If a transfer requires actual chain/exchange settlement, stage as PENDING; do not make destination budget available early.
8. Update performance snapshots and high-watermarks once, idempotently; do not compound an unconfirmed transaction twice.

Support minimum ticket, minimum expected edge, maximum redeployment rate, cool-off periods, cap size relative to liquidity, time-zone policy, accounting period close, reserve expiry and schedules. When no edge is present, do nothing. A loss does not create a mandatory win-back target. Debt-financed position escalations and martingale forbidden.

**Worked validation:** A profit allocation from Meme to Core while Meme trade settlement remains pending must be rejected. Same-wallet logical transfer must update both ledger accounts atomically; cross-wallet physical transfer must have intent/approval, pending state, chain submit, finality, confirm and then credit. If transfer fails, source reservation must be reconciled rather than independently recreated.

---

## 5. STRATEGY ENGINE AND MARKET REGIME CONTROL

Create a versioned `StrategyDefinition` plugin API including name/version, market eligibility, feature requirements, signal schema, entry/exit conditions, expected opportunity horizon, quote lifetime, confidence calibration, capital request, anticipated fees, maximum adverse excursion, factor exposure, market-regime eligibility, allowed chains/venues, emergency exit capability, research evidence, fail policies and safe deployment stage.

Implement research + paper versions of:
1. Liquid CEX trend/momentum.
2. Mean reversion and range regimes.
3. Intraday scalping and order-book imbalance.
4. Breakout, volatility expansion/contraction.
5. Maker inventory and spread capture with queue modelling.
6. Statistical pairs/sector relative value.
7. CEX-CEX arbitrage with pre-funded inventory.
8. DEX-DEX arbitrage only where atomicity/costs actually possible.
9. Cross-chain price divergence monitor, accounting for bridge latency and not claiming instant cross-chain atomicity.
10. Spot rotation BTC/ETH/SOL and sector baskets.
11. New-token launch research.
12. Bonding-curve progress and graduation watcher.
13. Post-graduation liquidity expansion and collapse warning.
14. Smart-wallet cluster studies, not blindly copy-trade.
15. Whale concentration/distribution warnings.
16. News/event-driven research with authenticity checks.
17. Market sentiment/narrative research.
18. Grid/range position-management in valid regimes.
19. Risk-off, drawdown recovery and portfolio hedging with allowed spot instruments only.
20. Risk-adjusted opportunity allocation across strategies.

**DO NOT enable all these as live by default.** Each strategy has explicit audit versions and deterministic regression datasets. Each simulated run records strategy/feature versions and source latency. Competing signals for one asset must net at portfolio level instead of inadvertently stacking risk. Strategy orders go through one Risk/Execution Gateway, never directly through SDK order calls.

**HFT**: Build native order-book ingest, sequence-gap recovery, clock synchronisation, colocated or region-aware connector testing, market data staleness budgets, limit-order queue simulation, latency histograms, smart limit orders and inventory-aware market making. Do not claim HFT without measurable exchange-to-signal-to-order latency and fill economics. No fictitious latency SLO or fabricated returns. Assess whether infrastructure cost is justified by statistically demonstrated edge. On-chain fee and inclusion dynamics are generally different from CEX matching-engine HFT.

---

## 6. MEME / GRADUATION / TOKEN SAFETY / SOCIAL INTELLIGENCE

Build complete token lifecycle states: observed mint/contract -> launchpad creation -> active bonding curve -> nearing graduation -> migrated/pool initialised -> early DEX discovery -> mature DEX -> CEX listing -> dormant/compromised/delisted. Launchpad-specific integrations are versioned and verified, including a Pump.fun/PumpSwap adapter for Solana and other supported launchpads with real, current semantics.

Discovery inputs: authenticated streaming on-chain events, on-chain pool creation, trusted DEX indexing, website/social discoveries, genuine transaction flow, capital migration, holder changes, contract deployer history and official exchange listings. Deduplicate token identifiers and avoid confusing same-symbol imitators.

Independent vetoable modules:
- EVM ownership, proxy upgrades, privileged mint, transfer blacklist, pausing, sell restriction, taxes, misleading router integrations, dangerous allowances, unsupported hooks.
- Solana token programme/Token-2022, freeze/mint/permanent delegate/transfer fee/transfer hook and account restrictions.
- EVM/Solana/Sui/Aptos chain-specific simulation for representative buy and sell sizes; failed or unrealistic exit => reject.
- Liquidity concentration, effective exit depth, LP ownership, locker claims verification, whale exits and withdrawal notices.
- Holder concentration clusters, sybil-funded wallets, wash trading, repeated rug-deployer patterns, false volume and suspicious smart-money labels.
- Narrative features: organic spread, diverse sources, meme image recognition, duplicate asset branding, coordinated posting, source timestamp, spoofed announcements, bot patterns and content language; distinguish popular meme from trading edge.
- Realised smart-wallet performance only where cost basis / account activity is sufficiently observable. Mark confidence separately from score.
- Require two-stage filters: universal security gate and individual strategy quantitative admission.

Security/market data vendor inputs (GoPlus/RugCheck/DEX Screener etc.) are additional evidence only; vendor score does not override native token checks. Request limits, outages and age must be observed. Quote expiry and buying tax/selling tax estimates must be included in net economics. No mass-buying of every newly launched coin, no coordinated manipulation.

---

## 7. VENUES, AGGREGATORS, ROUTING, GAS AND MEV

Centralised exchange adapters: structured `VenueAdapter` for Coinbase Advanced Trade and other UK-available, compliant spot venues; additional providers configurable after documented availability. Support read-only, user trade scope, disabled withdrawal scope, market metadata, filter/min lot increments, tick sizes, rate limits, user data/market data channels, order book snapshots/deltas, time synchronisation, balances, order create/cancel/replace, partial fills, trade fills, reconnect/sync, fee tiers, status and incident handling. Never imply a venue is available to a UK retail user until checked. Central venue names are examples, not blanket availability claims.

DEX routing: Jupiter for Solana where permitted; chain-verified Uniswap-compatible routes, aggregators and other protocol-specific adapters. Verify router address, spender, swap mode, token decimals, slippage, quote age, price impact, pool state, referral/protocol fees, transaction validity, expected output and post-swap balance. On ERC-20, use scoped amounts and expirations, not blanket perpetual token approvals. Prefer router/vendor APIs with authentic, current documentation.

Fee engine computes:
- Venue maker/taker and tier fees.
- AMM pool, protocol and routing fees.
- Chain base gas and execution gas / rollup settlement where applicable.
- Solana compute price, Jito tip (bounded), rent/account creation.
- EVM priority fee and provider-specific L2 components.
- Sui/Aptos chain-specific gas, TRON Energy/Bandwidth, Bitcoin feerate/UTXOs, Cosmos gas denoms.
- Bridge quote and potential late price changes.
- Price impact, expected slippage, adverse selection, taxes and failed transaction loss risk.

Quote-based execution must calculate net expected value after **round trip**, not merely entry cost. Choose public, private or bundle path based on safety, actual support, fee economics and observed landing rates. Protect user order flow; no user-harming sandwich/extraction tactics. Transaction timeout and unknown status require reconciliation before retrying; duplicate broadcasts may have unique tx hashes but the same economic intent.

Gas management: per `wallet × chain × native_asset` floor, estimated next N transactions + emergency exit allowance, target top-up, reserve replenishment schedule, budget cap, priority/tip cap and alerts. A wallet must not spend its final usable native currency such that it cannot exit. Auto top-ups and fee sponsorship require bounded, authorised transfer policies.

---

## 8. TRADE INTENT, RISK AND ORDER STATE MACHINE

Enforce stages:

`SIGNAL -> CANDIDATE -> RISK_EVALUATING -> ADMITTED -> CAPITAL_RESERVED -> QUOTED -> PREPARED -> APPROVAL_WAIT (if policy) -> SUBMITTING -> ACKNOWLEDGED / UNKNOWN -> PARTIALLY_FILLED -> FILLED / CANCELLED / EXPIRED / FAILED -> SETTLING -> FINAL / REORGED / DISPUTED -> RECONCILED -> LEDGER_APPLIED -> COMPOUNDING_ELIGIBLE`.

Every transition is typed, transactional, event-logged and repeatable. No order considered filled because API create-order succeeded. No chain transaction considered final merely because broadcaster returned a hash. Every economic intent has an idempotency key, deterministic owner, wallet chain nonce/sequence reservation and strategy budget reservation. Market risk checks need fresh relevant data; risk/fee/chain/ML services degraded => deny new entries and preserve exit supervisor where possible.

Risk policy hierarchy: global > portfolio > bucket > wallet > basket > strategy > individual order. Include max drawdown, realised and estimated loss, daily risk, position size, sector/factor concentration, wallet account exposure, max failed transaction rate, quote age, API health, liquidity exit budget, token blacklist/allowlist, spoof/manipulation risks, fee maximum, cross-chain settlement, maker inventory, net gamma/delta where applicable, unknown pending orders, permission constraints and mandatory cooldown. Hard veto cannot be relaxed through UI without reauthorization/version and audit.

Emergency controls: GLOBAL HALT_NEW_ENTRIES, EXIT_ONLY, CANCEL_SAFE_ORDERS, REDUCE_POSITION, DISABLE_WALLET, DISABLE_CHAIN, DISABLE_STRATEGY, DISABLE_VENUE, ALL_NONESSENTIAL_PAUSE, MANUAL_ESCALATION. Kill switch must maintain settlement watchers and emergency risk-reduction capacity; never equate `kill -9` to safely closing positions.

If order placement times out, status is UNKNOWN until reconciliation. Do not submit second order to “fix” an unknown first order. Implement deterministic state recovery after process crash and replay after message loss. Test at-least-once deliveries, duplicate events, out-of-order fills and chain reorgs.

---

## 9. SIMULTANEOUS BATCH WORK / CONCURRENCY CORRECTNESS

Design distinct worker pools: per-venue market ingest, per-chain ingest, token security scans, social/news jobs, model inference, strategy evaluation, trade proposal, risk admission, execution dispatcher, pending settlement, fee monitoring, treasury reconciliation, profit allocation and notifications. Independent work parallel; **mutating the same capital/signing lane must be serialised/locked**.

Use consumer groups and bounded concurrency with quotas by API key/provider, chain RPC, wallet signer, token pair, request weight and monthly service spending. Backpressure under spikes; prioritise safety/exits and settlement reconciliation above exploratory social or LLM jobs. Redis locks alone are not sufficient for financial correctness; use transactional database constraints/reservations, idempotency and compare-and-swap revisions (or equivalently proven linearizable mechanism).

Examples:
- Two strategies buy different tokens from same wallet concurrently: budget must reserve both atomically and prevent overspend.
- Two EVM orders from same address/chain: nonce allocator must sequence or safely manage replacement; separate chain nonces do not collide.
- Two Solana purchases: account references/blockhash expiry are checked separately; repeated intent cannot create duplicate position.
- Two Sui orders sharing mutable coin objects: serialize object use or select independent objects/balance semantics.
- Partial CEX fill and order replacement: inventory and ledger remain consistent.
- News batch backlog cannot postpone existing position stop checks.

Implement batch queue dashboard: jobs inflight/completed/retried/dead-letter, cost/token usage, provider latency, priority class and manual retry with idempotency.

---

## 10. OPTIONAL LLM / KIMI K3 INTELLIGENCE PLANE

Language model is an optional, switchable **research** connector; no hard dependence. Provide `ModelProvider` interface: Kimi K3 if available, alternative commercial/local LLMs, disabled/offline. Set model/context version, budget per task, timeouts, redaction policy, max concurrent calls, cost accounting, TTL on outputs, prompt-injection protection and required structured schema with validation. Never give LLM access to signing keys, withdrawal credentials, unfiltered wallet secrets, arbitrary command execution, execution endpoints or privileged controls.

Use the model for (a) multilingual news summarization with exact source, publication/observed timestamps, (b) narrative/meme association and image classification, (c) suspicious project research, (d) smart-wallet cluster explanations, (e) incident investigation assistance, (f) operator natural-language questions over already authorised data. Require facts to be independently verified for any market catalyst; unverified social posts are not hard signals.

Rule-based Python/Rust/ML feature engines produce reproducible signal vectors and portfolio optimisations. Use numerical research and calibration for price or volume signals. LLM natural language explanations do not substitute for evidence of actual market edge.

---

## 11. COMPLETE DATA MODEL / SUPABASE RLS

Create typed migrations with **at least** the following conceptual tables (normalise and adjust as needed; do not duplicate materially identical entities):

- Identity/security: `users`, `workspaces`, `memberships`, `roles`, `permissions`, `api_clients`, `sessions`, `mfa_events`, `secrets_references`, `signer_authorizations`, `wallet_connection_sessions`, `audit_events`.
- Treasury: `treasuries`, `portfolios`, `buckets`, `bucket_policy_versions`, `basket_definitions`, `basket_members`, `wallets`, `wallet_chain_accounts`, `wallet_bucket_allocations`, `exchange_connections`, `exchange_subaccounts`, `wallet_authorizations`, `allowance_snapshots`, `native_fee_reserves`, `deposit_intents`, `withdrawal_intents`, `internal_transfers`, `bridge_transfers`, `capital_reservations`, `balance_snapshots`, `valuation_fx_snapshots`.
- Ledger: `ledger_accounts`, `ledger_entries`, `ledger_postings`, `reconciliation_runs`, `reconciliation_discrepancies`, `accounting_periods`, `tax_provisions`, `corporate_actions`, `asset_cost_lots`, `asset_disposals`.
- Trading: `markets`, `instruments`, `chain_assets`, `venue_symbols`, `strategy_definitions`, `strategy_versions`, `strategy_instances`, `strategy_config_versions`, `strategy_capital_budgets`, `strategy_runs`, `market_regimes`, `feature_versions`, `signal_events`, `trade_intents`, `risk_decisions`, `quotes`, `routing_decisions`, `orders`, `order_events`, `partial_fills`, `fills`, `transaction_submissions`, `onchain_receipts`, `settlements`, `positions`, `position_lots`, `position_mark_snapshots`, `exit_conditions`, `emergency_actions`.
- Compounding: `target_plans`, `target_periods`, `high_water_marks`, `profit_eligibility_events`, `waterfall_rules`, `waterfall_executions`, `cross_bucket_allocations`, `capital_reinvestment_events`, `protected_vault_policies`.
- Chains/exchanges: `chain_registry`, `chain_adapter_versions`, `chain_capabilities`, `rpc_endpoints`, `rpc_health_samples`, `venue_registry`, `venue_health_samples`, `provider_rate_limit_windows`, `gas_fee_quotes`, `priority_fee_quotes`, `quote_routes`, `router_allowlists`, `pair_liquidity_snapshots`, `orderbook_snapshots`, `orderbook_deltas`, `stream_offsets`, `block_events`, `token_security_events`.
- Intelligence: `token_lifecycles`, `token_scans`, `holder_clusters`, `wallet_research_profiles`, `security_findings`, `news_sources`, `news_items`, `social_observations`, `narrative_scores`, `model_jobs`, `model_job_versions`, `catalyst_verifications`.
- Operations/QA: `job_batches`, `jobs`, `job_attempts`, `dead_letters`, `alerts`, `alert_rules`, `incident_records`, `health_checks`, `simulation_runs`, `backtest_runs`, `backtest_metrics`, `qa_evidence`, `deployment_gates`, `approval_requests`.

Every table includes stable UUID/ULID, created/update provenance, tenant/workspace scope as appropriate, immutable event semantics where required, operation IDs and schema version. Apply RLS to control-plane data; internal privileged services use minimal tightly scoped database roles and audited APIs, never broad client-side service role keys. Where trading state belongs to a single owner/treasury, enforce it structurally. Use append-only ledger, immutable cost events and safe migrations. Data-retention policy and retention/regulatory review for social inputs.

---

## 12. API DESIGN AND BACKEND COMMANDS

Generate OpenAPI and zod/protobuf compatible contracts for:

`GET /v1/overview`, `/v1/portfolios`, `/v1/buckets`, `/v1/buckets/{id}`, `/v1/wallets`, `/v1/wallets/{id}`, `/v1/chain-registry`, `/v1/chains/{id}/health`, `/v1/strategies`, `/v1/positions`, `/v1/trades`, `/v1/orders`, `/v1/risk`, `/v1/fees`, `/v1/analytics`, `/v1/targets`, `/v1/compounding`, `/v1/allocations`, `/v1/alerts`, `/v1/jobs`, `/v1/audit`.

Validated mutation commands include `createPortfolio`, `createBucket`, `updateBucketPolicy`, `createBasket`, `assignWalletToBucket`, `connectWallet`, `revokeWallet`, `authorizeTradingScope`, `setGasReservePolicy`, `startResearch`, `startPaper`, `pauseNewEntries`, `resumeApproved`, `enterExitOnly`, `emergencyStop`, `setStrategyBudget`, `approveCapitalTransfer`, `requestBridgeTransfer`, `updateCompoundingTarget`, `applyWaterfallPolicy`, `disableChain`, `approveDeploymentGate`.

Sensitive commands require authentication, CSRF protections where applicable, role checks, user confirmation, fresh re-authentication for permission increases and an audit record. HTTP requests need idempotency keys and optimistic concurrency control for policy edits. Real-time UI uses read-only server-streamed state; client-supplied display values are never authoritative ledger updates. API payloads must redact credentials.

---

## 13. WORLD-CLASS NEXT.JS DASHBOARD — SHELL AND PAGES

Use the supplied **APEX_Dashboard_Prototype.html** as a conceptual reference for the clean white premium direction and UI interactions, not as a production security or calculation implementation. Rebuild it using Next.js reusable components, Framer Motion transitions, mature accessibility and typed API data. Replace demo values with authenticated, correctly labelled real backend telemetry or paper-simulation state. Provide a global search header, workspace/portfolio selector, date range, environment indicator, chain health, wallet dropdown, alerts, emergency control and account settings. Sidebar: Command, Markets, Meme Radar, Strategies, Live Orders, Portfolios, Buckets, Wallets, Compounding, Chains, Execution, News, Risk, Research, Operations, Treasury, Settings.

**Page requirements** (all tables filter/sort/search, states loading/empty/error, mobile responsive; each consequential action uses stepper/drawer with reversible preview):

### APEX-001 Command Centre `/dashboard`
Four-level dashboard composition: (A) global equity, realised/unrealised, capital available, protected vault, rolling drawdown, gas budget, strategy performance; (B) equity chart with contribution-adjusted vs raw balances, target overlay and benchmark switch; (C) visual capital buckets stacked allocation, correlated factor exposure and one-click drilldown; (D) active positions, live orders, safety incidents, chains, priority jobs and recent fills. Start/pause/exit-only/emergency controls with role gating and confirmation. Persistent paper vs live banner.

### APEX-002 Market Explorer `/markets`
Tabs All Assets / CEX / DEX / Launches / Graduated / Watchlist. Search symbol+chain+contract+pair; filter venue, native chain, liquidity, market cap, age, quote currency, verified contract, execution cost, buy/sell capacity, token risk, narrative and graduation proximity. Saved filter views. Cards and list/table modes. Show delayed quotes honestly.

### APEX-003 Token Intelligence `/markets/[chain]/[asset]`
Canonical chain+token header, risk/security gate results, DEX pools/order books, liquidity/holder depth, largest wallets, suspicious wallet graph, mint/ownership controls, token lifecycle, recent txs, slippage/size test, estimated round-trip fees, socials/source authenticity, signals and protected trade planner. Display *why* rejected.

### APEX-004 Meme Radar `/meme-radar`
New launches, bonding curve progress, graduation countdown with uncertainty, confirmed migration events, prior developer launch history, liquidity warnings, organic narrative velocity, smart-wallet cluster movement, onchain/LLM discrepancy alerts, potential rug signals, watchlists and structured strategy eligibility. No auto-buy default.

### APEX-005 Strategies `/strategies`
Cards/table of all strategy versions, eligibility, environment, bucket assignment, chain coverage, current risk, win/loss distribution, backtest vs paper vs live metrics, costs, drawdown and evidence. Create/clone/disable with approval.

### APEX-006 Strategy Detail `/strategies/[id]`
Overview / Signals / Execution / Risk / Research / Jobs / Audit; edit independent cap, order type, stop policy, allowed assets, session schedule, fees, model version, deployment stage; strategy status and shadow comparison.

### APEX-007 Live Orders `/trading`
Orders/Positions/Fills tabs, timeline from signal to reconciliation, wallet signer scope, execution venue, fill ratio, expected vs realised slippage, gas/priority bids, blockchain finality, cancel/exit-only controls, paper vs live separation. Dynamic PnL when priced, freeze/stale badges otherwise.

### APEX-008 Portfolios `/portfolios`
Many portfolios with equity, allocation, physical vs logical segregation status, wallet/strategy counts, heatmap and factor correlation; new portfolio wizard.

### APEX-009 Bucket Detail `/portfolios/[portfolio]/buckets/[bucket]`
Overview / Assets / Wallets / Baskets / Allocations / Strategies / Compounding / Limits / Transfers / Audit. Rich capital-flow waterfall, spendable vs reserved vs in-flight balances, protected allocation visibility, chain-specific fee reserve widget and policy actions.

### APEX-010 Wallets `/wallets`
Card/List: chain family, wallet nickname, verified public address, vault type, protection classification, signer status, connected accounts, balances, exposure by bucket, token approvals, gas left, pending tx, allowance/revoke, chain-specific risk warnings and finality. Wallet setup wizard W-01–W-07 with no secret field.

### APEX-011 Wallet Detail `/wallets/[id]`
Balances/Assets/Permissions/Buckets/Activity/Fees/Connections tabs. Multi-chain address rendering; correct network selection; signed-transaction history; watch-only vs managed indicator; active authorization scope, revoke/rotate and pause.

### APEX-012 Baskets `/baskets`
Core accumulation, emerging ecosystem, meme launch, thematic sets, risk protection. Drag target weights, trade permissions, rebalancing preview, factor overlap warning, capacity checks and cross-bucket allocation links.

### APEX-013 Compounding Studio `/compounding`
Global / Portfolio / Bucket / Basket / Strategy tabs. Target graph GBP/% by period; target vs realized vs marked PnL; waterfall editor whose portions sum exactly 100; reinvestment cap; protected profit sweep; cross-compound routes; pending transfers; high-water mark; drawdown decompounding; signed policy versions. Show formula preview and scenario simulator (not a forecast). Scheduled automatic targets are monitoring only.

### APEX-014 Capital Transfer Wizard `/capital/transfers/new`
Step 1 source bucket + wallet/account; Step 2 destination bucket + wallet/account; Step 3 asset/chain/amount; Step 4 fees, availability, bridge route, finality/risks; Step 5 signer approval, idempotency and tracking. Differentiate pure internal ledger assignment from actual token transfer. Never credit destination before finality.

### APEX-015 Chains `/chains`
Chain cards with family, RPC latency, best block age, active connections, native gas health, supported capabilities, research/trading readiness badge, enabled strategies and total exposure. Registry and adapters management, chain enable/disable per policy, verify chain ID.

### APEX-016 Chain Detail `/chains/[chain]`
Nodes / Providers / Fees / Wallets / Markets / Transactions / Incidents / Adapters tabs; visual gas price distribution, stranded wallets, transaction failures, RPC reconciliation and provider fallbacks.

### APEX-017 Execution / MEV `/execution`
CEX/DEX routing view, quote comparator, expected and realized fee waterfall, priority/gas solver, Jito/Flashbots defensive route health, execution latency p50/p95/p99, transactions pending, failed costs, missing exit depth, most expensive strategies and route economics.

### APEX-018 Arbitrage & Dislocations `/arbitrage`
Opportunity scanner with two legs, book depth, wallet inventory on both venues, fees, latency and confidence. “Executable net edge” separated from naive spread. Experimental opportunities never auto route around risk gate.

### APEX-019 News & Intelligence `/intelligence`
Source-verified announcements, news feed, narrative clusters, social authenticity, image/meme classifier, watched wallets, model queue, credits/tokens, human approval and AI-disabled fallback status.

### APEX-020 Risk Command `/risk`
Global Risk / Bucket Risk / Wallet Risk / Chain Risk / Token Risk / Strategy Risk / Incidents. Heatmaps, drawdown with high-water marks, VaR/ES when reliable, correlated risk, daily stop lines, available rescue gas, broken settlement, one-click scoped stop/exit-only. Every current violation explains action and authoritative source.

### APEX-021 Backtesting & Research `/research`
Create backtest wizard, historical window, no-lookahead data guarantees, maker fill/slippage models, train/test segmentation, walk-forward and out-of-sample, monte carlo with stress, simulator replay, comparison and export. Metric uncertainty and survivorship bias always visible.

### APEX-022 Batch Jobs `/operations/jobs`
Queue dashboard with by-service counts, LLM batches, token scans, chain streams, worker locks, retries, error budget, cost usage and throughput. Pause nonessential research jobs without stopping trading safety workers.

### APEX-023 Treasury & Tax `/treasury`
Cash-flow reconciliation, spot cost basis GBP, realized gains, fees by asset, wallet/chain, tax provision, excluded internal transfers, deposit contributions, protected vault balances, export CSV and accountant-ready lot reports. Manual reconciliation exceptions.

### APEX-024 Audit & Incidents `/operations/audit`
Immutable event timelines, all policy changes, wallet connect/revoke, order lifecycle, approvals, kill switch activation, open incidents, root cause, reconciliation state and evidence.

### APEX-025 Settings `/settings`
Workspace/Auth/MFA, permissions, API integrations, chain provider config, model providers/cost budgets, alerts, execution policies, default trading disabled, safe-mode defaults, data retention and export, billing for infrastructure providers, feature flags.

### Wizards/drawers/overlays
- W-01–W-07 Wallet onboarding as above.
- B-01–B-05 Create bucket: classify, set capital, assign wallets, configure strategies/risk/compounding, review.
- C-01–C-05 Compounding policy: target basis, waterfall percentages, timing, destination approval requirements, preview and save.
- S-01–S-06 Strategy onboarding: strategy type, data sources, parameter bounds, risk budget, paper/research validation, deployment approval.
- T-01–T-05 Capital transfer as above.
- R-01–R-04 Risk policy update: diff, exposure impact, conflicts, privileged approval.
- E-01–E-04 Emergency workflow: scope, cancel/exit policy, confirmation, observe settlement continuation.
- Connection drawers, order timeline, token security explanation, model evidence, gas fee explanation, RPC provider diagnostics, incident detail, wallet allocation conflict resolution.

### Visual standards
White/light premium enterprise theme, spacious but information-dense, impeccable typography, small refined component radii, clear neutral/blue data palette, red reserved for actual danger, restrained Framer Motion, responsive breakpoints, fast focus and keyboard navigation, no generic dashboard repetition. Graphs must have accessible summaries, axes/units/time ranges, data provenance, delayed/stale states. Use suspense/loading skeletons; avoid skeleton flashes and unbounded animations on HFT streaming.

---

## 14. NOTIFICATIONS, OPERATIONS, QA AND SECURITY

Alert classes: hard risk veto, wallet reserve low, suspicious token/upgrade, exiting position, pending trade UNKNOWN, bridge overdue, exchange downtime, broken RPC, failed settlement, period drawdown, unauthorized signer attempt, vault access request, profit sweep confirmation, target achieved, target missed (informational only), batch queue backlog, degraded model. Channels: dashboard, optional email/Telegram/push based on user opt-in. Separate notification level from trade priority.

**Security:** independent threat model for signer compromise, malicious smart contracts, shared-wallet logical accounting mistakes, phishing links, quote/price oracle manipulation, LLM prompt injection, MEV leakage, provider takeover, malicious extensions, browser compromise, credential rotation, database privilege escalation, compromised CI dependency, social engineering and API replay. Enforce MFA/re-auth for sensitive operations, CSP/CSRF, RLS tests, rate limiting, signed policies, allowlisted programs/router addresses, scoped transaction policies, private key isolation and incident runbook. Implement no default open redirect into a wallet signing screen.

**QA suites (automate):**
- Schema migration and RLS cross-tenant isolation.
- Property-based conservation of every ledger and bucket assignment.
- Concurrency with 100+ competing budget claims and simulated failures.
- Strategy gate safety with malformed/adversarial signals and stale feed.
- Wallet connection/revocation for each chain family.
- Chain-specific execution simulator and actual testnet/dry-run where supported.
- EVM nonce/replacement and finality/reorg simulation.
- Solana blockhash expiry/Jito non-landing, token-2022 transfer restrictions.
- Sui shared/owned object contention and Coin selection.
- Aptos sequence number and gas revalidation.
- TRON Energy/Bandwidth exhaustion.
- Cosmos IBC acknowledgement/timeouts.
- Bitcoin UTXO selection, insufficient fees, RBF and unconfirmed inputs.
- CEX stream gap, disconnect/reconnect, rate limit 429 backoff, partial fills and unknown order.
- Cross-chain bridge failure, incomplete settlement and route risk.
- Negative execution edge after gas/priority fees and high slippage, including fee spikes.
- Scam contracts and broken sell simulation.
- Strategy portfolio concentration across seemingly independent buckets.
- LLM outage/slow inference while positions still require exits.
- Kill-switch races, risk gate bypass attempts and unauthorized transfers.
- Market data lookahead, survivorship, time alignment and stale spread.
- Paper/live data mixing prevention and UI environment banners.
- Wallet public address validation by family; no seed/private key UI field.
- Pixel/interaction QA on 1440, 1280, 1024, 768, 390px viewports; accessibility WCAG 2.2 AA; reduced motion; keyboard-only, screenreader labels.
- Load/soak/chaos tests, simulated worker crash, DB failover, NATS replay, redundant provider outages.
- Dependency audit, SAST, SCA, secret scanning, DAST within owned permitted environment, signer security review and an independent external audit before substantive mainnet capital.

A test or route must be displayed as `PASS`, `FAIL`, `BLOCKED`, `NOT RUN` with evidence (commit SHA, test command, timestamp and environmental assumptions). No hidden exclusion of failed tests.

---

## 15. P0 ARCHITECTURE AUDIT FINDINGS — IMPLEMENT FIXES

1. **Double spend:** global bucket total does not equal spendable wallet tokens -> source of truth ledger + atomic reservation.
2. **Shared wallet illusion:** UI may imply physical segregation -> show physical versus logical ownership everywhere.
3. **Single-chain nonce assumption:** EVM, Solana, Sui, Aptos, BTC and IBC have different state models -> specialised sign/settle services.
4. **Stale order books and RPC:** invalid price arbitrage -> timestamps, sequence gaps, freshness gate, source quorum when required.
5. **Gross-profit bias:** small trades fail net after entry and exit fees -> full roundtrip costs and expected failed tx expenditure.
6. **Frozen capital:** bridge/pending orders accidentally reused -> pending and reserved ledger states.
7. **Paper/live contamination:** synthetic fills appear real -> separately versioned environments, DB namespaces and permanent labels.
8. **LLM hallucinations/injection:** narrative feeds trigger unauthorised trade -> data-only model lane and verified signals.
9. **Strategy double bet:** same asset across baskets hides exposure -> aggregate exposure factor engine.
10. **Profit sweep during drawdown:** extracting “profit” from unrealised trade can create insolvency -> eligible realized profit after open exposures and obligations.
11. **Impossible exits:** liquidity disappears, freeze authority activated -> continuous sell simulation, liquidity-based position caps, emergency state.
12. **Wrong token identity:** duplicate symbol/bridge asset confusion -> canonical chain+token IDs + issuer/backing proof.
13. **Gas starvation:** spend last native token -> exit reserve and auto-refill with cap and approval.
14. **Unbounded fee bidding:** priority auction wipes edge -> strict economic max fee including failed tx probability.
15. **CEX unknown submission:** retry creates accidental second order -> idempotency/status reconciliation first.
16. **Partial-fill arbitrage:** residual inventory remains unmanaged -> two-leg inventory risk and hedge/abort plans.
17. **Backend autoscaling races:** multiple workers spend same capital -> transactional locks and monotonically versioned policy.
18. **Price manipulation:** reference price contaminated -> multi-source plausibility checks, depth and anomaly filter.
19. **Bridge trusted as final too early:** phantom destination funds -> verified finality/IBC acknowledgment.
20. **Too many active strategies:** cost, correlations and alert overload -> capital optimizer, throttled execution, research-to-live gates.
21. **False HFT claims:** low sampling interval ≠ fast fills -> actual wire-to-fill measurement and net execution attribution.
22. **Wallet secret exposure:** frontend could store sensitive signing material -> delegated/secure signer only, no secrets in browser local storage.
23. **Tax/lots:** crypto swap/cross-chain moves misbooked -> transfer vs disposal classification ledger with human review.
24. **Regulatory scope:** UK retail derivative capability incorrectly enabled -> jurisdiction-specific products/venue policy, spot first.
25. **Operations runaway:** paid LLM/RPC/simulation costs exceed returns -> budgets and telemetry by provider/strategy.
26. **Market open during infrastructure incident:** exit watchers stop with kill switch -> two-tier supervision and exit-only continuity.
27. **Scam model overconfidence:** passes “buy test” but not real sell -> independent sell-path capacity scenarios and rescans.
28. **Backtesting survivorship:** delisted/rugged tokens absent from dataset -> archive complete token launch and delisting history.
29. **Capital concentration across chains:** correlated coins represented as “diversified networks” -> common-factor and stablecoin depeg aggregation.
30. **Emergency rollback:** app crash before writing submission ID -> transactional outbox/inbox and reconciliation-first recovery.

Each finding must map to implementation code, test case and dashboard warning; unresolved P0 must block production authorisation.

---

## 16. DELIVERY PHASES AND ACCEPTANCE CRITERIA

**Phase A — inventory + architecture:** inspect repo and official docs; write decision records, chain capabilities, threat model, schema, current-code gap assessment and realistic work plan. Build initial UI shell and wire a *real* paper ledger; do not delay frontend until the end.

**Phase B — authoritative treasury:** implement portfolios/buckets/wallets, physical vs logical segregation, zero-sum ledger, reserve claims, wallet onboarding watch-only, synthetic feeds and compounding targets + financial governor. Test concurrency and reconciliation deeply. Acceptance: 100 concurrent competing intents cannot produce overspending; transfers do not duplicate value; vault remains unspendable by strategies.

**Phase C — multi-chain market data:** chain registry and family adapters, provider health, balance polling/indexing, costs and simulation. Initial functional integration tests on chain-family testnets or non-spending RPC calls. Add all named chain entries; distinguish CERTIFIED, READ_ONLY, PENDING and UNSUPPORTED capabilities clearly. Acceptance: cannot transmit any order through uncertified connector.

**Phase D — deterministic strategy/paper trading:** paper exchange, order-book replay, strategy SDK, market regime, risk checks, signal+execution logs, realistic roundtrip fees and wallet accounting. Acceptance: reproducible fill and PnL, no lookahead, replay after crash and no duplicate ledger application.

**Phase E — meme intelligence & external venues:** token lifecycle, launchpad/DEX index, security, smart wallet graph, optional LLM, CEX spot adapter and monitoring, quote routers. Acceptance: known malicious scenarios rejected and bad/stale feeds pause entries.

**Phase F — production wallet scopes and supervised real execution:** wallet provider authorisation, scoped signer, CEX restricted credentials, safe routes and confirmation, limited live trading capability behind explicit multiple gates. Acceptance: all P0 risk/ledger/security scenarios PASS and user opts in; otherwise remain paper only.

**Phase G — HFT research, MEV, cross-chain, batch automation:** implement low-latency optimisations, cross-venue inventory, defensive private routing, bounded priority bidding and capital optimization, only when research and test evidence support them. Acceptance: measured end-to-end net benefit, worker backpressure, safe unknown states and zero cross-bucket overspending.

**Phase H — release-readiness:** run automated browser tests, migration tests, strategy suites, SAST/DAST, secrets audit, disaster recovery, load/soak and pen-test readiness; provide runbook, evidence, known limitations and irreversible-stop simulation.

### Mandatory final report from Claude Code
- Source tree and implemented services/pages.
- Deployment instructions, required secrets scopes and no-secret demo instructions.
- Real functionality map versus mocked research/paper functionality.
- Per-chain capabilities matrix with explicit PASSED/READ_ONLY/BLOCKED/NOT BUILT.
- Per-provider API status, auth and legal availability caveats.
- Test outcomes with commands/logs and failed cases.
- Wallet and portfolio threat analysis.
- Screenshots/visual diff of the 25 pages at representative breakpoints.
- Performance/latency measurements, not estimates claimed as measured.
- Open issues P0/P1/P2 and blocked launch gates.
- Honest go-live recommendation based on evidence.

**Definition of done:** A real, runnable platform with beautiful usable UI, persisted wallet/bucket policies, paper-order pipeline, correct multi-chain capability registry, deterministic capital/risk/compounding accounting and rigorous tests; optional live execution only where chain/venue adapters and user permissions are genuinely configured and certified. If a requested external integration cannot be completed without credentials or SDK support, provide its working safe skeleton, correct disabled state, validation tests and exact setup procedure. NEVER substitute hardcoded green indicators or mock transactions for production integrations.

---

## 17. SOURCE DOCUMENTATION TO CHECK DURING IMPLEMENTATION

Verify current versions at build time, not just copied examples:

- Solana fees and compute budget: https://solana.com/docs/core/fees and https://solana.com/docs/core/fees/compute-budget
- Jito bundle/low-latency docs: https://docs.jito.wtf/lowlatencytxnsend/
- Uniswap Universal Router + Permit2: https://developers.uniswap.org/docs/protocols/universal-router/overview and https://developers.uniswap.org/docs/trading/swapping-api/concepts/permit2
- Mysten Sui SDK/transactions: https://sdk.mystenlabs.com/sui and https://sdk.mystenlabs.com/sui/transactions/signing-and-execution
- Aptos TypeScript SDK: https://aptos.guide/build/sdks/ts-sdk
- TRON Bandwidth/Energy: https://developers.tron.network/docs/bandwidth-and-energy
- Coinbase Advanced Trade WebSockets: https://help.coinbase.com/en/developer-platform/websocket-feeds/advanced-trade
- Binance official spot API docs: https://github.com/binance/binance-spot-api-docs (venue/jurisdiction availability independent)
- UK FCA cryptoasset services: https://www.fca.org.uk/firms/cryptoassets/who-needs-register
- Ethereum EIP-1559: https://eips.ethereum.org/EIPS/eip-1559

---

**Start execution now:** inspect the repo, produce a precise gap table and implement Phase A/B with a functional Next.js UI plus persistent treasury and safe research/paper engine. Continue phase-by-phase, parallelising independent tasks, testing and documenting each step. Do not request clarification on ordinary design choices. Stop for user action only where account credentials, secure signer authorisation, real money transfers, regulatory restrictions or genuinely missing essential information require it.
