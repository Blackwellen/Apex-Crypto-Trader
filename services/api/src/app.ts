import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z, ZodError } from 'zod';
import type { Config } from './config.ts';
import { mapPgError, withUser, type Tx } from './db.ts';
import { signDevToken, verifyBearer } from './auth.ts';

declare module 'fastify' { interface FastifyRequest { userId?: string } }

const uuid = z.string().uuid();
const amount = z.string().regex(/^[0-9]{1,60}$/, 'base-unit integer string');       // bigint as string; never JS number
const idemKey = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const ws = z.object({ workspace: uuid });
const page = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) });

/** Secrets must never enter the API. Reject any payload carrying key-material-looking fields (defence in depth; schemas are also strict). */
const SECRET_KEY = /(seed|mnemonic|private.?key|secret|passphrase|api.?secret|withdraw)/i;
function assertNoSecrets(v: unknown, path = ''): void {
  if (v && typeof v === 'object') for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (SECRET_KEY.test(k)) throw Object.assign(new Error(`field "${path}${k}" is not accepted: APEX never receives keys or seed phrases`), { statusCode: 400, code: 'secret_field_rejected' });
    assertNoSecrets(val, path + k + '.');
  }
}
const BIP39ish = /^(\w+\s+){11,23}\w+$/;

export async function buildApp(pool: pg.Pool, cfg: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024, trustProxy: false });

  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } });
  await app.register(cors, { origin: cfg.corsOrigins, methods: ['GET', 'POST'], allowedHeaders: ['authorization', 'content-type', 'idempotency-key'], maxAge: 600 });
  await app.register(rateLimit, { max: cfg.rateLimitMax, timeWindow: '1 minute', keyGenerator: (req) => req.userId ?? req.ip });

  app.setErrorHandler((e: Error & { statusCode?: number; code?: string }, _req, reply) => {
    if (e instanceof ZodError) return reply.code(400).send({ error: 'validation_failed', issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const m = mapPgError(e);
    if (m) return reply.code(m.status).send({ error: m.code, message: m.message });
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.code ?? 'bad_request', message: e.message });
    app.log.error(e);
    return reply.code(500).send({ error: 'internal_error', message: 'internal error' });      // never leak internals
  });

  // authentication for everything under /v1 (except health and the explicitly gated dev session)
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health' || req.url.startsWith('/v1/dev/')) return;
    const sub = await verifyBearer(req, cfg.jwtSecret);
    if (!sub) return reply.code(401).send({ error: 'unauthenticated' });
    req.userId = sub;
  });

  app.get('/health', async () => ({ ok: true, service: 'apex-api' }));

  // ---------- local-only dev session (disabled unless APEX_DEV_AUTH=1; refused in production by config) ----------
  if (cfg.devAuth) {
    app.post('/v1/dev/session', async (req) => {
      const body = z.object({ email: z.string().email() }).strict().parse(req.body);
      const r = await pool.query(`insert into auth.users(id,email) values ($1,$2) on conflict (email) do update set email=excluded.email returning id`, [randomUUID(), body.email]);
      return { userId: r.rows[0].id, token: await signDevToken(r.rows[0].id, cfg.jwtSecret), warning: 'DEV AUTH: local development only' };
    });
  }

  const q = <T extends z.ZodTypeAny>(schema: T, req: FastifyRequest) => schema.parse(req.query) as z.infer<T>;
  const read = async <R>(req: FastifyRequest, fn: (c: Tx) => Promise<R>) => withUser(pool, req.userId!, fn);

  // ---------- reads (RLS-scoped) ----------
  app.get('/v1/workspaces', async (req) => read(req, async (c) => ({ items: (await c.query(
    `select w.id, w.name, w.base_currency, m.role, s.global_state, s.paper_running, s.live_opt_in, s.live_feature_flag, live_allowed(w.id) as live_allowed
       from workspaces w join memberships m on m.workspace_id=w.id join workspace_settings s on s.workspace_id=w.id order by w.created_at`)).rows })));

  app.get('/v1/overview', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => {
    const settings = (await c.query(`select global_state, paper_running, live_opt_in, live_feature_flag, live_allowed(workspace_id) live_allowed from workspace_settings where workspace_id=$1`, [workspace])).rows[0];
    if (!settings) throw Object.assign(new Error('workspace not found'), { statusCode: 404, code: 'not_found' });
    const balances = (await c.query(
      `select a.environment, a.state, s.symbol, s.decimals, sum(a.balance)::text as amount
         from ledger_accounts a join assets s on s.id=a.asset_id where a.workspace_id=$1 and a.state not in ('external','equity','fees_expense') group by 1,2,3,4 order by 1,2,3`, [workspace])).rows;
    const counts = (await c.query(
      `select (select count(*) from portfolios where workspace_id=$1)::int portfolios, (select count(*) from buckets where workspace_id=$1)::int buckets,
              (select count(*) from wallets where workspace_id=$1)::int wallets, (select count(*) from trade_intents where workspace_id=$1 and state not in ('FINAL','RECONCILED','LEDGER_APPLIED','COMPOUNDING_ELIGIBLE','FAILED','CANCELLED','EXPIRED'))::int open_intents,
              (select count(*) from alerts where workspace_id=$1 and not acknowledged)::int open_alerts`, [workspace])).rows[0];
    const gates = (await c.query(`select status, count(*)::int n from deployment_gates where workspace_id=$1 group by 1`, [workspace])).rows;
    return { workspace, settings, balances, counts, gates, environmentNote: 'paper and live balances are separate ledger namespaces; live is disabled until all gates PASS' };
  }); });

  app.get('/v1/portfolios', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => ({ items: (await c.query(
    `select p.*, (select count(*) from buckets b where b.portfolio_id=p.id)::int bucket_count from portfolios p where workspace_id=$1 order by created_at`, [workspace])).rows })); });

  app.get('/v1/buckets', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => ({ items: (await c.query(
    `select b.*, (select count(*) from wallet_bucket_allocations a where a.bucket_id=b.id)::int wallet_count from buckets b where workspace_id=$1 order by created_at`, [workspace])).rows })); });

  app.get('/v1/buckets/:id', async (req) => { const { id } = z.object({ id: uuid }).parse(req.params); return read(req, async (c) => {
    const b = (await c.query(`select * from buckets where id=$1`, [id])).rows[0];
    if (!b) throw Object.assign(new Error('not found'), { statusCode: 404, code: 'not_found' });
    const balances = (await c.query(
      `select a.state, s.symbol, s.decimals, s.chain_id, a.wallet_chain_account_id, a.balance::text as amount from ledger_accounts a join assets s on s.id=a.asset_id
        where a.bucket_id=$1 and a.state not in ('external','equity','fees_expense') order by a.state, s.symbol`, [id])).rows;
    const wallets = (await c.query(`select w.id, w.nickname, w.family, w.address, w.capability, a.exclusive, a.max_allocation_bps, a.logical_ack from wallet_bucket_allocations a join wallets w on w.id=a.wallet_id where a.bucket_id=$1`, [id])).rows;
    const policies = (await c.query(`select * from compounding_policies where bucket_id=$1 order by version desc`, [id])).rows;
    const versions = (await c.query(`select version, policy, created_at from bucket_policy_versions where bucket_id=$1 order by version desc limit 20`, [id])).rows;
    const hwm = (await c.query(`select hwm::text from high_water_marks where bucket_id=$1`, [id])).rows[0]?.hwm ?? null;
    const deficits = (await c.query(`select quote_asset, amount::text from bucket_deficits where bucket_id=$1`, [id])).rows;
    return { bucket: b, balances, wallets, compoundingPolicies: policies, policyVersions: versions, highWaterMark: hwm, deficits,
      segregationNote: b.segregation === 'physical' ? 'Physical: wallet(s) dedicated to this bucket.' : b.segregation === 'logical' ? 'Logical: accounting separation only; wallet may be shared. No wallet-level security segregation.' : 'Protected: funds need approval + delay to leave.' };
  }); });

  app.get('/v1/wallets', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => ({ items: (await c.query(
    `select w.*, coalesce((select jsonb_agg(jsonb_build_object('bucket_id', a.bucket_id, 'exclusive', a.exclusive, 'bps', a.max_allocation_bps)) from wallet_bucket_allocations a where a.wallet_id=w.id), '[]') allocations,
            coalesce((select jsonb_agg(x.chain_id) from wallet_chain_accounts x where x.wallet_id=w.id), '[]') chains
       from wallets w where w.workspace_id=$1 order by created_at`, [workspace])).rows })); });

  app.get('/v1/wallets/:id', async (req) => { const { id } = z.object({ id: uuid }).parse(req.params); return read(req, async (c) => {
    const w = (await c.query(`select * from wallets where id=$1`, [id])).rows[0];
    if (!w) throw Object.assign(new Error('not found'), { statusCode: 404, code: 'not_found' });
    const accounts = (await c.query(`select x.id, x.chain_id, r.name, r.native_symbol from wallet_chain_accounts x join chain_registry r on r.id=x.chain_id where x.wallet_id=$1`, [id])).rows;
    const balances = (await c.query(
      `select a.state, a.bucket_id, s.symbol, s.decimals, a.wallet_chain_account_id, a.balance::text amount from ledger_accounts a join assets s on s.id=a.asset_id
        join wallet_chain_accounts x on x.id=a.wallet_chain_account_id where x.wallet_id=$1 and a.balance <> 0 order by 1`, [id])).rows;
    const allocations = (await c.query(`select * from wallet_bucket_allocations where wallet_id=$1`, [id])).rows;
    return { wallet: w, chainAccounts: accounts, balances, allocations, onChainBalanceNote: 'Balances shown are the internal ledger (paper or reconciled). On-chain verification requires a certified read adapter.' };
  }); });

  app.get('/v1/chain-registry', async (req) => read(req, async (c) => ({ items: (await c.query(
    `select r.*, coalesce((select jsonb_object_agg(k.capability, jsonb_build_object('status', k.status, 'evidence', k.evidence_ref)) from chain_capabilities k where k.chain_id=r.id), '{}') capabilities from chain_registry r order by family, name`)).rows })));

  app.get('/v1/chains/:id/health', async (req) => { const { id } = z.object({ id: z.string().min(3).max(80) }).parse(req.params); return read(req, async (c) => {
    const r = (await c.query(`select id, name, family, enabled from chain_registry where id=$1`, [id])).rows[0];
    if (!r) throw Object.assign(new Error('not found'), { statusCode: 404, code: 'not_found' });
    // No health probe worker exists yet: report NOT_MEASURED rather than inventing a green light.
    return { chain: r, health: { status: 'NOT_MEASURED', rpcLatencyMs: null, blockAgeMs: null, note: 'No chain health probe is running in this deployment; the status is unknown, not healthy.' } };
  }); });

  app.get('/v1/strategies', async (req) => read(req, async (c) => ({ items: (await c.query(`select * from strategy_definitions order by key, version desc`)).rows })));

  app.get('/v1/positions', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => ({ items: (await c.query(
    `select p.*, p.qty::text qty_s, p.cost_basis_quote::text cost_s, p.realized_pnl_quote::text pnl_s, b.workspace_id, b.name bucket_name, ab.symbol base_symbol, aq.symbol quote_symbol
       from positions p join buckets b on b.id=p.bucket_id join assets ab on ab.id=p.base_asset join assets aq on aq.id=p.quote_asset where b.workspace_id=$1 order by b.name`, [workspace])).rows })); });

  app.get('/v1/orders', async (req) => { const { workspace, limit, offset } = q(ws.merge(page), req); return read(req, async (c) => ({ items: (await c.query(
    `select i.id,i.environment,i.bucket_id,i.strategy_key,i.side,i.state,i.quantity::text quantity,i.notional::text notional,i.created_at,i.updated_at,
            (select jsonb_agg(jsonb_build_object('from',e.from_state,'to',e.to_state,'at',e.created_at) order by e.id) from order_events e where e.intent_id=i.id) timeline
       from trade_intents i where i.workspace_id=$1 order by i.created_at desc limit $2 offset $3`, [workspace, limit, offset])).rows })); });

  app.get('/v1/trades', async (req) => { const { workspace, limit, offset } = q(ws.merge(page), req); return read(req, async (c) => ({ items: (await c.query(
    `select f.id,f.intent_id,f.environment,f.venue_fill_id,f.qty::text qty,f.quote_amount::text quote_amount,f.fee_quote::text fee_quote,f.created_at from fills f where f.workspace_id=$1 order by f.created_at desc limit $2 offset $3`, [workspace, limit, offset])).rows })); });

  app.get('/v1/risk', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => {
    const s = (await c.query(`select global_state, global_limits, paper_running from workspace_settings where workspace_id=$1`, [workspace])).rows[0];
    const decisions = (await c.query(`select decision, count(*)::int n from risk_decisions where workspace_id=$1 group by 1`, [workspace])).rows;
    const vetoes = (await c.query(`select intent_id, reasons, created_at from risk_decisions where workspace_id=$1 and decision='VETO' order by created_at desc limit 25`, [workspace])).rows;
    const unknown = (await c.query(`select count(*)::int n from trade_intents where workspace_id=$1 and state='UNKNOWN'`, [workspace])).rows[0].n;
    const emergencies = (await c.query(`select * from emergency_actions where workspace_id=$1 order by created_at desc limit 25`, [workspace])).rows;
    const gates = (await c.query(`select g.gate_key, g.description, d.status, d.evidence_ref, d.commit_sha from required_gates g join deployment_gates d on d.gate_key=g.gate_key where d.workspace_id=$1 order by g.gate_key`, [workspace])).rows;
    return { settings: s, decisions, vetoes, unknownOrders: unknown, emergencies, gates };
  }); });

  app.get('/v1/fees', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => ({ items: (await c.query(
    `select s.symbol, s.decimals, a.bucket_id, a.balance::text fees_paid from ledger_accounts a join assets s on s.id=a.asset_id where a.workspace_id=$1 and a.state='fees_expense' and a.balance<>0`, [workspace])).rows,
    note: 'Fees recorded in the internal ledger (paper or reconciled). Live fee telemetry requires certified adapters.' })); });

  app.get('/v1/analytics', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => {
    const pnl = (await c.query(`select b.name, aq.symbol quote, sum(p.realized_pnl_quote)::text realized from positions p join buckets b on b.id=p.bucket_id join assets aq on aq.id=p.quote_asset where b.workspace_id=$1 group by 1,2`, [workspace])).rows;
    const fills = (await c.query(`select count(*)::int n, coalesce(sum(fee_quote),0)::text fees from fills where workspace_id=$1`, [workspace])).rows[0];
    return { realizedByBucket: pnl, fills, provenance: 'Derived from the internal ledger only. No market-price marks are available without a data feed; unrealised PnL is NOT computed.' };
  }); });

  app.get('/v1/targets', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => ({ items: (await c.query(`select t.*, t.target_amount::text target_amount_s, t.start_equity::text start_equity_s from target_plans t where workspace_id=$1 order by created_at desc`, [workspace])).rows, note: 'Targets are monitoring-only and never force trades.' })); });

  app.get('/v1/compounding', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => ({
    policies: (await c.query(`select * from compounding_policies where workspace_id=$1 order by bucket_id, version desc`, [workspace])).rows,
    executions: (await c.query(`select e.*, e.gross::text gross_s, e.eligible::text eligible_s from waterfall_executions e where workspace_id=$1 order by created_at desc limit 50`, [workspace])).rows })); });

  app.get('/v1/allocations', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => ({
    transfers: (await c.query(`select id,kind,status,src_bucket,dst_bucket,asset_id,amount::text amount,fee_amount::text fee,tx_ref,created_at from internal_transfers where workspace_id=$1 order by created_at desc limit 100`, [workspace])).rows,
    reservations: (await c.query(`select id,bucket_id,asset_id,amount::text amount,status,created_at from capital_reservations where workspace_id=$1 order by created_at desc limit 100`, [workspace])).rows,
    budgets: (await c.query(`select id,bucket_id,strategy_key,asset_id,limit_amount::text limit_amount,reserved_amount::text reserved_amount from strategy_capital_budgets where workspace_id=$1`, [workspace])).rows,
    approvals: (await c.query(`select id,kind,status,requested_by,approved_by,not_before,subject from approval_requests where workspace_id=$1 order by created_at desc limit 50`, [workspace])).rows })); });

  app.get('/v1/alerts', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => ({ items: (await c.query(`select * from alerts where workspace_id=$1 order by created_at desc limit 200`, [workspace])).rows })); });
  app.get('/v1/jobs', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => ({ items: (await c.query(`select id,queue,priority,essential,status,attempts,last_error,created_at from jobs where workspace_id=$1 order by created_at desc limit 200`, [workspace])).rows })); });
  app.get('/v1/audit', async (req) => { const { workspace, limit, offset } = q(ws.merge(page), req); return read(req, async (c) => ({ items: (await c.query(
    `select id, actor, action, entity, entity_id, environment, detail, created_at from audit_events where workspace_id=$1 order by id desc limit $2 offset $3`, [workspace, limit, offset])).rows })); });
  app.get('/v1/assets', async (req) => read(req, async (c) => ({ items: (await c.query(`select * from assets order by chain_id, symbol`)).rows })));

  // ---------- commands (validated, idempotent, audited by the database) ----------
  const cmd = <S extends z.ZodTypeAny>(name: string, schema: S, run: (c: Tx, b: z.infer<S>, key: string, userId: string) => Promise<unknown>) =>
    app.post(`/v1/commands/${name}`, async (req: FastifyRequest, reply: FastifyReply) => {
      assertNoSecrets(req.body);
      const key = idemKey.parse(req.headers['idempotency-key']);
      const body = schema.parse(req.body);
      const out = await withUser(pool, req.userId!, (c) => run(c, body, `${name}:${key}`, req.userId!));
      return reply.code(200).send({ ok: true, result: out });
    });
  const one = async (c: Tx, sql: string, p: unknown[]) => (await c.query(sql, p)).rows[0];

  cmd('createWorkspace', z.object({ name: z.string().min(1).max(120) }).strict(), async (c, b) => ({ id: (await one(c, `select api_create_workspace($1) id`, [b.name])).id }));
  cmd('createPortfolio', z.object({ workspace: uuid, name: z.string().min(1).max(120), environment: z.enum(['paper', 'live']).default('paper') }).strict(),
    async (c, b) => ({ id: (await one(c, `select api_create_portfolio($1,$2,$3) id`, [b.workspace, b.name, b.environment])).id }));
  cmd('createBucket', z.object({ portfolio: uuid, name: z.string().min(1).max(120), kind: z.enum(['trading', 'gas_reserve', 'protected_vault', 'research']).default('trading'),
      segregation: z.enum(['physical', 'logical', 'protected']).default('physical'), policy: z.record(z.unknown()).default({}) }).strict(),
    async (c, b) => ({ id: (await one(c, `select api_create_bucket($1,$2,$3,$4,$5::jsonb) id`, [b.portfolio, b.name, b.kind, b.segregation, JSON.stringify(b.policy)])).id }));
  cmd('updateBucketPolicy', z.object({ bucket: uuid, expectedVersion: z.number().int().min(1), policy: z.record(z.unknown()) }).strict(),
    async (c, b) => ({ version: (await one(c, `select api_update_bucket_policy($1,$2,$3::jsonb) v`, [b.bucket, b.expectedVersion, JSON.stringify(b.policy)])).v }));
  cmd('connectWallet', z.object({ workspace: uuid, nickname: z.string().min(1).max(80), family: z.enum(['evm', 'svm', 'sui', 'aptos', 'tron', 'cosmos', 'bitcoin', 'ton', 'near', 'cex']),
      address: z.string().min(20).max(120), capability: z.enum(['watch_only', 'user_signed', 'cex_view_only', 'cex_trade_only']).default('watch_only'), chains: z.array(z.string().max(80)).max(32).default([]) }).strict()
      .refine((b) => !BIP39ish.test(b.address.trim()), { message: 'address looks like a seed phrase; APEX never accepts seed phrases', path: ['address'] }),
    async (c, b) => ({ id: (await one(c, `select api_connect_wallet($1,$2,$3,$4,$5,$6) id`, [b.workspace, b.nickname, b.family, b.address.trim(), b.capability, b.chains])).id }));
  cmd('assignWalletToBucket', z.object({ wallet: uuid, bucket: uuid, exclusive: z.boolean().default(true), maxAllocationBps: z.number().int().min(1).max(10000).default(10000), logicalAck: z.boolean().default(false) }).strict(),
    async (c, b) => { await c.query(`select api_assign_wallet($1,$2,$3,$4,$5)`, [b.wallet, b.bucket, b.exclusive, b.maxAllocationBps, b.logicalAck]); return {}; });
  cmd('paperDeposit', z.object({ workspace: uuid, walletChainAccount: uuid, asset: uuid, amount: amount }).strict(),
    async (c, b, key) => ({ entry: (await one(c, `select api_paper_deposit($1,$2,$3,$4,$5) id`, [b.workspace, b.walletChainAccount, b.asset, b.amount, key])).id }));
  cmd('allocate', z.object({ workspace: uuid, bucket: uuid, walletChainAccount: uuid, asset: uuid, amount: amount }).strict(),
    async (c, b, key) => ({ entry: (await one(c, `select api_allocate($1,$2,$3,$4,$5,$6) id`, [b.workspace, b.bucket, b.walletChainAccount, b.asset, b.amount, key])).id }));
  cmd('requestCapitalTransfer', z.object({ workspace: uuid, srcBucket: uuid, srcWalletChainAccount: uuid, dstBucket: uuid, dstWalletChainAccount: uuid, asset: uuid, amount: amount }).strict(),
    async (c, b, key) => ({ id: (await one(c, `select api_request_transfer($1,$2,$3,$4,$5,$6,$7,$8) id`, [b.workspace, b.srcBucket, b.srcWalletChainAccount, b.dstBucket, b.dstWalletChainAccount, b.asset, b.amount, key])).id }));
  cmd('setStrategyBudget', z.object({ bucket: uuid, strategy: z.string().min(1).max(80), asset: uuid, limit: amount }).strict(),
    async (c, b) => ({ id: (await one(c, `select api_set_strategy_budget($1,$2,$3,$4) id`, [b.bucket, b.strategy, b.asset, b.limit])).id }));
  cmd('createBasket', z.object({ bucket: uuid, name: z.string().min(1).max(80), members: z.array(z.object({ asset: uuid, weight_bps: z.number().int().min(0).max(10000) }).strict()).min(1).max(100) }).strict(),
    async (c, b) => ({ id: (await one(c, `select api_create_basket($1,$2,$3::jsonb) id`, [b.bucket, b.name, JSON.stringify(b.members)])).id }));
  cmd('applyWaterfallPolicy', z.object({ bucket: uuid, mode: z.enum(['fixed', 'proportional', 'target_vol', 'anti_martingale', 'defensive_decompound', 'stair_step']).default('proportional'),
      reinvestBps: z.number().int().min(0).max(10000), vaultBps: z.number().int().min(0).max(10000), crossBucketBps: z.number().int().min(0).max(10000).default(0), reserveBps: z.number().int().min(0).max(10000),
      taxProvisionBps: z.number().int().min(0).max(10000).default(0), vaultBucket: uuid.optional(), vaultWalletChainAccount: uuid.optional(), crossBucket: uuid.optional(), crossWalletChainAccount: uuid.optional(),
      minTicket: amount.default('0'), drawdownLimitBps: z.number().int().min(0).max(10000).default(1000) }).strict()
      .refine((b) => b.reinvestBps + b.vaultBps + b.crossBucketBps + b.reserveBps === 10000, { message: 'waterfall must total exactly 100% (10000 bps)', path: ['reinvestBps'] }),
    async (c, b) => ({ id: (await one(c, `select api_create_compounding_policy($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) id`,
      [b.bucket, b.mode, b.reinvestBps, b.vaultBps, b.crossBucketBps, b.reserveBps, b.taxProvisionBps, b.vaultBucket ?? null, b.vaultWalletChainAccount ?? null, b.crossBucket ?? null, b.crossWalletChainAccount ?? null, b.minTicket, b.drawdownLimitBps])).id }));
  cmd('updateCompoundingTarget', z.object({ workspace: uuid, bucket: uuid.optional(), period: z.enum(['day', 'week', 'month', 'quarter', 'year']), targetAmount: amount.optional(), targetPctBps: z.number().int().min(0).max(1000000).optional(), startEquity: amount.default('0') }).strict()
      .refine((b) => b.targetAmount !== undefined || b.targetPctBps !== undefined, { message: 'provide an absolute amount and/or a percentage' }),
    async (c, b) => ({ id: (await one(c, `select api_create_target_plan($1,$2,$3,$4,$5,$6) id`, [b.workspace, b.bucket ?? null, b.period, b.targetAmount ?? null, b.targetPctBps ?? null, b.startEquity])).id }));
  const state = (name: string, st: string) => cmd(name, z.object({ workspace: uuid, reason: z.string().min(3).max(300) }).strict(),
    async (c, b) => { await c.query(`select api_set_global_state($1,$2,$3)`, [b.workspace, st, b.reason]); return { state: st }; });
  state('pauseNewEntries', 'halt_new_entries'); state('enterExitOnly', 'exit_only'); state('emergencyStop', 'emergency_stopped'); state('resumeApproved', 'active');
  cmd('startPaper', z.object({ workspace: uuid }).strict(), async (c, b) => { await c.query(`select api_set_paper_running($1,true)`, [b.workspace]); return { paperRunning: true }; });
  cmd('stopPaper', z.object({ workspace: uuid }).strict(), async (c, b) => { await c.query(`select api_set_paper_running($1,false)`, [b.workspace]); return { paperRunning: false }; });
  cmd('requestVaultRelease', z.object({ workspace: uuid, vaultBucket: uuid, walletChainAccount: uuid, asset: uuid, amount: amount }).strict(),
    async (c, b) => ({ id: (await one(c, `select api_request_vault_release($1,$2,$3,$4,$5) id`, [b.workspace, b.vaultBucket, b.walletChainAccount, b.asset, b.amount])).id }));
  cmd('decideApproval', z.object({ approval: uuid, approve: z.boolean() }).strict(), async (c, b) => { await c.query(`select api_decide_approval($1,$2)`, [b.approval, b.approve]); return {}; });
  cmd('releaseVault', z.object({ approval: uuid }).strict(), async (c, b, key) => ({ entry: (await one(c, `select api_release_vault($1,$2) id`, [b.approval, key])).id }));
  cmd('approveDeploymentGate', z.object({ workspace: uuid, gate: z.string().min(2).max(80), status: z.enum(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN']), evidenceRef: z.string().max(500).optional(), commitSha: z.string().max(64).optional() }).strict(),
    async (c, b) => { await c.query(`select api_set_gate($1,$2,$3,$4,$5)`, [b.workspace, b.gate, b.status, b.evidenceRef ?? null, b.commitSha ?? null]); return {}; });
  cmd('setLiveOptIn', z.object({ workspace: uuid, on: z.boolean() }).strict(), async (c, b) => { await c.query(`select api_set_live_opt_in($1,$2)`, [b.workspace, b.on]); return {}; });

  return app;
}
