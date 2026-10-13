import type { OrderBookSnapshot, VenueAdapter, VenueMarket, BookLevel } from '@apex/contracts';
import { formatDecimal, mulDecimal, parseDecimal } from './decimal.ts';
import { AmbiguousSubmitError, type OrderGateway, type OrderRequest, type VenueOrder } from './reconcile.ts';

export const PAPER_LABEL = 'SYNTHETIC PAPER VENUE - NOT A REAL EXCHANGE - fills are simulated and must never be mixed with live data' as const;
export interface PaperMarket extends VenueMarket { initialMid: string }
export interface PaperFill { fillId: string; clientOrderId: string; symbol: string; side: 'buy' | 'sell'; price: string; qty: string; feeQuote: string; synthetic: true; environment: 'PAPER' }
export type SyntheticBook = OrderBookSnapshot & { synthetic: true; environment: 'PAPER'; label: typeof PAPER_LABEL };

/** Deterministic xorshift-ish hash -> uint (no Math.random, no Date: same inputs => same book and fills, across runs). */
function h32(a: number, b: number, c: number): number { let x = (Math.imul(a ^ 0x9e3779b1, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(c + 1, 0x27d4eb2f)) >>> 0; x ^= x >>> 15; x = Math.imul(x, 0x2c1b3c6d) >>> 0; x ^= x >>> 12; return x >>> 0; }
const strHash = (s: string): number => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return h; };

