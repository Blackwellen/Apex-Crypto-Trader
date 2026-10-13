import type { RouteModule } from './ctx.ts';

/**
 * Paper pipeline status (migration 0300). Read-only. The payload tells the console, truthfully, whether the engine PROCESSES are alive
 * (heartbeats written by `apex-execution serve` and `researcher.paper_feed`), independent of the persisted `paper_running` flag.
 * All market data behind the paper pipeline is SYNTHETIC and paper PnL is meaningless as evidence of edge: every payload says so.
 */
export const paperRoutes: RouteModule = ({ app, read, one, q, schemas }) => {
  const { ws } = schemas;
  app.get('/v1/paper/status', async (req) => {
    const { workspace } = q(ws, req);
    return read(req, async (c) => {
      const s = (await one(c, `select api_paper_status($1) r`, [workspace])).r;
      return {
        ...s,
        // headline for badges: never claim "running" unless a process is actually heartbeating
        headline: s.verdict === 'running' ? 'Engine running (paper, SYNTHETIC data)'
          : s.verdict === 'engine_not_running' ? 'Engine process NOT RUNNING (paper engine is switched on but nothing is executing)'
          : s.verdict === 'partial_feed_not_running' ? 'Execution engine running, signal feed NOT RUNNING'
          : s.verdict === 'halted' ? `Halted (${s.global_state}): new entries refused` : 'Paper engine stopped',
      };
    });
  });
};
