// DB-backed per-(chain, account) sequence-number allocator (migration 0103). Same guarantees as the EVM nonce allocator.
import { validateAptosAddress } from './address.ts';

export interface Queryable { query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> }
export type SeqState = 'reserved' | 'broadcast' | 'committed' | 'released';
export interface SequenceReservation { id: string; chainId: string; account: string; seq: bigint; intentId: string; state: SeqState; txHash: string | null; gasUnitPrice: bigint | null; maxGasAmount: bigint | null; expirationTimestampSecs: bigint | null; replacementCount: number }
export class SequenceError extends Error {
  code: 'inflight_limit' | 'underpriced' | 'expiration' | 'bad_state' | 'other';
  constructor(code: SequenceError['code'], m: string) { super(m); this.name = 'SequenceError'; this.code = code; }
}
const nb = (x: unknown) => (x === null || x === undefined ? null : BigInt(x as string));
const row = (r: any): SequenceReservation => ({ id: r.id, chainId: r.chain_id, account: r.account, seq: BigInt(r.seq), intentId: r.intent_id, state: r.state, txHash: r.tx_hash, gasUnitPrice: nb(r.gas_unit_price), maxGasAmount: nb(r.max_gas_amount), expirationTimestampSecs: nb(r.expiration_timestamp_secs), replacementCount: r.replacement_count });
function mapErr(e: unknown): never {
  const m = (e as Error).message ?? '';
  if (m.includes('sequence_inflight_limit')) throw new SequenceError('inflight_limit', m);
  if (m.includes('replacement_underpriced')) throw new SequenceError('underpriced', m);
  if (m.includes('replacement_expiration_not_later')) throw new SequenceError('expiration', m);
  if (/requires state|cannot release/.test(m)) throw new SequenceError('bad_state', m);
  throw e;
}
export function minReplacementGasPrice(old: bigint, bumpBps = 1000): bigint { return old + (old * BigInt(bumpBps) + 9_999n) / 10_000n; }

export class SequenceAllocator {
  private db: Queryable; private maxInflight: number; private bumpBps: number;
  constructor(db: Queryable, o: { maxInflight?: number; minBumpBps?: number } = {}) { this.db = db; this.maxInflight = o.maxInflight ?? 16; this.bumpBps = o.minBumpBps ?? 1000; }
  private acct(a: string): string { const v = validateAptosAddress(a); if (!v.valid) throw new Error(`invalid account: ${v.reason}`); return v.normalized!; }
  /** `chainSequence` = the account's on-chain sequence_number (the next expected one). */
  async reserve(chainId: string, account: string, intentId: string, chainSequence?: bigint): Promise<SequenceReservation> {
    try { return row((await this.db.query('select * from aptos_reserve_sequence($1,$2,$3,$4,$5)', [chainId, this.acct(account), intentId, chainSequence?.toString() ?? null, this.maxInflight])).rows[0]); } catch (e) { return mapErr(e); }
  }
  async markBroadcast(id: string, txHash: string, gas: { gasUnitPrice: bigint; maxGasAmount: bigint }, expirationSecs: bigint): Promise<SequenceReservation> {
    try { return row((await this.db.query('select * from aptos_sequence_mark_broadcast($1,$2,$3,$4,$5)', [id, txHash, gas.gasUnitPrice.toString(), gas.maxGasAmount.toString(), expirationSecs.toString()])).rows[0]); } catch (e) { return mapErr(e); }
  }
  async replace(id: string, txHash: string, gas: { gasUnitPrice: bigint; maxGasAmount: bigint }, expirationSecs: bigint): Promise<SequenceReservation> {
    try { return row((await this.db.query('select * from aptos_sequence_replace($1,$2,$3,$4,$5,$6)', [id, gas.gasUnitPrice.toString(), gas.maxGasAmount.toString(), txHash, expirationSecs.toString(), this.bumpBps])).rows[0]); } catch (e) { return mapErr(e); }
  }
  async commit(id: string, txHash: string): Promise<SequenceReservation> { try { return row((await this.db.query('select * from aptos_sequence_commit($1,$2)', [id, txHash])).rows[0]); } catch (e) { return mapErr(e); } }
  async release(id: string): Promise<SequenceReservation> { try { return row((await this.db.query('select * from aptos_sequence_release($1)', [id])).rows[0]); } catch (e) { return mapErr(e); } }
  async reconcile(chainId: string, account: string, chainSequence: bigint): Promise<number> {
    return Number((await this.db.query('select aptos_sequence_reconcile($1,$2,$3) n', [chainId, this.acct(account), chainSequence.toString()])).rows[0].n);
  }
}
