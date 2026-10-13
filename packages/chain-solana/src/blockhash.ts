// Blockhash-expiry / landing state machine. Core safety rule: a transaction (or Jito bundle) whose status is UNKNOWN must be
// RECONCILED, never blindly re-sent. It is only safe to rebuild with a new blockhash once the old one is PROVEN expired
// (block height already beyond lastValidBlockHeight BEFORE a status query that found nothing).
export type Commitment = 'processed' | 'confirmed' | 'finalized';

export type SolTxState =
  | { kind: 'built'; lastValidBlockHeight: bigint }
  | { kind: 'submitted'; signature: string; lastValidBlockHeight: bigint }
  | { kind: 'reconcile'; signature: string; lastValidBlockHeight: bigint; reason: string }
  | { kind: Commitment; signature: string; slot: bigint; lastValidBlockHeight: bigint }
  | { kind: 'failed'; signature: string; slot: bigint; err: unknown }
  | { kind: 'expired'; signature: string; lastValidBlockHeight: bigint };

export interface SigStatus { slot: bigint; confirmationStatus: Commitment | null; err: unknown | null }
export interface SolObservation {
  /** block height read BEFORE issuing the status query (so null status after this height > lastValid proves non-landing) */
  blockHeightBeforeQuery: bigint;
  /** getSignatureStatuses(searchTransactionHistory=true) result for the signature; null = not found */
  status: SigStatus | null;
}
export type SolEvent = 'submitted' | 'landed' | 'finalized' | 'failed' | 'expired' | 'needs_reconcile';

/** Approximate validity window of a blockhash in blocks (Solana docs: 150 blocks). Used only for default budgeting, never for proof. */
export const BLOCKHASH_VALID_BLOCKS = 150n;

const order: Record<Commitment, number> = { processed: 0, confirmed: 1, finalized: 2 };

export function build(lastValidBlockHeight: bigint): SolTxState { return { kind: 'built', lastValidBlockHeight }; }
export function onSubmit(s: SolTxState, signature: string): SolTxState {
  if (s.kind !== 'built') throw new Error(`cannot submit from ${s.kind}`);
  return { kind: 'submitted', signature, lastValidBlockHeight: s.lastValidBlockHeight };
}
/** The submit call itself timed out / was ambiguous (incl. Jito bundle with no definitive status): signature may still land. */
export function onSubmitAmbiguous(s: SolTxState, signature: string, reason: string): SolTxState {
  if (s.kind !== 'built' && s.kind !== 'submitted') throw new Error(`cannot mark ambiguous from ${s.kind}`);
  return { kind: 'reconcile', signature, lastValidBlockHeight: s.lastValidBlockHeight, reason };
}

export function advance(s: SolTxState, o: SolObservation): { state: SolTxState; events: SolEvent[] } {
  const events: SolEvent[] = [];
  if (s.kind === 'built' || s.kind === 'failed' || s.kind === 'expired' || s.kind === 'finalized') return { state: s, events };
  const lv = s.lastValidBlockHeight;
  const sig = s.signature;
  if (o.status) {
    if (o.status.err !== null && o.status.err !== undefined) {
      events.push('failed'); return { state: { kind: 'failed', signature: sig, slot: o.status.slot, err: o.status.err }, events };
    }
    const c = o.status.confirmationStatus;
    if (c) {
      const prev = s.kind === 'processed' || s.kind === 'confirmed' ? s.kind : null;
      if (prev && order[prev] >= order[c]) return { state: s, events }; // never regress
      events.push(c === 'finalized' ? 'finalized' : 'landed');
      return { state: { kind: c, signature: sig, slot: o.status.slot, lastValidBlockHeight: lv }, events };
    }
    return { state: s, events };
  }
  // status not found
  if (s.kind === 'processed' || s.kind === 'confirmed') {
    // previously seen then vanished (fork / dropped): do NOT call it expired; reconcile
    events.push('needs_reconcile');
    return { state: { kind: 'reconcile', signature: sig, lastValidBlockHeight: lv, reason: `${s.kind} status disappeared (possible fork)` }, events };
  }
  if (o.blockHeightBeforeQuery > lv) { events.push('expired'); return { state: { kind: 'expired', signature: sig, lastValidBlockHeight: lv }, events }; }
  // still inside the validity window (or the query predated expiry): remain unresolved
  if (s.kind === 'reconcile') return { state: s, events };
  return { state: { kind: 'submitted', signature: sig, lastValidBlockHeight: lv }, events };
}

export type RetryDecision = 'wait' | 'reconcile' | 'safe_to_rebuild' | 'done_success' | 'done_failed';
export function retryDecision(s: SolTxState): RetryDecision {
  switch (s.kind) {
    case 'built': return 'safe_to_rebuild'; // never sent
    case 'expired': return 'safe_to_rebuild';
    case 'submitted': return 'wait';
    case 'reconcile': return 'reconcile';
    case 'processed': case 'confirmed': return 'wait';
    case 'finalized': return 'done_success';
    case 'failed': return 'done_failed';
  }
}
/** Safe-to-resend invariant: true ONLY if the previous attempt can no longer land. */
export function canRebuildWithNewBlockhash(s: SolTxState): boolean { return s.kind === 'built' || s.kind === 'expired'; }

export function toTxStatus(s: SolTxState): { state: 'unknown' | 'pending' | 'included' | 'final' | 'failed' | 'expired'; detail?: string } {
  switch (s.kind) {
    case 'built': return { state: 'unknown', detail: 'not submitted' };
    case 'submitted': return { state: 'pending' };
    case 'reconcile': return { state: 'unknown', detail: `RECONCILE REQUIRED: ${s.reason}` };
    case 'processed': case 'confirmed': return { state: 'included', detail: s.kind };
    case 'finalized': return { state: 'final' };
    case 'failed': return { state: 'failed', detail: JSON.stringify(s.err) };
    case 'expired': return { state: 'expired', detail: `blockhash expired past lastValidBlockHeight ${s.lastValidBlockHeight}` };
  }
}

export type BundleStatus = 'landed' | 'failed' | 'invalid' | 'pending' | 'unknown';
/** Map a Jito bundle status into the tx state machine. Anything except an authoritative result => reconcile via signature status. */
export function onBundleStatus(s: SolTxState, b: BundleStatus): SolTxState {
  if (s.kind !== 'submitted' && s.kind !== 'reconcile') return s;
  if (b === 'landed' || b === 'pending') return s; // landing is confirmed only through signature statuses
  // failed / invalid / unknown: a bundle report does not prove non-landing of the tx itself => reconcile
  return { kind: 'reconcile', signature: s.signature, lastValidBlockHeight: s.lastValidBlockHeight, reason: `bundle status '${b}': signature outcome unproven` };
}
