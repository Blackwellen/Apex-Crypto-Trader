import type { OrderBookSnapshot } from '@apex/contracts';
import { cmpDecimal, isZeroDecimal, normDecimal } from './decimal.ts';

/** Shape per CDP docs for channel "level2" (messages arrive with channel "l2_data"). */
export interface L2Update { side: 'bid' | 'offer'; event_time?: string; price_level: string; new_quantity: string }
export interface L2Event { type: 'snapshot' | 'update'; product_id: string; updates: L2Update[] }
export interface WsEnvelope { channel: string; client_id?: string; timestamp?: string; sequence_num?: number; events?: (L2Event | Record<string, unknown>)[] }

export type SyncState = 'AWAITING_SNAPSHOT' | 'SYNCED' | 'NEEDS_RESYNC';
export type FeedResult =
  | { action: 'applied' }
  | { action: 'ignored'; reason: string }
  | { action: 'resync'; reason: 'sequence_gap' | 'sequence_regression' | 'update_before_snapshot' | 'crossed_book' | 'malformed'; detail: string };

/**
 * Pure, clock-free level2 book maintainer with SEQUENCE-GAP detection.
 * Rules (documented: sequence_num is per-connection; a jump > 1 means dropped message):
 *  - Feed it EVERY message of the connection that has sequence_num (any channel), since the counter is connection-wide.
 *  - seq == last+1 -> ok. seq == last -> duplicate, ignored. seq > last+1 -> GAP -> NEEDS_RESYNC (book unusable). seq < last -> regression -> NEEDS_RESYNC.
 *  - On NEEDS_RESYNC the caller must drop the connection (or resubscribe), call reset(), and wait for a fresh snapshot. Updates are NOT applied while unsynced.
 *  - new_quantity is the absolute size at the level (not a delta); "0" deletes it.
 */
export class L2BookSync {
  private state: SyncState = 'AWAITING_SNAPSHOT';
  private lastSeq: number | null = null;
  private lastMsgAtMs: number | null = null;
  private readonly books = new Map<string, { bids: Map<string, string>; asks: Map<string, string> }>();
  resyncCount = 0; gapCount = 0;
  constructor(private readonly products: string[]) {}

  getState(): SyncState { return this.state; }
  /** Call on every (re)connect: sequence numbers restart per connection and old books are discarded. */
  reset(): void { this.state = 'AWAITING_SNAPSHOT'; this.lastSeq = null; this.lastMsgAtMs = null; this.books.clear(); }

  private fail(reason: Extract<FeedResult, { action: 'resync' }>['reason'], detail: string): FeedResult {
    this.state = 'NEEDS_RESYNC'; this.resyncCount++; if (reason === 'sequence_gap') this.gapCount++;
    this.books.clear(); // never serve a book we know may be wrong
    return { action: 'resync', reason, detail };
  }

  feed(msg: WsEnvelope, nowMs: number): FeedResult {
    if (typeof msg?.sequence_num !== 'number' || !Number.isInteger(msg.sequence_num)) return { action: 'ignored', reason: 'no sequence_num (not a sequenced data message)' };
    if (this.state === 'NEEDS_RESYNC') return { action: 'ignored', reason: 'awaiting resync: caller must reconnect and reset()' };
    const seq = msg.sequence_num;
    if (this.lastSeq !== null) {
      if (seq === this.lastSeq) return { action: 'ignored', reason: 'duplicate sequence_num' };
      if (seq < this.lastSeq) return this.fail('sequence_regression', `seq ${seq} < last ${this.lastSeq}`);
      if (seq !== this.lastSeq + 1) return this.fail('sequence_gap', `expected ${this.lastSeq + 1} got ${seq}`);
    }
    this.lastSeq = seq; this.lastMsgAtMs = nowMs;
    if (msg.channel !== 'l2_data') return { action: 'ignored', reason: `channel ${msg.channel} tracked for sequence only` };
    if (!Array.isArray(msg.events)) return this.fail('malformed', 'l2_data without events');
    // apply atomically per message: work on copies so a malformed event cannot half-apply
    const staged = new Map<string, { bids: Map<string, string>; asks: Map<string, string> }>();
    const stage = (p: string) => { let b = staged.get(p); if (!b) { const cur = this.books.get(p); b = { bids: new Map(cur?.bids), asks: new Map(cur?.asks) }; staged.set(p, b); } return b; };
    try {
      for (const e of msg.events as L2Event[]) {
        if (!this.products.includes(e.product_id)) continue;
        if (e.type === 'snapshot') {
          const b = { bids: new Map<string, string>(), asks: new Map<string, string>() };
          staged.set(e.product_id, b);
          this.applyUpdates(b, e.updates);
        } else if (e.type === 'update') {
          if (!this.books.has(e.product_id) && !staged.has(e.product_id)) return this.fail('update_before_snapshot', e.product_id);
          this.applyUpdates(stage(e.product_id), e.updates);
        }
      }
    } catch (err) { return this.fail('malformed', (err as Error).message); }
    for (const [p, b] of staged) {
      const bb = bestOf(b.bids, 'bid'), ba = bestOf(b.asks, 'ask');
      if (bb && ba && cmpDecimal(bb, ba) >= 0) return this.fail('crossed_book', `${p} bid ${bb} >= ask ${ba}`);
    }
    for (const [p, b] of staged) this.books.set(p, b);
    if (this.books.size === this.products.length) this.state = 'SYNCED';
    return { action: 'applied' };
  }

  private applyUpdates(b: { bids: Map<string, string>; asks: Map<string, string> }, ups: L2Update[]): void {
    for (const u of ups) {
      const side = u.side === 'bid' ? b.bids : u.side === 'offer' ? b.asks : null;
      if (!side) throw new Error(`unknown side ${String(u.side)}`);
      const price = normDecimal(u.price_level);
      if (isZeroDecimal(u.new_quantity)) side.delete(price); else side.set(price, normDecimal(u.new_quantity));
    }
  }

  /** ms since last sequenced message; null if none. A feed with no messages is STALE, not "unchanged". */
  ageMs(nowMs: number): number | null { return this.lastMsgAtMs === null ? null : nowMs - this.lastMsgAtMs; }
  isStale(nowMs: number, maxAgeMs: number): boolean { const a = this.ageMs(nowMs); return a === null || a > maxAgeMs; }

  /** Throws unless SYNCED and fresh: callers can never read a gapped or stale book. */
  snapshot(product: string, nowMs: number, maxAgeMs: number, depth = 50): OrderBookSnapshot {
    if (this.state !== 'SYNCED') throw new Error(`book not usable: state=${this.state}`);
    if (this.isStale(nowMs, maxAgeMs)) throw new Error('book stale');
    const b = this.books.get(product); if (!b) throw new Error(`no book for ${product}`);
    const sorted = (m: Map<string, string>, dir: 1 | -1) => [...m].sort((x, y) => dir * cmpDecimal(x[0], y[0])).slice(0, depth).map(([price, qty]) => ({ price, qty }));
    return { symbol: product, seq: this.lastSeq ?? 0, ts: this.lastMsgAtMs ?? nowMs, bids: sorted(b.bids, -1), asks: sorted(b.asks, 1) };
  }
}
function bestOf(m: Map<string, string>, side: 'bid' | 'ask'): string | null {
  let best: string | null = null;
  for (const p of m.keys()) if (best === null || (side === 'bid' ? cmpDecimal(p, best) > 0 : cmpDecimal(p, best) < 0)) best = p;
  return best;
}
