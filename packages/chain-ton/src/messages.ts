/**
 * TON external-message model for wallet contracts (v3/v4/v5): replay protection by seqno + valid_until (unix seconds).
 * Sending is NOT finality. An external message has no hash-like guarantee until the wallet seqno advances / a tx is observed.
 */
export interface TonWalletMessage { seqno: number; validUntil: number; subwalletId: number; sendMode: number; bounce: boolean }

export interface MessagePolicy { minTtlSec: number; maxTtlSec: number }
/** TTL window is POLICY (not consensus). Short validity limits replay/stuck-risk; too short fails on clock skew. */
export const DEFAULT_MESSAGE_POLICY: MessagePolicy = { minTtlSec: 30, maxTtlSec: 600 };

export function validateWalletMessage(m: TonWalletMessage, nowSec: number, onChainSeqno: number, p: MessagePolicy = DEFAULT_MESSAGE_POLICY): { ok: boolean; reasons: string[] } {
  const r: string[] = [];
  if (!Number.isInteger(m.seqno) || m.seqno < 0 || m.seqno > 0xffffffff) r.push('seqno must be u32');
  if (m.seqno !== onChainSeqno) r.push(`seqno ${m.seqno} != on-chain ${onChainSeqno} (wallet rejects non-sequential messages)`);
  if (!Number.isInteger(m.validUntil) || m.validUntil > 0xffffffff) r.push('valid_until must be u32 unix seconds');
  const ttl = m.validUntil - nowSec;
  if (ttl < p.minTtlSec) r.push(`valid_until too close/past (ttl ${ttl}s < ${p.minTtlSec}s)`);
  if (ttl > p.maxTtlSec) r.push(`valid_until too far (ttl ${ttl}s > ${p.maxTtlSec}s)`);
  if (!Number.isInteger(m.subwalletId) || m.subwalletId < 0 || m.subwalletId > 0xffffffff) r.push('subwallet_id must be u32');
  if (!Number.isInteger(m.sendMode) || m.sendMode < 0 || m.sendMode > 255) r.push('send mode must be u8');
  return { ok: r.length === 0, reasons: r };
}

export type MessageState = 'pending' | 'consumed' | 'expired_unsent';
/**
 * Resolve an external message:
 *  - on-chain seqno > m.seqno       => the seqno was CONSUMED (this message OR a competing one landed): look up the tx before assuming success.
 *  - now > valid_until && seqno same => expired without landing; the seqno is safe to re-sign. (Never re-sign earlier: both could land? No - same seqno
 *    means only one can, but the first may still be in flight until valid_until passes.)
 */
export function resolveMessage(m: TonWalletMessage, nowSec: number, onChainSeqno: number): { state: MessageState; safeToResign: boolean; note: string } {
  if (onChainSeqno > m.seqno) return { state: 'consumed', safeToResign: false, note: 'seqno advanced: confirm by tx lookup (could be a different message with same seqno)' };
  if (nowSec > m.validUntil) return { state: 'expired_unsent', safeToResign: true, note: 'valid_until passed and seqno unchanged: message can no longer land' };
  return { state: 'pending', safeToResign: false, note: 'still within validity window; do NOT re-sign this seqno' };
}

// ---- fees ----
export const TON_FEE_NOTE = 'TON fees = gas (gas_used x gas_price from blockchain config param 21 for basechain) + forward fees (config param 25 lump/bit/cell prices, charged per message hop) + storage fees. Values are config-derived and can change by validator vote; always query config, never hardcode. A message to a non-existent/uninitialised destination with bounce=true returns funds minus fees. TON transactions are asynchronous: the wallet tx is only the FIRST hop of a message tree.';
export interface TonFeeInputs { gasUsed: bigint; gasPriceNanoPerGas: bigint; forwardFeeNano: bigint; storageFeeNano: bigint; hops: bigint }
export function estimateTonFee(i: TonFeeInputs): bigint {
  if (i.gasUsed < 0n || i.gasPriceNanoPerGas <= 0n || i.hops < 1n) throw new Error('bad fee inputs');
  return i.gasUsed * i.gasPriceNanoPerGas + i.forwardFeeNano * i.hops + i.storageFeeNano;
}
