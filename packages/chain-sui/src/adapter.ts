import { assertCertified } from '@apex/contracts';
import type { Balance, CapabilityMap, ChainAdapter, FeeQuote, NativeReserve, TxStatus } from '@apex/contracts';
import { validateSuiAddress, SUI_COIN_TYPE, validateCoinType } from './address.ts';
import { computeSuiReserve } from './gas.ts';
import type { SuiReserveConfig } from './gas.ts';
import type { SuiRpcClient } from './rpc.ts';

export interface SuiAdapterDeps {
  capabilitiesFor(chainId: string): CapabilityMap; clientFor(chainId: string): SuiRpcClient; reserveConfigFor(chainId: string): SuiReserveConfig;
  /** ASSUMPTION used for the read-only quote: computation units of a typical transfer. Real budgets come from dry-runs. */
  assumedComputationUnits?: bigint; now?: () => number;
}
export class SuiChainAdapter implements ChainAdapter {
  readonly family = 'sui' as const;
  private d: SuiAdapterDeps;
  constructor(d: SuiAdapterDeps) { this.d = d; }
  capabilities(chainId: string) { return this.d.capabilitiesFor(chainId); }
  validateAddress(address: string) { return validateSuiAddress(address); }
  validateAssetId(assetId: string) { return assetId === 'native' || validateCoinType(assetId).valid ? { valid: true } : { valid: false, reason: 'expected native or a Move coin type' }; }
  private requireRead(chainId: string, cap: 'getBalances' | 'getFeeQuote') {
    const s = this.capabilities(chainId)[cap].status; if (s !== 'READ_ONLY' && s !== 'CERTIFIED') assertCertified(this.capabilities(chainId), chainId, cap);
  }
  async getBalances(chainId: string, address: string): Promise<Balance[]> {
    this.requireRead(chainId, 'getBalances');
    const a = validateSuiAddress(address); if (!a.valid) throw new Error(a.reason);
    const b = await this.d.clientFor(chainId).getBalance(a.normalized!, SUI_COIN_TYPE);
    return [{ assetId: 'native', amount: b.total, decimals: 9 }];
  }
  async getFeeQuote(chainId: string): Promise<FeeQuote> {
    this.requireRead(chainId, 'getFeeQuote');
    const price = await this.d.clientFor(chainId).getReferenceGasPrice();
    const units = this.d.assumedComputationUnits ?? 1_000n; const comp = price * units;
    return { chainId, nativeUnits: comp, components: { computation: comp }, observedAt: (this.d.now ?? Date.now)(),
      source: `suix_getReferenceGasPrice=${price} * ASSUMED ${units} units;INCOMPLETE:storageCost unknown until dry-run`, stale: true };
  }
  nativeReserveRequired(chainId: string, o: { plannedTxCount: number }): NativeReserve { return computeSuiReserve(chainId, this.d.reserveConfigFor(chainId), o); }
  async getTransactionStatus(chainId: string, digest: string): Promise<TxStatus> {
    const t = await this.d.clientFor(chainId).getTransaction(digest);
    if (!t) return { state: 'unknown', detail: 'digest not found on this node (reconcile before retry)' };
    if (t.effects.status === 'failure') return { state: t.checkpoint !== undefined ? 'failed' : 'failed', detail: t.effects.error ?? 'execution failure (gas still charged)' };
    return t.checkpoint !== undefined ? { state: 'final', detail: `checkpoint ${t.checkpoint}` } : { state: 'included', detail: 'executed, not yet in a checkpoint' };
  }
  async submit(chainId: string): Promise<{ txId: string }> { assertCertified(this.capabilities(chainId), chainId, 'submit'); throw new Error('submit not implemented in read-only build'); }
}
