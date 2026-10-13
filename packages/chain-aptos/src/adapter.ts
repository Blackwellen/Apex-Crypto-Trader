import { assertCertified } from '@apex/contracts';
import type { Balance, CapabilityMap, ChainAdapter, FeeQuote, NativeReserve, TxStatus } from '@apex/contracts';
import { validateAptosAddress, validateMoveType } from './address.ts';
import { computeAptosReserve } from './gas.ts';
import type { AptosReserveConfig } from './gas.ts';
import type { AptosRestClient } from './rest.ts';
import { resolveStatus } from './status.ts';

export interface AptosAdapterDeps {
  capabilitiesFor(chainId: string): CapabilityMap; clientFor(chainId: string): AptosRestClient; reserveConfigFor(chainId: string): AptosReserveConfig;
  /** ASSUMPTION for a read-only quote only: max_gas_amount of a typical transfer */
  assumedMaxGasAmount?: bigint; now?: () => number;
}
export class AptosChainAdapter implements ChainAdapter {
  readonly family = 'aptos' as const;
  private d: AptosAdapterDeps;
  constructor(d: AptosAdapterDeps) { this.d = d; }
  capabilities(chainId: string) { return this.d.capabilitiesFor(chainId); }
  validateAddress(address: string) { const r = validateAptosAddress(address, { strict: true }); return r.valid ? { valid: true, normalized: r.normalized! } : { valid: false, reason: r.reason! }; }
  validateAssetId(assetId: string) { return assetId === 'native' || validateMoveType(assetId).valid ? { valid: true } : { valid: false, reason: 'expected native or Move type tag' }; }
  private requireRead(chainId: string, cap: 'getBalances' | 'getFeeQuote') { const s = this.capabilities(chainId)[cap].status; if (s !== 'READ_ONLY' && s !== 'CERTIFIED') assertCertified(this.capabilities(chainId), chainId, cap); }
  async getBalances(chainId: string, address: string): Promise<Balance[]> {
    this.requireRead(chainId, 'getBalances');
    return [{ assetId: 'native', amount: await this.d.clientFor(chainId).getBalance(address), decimals: 8 }];
  }
  async getFeeQuote(chainId: string): Promise<FeeQuote> {
    this.requireRead(chainId, 'getFeeQuote');
    const est = await this.d.clientFor(chainId).estimateGasPrice(); const mga = this.d.assumedMaxGasAmount ?? 2_000n;
    return { chainId, nativeUnits: est.normal * mga, components: { maxGasCost: est.normal * mga }, observedAt: (this.d.now ?? Date.now)(), source: `estimate_gas_price=${est.normal} * ASSUMED max_gas_amount ${mga} (upper bound; actual = gas_used*price)`, stale: false };
  }
  nativeReserveRequired(chainId: string, o: { plannedTxCount: number }): NativeReserve { return computeAptosReserve(chainId, this.d.reserveConfigFor(chainId), o); }
  /** Without the submitter's tx fields we can only report committed/pending/unknown; expiry needs resolveStatus() with the tx's sequence + expiration. */
  async getTransactionStatus(chainId: string, hash: string): Promise<TxStatus> {
    const c = this.d.clientFor(chainId);
    const lookup = await c.getTransactionByHash(hash);
    const li = await c.ledgerInfo();
    const s = resolveStatus({ lookup, txSequenceNumber: (1n << 64n) - 1n, expirationTimestampSecs: 0n, ledgerTimestampUsec: li.ledgerTimestampUsec, accountSequenceNumber: 0n });
    if (s.state === 'final') return { state: 'final', detail: `version ${s.version}` };
    if (s.state === 'failed') return { state: 'failed', detail: s.vmStatus };
    if (s.state === 'pending') return { state: 'pending' };
    return { state: 'unknown', detail: s.detail };
  }
  async submit(chainId: string): Promise<{ txId: string }> { assertCertified(this.capabilities(chainId), chainId, 'submit'); throw new Error('submit not implemented in read-only build'); }
}
