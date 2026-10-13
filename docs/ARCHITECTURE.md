# APEX architecture (as built)

Status legend used across docs: **BUILT+TESTED** (automated test with recorded evidence), **BUILT** (code exists, limited/no automated evidence), **SKELETON** (safe disabled skeleton), **NOT BUILT**, **BLOCKED** (needs external credentials/SDK/legal input).

## Principle: the database is the financial authority
All money state lives in PostgreSQL (Supabase-compatible) as an append-only **double-entry ledger** (`packages/db/migrations/0002_ledger.sql`). Application code, Rust services, Python research and the UI can only *request* movements through SQL functions; invariants are enforced by the database itself:

| Invariant | Enforced by |
|---|---|
| Every entry balances to zero per asset | deferred constraint trigger `ledger_check_zero_sum` + check inside `post_entry` |
| No overspend, even with 100 concurrent claims | `CHECK (balance >= 0)` on non-contra `ledger_accounts` + row-lock serialisation + ordered posting (no deadlocks) |
| Paper can never touch live | environment match trigger on every posting; separate account namespace; live mutations restricted to service role |
| Idempotent replay | unique `(workspace, idempotency_key)` with payload-hash comparison; `capital_reservations.intent_key`; `fills (intent, venue_fill_id)`; `waterfall_executions.profit_event_id`; `order_events (intent, event_key)` |
| Protected vault never tradeable | only `available` accounts are reservable; vault release needs approval + delay + non-self owner |
| Pending funds never spendable | transfers move `available → pending_out`; destination credited only on `confirm_transfer` |
| Order lifecycle is typed | `allowed_transitions` table + `advance_intent`; ADMITTED needs an ADMIT `risk_decision` and no VETO; `UNKNOWN → SUBMITTING` is impossible |
| Live trading impossible by default | `guard_live_intent` trigger + `live_allowed(ws)` = opt-in AND operator flag AND all 16 `required_gates` PASS with evidence + commit SHA |
| Tenant isolation | RLS enabled+forced on every workspace table; clients have SELECT only; all writes through role-checking `SECURITY DEFINER api_*` functions |
| Audit | `audit_events` append-only, written by every `api_*` function |

## Services
```
Browser ──(httpOnly cookie, same-origin BFF proxy, CSRF origin+header check)──> apps/console (Next.js 16)
apps/console ──Bearer JWT──> services/api (Fastify, zod, rate-limit, helmet) ──as role `authenticated` + request.jwt.claim.sub──> PostgreSQL (RLS)
services/execution + services/risk (Rust)  ──service-role SQL functions──> PostgreSQL     (paper only; LiveVenue returns Err(LiveDisabled))
services/researcher (Python/FastAPI)       ──> simulation_runs / HTTP from API           (research only; SYNTHETIC data labelled)
packages/chain-*  (TS family adapters)     ──> capability registry; READ_ONLY at best; nothing CERTIFIED without evidence
packages/exchange-adapters                 ──> venue contract, public market data, paper venue, unknown-order reconciler
```
LLMs are **off the hot path**: `ModelProvider` is Disabled by default, has no access to execution, and outputs are schema-validated data only.

## Authentication
- Production: Supabase Auth (JWT HS256, `aud=authenticated`, `sub`=user id). The API verifies the JWT and sets `request.jwt.claim.sub` per transaction so `auth.uid()` and RLS work exactly as in Supabase. **Supabase Auth itself is not exercised in this build (BLOCKED: no project/credentials).**
- Local development: `APEX_DEV_AUTH=1` enables `POST /v1/dev/session` (refused when `NODE_ENV=production`); it uses a separate privileged DB URL only to create `auth.users` rows.

## Key custody
There is no column, field or API parameter that can carry a private key/seed (schema test + API secret-field rejection + client BIP39 detection). Managed signers are represented only by an opaque `signer_ref`; their creation is reserved to a signer service (NOT BUILT; BLOCKED on KMS/MPC provider choice).

## Where each spec area lives
See `docs/P0_FINDINGS_MAP.md` (finding → code → test → UI warning), `docs/ADAPTER_MATRIX.md` (chains/venues), `docs/QA_EVIDENCE.md` (every test run).
