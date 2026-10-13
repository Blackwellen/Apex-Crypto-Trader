import { z } from 'zod';
import type { RouteCtx, RouteModule } from './ctx.ts';
import { deriveHealth, MAX_BLOCK_AGE_MS, rpcCandidates, sanitizeEndpoint, type Sample } from '../probes/health.ts';
import { startProbes } from '../probes/prober.ts';
import { makePool } from '../db.ts';

const chainId = z.string().min(3).max(80);
const notFound = () => Object.assign(new Error('not found'), { statusCode: 404, code: 'not_found' });

/** Chains (APEX-015/016): overview + detail reads, real health (from recorded probe samples only), audited enable/disable commands. */
export const chainsRoutes: RouteModule = async (ctx: RouteCtx) => {
  const { app, read, q, cmd, one, schemas } = ctx;
  const { uuid, ws } = schemas;

  const latestSamples = async (c: any, ids: string[]) => (await c.query(
    `select distinct on (chain_id, endpoint) chain_id, endpoint, observed_at, ok, latency_ms, reported_chain_id, chain_id_match, block_height::text, block_time, error
       from rpc_health_samples where chain_id = any($1) and observed_at > now() - interval '2 days' order by chain_id, endpoint, observed_at desc`, [ids])).rows as (Sample & { chain_id: string })[];
  const healthFor = (family: string, samples: Sample[]) => deriveHealth(samples, { maxBlockAgeMs: MAX_BLOCK_AGE_MS[family] });

  // GET /v1/chains/:id/health — replaces the NOT_MEASURED stub in app.ts. Status comes ONLY from recorded probe samples.
  app.get('/v1/chains/:id/health', async (req) => { const { id } = z.object({ id: chainId }).parse(req.params); return read(req, async (c) => {
    const r = (await c.query(`select id, name, family, enabled from chain_registry where id=$1`, [id])).rows[0];
    if (!r) throw notFound();
    return { chain: r, health: healthFor(r.family, await latestSamples(c, [id])) };
  }); });

  app.get('/v1/chains/overview', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => {
    const reg = (await c.query(
      `select r.id, r.namespace, r.chain_ref, r.family, r.name, r.is_testnet, r.native_symbol, r.native_decimals, r.finality_model, r.address_format, r.explorer_url, r.enabled registry_enabled,
              (r.details is not null and jsonb_typeof(coalesce(r.details->'rpcCandidates', r.details->'rpc_candidates', r.details->'rpc', r.details->'rpcUrls')) = 'array') has_rpc_candidates,
              p.enabled policy_enabled, p.reason policy_reason, p.updated_at policy_updated_at,
              coalesce((select jsonb_object_agg(k.capability, jsonb_build_object('status', k.status, 'evidence', k.evidence_ref, 'updated_at', k.updated_at)) from chain_capabilities k where k.chain_id=r.id), '{}') capabilities
         from chain_registry r left join workspace_chain_policy p on p.chain_id=r.id and p.workspace_id=$1 order by r.family, r.name`, [workspace])).rows;
    const ids = reg.map((r: any) => r.id);
    const samples = await latestSamples(c, ids);
    const wallets = (await c.query(`select x.chain_id, count(distinct w.id)::int n from wallet_chain_accounts x join wallets w on w.id=x.wallet_id where w.workspace_id=$1 group by 1`, [workspace])).rows;
    const exposure = (await c.query(
      `select s.chain_id, a.environment, s.symbol, s.decimals, a.state, sum(a.balance)::text amount from ledger_accounts a join assets s on s.id=a.asset_id
        where a.workspace_id=$1 and a.state not in ('external','equity','fees_expense') group by 1,2,3,4,5 having sum(a.balance) <> 0 order by 1,2,3,5`, [workspace])).rows;
    const strat = (await c.query(
      `select r.id chain_id, count(*)::int n from strategy_instances i join strategy_definitions d on d.key=i.strategy_key and d.version=i.strategy_version
         join chain_registry r on r.family::text = any(d.allowed_families::text[]) where i.workspace_id=$1 and i.enabled group by 1`, [workspace])).rows;
    return { items: reg.map((r: any) => ({
      ...r, enabled: r.policy_enabled ?? r.registry_enabled,
      health: healthFor(r.family, samples.filter((s) => s.chain_id === r.id)),
      walletCount: wallets.find((w: any) => w.chain_id === r.id)?.n ?? 0,
      enabledStrategies: strat.find((s: any) => s.chain_id === r.id)?.n ?? 0,
      exposure: exposure.filter((e: any) => e.chain_id === r.id).map(({ chain_id: _c, ...e }: any) => e),
    })), probes: { configured: process.env.APEX_PROBES === '1', note: 'Health is derived only from recorded probe samples. With probing off every chain is NOT_MEASURED.' } };
  }); });

  app.get('/v1/chains/:id/detail', async (req) => { const { id } = z.object({ id: chainId }).parse(req.params); const { workspace } = q(ws, req); return read(req, async (c) => {
    const r = (await c.query(
      `select r.*, p.enabled policy_enabled, p.reason policy_reason, p.updated_at policy_updated_at,
              coalesce((select jsonb_object_agg(k.capability, jsonb_build_object('status', k.status, 'evidence', k.evidence_ref, 'updated_at', k.updated_at)) from chain_capabilities k where k.chain_id=r.id), '{}') capabilities
         from chain_registry r left join workspace_chain_policy p on p.chain_id=r.id and p.workspace_id=$2 where r.id=$1`, [id, workspace])).rows[0];
    if (!r) throw notFound();
    const candidates = rpcCandidates(r.details).map(sanitizeEndpoint).filter((x): x is string => !!x);
    delete r.details;                                   // raw URLs can embed API keys: only sanitised origins leave the API
    const samples = await latestSamples(c, [id]);
    const history = (await c.query(`select endpoint, observed_at, ok, latency_ms, chain_id_match, block_height::text, error from rpc_health_samples where chain_id=$1 order by observed_at desc limit 60`, [id])).rows;
    const providers = (await c.query(
      `select endpoint, count(*)::int samples, count(*) filter (where ok)::int ok_samples, percentile_cont(0.5) within group (order by latency_ms) filter (where ok) p50, max(observed_at) last_seen
         from rpc_health_samples where chain_id=$1 and observed_at > now() - interval '24 hours' group by 1 order by 1`, [id])).rows;
    const wallets = (await c.query(
      `select w.id wallet_id, x.id wca_id, w.nickname, w.family, w.address, w.capability, w.state,
              coalesce((select jsonb_agg(jsonb_build_object('bucket', b.name, 'exclusive', a.exclusive)) from wallet_bucket_allocations a join buckets b on b.id=a.bucket_id where a.wallet_id=w.id), '[]') buckets,
              coalesce((select jsonb_agg(jsonb_build_object('environment', l.environment, 'symbol', s.symbol, 'contract', s.contract, 'decimals', s.decimals, 'state', l.state, 'amount', l.balance::text))
                          from ledger_accounts l join assets s on s.id=l.asset_id where l.wallet_chain_account_id=x.id and l.balance <> 0), '[]') balances
         from wallet_chain_accounts x join wallets w on w.id=x.wallet_id where x.chain_id=$1 and w.workspace_id=$2 order by w.nickname`, [id, workspace])).rows;
    const markets = (await c.query(`select id, contract, symbol, decimals, token_program from assets where chain_id=$1 order by symbol`, [id])).rows;
    const txs = (await c.query(
      `select i.id, i.environment, i.state, i.side, i.strategy_key, i.created_at, i.updated_at from trade_intents i join wallet_chain_accounts x on x.id=i.wallet_chain_account_id
        where x.chain_id=$1 and i.workspace_id=$2 order by i.created_at desc limit 50`, [id, workspace])).rows;
    const fees = (await c.query(
      `select f.environment, s.symbol, s.decimals, count(*)::int fills, sum(f.fee_quote)::text fee_quote, sum(f.gas_native)::text gas_native, count(f.gas_native)::int gas_recorded
         from fills f join trade_intents i on i.id=f.intent_id join wallet_chain_accounts x on x.id=i.wallet_chain_account_id join assets s on s.id=i.quote_asset
        where x.chain_id=$1 and f.workspace_id=$2 group by 1,2,3`, [id, workspace])).rows;
    const incidents = (await c.query(
      `select 'policy' kind, action label, reason detail, created_at ts from emergency_actions where workspace_id=$2 and scope='CHAIN' and scope_id=$1
       union all select 'audit', action, detail::text, created_at from audit_events where workspace_id=$2 and entity='workspace_chain_policy' and entity_id=$1
       union all select 'rpc', case when chain_id_match is false then 'chain id mismatch' else 'probe failed' end, coalesce(error,''), observed_at from rpc_health_samples where chain_id=$1 and not ok
       order by ts desc limit 60`, [id, workspace])).rows;
    return { chain: { ...r, enabled: r.policy_enabled ?? r.enabled }, health: healthFor(r.family, samples), candidates, history, providers, wallets, markets, transactions: txs, fees, incidents,
      probes: { configured: process.env.APEX_PROBES === '1' } };
  }); });

  const body = z.object({ workspace: uuid, chain: chainId, reason: z.string().min(3).max(300).optional() }).strict();
  cmd('enableChain', body, async (c, b) => ({ enabled: (await one(c, `select api_set_chain_enabled($1,$2,true,$3) e`, [b.workspace, b.chain, b.reason ?? null])).e,
    note: 'monitoring enabled; trading still requires CERTIFIED capabilities and all deployment gates' }));
  cmd('disableChain', body.extend({ reason: z.string().min(3).max(300) }).strict(), async (c, b) => ({ enabled: (await one(c, `select api_set_chain_enabled($1,$2,false,$3) e`, [b.workspace, b.chain, b.reason])).e }));

  const stop = startProbes(process.env, makePool);
  if (stop) app.addHook('onClose', async () => { await stop(); });
};
