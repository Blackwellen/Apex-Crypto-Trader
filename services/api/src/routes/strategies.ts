import { z } from 'zod';
import type { RouteCtx, RouteModule } from './ctx.ts';

const FAMILIES = ['evm', 'svm', 'sui', 'aptos', 'tron', 'cosmos', 'bitcoin', 'ton', 'near', 'cex'] as const;
const slug = z.string().regex(/^[a-z][a-z0-9_]{2,39}$/, 'lowercase letters, digits and underscore; 3-40 chars');
const tag = z.string().regex(/^[a-z0-9_:.-]{2,60}$/);
const bound = z.object({ min: z.number().finite(), max: z.number().finite(), default: z.number().finite() }).strict()
  .refine((b) => b.min <= b.default && b.default <= b.max, { message: 'require min <= default <= max' });
const paramName = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);
const stratKey = z.string().min(3).max(120).regex(/^[a-z0-9_.]+$/);

export const createStrategySchema = (uuid: z.ZodString) => z.object({
  workspace: uuid, slug, name: z.string().trim().min(3).max(120),
  category: z.enum(['cex_directional', 'cex_microstructure', 'cex_relative_value', 'arbitrage', 'allocation', 'onchain_research', 'intelligence', 'monitor', 'risk', 'custom']).default('custom'),
  summary: z.string().max(600).default(''), families: z.array(z.enum(FAMILIES)).min(1).max(10),
  dataSources: z.array(tag).max(12).default([]), regimes: z.array(tag).max(8).default([]),
  paramBounds: z.record(paramName, bound).default({}).refine((o) => Object.keys(o).length <= 40, 'too many parameters'),
  riskBudget: z.object({ maxOrderBpsOfBudget: z.number().int().min(0).max(10000), maxDailyLossBps: z.number().int().min(0).max(10000).default(100) }).strict(),
  validationPlan: z.object({ paperDays: z.number().int().min(1).max(365), minTrades: z.number().int().min(1).max(100000), notes: z.string().max(500).default('') }).strict(),
  clonedFrom: stratKey.optional(),
}).strict();