/** Deterministic simulated venue for paper trading. `placeOrder` does not exist; use placePaperOrder (returns SYNTHETIC fills). */
export class PaperVenue implements VenueAdapter, OrderGateway {
  readonly id = 'paper-synthetic';
  readonly ukAvailability = 'UNVERIFIED' as const;
  readonly spotOnly = true as const;
  readonly synthetic = true as const;
  readonly environment = 'PAPER' as const;
  readonly label = PAPER_LABEL;
  private step = 0;
  private readonly orders = new Map<string, VenueOrder & { req: OrderRequest }>();
  readonly fills: PaperFill[] = [];
  readonly balances = new Map<string, bigint>();
  private fault: 'none' | 'timeout_after_accept' | 'timeout_before_accept' = 'none';
  createCalls = 0;
  constructor(private readonly markets: PaperMarket[], private readonly cfg: { seed: number; takerFeeBps: bigint; initialBalances: Record<string, string> }) {
    for (const [a, v] of Object.entries(cfg.initialBalances)) this.balances.set(a, parseDecimal(v));
  }
  advance(n = 1): void { this.step += n; this.matchResting(); }
  injectFault(f: PaperVenue['fault']): void { this.fault = f; }
  async listMarkets(): Promise<VenueMarket[]> { return this.markets.map(({ initialMid: _m, ...rest }) => rest); }
  private mkt(symbol: string): PaperMarket { const m = this.markets.find((x) => x.symbol === symbol); if (!m) throw new Error(`unknown paper market ${symbol}`); return m; }
  private mid(m: PaperMarket): bigint {
    const tick = parseDecimal(m.tickSize); const base = parseDecimal(m.initialMid);
    const drift = (BigInt(h32(this.cfg.seed, strHash(m.symbol), this.step) % 41) - 20n) * tick * 5n; // deterministic bounded walk around initial mid
    return base + drift;
  }
  private levels(m: PaperMarket, side: 'bid' | 'ask'): BookLevel[] {
    const tick = parseDecimal(m.tickSize), lot = parseDecimal(m.lotSize); const mid = this.mid(m);
    return Array.from({ length: 10 }, (_, i) => {
      const off = BigInt(i + 1) * tick; const price = side === 'bid' ? mid - off : mid + off;
      const q = lot * BigInt(1 + (h32(this.cfg.seed, strHash(m.symbol) + (side === 'bid' ? 1 : 2), this.step * 16 + i) % 100));
      return { price: formatDecimal(price), qty: formatDecimal(q) };
    });
  }
  async getOrderBook(symbol: string): Promise<SyntheticBook> {
    const m = this.mkt(symbol);
    return { symbol, seq: this.step, ts: this.step * 1000, bids: this.levels(m, 'bid'), asks: this.levels(m, 'ask'), synthetic: true, environment: 'PAPER', label: PAPER_LABEL };
  }
  /** Simulated fill against the synthetic book. Idempotent on clientOrderId. */
  placePaperOrder(req: OrderRequest): VenueOrder {
    const existing = this.orders.get(req.clientOrderId); if (existing) return strip(existing);
    const m = this.mkt(req.symbol); const qty = parseDecimal(req.qty); const lot = parseDecimal(m.lotSize);
    if (qty <= 0n || qty % lot !== 0n) throw Object.assign(new Error('qty not a multiple of lotSize'), { definitiveReject: true });
    if (req.type === 'limit' && !req.price) throw Object.assign(new Error('limit order needs price'), { definitiveReject: true });
    const o = { venueOrderId: `paper-${req.clientOrderId}`, clientOrderId: req.clientOrderId, status: 'open' as VenueOrder['status'], filledQty: '0', req };
    this.orders.set(req.clientOrderId, o);
    this.tryFill(o);
    return strip(o);
  }
  private tryFill(o: VenueOrder & { req: OrderRequest }): void {
    const { req } = o; const m = this.mkt(req.symbol);
    const book = this.levels(m, req.side === 'buy' ? 'ask' : 'bid');
    let remaining = parseDecimal(req.qty) - parseDecimal(o.filledQty);
    for (const lv of book) {
      if (remaining <= 0n) break;
      const p = parseDecimal(lv.price);
      if (req.type === 'limit') { const lim = parseDecimal(req.price!); if (req.side === 'buy' ? p > lim : p < lim) break; }
      const take = remaining < parseDecimal(lv.qty) ? remaining : parseDecimal(lv.qty);
      const notional = mulDecimal(take, p); const fee = (notional * this.cfg.takerFeeBps) / 10_000n;
      const baseBal = this.balances.get(m.base) ?? 0n, quoteBal = this.balances.get(m.quote) ?? 0n;
      if (req.side === 'buy') { if (quoteBal < notional + fee) { if (o.filledQty === '0') { o.status = 'rejected'; } break; } this.balances.set(m.quote, quoteBal - notional - fee); this.balances.set(m.base, baseBal + take); }
      else { if (baseBal < take) { if (o.filledQty === '0') { o.status = 'rejected'; } break; } this.balances.set(m.base, baseBal - take); this.balances.set(m.quote, quoteBal + notional - fee); }
      remaining -= take; o.filledQty = formatDecimal(parseDecimal(o.filledQty) + take);
      this.fills.push({ fillId: `pf-${this.fills.length + 1}`, clientOrderId: req.clientOrderId, symbol: req.symbol, side: req.side, price: lv.price, qty: formatDecimal(take), feeQuote: formatDecimal(fee), synthetic: true, environment: 'PAPER' });
    }
    if (o.status !== 'rejected') o.status = remaining === 0n ? 'filled' : parseDecimal(o.filledQty) > 0n ? 'partially_filled' : req.type === 'market' ? 'expired' : 'open'; // unfilled market remainder expires (IOC-like)
  }
  private matchResting(): void { for (const o of this.orders.values()) if ((o.status === 'open' || o.status === 'partially_filled') && o.req.type === 'limit') this.tryFill(o); }

  // ---- OrderGateway (for reconciler tests: simulates lost responses) ----
  async createOrder(req: OrderRequest): Promise<VenueOrder> {
    this.createCalls++;
    if (this.fault === 'timeout_before_accept') { this.fault = 'none'; throw new AmbiguousSubmitError('timeout (request may not have reached venue)'); }
    const o = this.placePaperOrder(req);
    if (this.fault === 'timeout_after_accept') { this.fault = 'none'; throw new AmbiguousSubmitError('timeout (venue accepted but response lost)'); }
    return o;
  }
  async getOrderByClientId(id: string): Promise<VenueOrder | null> { const o = this.orders.get(id); return o ? strip(o) : null; }
  async listOpenOrders(symbol: string): Promise<VenueOrder[]> { return [...this.orders.values()].filter((o) => o.req.symbol === symbol && (o.status === 'open' || o.status === 'partially_filled')).map(strip); }
}
const strip = ({ req: _r, ...o }: VenueOrder & { req: OrderRequest }): VenueOrder => ({ ...o });
