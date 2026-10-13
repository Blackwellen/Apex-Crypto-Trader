import { z } from 'zod';
import type { RouteCtx } from './ctx.ts';
import type { ResearcherStatus } from './research.ts';

const httpErr = (statusCode: number, code: string, message: string) => Object.assign(new Error(message), { statusCode, code });
export const STAGES = ['observed', 'launchpad', 'bonding_curve', 'graduating', 'migrated', 'early_dex', 'mature_dex', 'cex_listed', 'dormant'] as const;
export const TABS = ['all', 'cex', 'dex', 'launches', 'graduated', 'watchlist'] as const;

/** Tab semantics are derived from registry + operator-logged lifecycle facts only (no market data feed exists). */
export const TAB_SQL: Record<(typeof TABS)[number], string> = {
  all: 'true',
  cex: `(m.family = 'cex' or m.stage = 'cex_listed')`,
  dex: `(m.family <> 'cex' and (m.stage is null or m.stage in ('migrated','early_dex','mature_dex')))`,
  launches: `(m.stage in ('observed','launchpad','bonding_curve','graduating'))`,
  graduated: `(m.stage in ('migrated','early_dex','mature_dex','cex_listed'))`,
  watchlist: 'm.watched',
};
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m);

const listQuery = z.object({
  workspace: z.string().uuid(), tab: z.enum(TABS).default('all'), q: z.string().trim().max(200).default(''), chain: z.string().max(80).default(''),
  stage: z.enum(STAGES).optional(), limit: z.coerce.number().int().min(1).max(500).default(200),
});

