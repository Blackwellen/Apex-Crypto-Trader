// Receipt / reorg / finality state machine: pending -> included -> final, with reorged as an explicit state.
import type { FinalityPolicy } from './finality.ts';

export type TxState =
  | { kind: 'pending'; reorgCount: number }
  | { kind: 'included'; blockNumber: bigint; blockHash: string; reverted: boolean; reorgCount: number }
  | { kind: 'final'; blockNumber: bigint; blockHash: string; reverted: boolean; reorgCount: number; violation?: boolean }
  | { kind: 'reorged'; previousBlockNumber: bigint; previousBlockHash: string; reorgCount: number };

export interface Observation {
  /** current head block number */
  head: bigint;
  /** node's `finalized` block number if available */
  finalized?: bigint;
  /** receipt as returned now (null = node does not know the tx) */
  receipt: null | { blockNumber: bigint; blockHash: string; status: 'success' | 'reverted' | 'unknown' };
  /** hash of the canonical block currently at the recorded inclusion height (lets us detect a replaced block even if the receipt lookup is cached) */
  canonicalHashAtInclusion?: string | null;
}
export type LifecycleEvent = 'included' | 'reorged' | 'reincluded' | 'finalized' | 'finality_violation';

export const initialTxState: TxState = { kind: 'pending', reorgCount: 0 };

function depth(head: bigint, block: bigint): bigint { return head >= block ? head - block + 1n : 0n; }

function isFinal(policy: FinalityPolicy, head: bigint, finalized: bigint | undefined, blockNumber: bigint): boolean {
  const deepEnough = depth(head, blockNumber) >= policy.requiredDepth;
  const tagCovers = finalized !== undefined && blockNumber <= finalized;
  if (policy.requireFinalizedTag) return deepEnough && tagCovers;
  return deepEnough || tagCovers;
}

export function advance(state: TxState, obs: Observation, policy: FinalityPolicy): { state: TxState; events: LifecycleEvent[] } {
  const events: LifecycleEvent[] = [];
  const rc = obs.receipt;
  const rcReverted = rc?.status === 'reverted';

  switch (state.kind) {
    case 'pending': {
      if (!rc) return { state, events };
      events.push('included');
      return maybeFinal({ kind: 'included', blockNumber: rc.blockNumber, blockHash: rc.blockHash, reverted: rcReverted, reorgCount: state.reorgCount }, obs, policy, events);
    }
    case 'reorged': {
      if (!rc) return { state, events };
      events.push('reincluded');
      return maybeFinal({ kind: 'included', blockNumber: rc.blockNumber, blockHash: rc.blockHash, reverted: rcReverted, reorgCount: state.reorgCount }, obs, policy, events);
    }
    case 'included': {
      const gone = !rc;
      const moved = rc && rc.blockHash !== state.blockHash;
      const canonicalMismatch = obs.canonicalHashAtInclusion !== undefined && obs.canonicalHashAtInclusion !== state.blockHash;
      if (gone || (canonicalMismatch && !moved)) {
        events.push('reorged');
        return { state: { kind: 'reorged', previousBlockNumber: state.blockNumber, previousBlockHash: state.blockHash, reorgCount: state.reorgCount + 1 }, events };
      }
      if (moved && rc) {
        events.push('reorged', 'reincluded');
        return maybeFinal({ kind: 'included', blockNumber: rc.blockNumber, blockHash: rc.blockHash, reverted: rcReverted, reorgCount: state.reorgCount + 1 }, obs, policy, events);
      }
      return maybeFinal(state, obs, policy, events);
    }
    case 'final': {
      // finality is terminal. Contradicting evidence is surfaced loudly, never silently "un-finalized".
      const contradicts = !rc || rc.blockHash !== state.blockHash || (obs.canonicalHashAtInclusion !== undefined && obs.canonicalHashAtInclusion !== state.blockHash);
      if (contradicts && !state.violation) { events.push('finality_violation'); return { state: { ...state, violation: true }, events }; }
      return { state, events };
    }
  }
}

function maybeFinal(s: Extract<TxState, { kind: 'included' }>, obs: Observation, policy: FinalityPolicy, events: LifecycleEvent[]) {
  if (isFinal(policy, obs.head, obs.finalized, s.blockNumber)) {
    events.push('finalized');
    return { state: { ...s, kind: 'final' } as TxState, events };
  }
  return { state: s as TxState, events };
}

/** Map to the shared TxStatus vocabulary. A reverted-but-included tx is 'failed' once included (fees were consumed). */
export function toTxStatus(state: TxState, head?: bigint): { state: 'pending' | 'included' | 'final' | 'failed' | 'reorged'; confirmations?: number; detail?: string } {
  switch (state.kind) {
    case 'pending': return { state: 'pending' };
    case 'reorged': return { state: 'reorged', detail: `reorged out of ${state.previousBlockHash}; reorgCount=${state.reorgCount}` };
    case 'included':
      return { state: state.reverted ? 'failed' : 'included', ...(head !== undefined ? { confirmations: Number(depth(head, state.blockNumber)) } : {}), ...(state.reverted ? { detail: 'execution reverted (not yet final)' } : {}) };
    case 'final': {
      const detail = state.violation ? 'FINALITY VIOLATION: contradicting evidence after finality' : state.reverted ? 'execution reverted (final)' : undefined;
      return { state: state.reverted ? 'failed' : 'final', ...(detail ? { detail } : {}) };
    }
  }
}
