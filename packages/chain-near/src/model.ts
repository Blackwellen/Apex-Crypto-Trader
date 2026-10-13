/** NEAR gas: 1 TGas = 1e12 gas units. Price is yoctoNEAR per gas unit (block dependent, from RPC gas_price). 1 NEAR = 1e24 yocto. */
export const TGAS = 1_000_000_000_000n;
export const YOCTO_PER_NEAR = 10n ** 24n;

export const tgasToGas = (tgas: bigint): bigint => tgas * TGAS;
/** Fee burned for gas = gas * gasPrice (yocto). The tx PREPAYS gas (attached gas * price); unused is refunded (protocol-dependent). */
export function gasFeeYocto(gasUnits: bigint, gasPriceYocto: bigint): bigint {
  if (gasUnits < 0n || gasPriceYocto <= 0n) throw new Error('bad gas inputs');
  return gasUnits * gasPriceYocto;
}
export interface PrepaidGasCheck { ok: boolean; prepayYocto: bigint; reason?: string }
/** maxTotalPrepaidGas comes from the live protocol config (EXPERIMENTAL_protocol_config.max_total_prepaid_gas) - passed in, not assumed. */
export function checkPrepaidGas(i: { gasUnits: bigint; gasPriceYocto: bigint; maxTotalPrepaidGas: bigint; attachedDepositYocto: bigint; spendableYocto: bigint }): PrepaidGasCheck {
  const prepay = gasFeeYocto(i.gasUnits, i.gasPriceYocto);
  if (i.gasUnits > i.maxTotalPrepaidGas) return { ok: false, prepayYocto: prepay, reason: 'gas exceeds protocol max_total_prepaid_gas' };
  if (prepay + i.attachedDepositYocto > i.spendableYocto) return { ok: false, prepayYocto: prepay, reason: 'insufficient spendable balance for prepaid gas + deposit' };
  return { ok: true, prepayYocto: prepay };
}
/** Account must retain storage_usage * storage_amount_per_byte (locked); spendable = balance - locked - staked reserve. */
export function spendableYocto(i: { amount: bigint; locked: bigint; storageUsageBytes: bigint; storageAmountPerByte: bigint }): bigint {
  const storageStake = i.storageUsageBytes * i.storageAmountPerByte;
  const reserved = i.locked > storageStake ? i.locked : storageStake; // NEAR: required = max(locked, storage staking)
  return i.amount > reserved ? i.amount - reserved : 0n;
}

// ---- access-key nonce model ----
/**
 * Each (account, public key) access key has a nonce; a tx nonce MUST be strictly greater than the key's current nonce, and the node
 * also rejects nonces above block_height * ACCESS_KEY_NONCE_RANGE_MULTIPLIER. Concurrent txs from one key need locally reserved nonces.
 * The tx also carries a recent block_hash that must be within the protocol's transaction_validity_period (blocks).
 */
export class NonceManager {
  private next = new Map<string, bigint>();
  private static k(account: string, pubkey: string) { return `${account}|${pubkey}`; }
  seed(account: string, pubkey: string, chainNonce: bigint): void {
    const k = NonceManager.k(account, pubkey);
    const cur = this.next.get(k);
    if (cur === undefined || chainNonce + 1n > cur) this.next.set(k, chainNonce + 1n);
  }
  reserve(account: string, pubkey: string): bigint {
    const k = NonceManager.k(account, pubkey);
    const n = this.next.get(k);
    if (n === undefined) throw new Error('nonce not seeded from view_access_key');
    this.next.set(k, n + 1n);
    return n;
  }
  /** "InvalidNonce { tx_nonce, ak_nonce }" => resync to ak_nonce+1 */
  onError(account: string, pubkey: string, msg: string): bigint | null {
    const m = /ak_nonce[:=]\s*(\d+)/.exec(msg);
    if (!m) return null;
    const n = BigInt(m[1]!) + 1n; this.next.set(NonceManager.k(account, pubkey), n); return n;
  }
}
export function validateTxNonce(txNonce: bigint, accessKeyNonce: bigint, blockHeight: bigint, rangeMultiplier: bigint): { ok: boolean; reason?: string } {
  if (txNonce <= accessKeyNonce) return { ok: false, reason: 'nonce must be > access key nonce' };
  if (txNonce >= blockHeight * rangeMultiplier) return { ok: false, reason: 'nonce above block_height * multiplier' };
  return { ok: true };
}
export function blockHashStillValid(txBlockHeight: bigint, currentHeight: bigint, validityPeriodBlocks: bigint): boolean {
  return currentHeight - txBlockHeight < validityPeriodBlocks;
}

// ---- finality ----
/** `optimistic`: latest block, may be orphaned; `near-final`: doomslug final (1 block-quorum); `final`: Nightshade final, irreversible. */
export type NearFinality = 'optimistic' | 'near-final' | 'final';
export type NearTxExec = 'NONE' | 'INCLUDED' | 'INCLUDED_FINAL' | 'EXECUTED' | 'EXECUTED_OPTIMISTIC' | 'FINAL';
/** Map RPC send_tx wait_until / tx status to our TxStatus-like state. Only FINAL (+ SuccessValue) is treated as final. */
export function classifyTxStatus(s: { finalExecutionStatus?: string; failure?: boolean }): { state: 'unknown' | 'pending' | 'included' | 'final' | 'failed'; detail: string } {
  if (s.failure) return { state: s.finalExecutionStatus === 'FINAL' ? 'failed' : 'pending', detail: 'execution failure observed; failure is final only at FINAL' };
  switch (s.finalExecutionStatus) {
    case 'FINAL': return { state: 'final', detail: 'final' };
    case 'EXECUTED': case 'EXECUTED_OPTIMISTIC': case 'INCLUDED_FINAL': case 'INCLUDED': return { state: 'included', detail: `${s.finalExecutionStatus}: not irreversible yet` };
    case 'NONE': return { state: 'pending', detail: 'accepted by node, not included' };
    default: return { state: 'unknown', detail: 'status unavailable: reconcile before retrying' };
  }
}
