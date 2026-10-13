# Open risks, blockers and honest limitations
Maintained alongside `docs/IMPLEMENTATION_LOG.md`. P0 = blocks any live authorisation.

## P0 (live remains blocked)
- **Key custody / signing**: no KMS/MPC/external signer exists. Managed execution is impossible by design today. *Needs: provider decision + credentials + security review.*
- **No chain adapter is CERTIFIED**; swaps/transfers/bridges are not implemented for live. Read-only status only where a real RPC read passed (see ADAPTER_MATRIX).
- **No live venue integration**: only public market data / paper venue; UK availability of every venue is UNVERIFIED (needs human check against FCA / venue terms).
- **Independent security review and pen-test not done** (in-house tests only).
- **Supabase Auth/MFA/RLS-on-hosted not exercised** (no project credentials in this environment).
- **On-chain finality/reorg/IBC timeout paths** are state-machine tested with simulated inputs, not against live networks.
- **Gates**: all 16 `required_gates` are NOT_RUN/untrusted for live; none has been signed off. Do not sign one without evidence.

## P1
- No market-price feed → no unrealised PnL, no equity curve, no GBP valuation / tax cost basis in GBP.
- No balance-snapshot job → no equity history; no on-chain balance reconciliation job (`reconciliation_runs` not populated).
- No worker consuming `jobs`; no notifier service; alerts are only written by explicit actions.
- Chain health probes are optional/off by default; provider quorum not built.
- CSP allows inline scripts (Next bootstrap); nonce-based CSP not done.
- Execution latency numbers (Rust) are micro-benchmarks on this sandbox, not wire-to-fill measurements; **no HFT claim is made**.
- Token security: no on-chain simulation of buy/sell paths yet.
- Data model: spec's ~150 tables are implemented selectively; see IMPLEMENTATION_LOG "Table coverage".

## P2
- Browser QA used Chromium only (no Firefox/WebKit); screen-reader testing is automated-axe only, no manual NVDA/VoiceOver pass.
- Load/soak/chaos tests limited to DB/API concurrency tests.
