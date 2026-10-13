import type { RouteModule } from './ctx.ts';
import { chainsRoutes } from './chains.ts';
import { strategiesRoutes } from './strategies.ts';
import { tradingRoutes } from './trading.ts';
/** Single registration point for the UI-trading feature set (chains, strategies, trading/execution). */
export const uiTradingRoutes: RouteModule = async (ctx) => { await chainsRoutes(ctx); await strategiesRoutes(ctx); await tradingRoutes(ctx); };
