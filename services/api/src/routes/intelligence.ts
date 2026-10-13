import { z } from 'zod';
import type { RouteCtx } from './ctx.ts';
import type { ResearcherStatus } from './research.ts';

export async function intelligenceRoutes(ctx: RouteCtx, status: (fresh?: boolean) => Promise<ResearcherStatus>) {
  const { app, read, one, cmd, q } = ctx;
  const uuid = z.string().uuid(); const wsq = z.object({ workspace: uuid });

  app.get('/v1/intelligence/overview', async (req) => {
    const { workspace } = q(wsq, req);
    const researcher = await status();
    return read(req, async (c) => {
      const jobs = (await c.query(`select id, queue, priority, status, attempts, last_error, created_at from jobs where workspace_id=$1 and (queue like 'model%' or queue like 'llm%' or queue like 'intelligence%') order by created_at desc limit 100`, [workspace])).rows;
      const approvals = (await c.query(`select id, kind, status, subject, requested_by, not_before, created_at from approval_requests where workspace_id=$1 and status='pending' order by created_at desc limit 50`, [workspace])).rows;
      const news = (await one(c, `select count(*)::int total, count(*) filter (where verified)::int verified from news_items where workspace_id=$1`, [workspace]));
      const llm = researcher.reachable ? researcher.llm : undefined;
      return { researcher, model: {
        provider: llm ? llm.provider : null, enabled: !!llm?.enabled, state: !researcher.reachable ? 'UNKNOWN_RESEARCHER_NOT_REACHABLE' : llm?.enabled ? 'CONFIGURED' : 'DISABLED',
        budget: null, budgetNote: 'Call/token budgets are enforced inside the researcher process (ModelGateway) and are not reported by its /health endpoint, so APEX does not display a number it cannot read.',
        fallback: 'With the provider disabled every feature runs rule-based: news is entered and verified by hand, token safety uses the deterministic gate, and no model output can reach a decision.' },
        jobs, approvals, news };
    });
  });

  app.get('/v1/intelligence/news', async (req) => {
    const { workspace } = q(wsq, req);
    return read(req, async (c) => ({ items: (await c.query(`select n.id, n.headline, n.kind, n.source_name, n.source_url, n.published_at, n.observed_at, n.verified, n.verified_at, n.verification_checklist, n.verification_note,
        coalesce((select json_agg(json_build_object('lifecycle', l.lifecycle_id, 'symbol', t.symbol, 'chain', t.chain_id, 'contract', t.contract)) from news_catalyst_links l join token_lifecycles t on t.id = l.lifecycle_id where l.news_id = n.id), '[]'::json) catalysts
      from news_items n where n.workspace_id=$1 order by n.observed_at desc limit 200`, [workspace])).rows }));
  });

  cmd('addNewsItem', z.object({ workspace: uuid, headline: z.string().trim().min(3).max(300), kind: z.enum(['news', 'social_post', 'official_announcement', 'onchain_event']).default('news'),
    sourceName: z.string().trim().min(2).max(120), sourceUrl: z.string().trim().max(500).regex(/^https?:\/\/\S+$/).optional(), publishedAt: z.string().datetime({ offset: true }) }).strict(),
    async (c, b) => ({ id: (await one(c, `select api_add_news_item($1,$2,$3,$4,$5,$6::timestamptz) id`, [b.workspace, b.headline, b.kind, b.sourceName, b.sourceUrl ?? null, b.publishedAt])).id }));
  cmd('verifyNewsItem', z.object({ item: uuid, checklist: z.object({ source_identified: z.boolean(), timestamp_confirmed: z.boolean(), primary_source_corroborated: z.boolean(), not_promotional_or_paid: z.boolean() }).strict(), note: z.string().trim().min(5).max(500) }).strict(),
    async (c, b) => { await c.query(`select api_verify_news_item($1,$2::jsonb,$3)`, [b.item, JSON.stringify(b.checklist), b.note]); return { verified: true }; });
  cmd('linkCatalyst', z.object({ item: uuid, lifecycle: uuid, note: z.string().max(300).optional() }).strict(),
    async (c, b) => ({ id: (await one(c, `select api_link_catalyst($1,$2,$3) id`, [b.item, b.lifecycle, b.note ?? null])).id }));
}
