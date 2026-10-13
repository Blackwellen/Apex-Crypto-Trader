// DB-backed coin-object leases (migration 0102). Two concurrent orders can never lease the same object: a partial UNIQUE index
// plus a per-(chain, owner) advisory lock inside sui_lease_coins. Leases that outlive their TTL stay blocking until reconciled.
import type { SuiCoin } from './rpc.ts';
import { validateSuiAddress } from './address.ts';

export interface Queryable { query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> }
export interface CoinLease { id: string; chainId: string; owner: string; objectId: string; coinType: string; purpose: 'gas' | 'input'; intentId: string; version: bigint; balance: bigint; state: 'held' | 'released' | 'consumed' | 'expired'; expiresAt: Date }
export class LeaseError extends Error {
  code: 'insufficient' | 'bad_state' | 'other';
  constructor(code: LeaseError['code'], m: string) { super(m); this.name = 'LeaseError'; this.code = code; }
}
const row = (r: any): CoinLease => ({ id: r.id, chainId: r.chain_id, owner: r.owner, objectId: r.object_id, coinType: r.coin_type, purpose: r.purpose, intentId: r.intent_id, version: BigInt(r.object_version), balance: BigInt(r.balance), state: r.state, expiresAt: r.expires_at });

export class SuiCoinLeaser {
  private db: Queryable;
  constructor(db: Queryable) { this.db = db; }
  /**
   * Lease a dedicated gas coin (SUI) and/or input coins. `candidates` MUST come from a fresh RPC read (SuiRpcClient.getAllCoins).
   * Idempotent per intent. Throws LeaseError('insufficient') when no unleased, non-stale coin set covers the need.
   */
  async lease(o: { chainId: string; owner: string; intentId: string; candidates: SuiCoin[]; gasNeed?: bigint; input?: { coinType: string; need: bigint }; ttlSeconds?: number; maxInputObjects?: number }): Promise<CoinLease[]> {
    const ow = validateSuiAddress(o.owner); if (!ow.valid) throw new Error(`invalid owner: ${ow.reason}`);
    const cands = o.candidates.map((c) => ({ objectId: c.objectId, version: c.version.toString(), balance: c.balance.toString(), coinType: c.coinType }));
    for (const c of cands) if (!validateSuiAddress(c.objectId).valid) throw new Error(`invalid candidate object id ${c.objectId}`);
    try {
      const r = await this.db.query('select * from sui_lease_coins($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)', [
        o.chainId, ow.normalized, o.intentId, o.input?.coinType ?? '0x2::sui::SUI', (o.gasNeed ?? 0n).toString(), (o.input?.need ?? 0n).toString(), JSON.stringify(cands), o.ttlSeconds ?? 120, o.maxInputObjects ?? 50]);
      return r.rows.map(row);
    } catch (e) {
      const m = (e as Error).message ?? '';
      if (m.includes('insufficient_unleased_balance')) throw new LeaseError('insufficient', m);
      throw e;
    }
  }
  async release(chainId: string, intentId: string): Promise<number> { return Number((await this.db.query('select sui_lease_release($1,$2) n', [chainId, intentId])).rows[0].n); }
  /** The transaction executed: leased object versions are burnt (stale for any later candidate list). */
  async consume(chainId: string, intentId: string): Promise<number> { return Number((await this.db.query('select sui_lease_consume($1,$2) n', [chainId, intentId])).rows[0].n); }
  async expireDue(chainId: string): Promise<number> { return Number((await this.db.query('select sui_lease_expire_due($1) n', [chainId])).rows[0].n); }
  async resolveExpired(leaseId: string, outcome: 'unused' | 'consumed'): Promise<CoinLease> {
    try { return row((await this.db.query('select * from sui_lease_resolve($1,$2)', [leaseId, outcome])).rows[0]); }
    catch (e) { if (/only expired leases/.test((e as Error).message)) throw new LeaseError('bad_state', (e as Error).message); throw e; }
  }
}
