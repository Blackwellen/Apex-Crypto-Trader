'use client';
import { useState } from 'react';
import { Check, Circle } from 'lucide-react';
import { Badge, Button, ConfirmDialog, Dialog, LoadingBlock, ErrorState, useToast, cx } from '@/components/ui';
import { useApi, useCommand } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { formatUnits, when } from '@/lib/format';
import { isCancellable, stateNote, timeline, fillRatioBps, pctFromBps, slipCell, gasCell } from '@/lib/orders';
import { EnvBadge, Note } from './parts';

export interface OrderRow { id: string; environment: string; strategy_key: string; side: string; state: string; venue: string | null; quantity: string; notional: string; created_at: string; base_symbol: string; base_decimals: number; quote_symbol: string; quote_decimals: number;
  chain_id: string; native_symbol: string; native_decimals: number; filled_qty: string; fill_count: number; expected_slippage_bps: number | null; realised_slippage_bps: number | null; gas_native: string | null; risk_decision: string | null; reserved: boolean; timeline: { from: string; to: string; at: string }[] | null }
interface Detail { intent: OrderRow & { wallet: string; wallet_capability: string; bucket: string; limit_price: string | null }; events: { id: number; event_key: string; from_state: string; to_state: string; detail: any; created_at: string }[];
  fills: { id: string; venue_fill_id: string; qty: string; quote_amount: string; fee_quote: string; created_at: string }[]; decisions: { id: string; decision: string; reasons: unknown; evaluator: string; created_at: string }[] }

export function Timeline({ events, state }: { events: { to: string; at: string }[] | null; state: string }) {
  const steps = timeline(events, state);
  return (
    <ol className="space-y-1.5" aria-label="Order timeline from signal to reconciliation">
      {steps.map((s) => (
        <li key={s.state} aria-current={s.current ? 'step' : undefined} className={cx('flex items-center gap-2 rounded-lg px-2 py-1 text-[12px]', s.current && (s.state === 'UNKNOWN' ? 'bg-warn-soft font-semibold text-warn' : 'bg-accent-soft font-semibold text-accent'), !s.reached && 'text-muted')}>
          {s.reached ? <Check className="size-3.5 shrink-0" aria-hidden /> : <Circle className="size-3.5 shrink-0 opacity-40" aria-hidden />}
          <span className="font-mono">{s.state}</span><span className="ml-auto tabular">{s.at ? when(s.at) : s.reached ? '' : 'not reached'}</span>
        </li>))}
    </ol>
  );
}

