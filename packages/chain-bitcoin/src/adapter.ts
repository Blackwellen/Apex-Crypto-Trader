import { CapabilityNotCertified, type Balance, type CapabilityMap, type ChainAdapter, type NativeReserve } from '@apex/contracts';
import { validateBitcoinAddress } from './address.ts';
import { chainRecords } from './records.ts';
import { EsploraClient, fetchTransport, type Transport } from './client.ts';

/** READ-ONLY bitcoin adapter. No swap/AMM surface exists. submit() fails closed. */
export class BitcoinAdapter implements ChainAdapter {
  readonly family = 'bitcoin' as const;
  private clients = new Map<string, EsploraClient>();
  constructor(transport: Transport = fetchTransport) { for (const r of chainRecords) this.clients.set(r.id, new EsploraClient(r.rpcCandidates[0]!, transport)); }
  private rec(id: string) { const r = chainRecords.find((x) => x.id === id); if (!r) throw new Error(`unknown bitcoin chain ${id}`); return r; }
  capabilities(chainId: string): CapabilityMap { return this.rec(chainId).capabilities; }
  validateAddress(address: string, chainId?: string) {
    const net = chainId ? (this.rec(chainId).isTestnet ? 'testnet' : 'mainnet') : undefined;
    const r = validateBitcoinAddress(address, net);
    return { valid: r.valid, reason: r.reason, normalized: r.normalized };
  }
  async getBalances(chainId: string, address: string): Promise<Balance[]> {
    const v = this.validateAddress(address, chainId); if (!v.valid) throw new Error(v.reason);
    const b = await this.clients.get(chainId)!.getAddressBalance(address);
    return [{ assetId: 'native:BTC', amount: b.confirmedSat, decimals: 8 }]; // confirmed only; unconfirmed is NOT spendable-by-default
  }
  nativeReserveRequired(chainId: string): NativeReserve {
    // UTXO chain: no gas reserve concept; fee is paid from inputs. Dust floor is the only unspendable amount.
    return { chainId, floor: 0n, nextNTxEstimate: 0n, emergencyExit: 0n, total: 0n };
  }
  async submit(chainId: string): Promise<{ txId: string }> { throw new CapabilityNotCertified(chainId, 'submit', this.capabilities(chainId).submit.status); }
}
