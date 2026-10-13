// Reliable transaction status + finality for Aptos. Aptos has deterministic BFT finality: a transaction that is committed (found by hash with
// type != pending_transaction) is final. The dangerous direction is "not found": it is only EXPIRED when (a) chain time has passed
// expiration_timestamp_secs, AND (b) the sender's on-chain sequence_number has NOT advanced past the tx's sequence number. Otherwise the
// outcome is unproven => reconcile (the sequence number may have been consumed by a different/replacement transaction).
import type { AptosTxLookup } from './rest.ts';
import { isExpiredAt } from './gas.ts';

export type AptosStatus =
  | { state: 'pending'; detail?: string }
  | { state: 'final'; version: bigint; detail?: string }
  | { state: 'failed'; version: bigint; vmStatus: string; detail?: string }
  | { state: 'expired'; detail: string; safeToReuseSequence: true }
  | { state: 'unknown'; detail: string };

export const U64_MAX = (1n << 64n) - 1n;

export function resolveStatus(o: {
  lookup: AptosTxLookup;
  /** tx fields known to the submitter (needed when the node has no record) */
  txSequenceNumber: bigint; expirationTimestampSecs: bigint;
  /** a ledger read taken AFTER the lookup */
  ledgerTimestampUsec: bigint;
  /** sender's on-chain sequence_number read AFTER the lookup (next expected) */
  accountSequenceNumber: bigint;
}): AptosStatus {
  const l = o.lookup;
  if (l.kind === 'committed') return l.success ? { state: 'final', version: l.version } : { state: 'failed', version: l.version, vmStatus: l.vmStatus, detail: 'committed with execution failure (gas charged, sequence number consumed)' };
  if (l.kind === 'pending') return isExpiredAt(o.ledgerTimestampUsec, l.expirationTimestampSecs)
    ? { state: 'unknown', detail: 'mempool still lists tx past its expiration; re-query before acting' } : { state: 'pending' };
  // not found
  if (o.txSequenceNumber === U64_MAX) return { state: 'unknown', detail: 'orderless transaction (replay-protection nonce): sequence-number proof not applicable; reconcile by hash' };
  if (!isExpiredAt(o.ledgerTimestampUsec, o.expirationTimestampSecs)) return { state: 'pending', detail: 'not yet visible; still inside expiration window' };
  if (o.accountSequenceNumber > o.txSequenceNumber) return { state: 'unknown', detail: `sequence ${o.txSequenceNumber} was consumed on-chain by some transaction but not this hash: possible replacement; reconcile` };
  return { state: 'expired', detail: `expired at chain time and sequence ${o.txSequenceNumber} not consumed`, safeToReuseSequence: true };
}
