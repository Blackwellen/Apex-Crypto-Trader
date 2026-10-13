import { assertCertified } from '@apex/contracts';
import type { Balance, CapabilityMap, ChainAdapter, FeeQuote, NativeReserve, TxStatus } from '@apex/contracts';
import { validateSolanaAddress } from './base58.ts';
import { LAMPORTS_PER_SIGNATURE, quoteSolanaFee } from './fees.ts';
import { computeLamportsReserve } from './rent.ts';
import type { LamportsReserveConfig } from './rent.ts';
import type { SolanaRpcClient } from './rpc.ts';
import * as bh from './blockhash.ts';

export interface SolanaAdapterDeps {
  capabilitiesFor(chainId: string): CapabilityMap;
  clientFor(chainId: string): SolanaRpcClient;
  reserveConfigFor(chainId: string): LamportsReserveConfig;
  /** default compute budget used to price a quote */
  defaultCuLimit?: bigint; defaultMicroLamportsPerCu?: bigint;
  now?: () => number;
}
export class SolanaChainAdapter implements ChainAdapter {
  readonly family = 'svm' as const;
  private d: SolanaAdapterDeps;
  constructor(d: SolanaAdapterDeps) { this.d = d; }
  capabilities(chainId: string) { return this.d.capabilitiesFor(chainId); }
  validateAddress(address: string) { return validateSolanaAddress(address); }
  validateAssetId(assetId: string) { return assetId === 'native' ? { valid: true } : validateSolanaAddress(assetId); }
  private requireRead(chainId: string, cap: 'getBalances' | 'getFeeQuote') {
    const st = this.capabilities(chainId)[cap].status;
    if (st !== 'READ_ONLY' && st !== 'CERTIFIED') assertCertified(this.capabilities(chainId), chainId, cap);
  }
  async getBalances(chainId: string, address: string): Promise<Balance[]> {
    this.requireRead(chainId, 'getBalances');
    return [{ assetId: 'native', amount: await this.d.clientFor(chainId).getBalance(address), decimals: 9 }];
  }
  async getFeeQuote(chainId: string): Promise<FeeQuote> {
    this.requireRead(chainId, 'getFeeQuote');
    const fees = await this.d.clientFor(chainId).getRecentPrioritizationFees();
    const sorted = fees.map((f) => f.prioritizationFee).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const p50 = sorted.length ? sorted[sorted.length >> 1]! : 0n;
    const q = quoteSolanaFee({ version: 'v0', numSignatures: 1, cuLimit: this.d.defaultCuLimit ?? 200_000n, microLamportsPerCu: this.d.defaultMicroLamportsPerCu ?? p50 });
    const now = (this.d.now ?? Date.now)();
    return { chainId, nativeUnits: q.feeTotal, components: { baseFee: q.baseFee, priorityFee: q.priorityFee }, observedAt: now, source: `getRecentPrioritizationFees(p50=${p50} microLamports/CU); base=${LAMPORTS_PER_SIGNATURE}/sig`, stale: sorted.length === 0 };
  }
  nativeReserveRequired(chainId: string, opts: { plannedTxCount: number }): NativeReserve { return computeLamportsReserve(chainId, this.d.reserveConfigFor(chainId), opts); }
  async getTransactionStatus(chainId: string, txId: string): Promise<TxStatus> {
    const c = this.d.clientFor(chainId);
    const height = await c.getBlockHeight(); // read BEFORE the status query (expiry proof ordering)
    const [st] = await c.getSignatureStatuses([txId], true);
    // lastValidBlockHeight is unknown from a bare signature => never claim 'expired' here; unknown stays unknown (reconcile)
    const s = bh.advance({ kind: 'reconcile', signature: txId, lastValidBlockHeight: BigInt(Number.MAX_SAFE_INTEGER), reason: 'bare signature lookup' }, { blockHeightBeforeQuery: height, status: st ?? null }).state;
    return bh.toTxStatus(s) as TxStatus;
  }
  async submit(chainId: string): Promise<{ txId: string }> { assertCertified(this.capabilities(chainId), chainId, 'submit'); throw new Error('submit not implemented in read-only build'); }
}
