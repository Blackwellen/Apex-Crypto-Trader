import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RouteCtx, RouteModule } from './ctx.ts';
import { makeResearcherClient, resolveResearcherBase, ResearcherError, type ResearcherClient } from './researcher-client.ts';
import { marketsRoutes } from './markets.ts';
import { intelligenceRoutes } from './intelligence.ts';

const PROVENANCE = ['SYNTHETIC', 'REAL_USER_SUPPLIED', 'REAL_PUBLIC_API'] as const;
const SECRET_KEY = /(seed.?phrase|mnemonic|private.?key|secret|passphrase|api.?secret|withdraw)/i;   // "seed" alone is a legitimate RNG seed here
const idemKey = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const httpErr = (statusCode: number, code: string, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { statusCode, code, extra });

function assertNoSecrets(v: unknown, path = ''): void {
  if (v && typeof v === 'object') for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (SECRET_KEY.test(k)) throw httpErr(400, 'secret_field_rejected', `field "${path}${k}" is not accepted: APEX never receives keys or seed phrases`);
    assertNoSecrets(val, path + k + '.');
  }
}

// ---------------------------------------------------------------- request schemas (exported for unit tests)
const sleeve = z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/), allocation: z.number().min(0).max(1), stage: z.enum(['research', 'paper']).default('research') }).strict();
/** Fields the researcher's POST /backtests accepts today. Optional extras are forwarded ONLY if the live researcher advertises them in its OpenAPI schema. */
export const backtestSchema = z.object({
  workspace: z.string().uuid(),
  label: z.string().trim().min(1).max(120).optional(),
  seed: z.number().int().min(0).max(2 ** 31 - 1).default(7),
  nBars: z.number().int().min(300).max(20_000).default(2000),
  includeDelisted: z.boolean().default(true),
  venue: z.enum(['cex', 'dex']).default('cex'),
  initialCashQuote: z.number().int().min(100).max(1_000_000_000).default(100_000),
  sleeves: z.array(sleeve).min(1).max(10),
  nBoot: z.number().int().min(50).max(1000).default(200),
  nPaths: z.number().int().min(50).max(1000).default(200),
  extras: z.object({
    trainFraction: z.number().min(0.5).max(0.9).optional(),
    walkForwardFolds: z.number().int().min(2).max(12).optional(),
    takerFeeBps: z.number().min(0).max(500).optional(),
    halfSpreadBps: z.number().min(0).max(500).optional(),
    gasUnits: z.number().int().min(0).max(5_000_000).optional(),
    failProb: z.number().min(0).max(0.9).optional(),
  }).strict().optional(),
}).strict().refine((b) => b.sleeves.reduce((a, s) => a + s.allocation, 0) <= 1 + 1e-9, { message: 'sleeve allocations exceed 100%', path: ['sleeves'] });
export type BacktestInput = z.infer<typeof backtestSchema>;

export const EXTRA_FIELD_MAP: Record<string, string> = { trainFraction: 'train_fraction', walkForwardFolds: 'walk_forward_folds', takerFeeBps: 'taker_fee_bps', halfSpreadBps: 'half_spread_bps', gasUnits: 'gas_units', failProb: 'fail_prob' };

const tri = z.boolean().nullable().optional(); const num = (min: number, max: number) => z.number().min(min).max(max).nullable().optional();
export const findingsSchema = z.object({
  chain_family: z.enum(['evm', 'solana']),
  sell_simulation_ok: tri, sell_simulation_slippage_bps: num(0, 100_000), buy_tax_bps: num(0, 10_000), sell_tax_bps: num(0, 10_000),
  owner_can_mint: tri, is_upgradeable_proxy: tri, ownership_renounced: tri, can_pause_transfers: tri, has_blacklist: tri, can_change_tax: tri,
  mint_authority_set: tri, freeze_authority_set: tri, permanent_delegate_set: tri, transfer_hook_set: tri, transfer_fee_bps: num(0, 10_000),
  liquidity_usd: num(0, 1e12), exit_depth_usd: num(0, 1e12), lp_locked_pct: num(0, 100), lp_lock_verified: tri, lp_lock_remaining_days: num(0, 36_500), lp_controlled_by_deployer: tri,
  top1_holder_pct: num(0, 100), top10_holder_pct: num(0, 100), deployer_holder_pct: num(0, 100), sybil_cluster_pct: num(0, 100),
  age_hours: z.number().min(0).max(1e7), deployer_prior_rugs: z.number().int().min(0).max(10_000).nullable().optional(),
  findings_age_seconds: z.number().min(0).max(1e9).default(0),
  vendors: z.array(z.object({ vendor: z.string().min(1).max(60), risk_score: z.number().min(0).max(100).nullable(), age_seconds: z.number().min(0).max(1e9).default(0), flags: z.array(z.string().max(80)).max(20).default([]) }).strict()).max(10).default([]),
}).strict();
export const tokenSafetySchema = z.object({
  strategy: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/).default('default'),
  positionUsd: z.number().min(0).max(1e9), expectedGrossEdgeBps: z.number().min(-100_000).max(100_000), estSlippageBps: z.number().min(0).max(100_000),
  findings: findingsSchema,
}).strict();

