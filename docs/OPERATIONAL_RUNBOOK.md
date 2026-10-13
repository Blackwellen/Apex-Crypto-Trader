# Operational runbook (paper/research environment)

## Start the local stack
```bash
# Postgres 16 (as OS user postgres), port 54329
su postgres -c "/usr/lib/postgresql/16/bin/initdb -D /var/lib/apexpg -A trust" # first time only
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/apexpg -o '-p 54329 -c max_connections=300' -l /var/lib/apexpg/log start"
psql -h localhost -p 54329 -U postgres -c "create database apex"
psql -h localhost -p 54329 -U postgres -d apex -f infra/local/auth_shim.sql      # LOCAL ONLY (Supabase provides auth schema)
DATABASE_URL=postgres://postgres@localhost:54329/apex packages/db/migrate.sh
scripts/dev-up.sh                        # API :4000 (dev auth ON), console :3000
```
## Emergency procedure (paper today; same semantics for live later)
1. Console header → **Emergency stop** (type STOP). This sets `global_state=emergency_stopped` and `paper_running=false`; **new entries are refused by the DB** (`advance_intent ... ADMITTED`).
2. Settlement/reconciliation and risk-reducing exits continue; do **not** `kill -9` services expecting positions to close.
3. UNKNOWN orders: never resubmit. Reconcile against the venue by client order id; resolve with `advance_intent(... 'ACKNOWLEDGED'|'FILLED'|'FAILED' ...)` from the reconciler only.
4. Resume requires owner/admin (`Resume approved`).
## Recovery
- Process crash: services replay non-terminal intents; all ledger writes are idempotent by key → replays are no-ops.
- DB restore: restore, then run reconciliation (`reconciliation_runs`) before enabling the paper engine.
## Secrets
No secrets in the repo. Required runtime env: `SUPABASE_JWT_SECRET` (≥32 chars), `DATABASE_URL` (role `apex_app`, RLS-subject), `APEX_API_URL` for the console. Never set `APEX_DEV_AUTH` outside local development (the API refuses it in production).
