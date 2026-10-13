'use client';
import { useState } from 'react';
import { Async, Badge, Card, DataTable, EmptyState, Kpi, PageHeader, Select, StackedBar } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { useWs } from '@/components/hooks';
import { effectiveStatus, type CapMap } from '@/lib/chains';
import { formatUnits } from '@/lib/format';
import { LATENCY_BINS, slipCell } from '@/lib/orders';
import { CapBadge, EnvBadge, NotConnectedCard, Note, fmtDur } from '@/components/trading/parts';

interface Exec {
  waterfall: { environment: string; symbol: string; decimals: number; fills: number; gross: string; fees: string; gas_native: string | null; gas_recorded: number; expected_slippage_bps: number | null; realised_slippage_bps: number | null; slippage_recorded: number }[];
  byStrategy: { environment: string; strategy_key: string; symbol: string; decimals: number; fills: number; gross: string; fees: string }[];
  byVenue: { environment: string; venue: string; symbol: string; decimals: number; fills: number; gross: string; fees: string }[];
  pending: { environment: string; state: string; n: number }[]; failed: { environment: string; n: number }[];
  latency: { from_state: string; to_state: string; n: number; p50: number; p95: number; p99: number; histogram: number[] }[]; latencyNote: string; gasNote: string;
}
const f = (v: string, d: number, s: string) => `${formatUnits(v, d)} ${s}`;

function Waterfall({ w }: { w: Exec['waterfall'][number] }) {
  const gross = BigInt(w.gross), fees = BigInt(w.fees); const feeBps = gross === 0n ? 0 : Number((fees * 10000n) / gross);
  const rows: [string, string, string?][] = [['Gross notional', f(w.gross, w.decimals, w.symbol)], ['− Trading fees (recorded)', f(w.fees, w.decimals, w.symbol)],
    ['− Gas / priority fee', w.gas_recorded ? `${w.gas_native} native base units (${w.gas_recorded} of ${w.fills} fills)` : '— not recorded'],
    ['− Slippage', w.slippage_recorded ? slipCell(w.expected_slippage_bps, w.realised_slippage_bps) : '— not recorded'],
    ['= Net of recorded costs', f((gross - fees).toString(), w.decimals, w.symbol)]];
  return (
    <div className="rounded-xl border border-line p-4" role="group" aria-label={`Fee waterfall ${w.environment} ${w.symbol}`}>
      <div className="mb-2 flex items-center gap-2"><EnvBadge env={w.environment} /><strong>{w.symbol}</strong><span className="text-[12px] text-muted">{w.fills} fill(s)</span></div>
      <dl className="space-y-1 text-[13px]">{rows.map(([k, v]) => <div key={k} className="flex justify-between gap-3 border-t border-line pt-1 first:border-0"><dt className={k.startsWith('=') ? 'font-semibold' : ''}>{k}</dt><dd className="tabular text-right">{v}</dd></div>)}</dl>
      <div className="mt-3"><StackedBar parts={[{ label: 'Fees', value: Math.max(feeBps, 1), color: '#b3373a' }, { label: 'Net of recorded costs', value: Math.max(10000 - feeBps, 1), color: '#2758da' }]} /><p className="mt-1 text-[11px] text-muted">Fees are {(feeBps / 100).toFixed(2)}% of gross notional.</p></div>
    </div>
  );
}

function Latency({ d }: { d: Exec }) {
  const opts = d.latency.map((l) => ({ value: `${l.from_state}>${l.to_state}`, label: `${l.from_state} → ${l.to_state} (${l.n})` })); const [sel, setSel] = useState('');
  if (d.latency.length === 0) return <EmptyState title="No latency recorded" hint="Latency needs at least two recorded order events for an order. None exist yet." />;
  const l = d.latency.find((x) => `${x.from_state}>${x.to_state}` === sel) ?? d.latency[0]; const max = Math.max(...l.histogram, 1);
  return (<div className="space-y-4">
    <Select label="Pipeline stage" value={`${l.from_state}>${l.to_state}`} onChange={(e) => setSel(e.target.value)} options={opts} />
    <div className="grid grid-cols-3 gap-3 text-center"><div className="rounded-xl border border-line p-3"><div className="text-[11px] uppercase text-muted">p50</div><div className="tabular text-[20px] font-bold">{fmtDur(l.p50)}</div></div><div className="rounded-xl border border-line p-3"><div className="text-[11px] uppercase text-muted">p95</div><div className="tabular text-[20px] font-bold">{fmtDur(l.p95)}</div></div><div className="rounded-xl border border-line p-3"><div className="text-[11px] uppercase text-muted">p99</div><div className="tabular text-[20px] font-bold">{fmtDur(l.p99)}</div></div></div>
    <figure><div role="img" aria-label={`Latency histogram for ${l.from_state} to ${l.to_state}, ${l.n} samples: ${LATENCY_BINS.map((b, i) => `${b} ${l.histogram[i]}`).join(', ')}`} className="flex h-32 items-end gap-1">
      {l.histogram.map((v, i) => <div key={i} className="flex flex-1 flex-col items-center justify-end gap-1"><span className="tabular text-[10px] text-muted">{v}</span><div className="w-full rounded-t bg-accent" style={{ height: `${(v / max) * 100}%`, minHeight: v ? 3 : 0 }} /></div>)}</div>
      <div className="mt-1 flex gap-1 text-center text-[10px] text-muted" aria-hidden>{LATENCY_BINS.map((b) => <span key={b} className="flex-1">{b}</span>)}</div>
      <figcaption className="mt-2 text-[11px] text-muted">Unit: milliseconds between consecutive order_events. n = {l.n}. Provenance: order_events timestamps.</figcaption></figure>
    <Note tone="warn">{d.latencyNote} With few samples, percentiles are not statistically meaningful.</Note>
  </div>);
}