const MAX_CONCURRENT_RUNS = 2;
let inFlight = 0;

export interface ResearcherStatus { reachable: boolean; origin: string; checkedAt: string; error?: string; version?: string; mode?: string; llm?: { provider: string; enabled: boolean }; strategies?: string[]; databaseConfigured?: boolean; backtestFields?: string[] }

export function researcherStatusFn(client: ResearcherClient) {
  let cache: { at: number; v: ResearcherStatus } | null = null;
  return async (fresh = false): Promise<ResearcherStatus> => {
    if (!fresh && cache && Date.now() - cache.at < 5000) return cache.v;
    const checkedAt = new Date().toISOString(); let v: ResearcherStatus;
    try {
      const h = await client.call('/health', { timeoutMs: 3000 });
      let fields: string[] | undefined;
      try { const o = await client.call('/openapi.json', { timeoutMs: 3000 }); fields = Object.keys(o?.components?.schemas?.BacktestReq?.properties ?? {}); } catch { fields = undefined; }
      v = { reachable: true, origin: client.origin, checkedAt, version: h.version, mode: h.mode, llm: h.llm ? { provider: String(h.llm.provider), enabled: !!h.llm.enabled } : undefined,
            strategies: Array.isArray(h.strategies) ? h.strategies.map(String) : undefined, databaseConfigured: !!h.database_configured, backtestFields: fields };
    } catch (e) { v = { reachable: false, origin: client.origin, checkedAt, error: e instanceof ResearcherError ? e.message : 'researcher status unavailable' }; }
    cache = { at: Date.now(), v }; return v;
  };
}

