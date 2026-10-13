# APEX threat model (initial)

Scope: control plane + paper trading as built. Real-fund signing is **not built**; threats below marked *(future)* must be re-assessed before any live gate is signed. This is an internal model, **not** an independent security review (gate `external_security_review` stays NOT_RUN).

| # | Threat | Mitigation present | Residual / status |
|---|---|---|---|
| T1 | Cross-tenant data access | RLS enabled+forced on all tenant tables; client roles SELECT-only; definer functions assert membership/role | Tested (db/rls.test, api tests). Supabase-hosted RLS not exercised. |
| T2 | Privilege escalation via SQL functions | internals revoked from PUBLIC; only `api_*` granted to `authenticated`; `search_path` pinned on definers | Tested negative cases; no external review |
| T3 | Overspend / double spend by concurrent workers | DB CHECK + row locks, idempotency keys | 100-way concurrency tests PASS (db + http) |
| T4 | Duplicate economic fills on replay | unique fill keys, idempotent `apply_fill`, event keys | Tested (50 concurrent deliveries) |
| T5 | Paper/live contamination | environment trigger, live guard trigger, service-role-only live ledger | Tested |
| T6 | Secret exposure (seed/keys/API secrets) | no key columns, API rejects secret-named fields and seed-like addresses, UI has no such inputs | Tested; custody design (KMS/MPC) NOT BUILT |
| T7 | XSS stealing session | httpOnly SameSite=Strict cookie, BFF proxy (no bearer in JS), strict CSP | CSP uses `'unsafe-inline'` scripts (Next inline bootstrap) — nonce-based CSP is an open item |
| T8 | CSRF on mutations | SameSite=Strict + Origin==Host + custom header `x-apex-csrf` | Tested via e2e flows; no dedicated negative e2e yet |
| T9 | API abuse | rate limit, body limit, zod strict schemas, safe error mapping | Tested (429, validation) |
| T10 | Phishing / malicious wallet connect | no signing flows; addresses validated; no redirect into wallet signing | n/a until signing exists *(future)* |
| T11 | Malicious contracts / scam tokens | token-safety scoring module (researcher) + planned sell-path simulation | Rule scoring tested on patterns; on-chain simulation NOT BUILT |
| T12 | LLM prompt injection | LLM disabled by default, data-only lane, schema validation, no execution access | Protocol-tested only |
| T13 | RPC/provider takeover or stale data | chain-id verification, capability registry fail-closed, health NOT_MEASURED shown honestly | Probes optional; quorum NOT BUILT |
| T14 | Supply-chain compromise | pinned lockfiles (pnpm-lock, Cargo.lock) | SCA/SAST/secret-scan results recorded in QA_EVIDENCE when run |
| T15 | Operator error (resume live, loosen limits) | live needs 16 PASS gates + opt-in + flag; limits can only be tightened from UI; approvals with delay | Tested at DB level |
| T16 | Insider with DB superuser | out of scope (Supabase project owner); audit table is append-only for non-superusers | Open |
| T17 | Replay of API commands | Idempotency-Key required; replays are no-ops | Tested |
| T18 | Shared-wallet logical accounting error | exclusivity trigger; explicit `logical_ack`; UI shows physical vs logical everywhere | Tested at DB level |
