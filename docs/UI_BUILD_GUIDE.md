# UI build guide (apps/console) — conventions every page must follow

Stack: Next.js 16 App Router (read `apps/console/node_modules/next/dist/docs/` before using any Next API; this version differs from older releases — e.g. `proxy.ts` replaces middleware), React 19, Tailwind 4 (tokens in `app/globals.css`), Framer Motion (restrained), TanStack Query.

## Hard rules
1. **No fabricated data.** Every number comes from an authenticated API call (`useApi`/`useWs`) or is clearly absent. If a data source does not exist yet (market prices, social feeds, chain probes…), render an honest `NotConnected`/`EmptyState` explaining exactly what is missing and the setup step. Never hardcode green indicators, balances, PnL, prices or health.
2. **Money** is integer base-unit *strings* end to end. Use `lib/format.ts` (`formatUnits`, `parseUnits`: BigInt only). Never `Number()`/`parseFloat` on ledger amounts. Percentages entered as basis points ints.
3. **Environment honesty**: paper vs live is always visible (shell banner already does this). Do not mix paper and live rows without a visible environment column/badge.
4. **Mutations** go through `useCommand('<commandName>')` → `POST /v1/commands/<name>` with an auto `Idempotency-Key`. Show busy state, success toast, and the API's rejection message on error (`toast.push(e.message,'bad')`). UI role gating (`useWorkspace().canWrite/canAdmin/canOwn`) is cosmetic only — the database enforces roles.
5. **Consequential actions** use a Dialog/Drawer/stepper with a preview of what will change; destructive/permission-affecting ones use `ConfirmDialog` (type-to-confirm).
6. **No secret fields.** Never add inputs for seed phrases, private keys, API secrets or withdrawal permissions. Wallet onboarding is public-address/watch-only/provider-connect only.
7. Every page needs loading / empty / error states (`Async`, `LoadingBlock`, `EmptyState`, `ErrorState`), full keyboard operation, visible focus, labelled controls, tables via `DataTable` (search + sort + filters), charts via `LineChart`/`StackedBar` (accessible summary, units, provenance).
8. Responsive at 1440/1280/1024/768/390 with **no horizontal page overflow**; WCAG 2.2 AA (axe serious/critical = 0); reduced-motion respected.
9. Visual direction: the white premium look in `components/ui.tsx` (docs/spec/APEX_Dashboard_Prototype.html + the PNGs in docs/spec are the reference). Reuse `components/ui.tsx` primitives; add new shared primitives there only if several pages need them (re-read the file before editing: others edit it too — prefer new files `components/<feature>/*.tsx`).

## Backend extension
API core: `services/api/src/app.ts`. Add endpoints in **your own module** `services/api/src/routes/<feature>.ts` exporting a `RouteModule` (see `routes/ctx.ts` for `read`, `cmd`, `one`, `q`, `schemas`), then append ONE import + array entry in `routes/index.ts` (re-read before editing). Reads must run through `ctx.read` (RLS). Writes must call a SECURITY DEFINER `api_*` SQL function that checks role + audits — add it in a new migration numbered in YOUR range (below); never write ledger/config tables directly. New tables need RLS (enable + force + select policy via `is_member(workspace_id)`) and `grant select ... to authenticated` — follow `0005_rls_api.sql`.
Migration ranges: UI-capital 0200–0219, UI-ops 0220–0239, UI-trading 0240–0259, UI-markets 0260–0279.

## Testing (required, record real output)
- Unit tests (vitest) for pure logic (formatters, validators, waterfall preview math).
- Playwright e2e in `apps/console/e2e/<feature>.spec.ts` using `e2e/helpers.ts` (`login`, `createWorkspaceIfNeeded`, `a11y`, `VIEWPORTS`, `SHOTS`): drive the real UI against the real API + DB, assert persisted results by reloading the page, run axe at the 5 viewports, assert no horizontal overflow, save screenshots to `docs/evidence/screenshots/<page>-<width>.png`.
- API tests in `services/api/tests/<feature>.test.ts` (copy the harness from `api.test.ts`): auth, RLS cross-tenant negative, validation, idempotency.
- Run via `scripts/evidence.sh "<suite name>" <command>` so results land in `docs/QA_EVIDENCE.md`. Dev stack: `scripts/dev-up.sh` (API :4000 with dev auth, console :3000, Postgres :54329 `apex` DB; apply new migrations to it with `DATABASE_URL=postgres://postgres@localhost:54329/apex packages/db/migrate.sh`). Do **not** kill other processes by pattern (`pkill -f`) — other agents share this machine; the dev stack is shared, so restart only your own processes if needed and prefer `E2E_BASE_URL` pointing at the shared server.
- Never edit another agent's files except to append your single registration line. Do not git commit; the lead commits.