export const researchModule: RouteModule = async (ctx: RouteCtx) => {
  const { app, read, one, q, schemas } = ctx;
  const client = makeResearcherClient(resolveResearcherBase(process.env.APEX_RESEARCHER_URL));
  const status = researcherStatusFn(client);
  const backtestTimeout = Number(process.env.APEX_RESEARCHER_BACKTEST_TIMEOUT_MS ?? 90_000);

  app.get('/v1/research/health', async () => status(true));

  app.get('/v1/research/backtests', async (req) => {
    const { workspace, limit } = q(schemas.ws.extend({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req);
    return read(req, async (c) => ({ items: (await c.query(
      `select id, status, label, data_provenance, params, error, created_at, finished_at,
              coalesce(metrics->'report'->'point_metrics', metrics->'point') point_metrics
         from simulation_runs where workspace_id=$1 and kind='backtest' order by created_at desc limit $2`, [workspace, limit])).rows }));
  });
  app.get('/v1/research/backtests/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return read(req, async (c) => {
      const r = await one(c, `select id, workspace_id, status, label, data_provenance, params, metrics, error, created_at, finished_at from simulation_runs where id=$1 and kind='backtest'`, [id]);
      if (!r) throw httpErr(404, 'not_found', 'run not found');
      return r;
    });
  });

  // ---- startBacktest: validated, idempotent, audited. Own tx per state transition so queued/running are durable while the researcher works.
  app.post('/v1/commands/startBacktest', async (req: FastifyRequest, reply: FastifyReply) => {
    assertNoSecrets(req.body);
    const key = idemKey.parse(req.headers['idempotency-key']);
    const b = backtestSchema.parse(req.body);
    const caps = await status();
    const extras = Object.entries(b.extras ?? {}).filter(([, v]) => v !== undefined);
    for (const [k] of extras) {
      if (!caps.reachable || !caps.backtestFields?.includes(EXTRA_FIELD_MAP[k])) throw httpErr(422, 'unsupported_by_researcher', `the researcher does not support "${k}" (it does not advertise ${EXTRA_FIELD_MAP[k]}); remove it or upgrade the researcher`);
    }
    if (caps.reachable && caps.strategies) for (const s of b.sleeves) if (!caps.strategies.includes(s.name)) throw httpErr(422, 'unknown_strategy', `unknown strategy "${s.name}"`);
    const { workspace, label, extras: _x, ...params } = b;
    const stored = { ...params, extras: Object.fromEntries(extras) };
    const started = (await read(req, (c) => one(c, `select api_start_backtest($1,$2,$3::jsonb,$4) r`, [workspace, `startBacktest:${key}`, JSON.stringify(stored), label ?? null]))).r as { id: string; created: boolean; status: string };
    if (!started.created) return reply.send({ ok: true, result: { id: started.id, status: started.status, replayed: true } });

    const advance = (st: string, prov: string | null, metrics: unknown, err: string | null) =>
      read(req, (c) => one(c, `select api_advance_backtest($1,$2,$3,$4::jsonb,$5) s`, [started.id, st, prov, metrics === null ? null : JSON.stringify(metrics), err]));
    const fail = async (e: unknown): Promise<never> => {
      const re = e instanceof ResearcherError ? e : null;
      const msg = re ? re.message : 'backtest failed';
      await advance('failed', null, null, msg);
      const statusCode = re?.kind === 'timeout' ? 504 : re?.kind === 'upstream_4xx' ? 422 : 502;
      return reply.code(statusCode).send({ error: re?.kind === 'unreachable' ? 'researcher_unreachable' : 'researcher_failed', message: msg, runId: started.id }) as never;
    };
    if (!caps.reachable) return fail(new ResearcherError('unreachable', 'researcher service is not reachable (run recorded as failed)'));
    if (inFlight >= MAX_CONCURRENT_RUNS) { await advance('failed', null, null, 'too many concurrent runs; retry shortly'); return reply.code(429).send({ error: 'busy', message: 'too many concurrent backtests; retry shortly', runId: started.id }); }
    inFlight++;
    try {
      await advance('running', null, null, null);
      const body: Record<string, unknown> = { seed: params.seed, n_bars: params.nBars, include_delisted: params.includeDelisted, venue: params.venue,
        initial_cash_quote: params.initialCashQuote, sleeves: params.sleeves, n_boot: params.nBoot, n_paths: params.nPaths };
      for (const [k, v] of extras) body[EXTRA_FIELD_MAP[k]] = v;        // NOTE: workspace_id is deliberately NOT forwarded; the researcher never writes our DB
      const t0 = Date.now();
      const out = await client.call('/backtests', { method: 'POST', body, timeoutMs: backtestTimeout });
      const prov = out?.data_provenance;
      if (!PROVENANCE.includes(prov) || !out.report || typeof out.report !== 'object' || out.report.data_provenance !== prov || !out.report.point_metrics)
        throw new ResearcherError('bad_response', 'researcher returned an unlabelled or malformed result; it was rejected');
      await advance('done', prov, { report: out.report, source: { service: 'researcher', version: caps.version ?? null, durationMs: Date.now() - t0 } }, null);
      return reply.send({ ok: true, result: { id: started.id, status: 'done', replayed: false, dataProvenance: prov } });
    } catch (e) {
      if (reply.sent) return reply;
      return fail(e);
    } finally { inFlight--; }
  });

  // ---- token safety gate: stateless evaluation of USER-ENTERED structured findings by the researcher's deterministic scorer.
  app.post('/v1/research/token-safety/evaluate', async (req, reply) => {
    assertNoSecrets(req.body);
    const b = tokenSafetySchema.parse(req.body);
    const caps = await status();
    if (!caps.reachable) return reply.code(503).send({ error: 'researcher_unreachable', message: 'researcher service is not reachable; no safety evaluation was produced (treat the token as NOT cleared)' });
    const findings: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b.findings)) if (v !== undefined) findings[k] = v;   // explicit null = "unknown" (fails closed in the gate)
    try {
      const out = await client.call('/token-safety/evaluate', { method: 'POST', body: findings, timeoutMs: 8000,
        query: { strategy: b.strategy, position_usd: b.positionUsd, expected_gross_edge_bps: b.expectedGrossEdgeBps, est_slippage_bps: b.estSlippageBps } });
      return { ...out, inputNote: 'Evaluated from structured findings you entered by hand. APEX did not read the chain; vendor scores are additive evidence only and can never clear a token.' };
    } catch (e) {
      if (e instanceof ResearcherError) return reply.code(e.kind === 'upstream_4xx' ? 422 : 502).send({ error: e.kind === 'upstream_4xx' ? 'rejected_findings' : 'researcher_failed', message: e.message });
      throw e;
    }
  });

  await marketsRoutes(ctx, status);
  await intelligenceRoutes(ctx, status);
};