export function OrderDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useApi<Detail>(id ? `v1/orders/${id}` : null); const { canWrite } = useWorkspace(); const toast = useToast(); const cancel = useCommand('cancelIntent'); const [confirm, setConfirm] = useState(false);
  const d = q.data; const o = d?.intent;
  return (
    <Dialog open={!!id} onClose={onClose} side title={o ? `${o.side.toUpperCase()} ${o.base_symbol}/${o.quote_symbol}` : 'Order'}
      footer={o && isCancellable(o.state) ? <Button variant="danger" disabled={!canWrite} onClick={() => setConfirm(true)}>Cancel order</Button> : undefined}>
      {q.isLoading ? <LoadingBlock /> : q.error ? <ErrorState error={q.error} retry={() => q.refetch()} /> : d && o ? (
        <div className="space-y-5 text-[13px]">
          <div className="flex flex-wrap items-center gap-2"><EnvBadge env={o.environment} /><Badge tone={o.state === 'UNKNOWN' ? 'warn' : 'neutral'}>{o.state}</Badge><span className="text-muted">{o.strategy_key}</span></div>
          {(() => { const n = stateNote({ state: o.state, risk_decision: d.decisions.at(-1)?.decision ?? null }); return n ? <Note tone={n.tone === 'warn' ? 'warn' : 'neutral'}>{n.text}</Note> : null; })()}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <dt className="font-semibold">Quantity</dt><dd className="tabular">{formatUnits(o.quantity, o.base_decimals)} {o.base_symbol}</dd>
            <dt className="font-semibold">{o.side === 'buy' ? 'Quote budget' : 'Base sold'}</dt><dd className="tabular">{o.side === 'buy' ? `${formatUnits(o.notional, o.quote_decimals)} ${o.quote_symbol}` : `${formatUnits(o.notional, o.base_decimals)} ${o.base_symbol}`}</dd>
            <dt className="font-semibold">Limit price</dt><dd>{o.limit_price ?? '—'}</dd>
            <dt className="font-semibold">Bucket / wallet</dt><dd>{o.bucket} / {o.wallet} ({o.wallet_capability})</dd>
            <dt className="font-semibold">Chain / venue</dt><dd>{o.chain_id} / {o.venue ?? '—'}</dd>
            <dt className="font-semibold">Fill ratio</dt><dd>{pctFromBps(fillRatioBps(d.fills.reduce((s, f) => s + BigInt(f.qty), 0n).toString(), o.quantity))}</dd>
            <dt className="font-semibold">Slippage exp / real</dt><dd>{slipCell(o.expected_slippage_bps, o.realised_slippage_bps)}</dd>
            <dt className="font-semibold">Gas</dt><dd>{gasCell(o.gas_native, o.native_decimals, o.native_symbol)}</dd>
            <dt className="font-semibold">Finality</dt><dd>{['FINAL', 'RECONCILED', 'LEDGER_APPLIED', 'COMPOUNDING_ELIGIBLE'].includes(o.state) ? o.state : 'Not final'}</dd>
          </dl>
          <section><h3 className="mb-2 font-semibold">Timeline</h3><Timeline events={d.events.map((e) => ({ to: e.to_state, at: e.created_at }))} state={o.state} /></section>
          <section><h3 className="mb-2 font-semibold">Risk decisions</h3>{d.decisions.length === 0 ? <p className="text-muted">None recorded. {o.state === 'RISK_EVALUATING' ? 'Waiting for the risk service.' : ''}</p> :
            <ul className="space-y-1">{d.decisions.map((r) => <li key={r.id}><Badge tone={r.decision === 'ADMIT' ? 'good' : 'bad'}>{r.decision}</Badge> <span className="text-muted">{r.evaluator} · {when(r.created_at)}</span></li>)}</ul>}</section>
          <section><h3 className="mb-2 font-semibold">Fills</h3>{d.fills.length === 0 ? <p className="text-muted">No fills recorded.</p> :
            <ul className="space-y-1">{d.fills.map((f) => <li key={f.id} className="tabular">{formatUnits(f.qty, o.base_decimals)} {o.base_symbol} for {formatUnits(f.quote_amount, o.quote_decimals)} {o.quote_symbol} (fee {formatUnits(f.fee_quote, o.quote_decimals)}) · {when(f.created_at)}</li>)}</ul>}</section>
          <section><h3 className="mb-2 font-semibold">Event log</h3><ul className="space-y-1 text-[12px] text-muted">{d.events.map((e) => <li key={e.id}>{when(e.created_at)} · {e.from_state} → {e.to_state}{e.detail && Object.keys(e.detail).length ? ` · ${JSON.stringify(e.detail).slice(0, 120)}` : ''}</li>)}</ul></section>
          <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} danger busy={cancel.isPending} confirmLabel="Cancel order" title="Cancel this order"
            body={<><p>The intent moves to <strong>CANCELLED</strong> before it is submitted and any reserved capital is returned to the bucket.</p><p className="text-muted">Only orders that have not reached SUBMITTING can be cancelled here. Orders already submitted, or UNKNOWN, are settled by reconciliation.</p></>}
            onConfirm={() => cancel.mutate({ body: { intent: o.id, reason: 'Cancelled from console' } }, { onSuccess: () => { toast.push('Order cancelled'); setConfirm(false); onClose(); }, onError: (e) => { toast.push(e.message, 'bad'); setConfirm(false); } })} />
        </div>) : null}
    </Dialog>
  );
}