export async function marketsRoutes(ctx: RouteCtx, _status: () => Promise<ResearcherStatus>) {
  const { app, read, one, cmd, q } = ctx;
  const uuid = z.string().uuid();
  const chainId = z.string().regex(/^[a-z0-9]+:[A-Za-z0-9_-]{1,64}$/);
  const contract = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);

  app.get('/v1/market/chains', async (req) => read(req, async (c) => ({ items: (await c.query(`select id, name, family, native_symbol, enabled, explorer_url, address_format, finality_model, is_testnet from chain_registry order by name`)).rows })));

  app.get('/v1/market/list', async (req) => {
    const f = q(listQuery, req);
    return read(req, async (c) => {
      const params: unknown[] = [f.workspace]; const where: string[] = [TAB_SQL[f.tab]];
      if (f.chain) { params.push(f.chain); where.push(`m.chain_id = $${params.length}`); }
      if (f.stage) { params.push(f.stage); where.push(`m.stage = $${params.length}`); }
      if (f.q) {
        const pair = f.q.split('/');
        if (pair.length === 2 && pair[0] && pair[1]) {      // BASE/QUOTE: base symbol here, quote asset (or chain native) present on the same chain
          params.push(likeEscape(pair[0].trim())); const pb = params.length; params.push(pair[1].trim().toUpperCase()); const pq = params.length;
          where.push(`(m.symbol ilike $${pb} || '%' and (exists (select 1 from assets qa where qa.chain_id = m.chain_id and upper(qa.symbol) = $${pq}) or upper(m.native_symbol) = $${pq}))`);
        } else {
          params.push('%' + likeEscape(f.q) + '%'); const p = params.length;
          where.push(`(m.symbol ilike $${p} or m.chain_id ilike $${p} or m.chain_name ilike $${p} or m.contract ilike $${p})`);
        }
      }
      params.push(f.limit);
      const rows = (await c.query(`
        with keys as (
          select chain_id, contract from assets
          union select chain_id, contract from token_lifecycles where workspace_id = $1
          union select chain_id, contract from watchlist_items where workspace_id = $1
        ), m as (
          select k.chain_id, k.contract, coalesce(a.symbol, l.symbol, w.symbol, '(unnamed)') symbol, a.decimals, (a.id is not null) in_registry,
                 cr.name chain_name, cr.family, cr.native_symbol, l.stage, l.stage_observed_at, (w.id is not null) watched
            from keys k join chain_registry cr on cr.id = k.chain_id
            left join assets a on a.chain_id = k.chain_id and a.contract = k.contract
            left join token_lifecycles l on l.workspace_id = $1 and l.chain_id = k.chain_id and l.contract = k.contract
            left join watchlist_items w on w.workspace_id = $1 and w.chain_id = k.chain_id and w.contract = k.contract
        )
        select * from m where ${where.join(' and ')} order by watched desc, symbol, chain_id limit $${params.length}`, params)).rows;
      const counts = (await one(c, `
        with keys as (select chain_id, contract from assets union select chain_id, contract from token_lifecycles where workspace_id = $1 union select chain_id, contract from watchlist_items where workspace_id = $1)
        select count(*)::int total from keys`, [f.workspace])).total;
      return { items: rows, total: counts, feed: { connected: false, note: 'No market data feed is connected: rows are identities from the canonical registry, your watchlist and your lifecycle observations. There are no prices.' } };
    });
  });

  app.get('/v1/market/asset', async (req) => {
    const p = q(z.object({ workspace: uuid, chain: chainId, contract }), req);
    return read(req, async (c) => {
      const chain = await one(c, `select id, name, family, native_symbol, native_decimals, enabled, explorer_url, address_format, finality_model, is_testnet from chain_registry where id=$1`, [p.chain]);
      if (!chain) throw httpErr(404, 'not_found', 'unknown chain');
      const asset = await one(c, `select id, chain_id, contract, symbol, decimals, token_program from assets where chain_id=$1 and contract=$2`, [p.chain, p.contract]);
      const lifecycle = await one(c, `select id, symbol, stage, stage_observed_at, source, evidence_ref, note, updated_at from token_lifecycles where workspace_id=$1 and chain_id=$2 and contract=$3`, [p.workspace, p.chain, p.contract]);
      const watch = await one(c, `select id, note, created_at from watchlist_items where workspace_id=$1 and chain_id=$2 and contract=$3`, [p.workspace, p.chain, p.contract]);
      if (!asset && !lifecycle && !watch) throw httpErr(404, 'not_found', 'this chain + contract is not in the registry, your lifecycle log or your watchlist');
      const events = lifecycle ? (await c.query(`select id, stage, observed_at, source, evidence_ref, note, recorded_at from token_lifecycle_events where lifecycle_id=$1 order by observed_at desc, id desc limit 50`, [lifecycle.id])).rows : [];
      const catalysts = lifecycle ? (await c.query(`select n.id, n.headline, n.source_name, n.source_url, n.published_at, n.verified_at from news_catalyst_links l join news_items n on n.id=l.news_id where l.lifecycle_id=$1 order by n.published_at desc`, [lifecycle.id])).rows : [];
      return { chain, asset, lifecycle, watch, events, catalysts, identity: { chainId: p.chain, contract: p.contract, canonicalKey: `${p.chain}:${p.contract}`, inRegistry: !!asset } };
    });
  });

  app.get('/v1/market/views', async (req) => {
    const p = q(z.object({ workspace: uuid, page: z.enum(['markets', 'meme_radar']).default('markets') }), req);
    return read(req, async (c) => ({ items: (await c.query(`select id, name, filters, created_by, created_at from saved_views where workspace_id=$1 and page=$2 order by name`, [p.workspace, p.page])).rows }));
  });

  app.get('/v1/market/lifecycles', async (req) => {
    const p = q(z.object({ workspace: uuid }), req);
    return read(req, async (c) => {
      const items = (await c.query(`select l.id, l.chain_id, cr.name chain_name, l.contract, l.symbol, l.stage, l.stage_observed_at, l.source, l.evidence_ref, l.note, l.updated_at,
          (w.id is not null) watched, (select count(*)::int from news_catalyst_links k where k.lifecycle_id = l.id) catalysts
        from token_lifecycles l join chain_registry cr on cr.id = l.chain_id
        left join watchlist_items w on w.workspace_id = l.workspace_id and w.chain_id = l.chain_id and w.contract = l.contract
        where l.workspace_id=$1 order by l.stage_observed_at desc limit 500`, [p.workspace])).rows;
      const strategies = (await c.query(`select key, name, stage, allowed_families from strategy_definitions order by key`)).rows;
      return { items, strategies, stages: STAGES };
    });
  });

  // ---------------- commands ----------------
  const ws = z.string().uuid();
  cmd('saveMarketView', z.object({ workspace: ws, page: z.enum(['markets', 'meme_radar']).default('markets'), name: z.string().trim().min(1).max(80),
    filters: z.object({ tab: z.enum(TABS).optional(), q: z.string().max(200).optional(), chain: z.string().max(80).optional(), stage: z.enum(STAGES).optional() }).strict() }).strict(),
    async (c, b) => ({ id: (await one(c, `select api_save_market_view($1,$2,$3,$4::jsonb) id`, [b.workspace, b.page, b.name, JSON.stringify(b.filters)])).id }));
  cmd('deleteMarketView', z.object({ view: uuid }).strict(), async (c, b) => { await c.query(`select api_delete_market_view($1)`, [b.view]); return {}; });
  cmd('watchAsset', z.object({ workspace: ws, chain: chainId, contract, symbol: z.string().trim().max(40).optional(), note: z.string().max(300).optional() }).strict(),
    async (c, b) => ({ id: (await one(c, `select api_watch_asset($1,$2,$3,$4,$5) id`, [b.workspace, b.chain, b.contract, b.symbol ?? null, b.note ?? null])).id }));
  cmd('unwatchAsset', z.object({ workspace: ws, chain: chainId, contract }).strict(), async (c, b) => { await c.query(`select api_unwatch_asset($1,$2,$3)`, [b.workspace, b.chain, b.contract]); return {}; });
  cmd('logTokenObservation', z.object({ workspace: ws, chain: chainId, contract, symbol: z.string().trim().min(1).max(40), stage: z.enum(STAGES),
    observedAt: z.string().datetime({ offset: true }), source: z.string().trim().min(2).max(200), evidenceRef: z.string().trim().max(500).optional(), note: z.string().max(500).optional() }).strict(),
    async (c, b) => one(c, `select api_log_token_observation($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9) r`, [b.workspace, b.chain, b.contract, b.symbol, b.stage, b.observedAt, b.source, b.evidenceRef ?? null, b.note ?? null]).then((r) => r.r));
}