function Body() {
  const q = useWs<Exec>('analytics/execution'); const chains = useWs<{ items: { id: string; name: string; capabilities: CapMap }[] }>('chains/overview');
  return (<>
    <PageHeader title="Execution" description="Fee waterfall, pipeline latency and cost attribution from recorded fills and order events. Venue routing, quote comparison and MEV-route health appear only when their feeds are connected." />
    <Async q={q}>{(d) => {
      const fills = d.waterfall.reduce((a, w) => a + w.fills, 0); const pending = d.pending.reduce((a, p) => a + p.n, 0); const failed = d.failed.reduce((a, p) => a + p.n, 0);
      return (<>
        <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi label="Recorded fills" value={fills} sub={fills ? 'Across environments, kept separate below' : 'No fills yet'} />
          <Kpi label="Orders in flight" value={pending} sub={pending ? d.pending.map((p) => `${p.n} ${p.state}`).join(' · ') : 'None'} />
          <Kpi label="Failed orders" value={failed} sub={failed ? 'Failure costs are not recorded' : 'None'} tone={failed ? 'warn' : undefined} />
          <Kpi label="Latency samples" value={d.latency.reduce((a, l) => a + l.n, 0)} sub="Internal pipeline stages only" />
        </div>
        <div className="mb-5 grid gap-5 xl:grid-cols-2">
          <Card className="min-w-0" title="Fee waterfall (from fills)">{d.waterfall.length === 0 ? <EmptyState title="No fills yet" hint="The waterfall is built from recorded fills. Gas and slippage rows stay empty until the execution service records them." /> : <div className="space-y-4">{d.waterfall.map((w) => <Waterfall key={w.environment + w.symbol} w={w} />)}<Note>{d.gasNote}</Note></div>}</Card>
          <Card className="min-w-0" title="Execution latency p50 / p95 / p99"><Latency d={d} /></Card>
        </div>
        <div className="mb-5 grid gap-5 xl:grid-cols-2">
          <Card className="min-w-0" title="Most expensive strategies (by fees)">{d.byStrategy.length === 0 ? <EmptyState title="No fills yet" /> : <DataTable caption="Fees by strategy" rows={d.byStrategy.map((s, i) => ({ ...s, id: String(i) }))} cols={[
            { key: 'strategy_key', header: 'Strategy' }, { key: 'environment', header: 'Env', filter: true, render: (s) => <EnvBadge env={s.environment} /> }, { key: 'fills', header: 'Fills', align: 'right', sort: (s) => s.fills },
            { key: 'fees', header: 'Fees', align: 'right', text: (s) => f(s.fees, s.decimals, s.symbol), sort: (s) => Number(BigInt(s.fees) / 10n ** BigInt(Math.max(0, s.decimals - 4))) },
            { key: 'gross', header: 'Gross', align: 'right', text: (s) => f(s.gross, s.decimals, s.symbol) }]} />}</Card>
          <Card className="min-w-0" title="Route economics (by venue)">{d.byVenue.length === 0 ? <EmptyState title="No fills yet" /> : <DataTable caption="Fees by venue" rows={d.byVenue.map((s, i) => ({ ...s, id: String(i) }))} cols={[
            { key: 'venue', header: 'Venue / route' }, { key: 'environment', header: 'Env', filter: true, render: (s) => <EnvBadge env={s.environment} /> }, { key: 'fills', header: 'Fills', align: 'right', sort: (s) => s.fills },
            { key: 'fees', header: 'Fees', align: 'right', text: (s) => f(s.fees, s.decimals, s.symbol) }, { key: 'gross', header: 'Gross', align: 'right', text: (s) => f(s.gross, s.decimals, s.symbol) }]} />}</Card>
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <NotConnectedCard title="CEX / DEX quote comparator" what="Comparing live venue and aggregator quotes needs quote adapters. None are connected, so no comparison is shown." setup={['Connect a venue adapter (market metadata and order books) from the exchange adapters package.', 'Certify buildSwapQuote on a chain adapter for DEX routes.']} />
          <NotConnectedCard title="Jito / Flashbots defensive route health" what="Private-route landing rates are not measured. No route health is shown rather than an assumed green." setup={['Certify supportsPrivateRoute for the chain.', 'Record submissions and landing outcomes so landing rate can be measured.']} />
          <NotConnectedCard title="Missing exit depth" what="Exit depth requires order-book or pool-liquidity data per position." setup={['Connect an order-book or pool-state feed.', 'Run the continuous sell-simulation job (Operations).']} />
          <Card className="min-w-0" title="Priority / gas solver inputs">
            <p className="mb-3 text-[13px] text-muted">The solver needs certified fee quotes per chain. Current status of <code>getFeeQuote</code> in the registry:</p>
            <Async q={chains} empty={(c) => c.items.length === 0}>{(c) => <ul className="divide-y divide-line text-[13px]">{c.items.map((x) => <li key={x.id} className="flex items-center justify-between py-2"><span>{x.name}</span><CapBadge status={effectiveStatus(x.capabilities.getFeeQuote)} /></li>)}</ul>}</Async>
          </Card>
        </div>
      </>);
    }}</Async>
  </>);
}
export default function ExecutionPage() { return <NeedWorkspace><Body /></NeedWorkspace>; }
