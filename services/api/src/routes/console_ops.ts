import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RouteModule } from './ctx.ts';
import type { Tx } from '../db.ts';

/**
 * UI-ops routes (migrations 0220/0221): capital accounts for the transfer wizard, risk exposure / violations / incidents,
 * treasury cash-flow reconciliation, jobs summary, audit search, compounding overview, settings (members / integrations),
 * and the commands behind them. Reads run through ctx.read (RLS). Writes only call SECURITY DEFINER api_* functions that
 * check role + audit. Every command here is wrapped in generic idempotency (api_idem_begin/finish): the same
 * Idempotency-Key replays the stored result and performs no second effect.
 */
export const consoleOpsRoutes: RouteModule = ({ app, cfg, read, cmd, one, q, schemas }) => {
  const { uuid, amount, ws, page } = schemas;
  const reason = z.string().min(3).max(300);

  /** Run `fn` at most once per (user, Idempotency-Key). Replays return the stored result. */
  const once = async (c: Tx, key: string, name: string, body: unknown, fn: () => Promise<unknown>) => {
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const r = (await one(c, `select api_idem_begin($1,$2,$3) r`, [key, name, hash])).r;
    if (r.replay) return r.result;
    const out = await fn();
    await c.query(`select api_idem_finish($1,$2::jsonb)`, [key, JSON.stringify(out ?? {})]);
    return out;
  };
  const icmd = <S extends z.ZodTypeAny>(name: string, schema: S, run: (c: Tx, b: z.infer<S>, key: string) => Promise<unknown>) =>
    cmd(name, schema, (c, b, key) => once(c, key, name, b, () => run(c, b, key)));

  // ------------------------------------------------------------------ capital accounts (transfer wizard)
  app.get('/v1/capital/accounts', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => ({
    buckets: (await c.query(`select id, name, kind, segregation, environment, state, portfolio_id from buckets where workspace_id=$1 order by created_at`, [workspace])).rows,
    accounts: (await c.query(
      `select x.id wca, x.chain_id, r.name chain_name, r.native_symbol, r.native_decimals, r.finality_model, w.id wallet_id, w.nickname, w.family, w.state wallet_state, w.capability,
              coalesce((select jsonb_agg(jsonb_build_object('bucket_id', a.bucket_id, 'exclusive', a.exclusive, 'bps', a.max_allocation_bps, 'logical_ack', a.logical_ack)) from wallet_bucket_allocations a where a.wallet_id=w.id), '[]') allocations
         from wallet_chain_accounts x join wallets w on w.id=x.wallet_id join chain_registry r on r.id=x.chain_id where w.workspace_id=$1 order by w.nickname, x.chain_id`, [workspace])).rows,
    balances: (await c.query(
      `select a.environment, a.bucket_id, a.wallet_chain_account_id wca, s.id asset_id, s.symbol, s.decimals, s.chain_id, a.state, a.balance::text amount
         from ledger_accounts a join assets s on s.id=a.asset_id
        where a.workspace_id=$1 and a.bucket_id is not null and a.state not in ('external','equity','fees_expense') and a.balance<>0`, [workspace])).rows,
    note: 'Balances are the internal ledger (paper or reconciled). A LOGICAL transfer (same wallet) is one atomic ledger entry; a PHYSICAL transfer (different wallets) stays pending until finality and the destination is not credited early.',
  })); });

  // ------------------------------------------------------------------ risk
  app.get('/v1/risk/exposure', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => ({
    ledger: (await c.query(
      `select a.environment, a.bucket_id, b.name bucket_name, b.kind bucket_kind, b.state bucket_state, w.id wallet_id, w.nickname wallet_nickname, w.state wallet_state,
              a.wallet_chain_account_id wca, s.id asset_id, s.symbol, s.decimals, s.chain_id, a.state, a.balance::text amount
         from ledger_accounts a join assets s on s.id=a.asset_id left join buckets b on b.id=a.bucket_id
         left join wallet_chain_accounts x on x.id=a.wallet_chain_account_id left join wallets w on w.id=x.wallet_id
        where a.workspace_id=$1 and a.state not in ('external','equity','fees_expense') and a.balance<>0 order by b.name nulls first, s.symbol`, [workspace])).rows,
    strategies: (await c.query(
      `select i.strategy_key, i.environment, qa.symbol quote_symbol, qa.decimals quote_decimals, count(*)::int open_intents, sum(i.notional)::text open_notional
         from trade_intents i join assets qa on qa.id=i.quote_asset
        where i.workspace_id=$1 and i.state not in ('FINAL','RECONCILED','LEDGER_APPLIED','COMPOUNDING_ELIGIBLE','FAILED','CANCELLED','EXPIRED') group by 1,2,3,4`, [workspace])).rows,
    budgets: (await c.query(
      `select g.strategy_key, b.name bucket_name, s.symbol, s.decimals, g.limit_amount::text limit_amount, g.reserved_amount::text reserved_amount
         from strategy_capital_budgets g join buckets b on b.id=g.bucket_id join assets s on s.id=g.asset_id where g.workspace_id=$1`, [workspace])).rows,
    provenance: 'Internal double-entry ledger only. No market-price feed is connected, so exposure is shown per asset in native units and is never summed across assets or converted to GBP.',
  })); });

  app.get('/v1/risk/violations', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => {
    type V = { key: string; severity: 'critical' | 'warn' | 'info'; scope: string; scope_id?: string | null; title: string; detail: string; source: string; rule: string; action: string };
    const v: V[] = [];
    const st = (await c.query(`select global_state, global_limits, live_opt_in, live_feature_flag, nonessential_jobs_paused from workspace_settings where workspace_id=$1`, [workspace])).rows[0];
    if (!st) throw Object.assign(new Error('workspace not found'), { statusCode: 404, code: 'not_found' });
    if (st.global_state !== 'active') v.push({ key: 'global_state', severity: 'critical', scope: 'global', title: `Global state is ${st.global_state}`, detail: 'New entries are refused workspace-wide.', source: 'workspace_settings.global_state', rule: 'advance_intent(): ADMITTED requires global_state = active', action: 'Resume (owner/admin) once the incident is understood.' });
    const gates = (await c.query(`select g.gate_key, d.status from required_gates g left join deployment_gates d on d.gate_key=g.gate_key and d.workspace_id=$1 where coalesce(d.status,'NOT_RUN') <> 'PASS'`, [workspace])).rows;
    if (gates.length) v.push({ key: 'gates', severity: 'info', scope: 'global', title: `${gates.length} deployment gate(s) not PASS: live execution is locked`, detail: gates.map((g: any) => `${g.gate_key}=${g.status ?? 'NOT_RUN'}`).join(', '), source: 'deployment_gates / live_allowed()', rule: 'live_allowed(): every required_gates row must be PASS with evidence + commit SHA, plus opt-in and operator flag', action: 'Expected while building. Sign a gate off only with real evidence.' });
    const unknown = (await c.query(`select id, bucket_id from trade_intents where workspace_id=$1 and state='UNKNOWN'`, [workspace])).rows;
    for (const u of unknown) v.push({ key: 'unknown:' + u.id, severity: 'critical', scope: 'bucket', scope_id: u.bucket_id, title: 'Order outcome UNKNOWN', detail: `Intent ${u.id} timed out without an authoritative status.`, source: 'trade_intents.state', rule: 'advance_intent(): UNKNOWN cannot move to SUBMITTING; reconcile first', action: 'Reconcile with the venue. Never resubmit.' });
    const over = (await c.query(
      `select b.id, b.name, b.policy, s.global_limits from buckets b join workspace_settings s on s.workspace_id=b.workspace_id where b.workspace_id=$1
          and (((b.policy->>'max_slippage_bps') ~ '^[0-9]+(\\.[0-9]+)?$' and (b.policy->>'max_slippage_bps')::numeric > (s.global_limits->>'max_slippage_bps')::numeric)
            or ((b.policy->>'max_order_notional_bps_of_bucket') ~ '^[0-9]+(\\.[0-9]+)?$' and (b.policy->>'max_order_notional_bps_of_bucket')::numeric > (s.global_limits->>'max_order_notional_bps_of_bucket')::numeric))`, [workspace])).rows;
    for (const b of over) v.push({ key: 'limit:' + b.id, severity: 'critical', scope: 'bucket', scope_id: b.id, title: `Bucket "${b.name}" policy exceeds a global hard limit`, detail: `bucket policy ${JSON.stringify(b.policy)} vs global ${JSON.stringify(b.global_limits)}`, source: 'buckets.policy vs workspace_settings.global_limits', rule: 'api_update_bucket_policy(): child limits may not exceed global limits', action: 'Edit the bucket policy (Risk policy wizard) to be within the global limits.' });
    for (const b of (await c.query(`select id, name, state from buckets where workspace_id=$1 and state <> 'active'`, [workspace])).rows)
      v.push({ key: 'bucket_state:' + b.id, severity: 'warn', scope: 'bucket', scope_id: b.id, title: `Bucket "${b.name}" is ${b.state}`, detail: 'Capital reservations for new entries are refused for this bucket.', source: 'buckets.state', rule: 'reserve_capital(): bucket must be active', action: 'Resume the bucket (owner/admin) when safe.' });
    for (const w of (await c.query(`select id, nickname, state from wallets where workspace_id=$1 and state <> 'active'`, [workspace])).rows)
      v.push({ key: 'wallet_state:' + w.id, severity: 'warn', scope: 'wallet', scope_id: w.id, title: `Wallet "${w.nickname}" is ${w.state}`, detail: 'Wallet is out of service.', source: 'wallets.state', rule: 'wallet lifecycle (migration 0200)', action: 'Resume or replace the wallet.' });
    for (const t of (await c.query(`select id, kind, status, created_at from internal_transfers where workspace_id=$1 and status in ('requested','pending_finality')`, [workspace])).rows)
      v.push({ key: 'transfer:' + t.id, severity: 'warn', scope: 'bucket', title: `${t.kind} transfer ${t.status.replace('_', ' ')}`, detail: `Transfer ${t.id} is not final: the destination has NOT been credited and the funds are unavailable to the source.`, source: 'internal_transfers.status', rule: 'request_transfer()/confirm_transfer(): destination credited only at finality', action: 'Wait for finality, or fail the transfer to return funds to the source.' });
    for (const d of (await c.query(`select b.name, s.symbol, d.amount::text amount, d.bucket_id from bucket_deficits d join buckets b on b.id=d.bucket_id join assets s on s.id=d.quote_asset where b.workspace_id=$1 and d.amount>0`, [workspace])).rows)
      v.push({ key: 'deficit:' + d.bucket_id + d.symbol, severity: 'warn', scope: 'bucket', scope_id: d.bucket_id, title: `Bucket "${d.name}" carries a ${d.symbol} loss deficit`, detail: `${d.amount} base units must be recovered before profit is distributed.`, source: 'bucket_deficits', rule: 'apply_waterfall() step 2: recover deficit before distributing profit', action: 'Informational: no sweep occurs until recovered.' });
    for (const d of (await c.query(`select asset_id, sum(balance)::text s from ledger_accounts where workspace_id=$1 group by asset_id having sum(balance) <> 0`, [workspace])).rows)
      v.push({ key: 'conservation:' + d.asset_id, severity: 'critical', scope: 'token', scope_id: d.asset_id, title: 'Ledger conservation violated', detail: `Sum of all ledger accounts for asset ${d.asset_id} is ${d.s}, expected 0.`, source: 'ledger_accounts / ledger_postings', rule: 'Invariant I1: every entry balances to zero per asset', action: 'Stop and investigate; this should be impossible.' });
    const crit = (await c.query(`select id, class, message from alerts where workspace_id=$1 and not acknowledged and severity='critical'`, [workspace])).rows;
    for (const a of crit) v.push({ key: 'alert:' + a.id, severity: 'critical', scope: 'global', title: `Unacknowledged critical alert: ${a.class}`, detail: a.message, source: 'alerts', rule: 'alert classes (spec section 14)', action: 'Acknowledge in Audit & Incidents once handled.' });
    const rd = (await c.query(`select count(*)::int n from reconciliation_discrepancies where workspace_id=$1 and status='open'`, [workspace])).rows[0].n;
    if (rd) v.push({ key: 'recon', severity: 'warn', scope: 'global', title: `${rd} open reconciliation exception(s)`, detail: 'Ledger and an external source disagree.', source: 'reconciliation_discrepancies', rule: 'manual reconciliation exceptions', action: 'Resolve with a written note in Treasury.' });
    return { items: v, evaluatedAt: new Date().toISOString(), globalLimits: st.global_limits };
  }); });

  app.get('/v1/risk/incidents', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => ({
    alerts: (await c.query(`select id, class, severity, message, environment, acknowledged, acknowledged_by, acknowledged_at, ack_note, source, created_at from alerts where workspace_id=$1 order by created_at desc limit 200`, [workspace])).rows,
    emergencyActions: (await c.query(`select id, scope, scope_id, action, actor, reason, created_at from emergency_actions where workspace_id=$1 order by created_at desc limit 100`, [workspace])).rows,
    unknownOrders: (await c.query(`select id, bucket_id, strategy_key, environment, updated_at from trade_intents where workspace_id=$1 and state='UNKNOWN' order by updated_at desc limit 50`, [workspace])).rows,
    brokenSettlement: (await c.query(`select id, kind, status, environment, amount::text amount, created_at from internal_transfers where workspace_id=$1 and status in ('requested','pending_finality','failed') order by created_at desc limit 50`, [workspace])).rows,
    note: 'Alerts are written by explicit operator actions and services; no notifier or probe service is running, so an empty list is not proof of health.',
  })); });

  // ------------------------------------------------------------------ settings
  app.get('/v1/settings/members', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => ({
    items: (await c.query(`select * from api_list_members($1)`, [workspace])).rows,
    inviteAvailable: false,
    inviteNote: 'Inviting members requires Supabase Auth (email invites + MFA). This deployment uses local dev auth, so invites are disabled rather than faked.',
  })); });

  app.get('/v1/settings/overview', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => {
    const w = (await c.query(`select w.id, w.name, w.base_currency, w.created_at, w.schema_version from workspaces w where w.id=$1`, [workspace])).rows[0];
    if (!w) throw Object.assign(new Error('workspace not found'), { statusCode: 404, code: 'not_found' });
    const s = (await c.query(`select global_state, global_limits, live_opt_in, live_feature_flag, paper_running, nonessential_jobs_paused, live_allowed(workspace_id) live_allowed from workspace_settings where workspace_id=$1`, [workspace])).rows[0];
    const role = (await c.query(`select role from memberships where workspace_id=$1 and user_id=auth.uid()`, [workspace])).rows[0]?.role ?? null;
    return { workspace: w, settings: s, yourRole: role, authMode: cfg.devAuth ? 'dev' : 'jwt', flags: [
      { key: 'live_feature_flag', value: s.live_feature_flag, source: 'workspace_settings.live_feature_flag', note: 'Operator flag: set by the platform operator, not by workspace users (no UI/API command exists).' },
      { key: 'live_opt_in', value: s.live_opt_in, source: 'workspace_settings.live_opt_in', note: 'Owner opt-in; changed in Risk Command.' },
      { key: 'paper_running', value: s.paper_running, source: 'workspace_settings.paper_running', note: 'Persisted desire for the paper engine to run.' },
      { key: 'nonessential_jobs_paused', value: s.nonessential_jobs_paused, source: 'workspace_settings.nonessential_jobs_paused', note: 'Operations > Jobs.' },
      { key: 'live_allowed', value: s.live_allowed, source: 'live_allowed(workspace)', note: 'Derived: opt-in AND operator flag AND state=active AND every gate PASS.' }] };
  }); });

  const has = (n: string) => !!process.env[n] && process.env[n]!.length > 0;
  app.get('/v1/settings/integrations', async (req) => { q(z.object({ workspace: uuid }), req); return read(req, async () => ({
    // Only environment-variable PRESENCE is reported (never values). Nothing here performs a live probe, so no integration is ever shown as healthy.
    items: [
      { key: 'supabase_auth', name: 'Supabase Auth (+ MFA)', status: cfg.devAuth ? 'NOT CONFIGURED' : (has('SUPABASE_URL') && has('SUPABASE_JWT_SECRET') ? 'CONFIGURED - UNVERIFIED' : 'NOT CONFIGURED'),
        detail: cfg.devAuth ? 'This API is running with local DEV AUTH (APEX_DEV_AUTH=1). Anyone who can reach it can mint a token: local development only.' : 'Hosted auth not detected.',
        setup: ['Create a Supabase project and enable email auth + TOTP MFA.', 'Set SUPABASE_URL and SUPABASE_JWT_SECRET on the API; remove APEX_DEV_AUTH.', 'Apply packages/db/migrations to the Supabase database and run the RLS tests against it.', 'Require MFA/re-auth for owner commands (not yet enforced in code).'] },
      { key: 'kms_signer', name: 'KMS / MPC signer', status: has('APEX_SIGNER_ENDPOINT') ? 'CONFIGURED - UNVERIFIED' : 'BLOCKED',
        detail: 'No signer exists. Managed execution is impossible by design until a provider is chosen and security-reviewed. APEX never accepts raw keys or seed phrases.',
        setup: ['Choose a provider (cloud KMS with allow-listed policies, or an MPC custodian).', 'Define scoped transaction policies and an audited revocation path.', 'Set APEX_SIGNER_ENDPOINT and complete the key_custody and wallet_authority gates with evidence.'] },
      { key: 'coinbase', name: 'Coinbase (read-only API key)', status: has('COINBASE_READONLY_KEY_NAME') ? 'CONFIGURED - UNVERIFIED' : 'NOT CONFIGURED',
        detail: 'Only public market data is used today. A private read-only key is needed for balances and fills reconciliation. Trade and withdraw permissions must never be granted.',
        setup: ['Create a Coinbase API key with VIEW permission only (no trade, no transfer).', 'Store the secret in your secret manager; set COINBASE_READONLY_KEY_NAME for the service.', 'Run the read-only reconciliation certification before relying on it.'] },
      { key: 'rpc', name: 'Chain RPC providers', status: has('APEX_RPC_PROVIDER_URLS') ? 'CONFIGURED - UNVERIFIED' : 'NOT CONFIGURED',
        detail: 'Public RPC endpoints may be used for read checks; no provider quorum, health probe or paid provider is configured, so chain health is NOT_MEASURED.',
        setup: ['Pick at least two independent providers per enabled chain.', 'Set APEX_RPC_PROVIDER_URLS (service-side only) and enable the chain health probe worker.', 'Certify each adapter before enabling execution.'] },
      { key: 'llm', name: 'LLM provider (data-only lane)', status: has('ANTHROPIC_API_KEY') || has('APEX_LLM_PROVIDER') ? 'CONFIGURED - UNVERIFIED' : 'NOT CONFIGURED',
        detail: 'The optional model lane can only produce data/evidence, never trade instructions. Not configured: research uses no model calls.',
        setup: ['Choose a provider and set a monthly cost budget.', 'Set the provider key on the researcher service (never in the browser).', 'Keep the lane data-only; verified signals only reach the strategy engine.'] },
      { key: 'notifier', name: 'Notifications (email / Telegram / push)', status: 'NOT CONFIGURED', detail: 'No notifier service exists; alerts appear in the dashboard only.', setup: ['Choose channels and opt-in per user.', 'Deploy the notifier worker.'] },
    ],
    retention: 'The audit log, ledger entries and postings are append-only (database triggers) and are never deleted by the application. No automated retention or purge job exists. Export is available as CSV from each page; a full-data export tool is not built.',
  })); });

  // ------------------------------------------------------------------ jobs
  app.get('/v1/jobs/summary', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => {
    const groups = (await c.query(`select queue, status, essential, paused, count(*)::int n, min(created_at) oldest from jobs where workspace_id=$1 group by 1,2,3,4 order by 1,2`, [workspace])).rows;
    const dead = (await c.query(`select id, queue, essential, status, attempts, last_error, created_at from jobs where workspace_id=$1 and status in ('failed','dead') order by created_at desc limit 100`, [workspace])).rows;
    const obs = (await c.query(`select count(*) filter (where locked_by is not null)::int locked, count(*) filter (where status='running')::int running, max(created_at) newest from jobs where workspace_id=$1`, [workspace])).rows[0];
    const paused = (await c.query(`select nonessential_jobs_paused p from workspace_settings where workspace_id=$1`, [workspace])).rows[0]?.p ?? false;
    return { groups, dead, paused, workerEvidence: { jobsHoldingALock: obs.locked, jobsRunning: obs.running, newestJobAt: obs.newest },
      note: 'There is no worker heartbeat table and no job consumer is deployed with this stack: queued jobs stay queued unless a worker you run claims them. "Running" is only what a worker wrote.' };
  }); });

  icmd('pauseNonEssentialJobs', z.object({ workspace: uuid, reason }).strict(), async (c, b) => ({ paused: (await one(c, `select api_pause_nonessential_jobs($1,$2) n`, [b.workspace, b.reason])).n }));
  icmd('resumeNonEssentialJobs', z.object({ workspace: uuid }).strict(), async (c, b) => ({ resumed: (await one(c, `select api_resume_nonessential_jobs($1) n`, [b.workspace])).n }));
  icmd('retryJob', z.object({ job: uuid }).strict(), async (c, b, key) => ({ id: (await one(c, `select api_retry_job($1,$2) id`, [b.job, key])).id }));

  // ------------------------------------------------------------------ audit & incidents
  app.get('/v1/audit/search', async (req) => {
    const f = q(ws.merge(page as z.AnyZodObject).extend({ action: z.string().max(80).optional(), entity: z.string().max(80).optional(), actor: uuid.optional(),
      from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() }), req);
    return read(req, async (c) => {
      const where = `workspace_id=$1 and ($2::text is null or action ilike $2 || '%') and ($3::text is null or entity = $3) and ($4::uuid is null or actor = $4)
                     and ($5::timestamptz is null or created_at >= $5) and ($6::timestamptz is null or created_at <= $6)`;
      const p = [f.workspace, f.action ?? null, f.entity ?? null, f.actor ?? null, f.from ?? null, f.to ?? null];
      const items = (await c.query(`select id, actor, action, entity, entity_id, environment, detail, created_at from audit_events where ${where} order by id desc limit $7 offset $8`, [...p, f.limit, f.offset])).rows;
      const total = (await c.query(`select count(*)::int n from audit_events where ${where}`, p)).rows[0].n;
      const facets = { actions: (await c.query(`select distinct action from audit_events where workspace_id=$1 order by 1 limit 300`, [f.workspace])).rows.map((r: any) => r.action),
        entities: (await c.query(`select distinct entity from audit_events where workspace_id=$1 order by 1 limit 100`, [f.workspace])).rows.map((r: any) => r.entity),
        actors: (await c.query(`select distinct actor from audit_events where workspace_id=$1 and actor is not null limit 100`, [f.workspace])).rows.map((r: any) => r.actor) };
      return { items, total, facets, immutable: 'audit_events is append-only: a database trigger rejects UPDATE and DELETE for every role.' };
    });
  });
  icmd('acknowledgeAlert', z.object({ alert: z.number().int().min(1), note: z.string().max(500).optional() }).strict(), async (c, b) => { await c.query(`select api_ack_alert($1,$2)`, [b.alert, b.note ?? '']); return {}; });
  icmd('recordIncident', z.object({ workspace: uuid, class: z.string().min(2).max(60), severity: z.enum(['info', 'warn', 'critical']), message: z.string().min(3).max(1000) }).strict(),
    async (c, b) => ({ id: (await one(c, `select api_record_incident($1,$2,$3,$4) id`, [b.workspace, b.class, b.severity, b.message])).id }));

  // ------------------------------------------------------------------ transfers (paper lifecycle only)
  icmd('confirmPaperTransfer', z.object({ transfer: uuid, ref: z.string().max(120).optional() }).strict(), async (c, b) => { await c.query(`select api_confirm_paper_transfer($1,$2)`, [b.transfer, b.ref ?? '']); return {}; });
  icmd('failPaperTransfer', z.object({ transfer: uuid }).strict(), async (c, b) => { await c.query(`select api_fail_paper_transfer($1)`, [b.transfer]); return {}; });

  // ------------------------------------------------------------------ limits / scoped emergency
  const limits = z.object({ max_order_notional_bps_of_bucket: z.number().int().min(0).max(10000).optional(), max_slippage_bps: z.number().int().min(0).max(10000).optional(), max_quote_age_ms: z.number().int().min(0).max(3_600_000).optional() }).strict()
    .refine((l) => Object.keys(l).length > 0, { message: 'provide at least one limit' });
  icmd('tightenGlobalLimits', z.object({ workspace: uuid, limits, reason }).strict(), async (c, b) => ({ limits: (await one(c, `select api_tighten_global_limits($1,$2::jsonb,$3) l`, [b.workspace, JSON.stringify(b.limits), b.reason])).l }));
  icmd('requestLimitIncrease', z.object({ workspace: uuid, limits, reason }).strict(), async (c, b) => ({ approval: (await one(c, `select api_request_limit_increase($1,$2::jsonb,$3) id`, [b.workspace, JSON.stringify(b.limits), b.reason])).id }));
  icmd('applyLimitIncrease', z.object({ approval: uuid }).strict(), async (c, b) => ({ limits: (await one(c, `select api_apply_limit_increase($1) l`, [b.approval])).l }));
  icmd('setBucketState', z.object({ bucket: uuid, state: z.enum(['active', 'halt_new_entries', 'exit_only', 'disabled']), reason }).strict(), async (c, b) => { await c.query(`select api_set_bucket_state($1,$2,$3)`, [b.bucket, b.state, b.reason]); return { state: b.state }; });

  // ------------------------------------------------------------------ compounding
  app.get('/v1/compounding/overview', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => ({
    buckets: (await c.query(
      `select b.id, b.name, b.kind, b.environment, b.state, b.portfolio_id, h.hwm::text hwm, h.updated_at hwm_updated_at,
              (select row_to_json(p) from (select id, version, mode, reinvest_bps, vault_bps, cross_bucket_bps, reserve_bps, tax_provision_bps, vault_bucket_id, cross_bucket_id, min_ticket::text min_ticket, drawdown_limit_bps, created_at from compounding_policies cp where cp.bucket_id=b.id order by version desc limit 1) p) latest_policy,
              coalesce((select jsonb_agg(jsonb_build_object('asset_id', d.quote_asset, 'symbol', s.symbol, 'decimals', s.decimals, 'amount', d.amount::text)) from bucket_deficits d join assets s on s.id=d.quote_asset where d.bucket_id=b.id and d.amount>0), '[]') deficits,
              coalesce((select jsonb_agg(jsonb_build_object('asset_id', e.quote_asset, 'symbol', s.symbol, 'decimals', s.decimals, 'realised', e.r)) from (select quote_asset, sum(realized_net_quote)::text r from profit_eligibility_events where bucket_id=b.id group by 1) e join assets s on s.id=e.quote_asset), '[]') realised
         from buckets b left join high_water_marks h on h.bucket_id=b.id where b.workspace_id=$1 and b.kind not in ('protected_vault','gas_reserve') order by b.created_at`, [workspace])).rows,
    vaults: (await c.query(`select id, name, environment from buckets where workspace_id=$1 and kind='protected_vault' order by created_at`, [workspace])).rows,
    targets: (await c.query(
      `select t.id, t.bucket_id, b.name bucket_name, t.period, t.target_amount::text target_amount, t.target_pct_bps, t.start_equity::text start_equity, t.target_asset, s.symbol, s.decimals, t.monitoring_only, t.created_at,
              case t.period when 'day' then date_trunc('day', now()) when 'week' then date_trunc('week', now()) when 'month' then date_trunc('month', now()) when 'quarter' then date_trunc('quarter', now()) else date_trunc('year', now()) end window_start,
              case when t.target_asset is null then null else (select coalesce(sum(e.realized_net_quote),0)::text from profit_eligibility_events e
                 where e.workspace_id=t.workspace_id and (t.bucket_id is null or e.bucket_id=t.bucket_id) and e.quote_asset=t.target_asset
                   and e.created_at >= (case t.period when 'day' then date_trunc('day', now()) when 'week' then date_trunc('week', now()) when 'month' then date_trunc('month', now()) when 'quarter' then date_trunc('quarter', now()) else date_trunc('year', now()) end)
                   and e.created_at >= t.created_at) end realised_in_period
         from target_plans t left join buckets b on b.id=t.bucket_id left join assets s on s.id=t.target_asset where t.workspace_id=$1 order by t.created_at desc`, [workspace])).rows,
    note: 'Targets are monitoring-only and never force trades. Progress = net realised profit recorded in profit_eligibility_events since the later of the period start and the plan creation, in the plan\'s reporting asset. Unrealised PnL is not computed (no price feed).',
  })); });
  icmd('setCompoundingTarget', z.object({ workspace: uuid, bucket: uuid.optional(), period: z.enum(['day', 'week', 'month', 'quarter', 'year']), asset: uuid, targetAmount: amount.optional(), targetPctBps: z.number().int().min(1).max(1000000).optional(), startEquity: amount.default('0') }).strict()
    .refine((b) => b.targetAmount !== undefined || b.targetPctBps !== undefined, { message: 'provide an absolute amount and/or a percentage' }),
    async (c, b) => ({ id: (await one(c, `select api_set_compounding_target($1,$2,$3,$4,$5,$6,$7) id`, [b.workspace, b.bucket ?? null, b.period, b.asset, b.targetAmount ?? null, b.targetPctBps ?? null, b.startEquity])).id }));

  // ------------------------------------------------------------------ treasury
  app.get('/v1/treasury/cashflow', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => {
    const flows = (await c.query(
      `select e.environment, s.id asset_id, s.symbol, s.decimals,
              coalesce(sum(p.amount) filter (where e.kind='deposit' and a.state='available'),0)::text deposits,
              coalesce(sum(p.amount) filter (where e.kind='allocate' and a.bucket_id is not null),0)::text allocations,
              coalesce(sum(p.amount) filter (where e.kind='vault_release' and a.state='available'),0)::text vault_releases,
              coalesce(sum(p.amount) filter (where e.kind in ('transfer_logical','transfer_confirm') and a.state='available' and p.amount>0),0)::text transfers_in,
              coalesce(sum(p.amount) filter (where e.kind='transfer_pending' and p.amount>0),0)::text transfers_pending
         from ledger_entries e join ledger_postings p on p.entry_id=e.id join ledger_accounts a on a.id=p.account_id join assets s on s.id=p.asset_id
        where e.workspace_id=$1 group by 1,2,3,4 order by 1,3`, [workspace])).rows;
    const pool = (await c.query(`select a.environment, a.asset_id, coalesce(sum(a.balance),0)::text balance from ledger_accounts a where a.workspace_id=$1 and a.bucket_id is null and a.wallet_chain_account_id is not null and a.state='available' group by 1,2`, [workspace])).rows;
    const fees = (await c.query(`select a.environment, a.bucket_id, b.name bucket_name, s.id asset_id, s.symbol, s.decimals, a.balance::text fees from ledger_accounts a join assets s on s.id=a.asset_id left join buckets b on b.id=a.bucket_id where a.workspace_id=$1 and a.state='fees_expense' and a.balance<>0`, [workspace])).rows;
    const realised = (await c.query(`select p.environment, b.id bucket_id, b.name bucket_name, s.symbol, s.decimals, s.id asset_id, sum(p.realized_pnl_quote)::text realised from positions p join buckets b on b.id=p.bucket_id join assets s on s.id=p.quote_asset where b.workspace_id=$1 group by 1,2,3,4,5,6`, [workspace])).rows;
    const held = (await c.query(`select a.environment, a.state, b.id bucket_id, b.name bucket_name, s.id asset_id, s.symbol, s.decimals, sum(a.balance)::text balance from ledger_accounts a join assets s on s.id=a.asset_id join buckets b on b.id=a.bucket_id where a.workspace_id=$1 and a.state in ('vault','restricted','fee_reserve') and a.balance<>0 group by 1,2,3,4,5,6,7`, [workspace])).rows;
    const lots = (await c.query(`select p.environment, b.name bucket_name, ab.symbol base_symbol, ab.decimals base_decimals, aq.symbol quote_symbol, aq.decimals quote_decimals, p.qty::text qty, p.cost_basis_quote::text cost_basis, p.realized_pnl_quote::text realised from positions p join buckets b on b.id=p.bucket_id join assets ab on ab.id=p.base_asset join assets aq on aq.id=p.quote_asset where b.workspace_id=$1 order by b.name, ab.symbol`, [workspace])).rows;
    return { flows, pool, fees, realised, held, lots,
      notes: { scope: 'Reconciliation is ledger-internal (deposits vs allocations vs wallet pool). It does not compare against on-chain or exchange balances: that needs certified read adapters.',
        tax: 'Tax provisions are an accounting set-aside (restricted balances) computed from the policy percentage. They are not tax advice and not a tax calculation or payment.',
        gbp: 'GBP cost basis and gains require historical FX and price data, which is not connected. Lots below show native-unit average cost from position records only.' } };
  }); });

  app.get('/v1/treasury/exceptions', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => ({ items: (await c.query(
    `select d.id, d.environment, d.bucket_id, b.name bucket_name, d.asset_id, s.symbol, s.decimals, d.expected::text expected, d.observed::text observed, d.source, d.note, d.status, d.created_at, d.resolved_at, d.resolution
       from reconciliation_discrepancies d join assets s on s.id=d.asset_id left join buckets b on b.id=d.bucket_id where d.workspace_id=$1 order by (d.status='open') desc, d.created_at desc`, [workspace])).rows })); });
  icmd('addReconciliationException', z.object({ workspace: uuid, bucket: uuid.optional(), asset: uuid, expected: amount, observed: amount, source: z.string().min(1).max(200), note: z.string().max(1000).optional() }).strict(),
    async (c, b) => ({ id: (await one(c, `select api_add_discrepancy($1,$2,$3,$4,$5,$6,$7) id`, [b.workspace, b.bucket ?? null, b.asset, b.expected, b.observed, b.source, b.note ?? null])).id }));
  icmd('resolveReconciliationException', z.object({ id: uuid, resolution: z.string().min(3).max(500) }).strict(), async (c, b) => { await c.query(`select api_resolve_discrepancy($1,$2)`, [b.id, b.resolution]); return {}; });
};
