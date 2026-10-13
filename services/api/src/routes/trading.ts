import { z } from 'zod';
import type { RouteCtx, RouteModule } from './ctx.ts';

const amountS = z.string().regex(/^[0-9]{1,60}$/, 'base-unit integer string').refine((s) => BigInt(s) > 0n, 'must be greater than zero');
export const paperIntentSchema = (uuid: z.ZodString) => z.object({
  workspace: uuid, bucket: uuid, walletChainAccount: uuid, baseAsset: uuid, quoteAsset: uuid, side: z.enum(['buy', 'sell']),
  quantity: amountS, notional: amountS, limitPrice: z.string().regex(/^[0-9]{1,22}(\.[0-9]{1,18})?$/).optional(),
  strategy: z.string().regex(/^[a-z0-9_.]{3,80}$/).default('manual_paper'),
}).strict();

/** Trading (APEX-007) + execution analytics (APEX-017). Everything is derived from recorded rows; unrecorded values are returned as null. */
export const tradingRoutes: RouteModule = async (ctx: RouteCtx) => {
  const { app, read, q, cmd, one, schemas } = ctx; const { uuid, ws, page } = schemas;

  app.get('/v1/orders/board', async (req) => { const { workspace, limit, offset } = q((ws as any).merge(page), req) as { workspace: string; limit: number; offset: number }; return read(req, async (c) => ({ items: (await c.query(
    `select i.id, i.environment, i.bucket_id, b.name bucket, i.strategy_key, i.side, i.state, i.venue, i.quantity::text quantity, i.notional::text notional, i.limit_price::text limit_price, i.created_at, i.updated_at,
            ab.symbol base_symbol, ab.decimals base_decimals, aq.symbol quote_symbol, aq.decimals quote_decimals, x.chain_id, i.reservation_id is not null reserved,
            coalesce((select sum(f.qty) from fills f where f.intent_id=i.id),0)::text filled_qty, (select count(*) from fills f where f.intent_id=i.id)::int fill_count,
            (select avg(f.expected_slippage_bps)::float8 from fills f where f.intent_id=i.id) expected_slippage_bps, (select avg(f.realised_slippage_bps)::float8 from fills f where f.intent_id=i.id) realised_slippage_bps,
            (select sum(f.gas_native)::text from fills f where f.intent_id=i.id) gas_native,
            (select r.decision from risk_decisions r where r.intent_id=i.id order by r.created_at desc limit 1) risk_decision,
            (select jsonb_agg(jsonb_build_object('from', e.from_state, 'to', e.to_state, 'at', e.created_at, 'detail', e.detail) order by e.id) from order_events e where e.intent_id=i.id) timeline
       from trade_intents i join buckets b on b.id=i.bucket_id join assets ab on ab.id=i.base_asset join assets aq on aq.id=i.quote_asset join wallet_chain_accounts x on x.id=i.wallet_chain_account_id
      where i.workspace_id=$1 order by i.created_at desc limit $2 offset $3`, [workspace, limit, offset])).rows })); });

  app.get('/v1/trades/board', async (req) => { const { workspace, limit, offset } = q((ws as any).merge(page), req) as { workspace: string; limit: number; offset: number }; return read(req, async (c) => ({ items: (await c.query(
    `select f.id, f.intent_id, f.environment, f.venue_fill_id, f.qty::text qty, f.quote_amount::text quote_amount, f.fee_quote::text fee_quote, f.created_at,
            f.expected_slippage_bps, f.realised_slippage_bps, f.gas_native::text gas_native, f.priority_fee_native::text priority_fee_native,
            i.strategy_key, i.side, i.venue, ab.symbol base_symbol, ab.decimals base_decimals, aq.symbol quote_symbol, aq.decimals quote_decimals, x.chain_id
       from fills f join trade_intents i on i.id=f.intent_id join assets ab on ab.id=i.base_asset join assets aq on aq.id=i.quote_asset join wallet_chain_accounts x on x.id=i.wallet_chain_account_id
      where f.workspace_id=$1 order by f.created_at desc limit $2 offset $3`, [workspace, limit, offset])).rows })); });

  app.get('/v1/orders/:id', async (req) => { const { id } = z.object({ id: uuid }).parse(req.params); return read(req, async (c) => {
    const i = (await c.query(
      `select i.*, i.quantity::text quantity_s, i.notional::text notional_s, ab.symbol base_symbol, ab.decimals base_decimals, aq.symbol quote_symbol, aq.decimals quote_decimals, x.chain_id, w.nickname wallet, w.capability wallet_capability, b.name bucket
         from trade_intents i join buckets b on b.id=i.bucket_id join assets ab on ab.id=i.base_asset join assets aq on aq.id=i.quote_asset
         join wallet_chain_accounts x on x.id=i.wallet_chain_account_id join wallets w on w.id=x.wallet_id where i.id=$1`, [id])).rows[0];
    if (!i) throw Object.assign(new Error('not found'), { statusCode: 404, code: 'not_found' });
    const events = (await c.query(`select id, event_key, from_state, to_state, detail, created_at from order_events where intent_id=$1 order by id`, [id])).rows;
    const fills = (await c.query(`select id, venue_fill_id, qty::text qty, quote_amount::text quote_amount, fee_quote::text fee_quote, expected_slippage_bps, realised_slippage_bps, gas_native::text gas_native, created_at from fills where intent_id=$1 order by created_at`, [id])).rows;
    const decisions = (await c.query(`select id, decision, reasons, policy_version, evaluator, created_at from risk_decisions where intent_id=$1 order by created_at`, [id])).rows;
    return { intent: { ...i, quantity: i.quantity_s, notional: i.notional_s }, events, fills, decisions };
  }); });

  // Execution analytics: fee waterfall from fills, pipeline-transition latency from order_events timestamps, pending/failed counts, per-strategy/venue costs.
  app.get('/v1/analytics/execution', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => {
    const waterfall = (await c.query(
      `select f.environment, aq.symbol, aq.decimals, count(*)::int fills, sum(f.quote_amount)::text gross, sum(f.fee_quote)::text fees,
              sum(f.gas_native)::text gas_native, count(f.gas_native)::int gas_recorded, avg(f.expected_slippage_bps)::float8 expected_slippage_bps, avg(f.realised_slippage_bps)::float8 realised_slippage_bps,
              count(f.expected_slippage_bps)::int slippage_recorded
         from fills f join trade_intents i on i.id=f.intent_id join assets aq on aq.id=i.quote_asset where f.workspace_id=$1 group by 1,2,3 order by 1,2`, [workspace])).rows;
    const byStrategy = (await c.query(
      `select f.environment, i.strategy_key, aq.symbol, aq.decimals, count(*)::int fills, sum(f.quote_amount)::text gross, sum(f.fee_quote)::text fees
         from fills f join trade_intents i on i.id=f.intent_id join assets aq on aq.id=i.quote_asset where f.workspace_id=$1 group by 1,2,3,4 order by sum(f.fee_quote) desc limit 50`, [workspace])).rows;
    const byVenue = (await c.query(
      `select f.environment, coalesce(i.venue,'(none)') venue, aq.symbol, aq.decimals, count(*)::int fills, sum(f.quote_amount)::text gross, sum(f.fee_quote)::text fees
         from fills f join trade_intents i on i.id=f.intent_id join assets aq on aq.id=i.quote_asset where f.workspace_id=$1 group by 1,2,3,4 order by 1,2`, [workspace])).rows;
    const pending = (await c.query(
      `select environment, state, count(*)::int n from trade_intents where workspace_id=$1 and state in ('SUBMITTING','ACKNOWLEDGED','UNKNOWN','PARTIALLY_FILLED','APPROVAL_WAIT','RISK_EVALUATING','QUOTED','PREPARED') group by 1,2 order by 1,2`, [workspace])).rows;
    const failed = (await c.query(`select environment, count(*)::int n from trade_intents where workspace_id=$1 and state='FAILED' group by 1`, [workspace])).rows;
    const latency = (await c.query(
      `with e as (select intent_id, from_state, to_state, extract(epoch from (created_at - lag(created_at) over (partition by intent_id order by id))) * 1000 as ms from order_events where workspace_id=$1)
       select from_state, to_state, count(ms)::int n, percentile_cont(0.5) within group (order by ms) p50, percentile_cont(0.95) within group (order by ms) p95, percentile_cont(0.99) within group (order by ms) p99,
              array[count(*) filter (where ms < 10), count(*) filter (where ms >= 10 and ms < 50), count(*) filter (where ms >= 50 and ms < 100), count(*) filter (where ms >= 100 and ms < 250),
                    count(*) filter (where ms >= 250 and ms < 500), count(*) filter (where ms >= 500 and ms < 1000), count(*) filter (where ms >= 1000 and ms < 5000), count(*) filter (where ms >= 5000)] histogram
         from e where ms is not null group by 1,2 order by n desc`, [workspace])).rows;
    return { waterfall, byStrategy, byVenue, pending, failed, latency,
      latencyNote: 'Latency is the interval between consecutive recorded order_events (internal pipeline stages). It is NOT exchange wire-to-fill latency, which is not measured in this deployment.',
      gasNote: 'Gas, priority fee and slippage are shown only where the execution service recorded them on fills; otherwise they are null.' };
  }); });

  cmd('cancelIntent', z.object({ intent: uuid, reason: z.string().max(200).optional() }).strict(),
    async (c, b) => ({ state: (await one(c, `select api_cancel_intent($1,$2) s`, [b.intent, b.reason ?? null])).s }));
  cmd('createPaperIntent', paperIntentSchema(uuid), async (c, b, key) => {
    // the ticket speaks in base units; limit price is display-only. The SQL function inserts + moves to RISK_EVALUATING and nothing further: risk must ADMIT.
    const id = (await one(c, `select api_create_paper_intent($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) id`,
      [b.workspace, b.bucket, b.walletChainAccount, b.baseAsset, b.quoteAsset, b.side, b.quantity, b.notional, b.limitPrice ?? null, b.strategy, key])).id;
    return { id, state: 'RISK_EVALUATING', note: 'created in PAPER; waiting for the independent risk service to ADMIT or VETO. This ticket cannot bypass risk.' };
  });
};