/** Strategies (APEX-005/006): catalogue + detail reads (RLS) and audited commands. Never invents metrics: empty arrays mean "no runs yet". */
export const strategiesRoutes: RouteModule = async (ctx: RouteCtx) => {
  const { app, read, q, cmd, one, schemas } = ctx; const { uuid, ws } = schemas;

  app.get('/v1/strategies/catalog', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => {
    const items = (await c.query(
      `select d.key, d.version, d.name, d.stage catalogue_stage, coalesce(sd.stage, 'research') stage, d.spot_only, d.allowed_families, d.evidence, (d.evidence <> '{}'::jsonb) has_evidence,
              d.category, d.summary, d.data_sources, d.regimes, d.param_bounds, d.risk_budget, d.validation_plan, d.workspace_id, d.cloned_from, d.created_at,
              coalesce((select jsonb_agg(jsonb_build_object('bucket_id', i.bucket_id, 'bucket', b.name, 'environment', i.environment, 'enabled', i.enabled, 'params', i.params) order by b.name)
                          from strategy_instances i join buckets b on b.id=i.bucket_id where i.workspace_id=$1 and i.strategy_key=d.key), '[]') instances,
              (select count(*) from trade_intents t where t.workspace_id=$1 and t.strategy_key=d.key)::int intents
         from strategy_definitions d left join strategy_deployments sd on sd.workspace_id=$1 and sd.strategy_key=d.key and sd.strategy_version=d.version
        order by d.workspace_id nulls first, d.key, d.version desc`, [workspace])).rows;
    const approvals = (await c.query(`select id, subject, status, requested_by, created_at from approval_requests where workspace_id=$1 and kind='strategy_stage' and status in ('pending','approved') order by created_at desc`, [workspace])).rows;
    return { items, approvals };
  }); });

  app.get('/v1/strategies/:key/detail', async (req) => { const { key } = z.object({ key: stratKey }).parse(req.params); const { workspace } = q(ws, req); return read(req, async (c) => {
    const def = (await c.query(
      `select d.*, coalesce(sd.stage, 'research') deployment_stage from strategy_definitions d left join strategy_deployments sd on sd.workspace_id=$2 and sd.strategy_key=d.key and sd.strategy_version=d.version
        where d.key=$1 order by d.version desc limit 1`, [key, workspace])).rows[0];
    if (!def) throw Object.assign(new Error('not found'), { statusCode: 404, code: 'not_found' });
    const instances = (await c.query(
      `select i.id, i.bucket_id, b.name bucket, b.state bucket_state, i.environment, i.enabled, i.params, i.version, i.updated_at from strategy_instances i join buckets b on b.id=i.bucket_id
        where i.workspace_id=$1 and i.strategy_key=$2 order by b.name`, [workspace, key])).rows;
    const budgets = (await c.query(
      `select sb.bucket_id, b.name bucket, sb.asset_id, a.symbol, a.decimals, sb.limit_amount::text limit_amount, sb.reserved_amount::text reserved_amount, sb.version
         from strategy_capital_budgets sb join buckets b on b.id=sb.bucket_id join assets a on a.id=sb.asset_id where sb.workspace_id=$1 and sb.strategy_key=$2 order by b.name`, [workspace, key])).rows;
    const signals = (await c.query(
      `select i.id, i.environment, i.side, i.state, i.created_at, ab.symbol base_symbol, aq.symbol quote_symbol from trade_intents i join assets ab on ab.id=i.base_asset join assets aq on aq.id=i.quote_asset
        where i.workspace_id=$1 and i.strategy_key=$2 order by i.created_at desc limit 50`, [workspace, key])).rows;
    const execution = (await c.query(
      `select f.environment, aq.symbol, aq.decimals, count(*)::int fills, sum(f.quote_amount)::text gross, sum(f.fee_quote)::text fees
         from fills f join trade_intents i on i.id=f.intent_id join assets aq on aq.id=i.quote_asset where i.workspace_id=$1 and i.strategy_key=$2 group by 1,2,3`, [workspace, key])).rows;
    const risk = (await c.query(
      `select r.decision, count(*)::int n from risk_decisions r join trade_intents i on i.id=r.intent_id where i.workspace_id=$1 and i.strategy_key=$2 group by 1`, [workspace, key])).rows;
    const vetoes = (await c.query(
      `select r.intent_id, r.reasons, r.created_at from risk_decisions r join trade_intents i on i.id=r.intent_id where i.workspace_id=$1 and i.strategy_key=$2 and r.decision='VETO' order by r.created_at desc limit 20`, [workspace, key])).rows;
    const runs = (await c.query(
      `select id, kind, label, status, data_provenance, created_at, finished_at, metrics from simulation_runs where workspace_id=$1 and position($2 in params::text) > 0 order by created_at desc limit 20`, [workspace, `"${key}"`])).rows;
    const jobs = (await c.query(`select id, queue, status, attempts, last_error, created_at from jobs where workspace_id=$1 and position($2 in payload::text) > 0 order by created_at desc limit 30`, [workspace, `"${key}"`])).rows;
    const audit = (await c.query(
      `select id, actor, action, entity, entity_id, environment, detail, created_at from audit_events where workspace_id=$1 and (entity_id=$2 or detail->>'strategy'=$2) order by id desc limit 50`, [workspace, key])).rows;
    const approvals = (await c.query(`select id, subject, status, requested_by, approved_by, created_at, decided_at from approval_requests where workspace_id=$1 and kind='strategy_stage' and subject->>'strategy'=$2 order by created_at desc limit 20`, [workspace, key])).rows;
    return { definition: def, stage: def.deployment_stage, instances, budgets, signals, execution, risk, vetoes, runs, jobs, audit, approvals };
  }); });

  const jsonb = (v: unknown) => JSON.stringify(v);
  cmd('createStrategy', createStrategySchema(uuid), async (c, b) => ({ key: (await one(c, `select api_create_strategy($1,$2,$3,$4,$5,$6::chain_family[],$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12) k`,
    [b.workspace, b.slug, b.name, b.category, b.summary, b.families, b.dataSources, b.regimes, jsonb(b.paramBounds),
     jsonb({ max_order_bps_of_budget: b.riskBudget.maxOrderBpsOfBudget, max_daily_loss_bps: b.riskBudget.maxDailyLossBps }),
     jsonb({ paper_days: b.validationPlan.paperDays, min_trades: b.validationPlan.minTrades, notes: b.validationPlan.notes }), b.clonedFrom ?? null])).k, stage: 'research' }));
  cmd('requestStrategyStage', z.object({ workspace: uuid, strategy: stratKey, version: z.number().int().min(1), to: z.enum(['paper', 'live_candidate']) }).strict(),
    async (c, b) => ({ approval: (await one(c, `select api_request_strategy_stage($1,$2,$3,$4) a`, [b.workspace, b.strategy, b.version, b.to])).a, note: 'an owner other than the requester must approve (decideApproval), then apply' }));
  cmd('applyStrategyStage', z.object({ approval: uuid }).strict(), async (c, b) => ({ stage: (await one(c, `select api_apply_strategy_stage($1) s`, [b.approval])).s }));
  cmd('disableStrategy', z.object({ workspace: uuid, strategy: stratKey, reason: z.string().min(3).max(300) }).strict(),
    async (c, b) => ({ instancesDisabled: (await one(c, `select api_disable_strategy($1,$2,$3) n`, [b.workspace, b.strategy, b.reason])).n }));
  cmd('setStrategyEnabled', z.object({ bucket: uuid, strategy: stratKey, enabled: z.boolean() }).strict(),
    async (c, b) => ({ enabled: (await one(c, `select api_set_strategy_enabled($1,$2,$3) e`, [b.bucket, b.strategy, b.enabled])).e }));
  cmd('configureStrategyInstance', z.object({ bucket: uuid, strategy: stratKey, params: z.object({
      order_type: z.enum(['limit', 'market']).optional(), stop_loss_bps: z.number().int().min(0).max(10000).optional(), max_order_bps_of_budget: z.number().int().min(0).max(10000).optional(),
      max_slippage_bps: z.number().int().min(0).max(10000).optional(), tuned: z.record(paramName, z.number().finite()).optional() }).strict() }).strict(),
    async (c, b) => ({ version: (await one(c, `select api_configure_strategy_instance($1,$2,$3::jsonb) v`, [b.bucket, b.strategy, jsonb(b.params)])).v }));
};
