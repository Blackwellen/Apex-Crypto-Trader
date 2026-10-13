# Implementation log (append-only narrative; evidence lives in QA_EVIDENCE.md)

## 2026-10-13 — Session 1
**Audit:** repository and GitHub remote were empty (no commits). Spec package (`docs/spec/`) supplied via zip: master build prompt, QA/gap assessment, HTML prototype, screenshots. Greenfield build on branch `claude/apex-build`.
**Toolchain verified:** Node 22.22, pnpm 10.28, Rust 1.97, Python 3.13, PostgreSQL 16 server binaries, Chromium (Playwright). Docker is NOT available. Package registries reachable via proxy.

### Phase A/B — foundation (lead)
- DB migrations 0001–0006: identity/workspaces/roles, portfolios/buckets/wallets/baskets/registries, double-entry ledger, reservations, transfers, vault approvals, trade intents + order state machine + risk decisions + fills/positions, live gates, compounding policy/waterfall/targets/HWM, ops tables, RLS + role-checked API functions.
- **Bugs found by our own tests and fixed (kept for honesty):**
  1. Concurrent identical `intent_key` raised a unique violation instead of replaying → `reserve_capital` now atomic with `unique_violation` handler.
  2. SQL `numeric /` is not integer division: waterfall splits and position cost basis produced fractions (caught by `parts_sum` constraint) → `div()` floor.
  3. Zero-amount postings (zero fees) violated `amount <> 0` → skipped in `post_entry`.
  4. API plugins registered without `await` silently skipped helmet/CORS/rate-limit for already-defined routes → `buildApp` is async; headers and 429 now asserted by tests.
  5. Dev session endpoint initially used the unprivileged pool (403) → separate dev-admin pool.
- API (Fastify): reads for all spec endpoints; commands for workspace/portfolio/bucket/wallet/allocation/transfer/compounding/targets/safety/gates; strict zod; Idempotency-Key; secret-field rejection; safe error mapping; chain health honestly `NOT_MEASURED`.
- Console shell (Next.js 16): design system, httpOnly-cookie BFF proxy with CSRF checks, workspace context, Command Centre (APEX-001) wired to real endpoints, kill switch with typed confirmation.
- Delegated in parallel (separate directories / migration ranges to avoid capital or schema races): Rust execution+risk, Python researcher, chain adapters A (registry, EVM, Solana, Sui, Aptos), chain adapters B (TRON, Cosmos, Bitcoin, TON, NEAR, venues), and four UI page groups.
