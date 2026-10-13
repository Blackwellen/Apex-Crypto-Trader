import { CapabilityNotCertified, type Balance, type CapabilityMap, type ChainAdapter, type FeeQuote, type NativeReserve } from '@apex/contracts';
import { validateTronAddress } from './address.ts';
import { TronClient, type Transport, fetchTransport } from './client.ts';
import { trxReserve, type TronChainParams } from './fees.ts';
import { chainRecords } from './records.ts';

/** READ-ONLY TRON adapter. submit() always throws: no execution path exists in this package. */
export class TronAdapter implements ChainAdapter {
  readonly family = 'tron' as const;
  private params = new Map<string, TronChainParams>();
  private clients = new Map<string, TronClient>();
  constructor(transport: Transport = fetchTransport) {
    for (const r of chainRecords) if (r.rpcCandidates[0]) this.clients.set(r.id, new TronClient(r.rpcCandidates[0], transport));
  }
  private client(chainId: string): TronClient {
    const c = this.clients.get(chainId);
    if (!c) throw new Error(`unknown TRON chain ${chainId}`);
    return c;
  }
  capabilities(chainId: string): CapabilityMap {
    const r = chainRecords.find((x) => x.id === chainId);
    if (!r) throw new Error(`unknown TRON chain ${chainId}`);
    return r.capabilities;
  }
  validateAddress(address: string) { const r = validateTronAddress(address); return { valid: r.valid, reason: r.reason, normalized: r.normalized }; }
  async getBalances(chainId: string, address: string): Promise<Balance[]> {
    const a = await this.client(chainId).getAccount(address);
    return [{ assetId: 'native:TRX', amount: a.balanceSun, decimals: 6 }];
  }
  async refreshParams(chainId: string): Promise<TronChainParams> {
    const p = await this.client(chainId).getChainParameters();
    this.params.set(chainId, p);
    return p;
  }
  async getFeeQuote(chainId: string): Promise<FeeQuote> {
    const p = await this.refreshParams(chainId);
    return { chainId, nativeUnits: p.bandwidthFeeSun, components: { bandwidthFeeSunPerByte: p.bandwidthFeeSun, energyFeeSunPerUnit: p.energyFeeSun, maxFeeLimitSun: p.maxFeeLimitSun }, observedAt: Date.now(), source: 'getchainparameters', stale: false };
  }
  nativeReserveRequired(chainId: string, opts: { plannedTxCount: number }): NativeReserve {
    const p = this.params.get(chainId);
    if (!p) throw new Error('chain parameters not loaded: call refreshParams/getFeeQuote first (no hardcoded fees)');
    // Conservative shape assumptions (policy inputs, not chain constants): TRC20 transfer ~ 350B & energy supplied by caller policy in production.
    const shape = { bandwidthBytes: 350n, energy: 65_000n };
    const r = trxReserve({ params: p, plannedTxCount: opts.plannedTxCount, perTx: shape, exit: shape, floorSun: 0n });
    return { chainId, ...r };
  }
  async submit(chainId: string): Promise<{ txId: string }> {
    throw new CapabilityNotCertified(chainId, 'submit', this.capabilities(chainId).submit.status);
  }
}
