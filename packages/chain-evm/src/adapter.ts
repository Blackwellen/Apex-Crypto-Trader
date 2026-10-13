// ChainAdapter implementation for the EVM family. Reads are allowed at READ_ONLY; execution requires CERTIFIED (fail closed).
import { assertCertified } from '@apex/contracts';
import type { Balance, CapabilityMap, ChainAdapter, FeeQuote, NativeReserve, TxStatus } from '@apex/contracts';
import { validateEvmAddress } from './address.ts';
import { fetchGasQuote, toFeeQuote, worstCaseCost } from './fees.ts';
import type { FeePolicy } from './fees.ts';
import { l2Components } from './l2.ts';
import { computeNativeReserve } from './reserve.ts';
import type { ReserveConfig } from './reserve.ts';
import type { EvmRpcClient } from './rpc.ts';
import { getFinalityPolicy } from './finality.ts';
import { advance, initialTxState, toTxStatus } from './lifecycle.ts';

export interface EvmAdapterDeps {
  capabilitiesFor(chainId: string): CapabilityMap;
  clientFor(chainId: string): EvmRpcClient;
  feePolicyFor(chainId: string): FeePolicy;
  reserveConfigFor(chainId: string): ReserveConfig;
  /** default gas limit for a plain transfer-class quote */
  defaultGasLimit?: bigint;
  now?: () => number;
}

export class EvmChainAdapter implements ChainAdapter {
  readonly family = 'evm' as const;
  private d: EvmAdapterDeps;
  constructor(deps: EvmAdapterDeps) { this.d = deps; }

  capabilities(chainId: string): CapabilityMap { return this.d.capabilitiesFor(chainId); }
  validateAddress(address: string): { valid: boolean; reason?: string; normalized?: string } {
    const r = validateEvmAddress(address);
    return r.valid ? { valid: true, normalized: r.normalized! } : { valid: false, reason: r.reason! };
  }
  validateAssetId(assetId: string) { return assetId === 'native' ? { valid: true } : this.validateAddress(assetId); }

  /** READ_ONLY is enough for balance reads. Native balance only; token balances need an explicit token list. */
  async getBalances(chainId: string, address: string): Promise<Balance[]> {
    const caps = this.capabilities(chainId).getBalances;
    if (caps.status !== 'READ_ONLY' && caps.status !== 'CERTIFIED') assertCertified(this.capabilities(chainId), chainId, 'getBalances');
    const a = this.validateAddress(address); if (!a.valid) throw new Error(a.reason);
    const amount = await this.d.clientFor(chainId).getBalance(a.normalized!);
    return [{ assetId: 'native', amount, decimals: 18 }];
  }

  async getFeeQuote(chainId: string): Promise<FeeQuote> {
    const st = this.capabilities(chainId).getFeeQuote.status;
    if (st !== 'READ_ONLY' && st !== 'CERTIFIED') assertCertified(this.capabilities(chainId), chainId, 'getFeeQuote');
    const client = this.d.clientFor(chainId);
    const { gas, source } = await fetchGasQuote(client, this.d.feePolicyFor(chainId));
    const gasLimit = this.d.defaultGasLimit ?? 21_000n;
    const now = (this.d.now ?? Date.now)();
    return toFeeQuote({
      chainId, gas, gasLimit, worstCaseExecutionCost: worstCaseCost(gas, gasLimit),
      l2Components: l2Components(client.expectedChainId), observedAt: now, source,
    }, now);
  }

  nativeReserveRequired(chainId: string, opts: { plannedTxCount: number }): NativeReserve {
    return computeNativeReserve(chainId, this.d.reserveConfigFor(chainId), opts);
  }

  async getTransactionStatus(chainId: string, txId: string): Promise<TxStatus> {
    const client = this.d.clientFor(chainId);
    const policy = getFinalityPolicy(chainId);
    const [head, receipt] = await Promise.all([client.blockNumber(), client.getTransactionReceipt(txId)]);
    let finalized: bigint | undefined;
    if (policy.finalizedTag === 'supported') { try { finalized = (await client.getBlock('finalized'))?.number; } catch { finalized = undefined; } }
    const { state } = advance(initialTxState, { head, ...(finalized !== undefined ? { finalized } : {}), receipt }, policy);
    // a single observation cannot prove reorg history; callers persisting state should drive advance() themselves.
    return toTxStatus(state, head) as TxStatus;
  }

  async submit(chainId: string, signedTx: Uint8Array): Promise<{ txId: string }> {
    assertCertified(this.capabilities(chainId), chainId, 'submit');
    const hex = '0x' + Array.from(signedTx, (b) => b.toString(16).padStart(2, '0')).join('');
    return { txId: await this.d.clientFor(chainId).sendRawTransaction(hex) };
  }
}
