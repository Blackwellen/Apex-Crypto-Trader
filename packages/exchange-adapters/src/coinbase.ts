import type { OrderBookSnapshot, VenueAdapter, VenueMarket } from '@apex/contracts';
import { fetchTransport, VenueHttpError, type Transport } from './http.ts';
import type { RateLimitManager } from './ratelimit.ts';

export const COINBASE_PUBLIC_BASE = 'https://api.coinbase.com/api/v3/brokerage';
export const COINBASE_WS_URL = 'wss://advanced-trade-ws.coinbase.com';
export const COINBASE_DOCS = [
  'https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/rest-api',
  'https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-channels',
  'https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/websocket/level2',
];

/**
 * Coinbase Advanced Trade PUBLIC market-data adapter. Unauthenticated endpoints only (/market/*). Public responses are cached ~1s by Coinbase.
 * There is NO order placement, NO account endpoint, NO JWT/credential code in this class. `placeOrder` is intentionally absent.
 * ukAvailability is UNVERIFIED: this adapter reading public data says nothing about whether a UK retail user may trade on the venue.
 */
export class CoinbasePublicVenue implements VenueAdapter {
  readonly id = 'coinbase-advanced-public';
  readonly ukAvailability = 'UNVERIFIED' as const;
  readonly spotOnly = true as const;
  constructor(private readonly transport: Transport = fetchTransport, private readonly limiter?: RateLimitManager, private readonly base = COINBASE_PUBLIC_BASE) {}

  private async get(path: string, weight = 1): Promise<any> {
    const run = async () => {
      const r = await this.transport({ method: 'GET', url: `${this.base}${path}` });
      if (r.status === 429) throw new VenueHttpError('rate limited', 429, r.headers['retry-after'] ? Number(r.headers['retry-after']) : undefined);
      if (r.status < 200 || r.status >= 300) throw new VenueHttpError(`HTTP ${r.status} ${path}`, r.status);
      return r.json;
    };
    return this.limiter ? this.limiter.execute({ weight, retryable: true }, run) : run();
  }

  async listMarkets(): Promise<VenueMarket[]> {
    const j = await this.get('/market/products?product_type=SPOT&limit=1000');
    if (!Array.isArray(j?.products)) throw new VenueHttpError('malformed products response', 502);
    return j.products.map((p: any): VenueMarket => ({
      symbol: String(p.product_id), base: String(p.base_currency_id), quote: String(p.quote_currency_id),
      tickSize: String(p.quote_increment), lotSize: String(p.base_increment), minNotional: String(p.quote_min_size),
      // any trading restriction => offline: fail closed
      status: p.status === 'online' && !p.is_disabled && !p.trading_disabled && !p.cancel_only && !p.limit_only && !p.post_only && !p.auction_mode ? 'online' : 'offline',
    }));
  }

  /** REST book carries no sequence number: seq is 0 and consumers must treat it as a point-in-time snapshot (use ts for freshness). */
  async getOrderBook(symbol: string, depth = 50): Promise<OrderBookSnapshot> {
    if (!/^[A-Z0-9]{2,12}-[A-Z0-9]{2,12}$/.test(symbol)) throw new VenueHttpError(`bad symbol ${symbol}`, 400);
    const j = await this.get(`/market/product_book?product_id=${symbol}&limit=${depth}`);
    const b = j?.pricebook;
    if (!b || b.product_id !== symbol) throw new VenueHttpError('malformed or mismatched book', 502);
    const lv = (a: any[]) => a.map((x) => ({ price: String(x.price), qty: String(x.size) }));
    const ts = Date.parse(b.time);
    if (!Number.isFinite(ts)) throw new VenueHttpError('book without valid time', 502);
    return { symbol, seq: 0, ts, bids: lv(b.bids ?? []), asks: lv(b.asks ?? []) };
  }
}
