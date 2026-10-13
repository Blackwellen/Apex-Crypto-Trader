// DB-backed per-(chain, signer) nonce allocator. All state transitions are atomic SQL functions (see migration 0101);
// this class is a thin typed wrapper. Redis/in-process locks are NOT used for correctness.
import { addressKey } from './address.ts';

/** Anything with a pg-style query(): pg.Pool, pg.Client or a PoolClient inside a caller's transaction. */
export interface Queryable { query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> }

export type ReservationState = 'reserved' | 'broadcast' | 'confirmed' | 'released';
export interface NonceReservation {
  id: string; chainId: string; signer: string; nonce: bigint; intentId: string; state: ReservationState;
  txHash: string | null; maxFeePerGas: bigint | null; maxPriorityFeePerGas: bigint | null; replacementCount: number;
}
export class NonceError extends Error {
  code: 'inflight_limit' | 'underpriced' | 'bad_state' | 'other';
  constructor(code: NonceError['code'], message: string) { super(message); this.name = 'NonceError'; this.code = code; }
}

const MIN_BUMP_BPS_DEFAULT = 1000; // 10%: the common txpool replacement threshold (geth default price bump)

function mapRow(r: any): NonceReservation {
  return {
    id: r.id, chainId: r.chain_id, signer: r.signer, nonce: BigInt(r.nonce), intentId: r.intent_id, state: r.state, txHash: r.tx_hash,
    maxFeePerGas: r.max_fee_per_gas === null ? null : BigInt(r.max_fee_per_gas),
    maxPriorityFeePerGas: r.max_priority_fee_per_gas === null ? null : BigInt(r.max_priority_fee_per_gas),
    replacementCount: r.replacement_count,
  };
}
function mapErr(e: unknown): never {
  const m = (e as { message?: string }).message ?? String(e);
  if (m.includes('nonce_inflight_limit')) throw new NonceError('inflight_limit', m);
  if (m.includes('replacement_underpriced')) throw new NonceError('underpriced', m);
  if (/requires state|cannot release/.test(m)) throw new NonceError('bad_state', m);
  throw e;
}

/** Pure replacement rule (mirrors the SQL): bumped >= ceil(old * (1 + bps/10000)) for BOTH fee fields. */
export function minReplacementFee(old: bigint, bumpBps = MIN_BUMP_BPS_DEFAULT): bigint {
  const b = BigInt(bumpBps);
  return old + (old * b + 9_999n) / 10_000n;
}
export function isValidReplacement(prev: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }, next: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }, bumpBps = MIN_BUMP_BPS_DEFAULT): boolean {
  return next.maxFeePerGas >= minReplacementFee(prev.maxFeePerGas, bumpBps) && next.maxPriorityFeePerGas >= minReplacementFee(prev.maxPriorityFeePerGas, bumpBps);
}
/** Smallest valid replacement fees for a stuck tx (optionally pushed higher by the caller's fresh quote). */
export function bumpedFees(prev: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }, bumpBps = MIN_BUMP_BPS_DEFAULT) {
  return { maxFeePerGas: minReplacementFee(prev.maxFeePerGas, bumpBps), maxPriorityFeePerGas: minReplacementFee(prev.maxPriorityFeePerGas, bumpBps) };
}

export class NonceAllocator {
  private db: Queryable; private maxInflight: number; private bumpBps: number;
  constructor(db: Queryable, opts: { maxInflight?: number; minBumpBps?: number } = {}) {
    this.db = db; this.maxInflight = opts.maxInflight ?? 16; this.bumpBps = opts.minBumpBps ?? MIN_BUMP_BPS_DEFAULT;
  }
  /** Reserve a nonce for `intentId` (idempotent). `chainPendingNonce` = node's eth_getTransactionCount(signer,'pending'). */
  async reserve(chainId: string, signer: string, intentId: string, chainPendingNonce?: bigint): Promise<NonceReservation> {
    try {
      const r = await this.db.query('select * from evm_reserve_nonce($1,$2,$3,$4,$5)', [chainId, addressKey(signer), intentId, chainPendingNonce?.toString() ?? null, this.maxInflight]);
      return mapRow(r.rows[0]);
    } catch (e) { return mapErr(e); }
  }
  async markBroadcast(id: string, txHash: string, fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): Promise<NonceReservation> {
    try { return mapRow((await this.db.query('select * from evm_nonce_mark_broadcast($1,$2,$3,$4)', [id, txHash, fees.maxFeePerGas.toString(), fees.maxPriorityFeePerGas.toString()])).rows[0]); } catch (e) { return mapErr(e); }
  }
  async replace(id: string, txHash: string, fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): Promise<NonceReservation> {
    try { return mapRow((await this.db.query('select * from evm_nonce_replace($1,$2,$3,$4,$5)', [id, fees.maxFeePerGas.toString(), fees.maxPriorityFeePerGas.toString(), txHash, this.bumpBps])).rows[0]); } catch (e) { return mapErr(e); }
  }
  async confirm(id: string, txHash: string): Promise<NonceReservation> {
    try { return mapRow((await this.db.query('select * from evm_nonce_confirm($1,$2)', [id, txHash])).rows[0]); } catch (e) { return mapErr(e); }
  }
  async release(id: string): Promise<NonceReservation> {
    try { return mapRow((await this.db.query('select * from evm_nonce_release($1)', [id])).rows[0]); } catch (e) { return mapErr(e); }
  }
  /** Sync with the chain's latest confirmed tx count; returns number of broadcast reservations marked confirmed. */
  async reconcile(chainId: string, signer: string, chainLatestNonce: bigint): Promise<number> {
    return Number((await this.db.query('select evm_nonce_reconcile($1,$2,$3) as n', [chainId, addressKey(signer), chainLatestNonce.toString()])).rows[0].n);
  }
}
