/**
 * UNKNOWN-order handling (spec section 8 / P0 #15): if order creation times out or errors ambiguously, the order is UNKNOWN.
 * We RECONCILE by client_order_id. We NEVER resubmit. Any new order needs a new economic intent upstream, after reconciliation.
 */
export interface OrderRequest { clientOrderId: string; symbol: string; side: 'buy' | 'sell'; type: 'limit' | 'market'; qty: string; price?: string }
export type VenueOrderStatus = 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected' | 'expired';
export interface VenueOrder { venueOrderId: string; clientOrderId: string; status: VenueOrderStatus; filledQty: string }

export class AmbiguousSubmitError extends Error {}
/** Abstraction implemented by tests/paper only; NO live implementation exists in this repo. */
export interface OrderGateway {
  createOrder(req: OrderRequest, signal?: { timeoutMs: number }): Promise<VenueOrder>;
  getOrderByClientId(clientOrderId: string): Promise<VenueOrder | null>;
  listOpenOrders(symbol: string): Promise<VenueOrder[]>;
}
export type SubmitOutcome =
  | { state: 'ACKNOWLEDGED'; order: VenueOrder }           // acked, NOT filled
  | { state: 'REJECTED'; error: string }                    // definitive venue rejection (not ambiguous)
  | { state: 'UNKNOWN'; reason: string };                   // ambiguous: must reconcile
export type ReconcileOutcome =
  | { state: 'FOUND'; order: VenueOrder }
  | { state: 'UNRESOLVED'; attempts: number; note: string }; // still unknown: escalate; DO NOT resubmit

export class UnknownOrderReconciler {
  private readonly seen = new Map<string, SubmitOutcome | ReconcileOutcome>();
  private readonly unknown = new Set<string>();
  constructor(private readonly gw: OrderGateway, private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)), private readonly opts = { attempts: 5, baseDelayMs: 500, createTimeoutMs: 5000 }) {}

  isUnknown(clientOrderId: string): boolean { return this.unknown.has(clientOrderId); }
  /** Always false for unknown/ambiguous orders - exposed so callers/tests can assert the invariant. */
  canResubmit(clientOrderId: string): boolean { return !this.seen.has(clientOrderId); }

  async submit(req: OrderRequest): Promise<SubmitOutcome> {
    if (!req.clientOrderId) throw new Error('clientOrderId required (idempotency key)');
    if (this.seen.has(req.clientOrderId)) throw new Error(`clientOrderId ${req.clientOrderId} already submitted: refusing duplicate create (reconcile instead)`);
    this.seen.set(req.clientOrderId, { state: 'UNKNOWN', reason: 'in flight' });
    let out: SubmitOutcome;
    try {
      const order = await this.gw.createOrder(req, { timeoutMs: this.opts.createTimeoutMs });
      out = order.status === 'rejected' ? { state: 'REJECTED', error: 'venue rejected' } : { state: 'ACKNOWLEDGED', order };
    } catch (e) {
      const definitive = (e as { definitiveReject?: boolean }).definitiveReject === true;
      out = definitive ? { state: 'REJECTED', error: (e as Error).message } : { state: 'UNKNOWN', reason: (e as Error).message || 'timeout' };
    }
    this.seen.set(req.clientOrderId, out);
    if (out.state === 'UNKNOWN') this.unknown.add(req.clientOrderId);
    return out;
  }

  /** Query-only. Looks up by client_order_id with backoff; falls back to scanning open orders. */
  async reconcile(req: OrderRequest): Promise<ReconcileOutcome> {
    for (let i = 0; i < this.opts.attempts; i++) {
      try {
        const o = (await this.gw.getOrderByClientId(req.clientOrderId)) ?? (await this.gw.listOpenOrders(req.symbol)).find((x) => x.clientOrderId === req.clientOrderId) ?? null;
        if (o) { this.unknown.delete(req.clientOrderId); this.seen.set(req.clientOrderId, { state: 'FOUND', order: o }); return { state: 'FOUND', order: o }; }
      } catch { /* query failure is also not evidence of absence */ }
      if (i < this.opts.attempts - 1) await this.sleep(this.opts.baseDelayMs * 2 ** i);
    }
    // "not found" can mean "not yet visible": remain UNKNOWN. Never treat absence as proof of failure.
    return { state: 'UNRESOLVED', attempts: this.opts.attempts, note: 'order not visible by client_order_id; remains UNKNOWN; escalate / re-query later; resubmission forbidden' };
  }
}
