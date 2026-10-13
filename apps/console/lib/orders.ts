import { formatUnits } from './format';
/** Pure order-pipeline presentation logic. */
export const PIPELINE: { state: string; group: string }[] = [
  { state: 'SIGNAL', group: 'signal' }, { state: 'CANDIDATE', group: 'candidate' }, { state: 'RISK_EVALUATING', group: 'risk' }, { state: 'ADMITTED', group: 'risk' },
  { state: 'CAPITAL_RESERVED', group: 'capital' }, { state: 'QUOTED', group: 'quote' }, { state: 'PREPARED', group: 'prepare' }, { state: 'APPROVAL_WAIT', group: 'approval' },
  { state: 'SUBMITTING', group: 'submit' }, { state: 'ACKNOWLEDGED', group: 'ack' }, { state: 'UNKNOWN', group: 'ack' }, { state: 'PARTIALLY_FILLED', group: 'fill' },
  { state: 'FILLED', group: 'outcome' }, { state: 'CANCELLED', group: 'outcome' }, { state: 'EXPIRED', group: 'outcome' }, { state: 'FAILED', group: 'outcome' },
  { state: 'SETTLING', group: 'settle' }, { state: 'FINAL', group: 'final' }, { state: 'REORGED', group: 'final' }, { state: 'DISPUTED', group: 'final' },
  { state: 'RECONCILED', group: 'reconcile' }, { state: 'LEDGER_APPLIED', group: 'ledger' }, { state: 'COMPOUNDING_ELIGIBLE', group: 'compound' },
];
export interface Ev { from?: string; to: string; at: string; detail?: unknown }
export interface TimelineStep { state: string; reached: boolean; at: string | null; current: boolean }
/** Every pipeline state, marked reached (with its time) only if an order_event to that state exists. Nothing is inferred. */
export function timeline(events: Ev[] | null | undefined, current: string): TimelineStep[] {
  const by = new Map((events ?? []).map((e) => [e.to, e.at]));
  const reached = (s: string) => by.has(s) || (s === 'SIGNAL' && (events?.length ?? 0) > 0) || s === current;
  return PIPELINE.map((p) => ({ state: p.state, reached: reached(p.state), at: by.get(p.state) ?? null, current: p.state === current }));
}
/** only states before SUBMITTING can be cancelled by the console (matches api_cancel_intent) */
export const CANCELLABLE = ['SIGNAL', 'CANDIDATE', 'RISK_EVALUATING', 'ADMITTED', 'CAPITAL_RESERVED', 'QUOTED', 'PREPARED', 'APPROVAL_WAIT'];
export const isCancellable = (state: string) => CANCELLABLE.includes(state);
export const TERMINAL = ['FILLED', 'CANCELLED', 'EXPIRED', 'FAILED', 'SETTLING', 'FINAL', 'REORGED', 'DISPUTED', 'RECONCILED', 'LEDGER_APPLIED', 'COMPOUNDING_ELIGIBLE'];

export function stateNote(o: { state: string; risk_decision?: string | null; environment?: string }): { tone: 'warn' | 'neutral' | 'bad'; text: string } | null {
  if (o.state === 'UNKNOWN') return { tone: 'warn', text: 'Awaiting reconciliation — will never be blindly retried.' };
  if (o.state === 'RISK_EVALUATING' && !o.risk_decision) return { tone: 'neutral', text: 'Waiting for the risk service. No risk decision has been recorded; this order cannot proceed without one.' };
  if (o.state === 'APPROVAL_WAIT') return { tone: 'neutral', text: 'Waiting for approval.' };
  if (o.state === 'FAILED') return { tone: 'bad', text: 'Failed. See the timeline for the last recorded event.' };
  return null;
}
/** fill ratio in basis points from two integer strings; null when nothing is ordered */
export function fillRatioBps(filled: string, qty: string): number | null {
  const q = BigInt(qty); if (q === 0n) return null;
  return Number((BigInt(filled) * 10000n) / q);
}
export const pctFromBps = (bps: number | null) => (bps === null ? '—' : `${(bps / 100).toFixed(2)}%`);
export const dash = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));
export const slipCell = (expected: number | null | undefined, realised: number | null | undefined) =>
  expected == null && realised == null ? '—' : `${expected == null ? '—' : expected.toFixed(1)} / ${realised == null ? '—' : realised.toFixed(1)} bps`;
export const gasCell = (gas: string | null | undefined, nativeDecimals: number, symbol: string) => (gas == null ? '—' : `${formatUnits(gas, nativeDecimals, 8)} ${symbol}`);

/** percentile bins labels used by /v1/analytics/execution histogram */
export const LATENCY_BINS = ['<10 ms', '10-50', '50-100', '100-250', '250-500', '0.5-1 s', '1-5 s', '≥5 s'];
