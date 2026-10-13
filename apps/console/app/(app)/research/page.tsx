'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { Async, Badge, Button, Card, DataTable, EmptyState, PageHeader, TabPanel, Tabs } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { useWs } from '@/components/hooks';
import { get } from '@/lib/api';
import { when } from '@/lib/format';
import { downloadCsv } from '@/lib/csv';
import { EXPORT_HEADER, exportRows, fnum, interval } from '@/lib/research/results';
import { ProvenanceBadge, ResearcherStatusBar, SyntheticNotice, downloadJson } from '@/components/research/common';
import { BacktestWizard } from '@/components/research/wizard';

type Run = { id: string; status: string; label: string | null; data_provenance: string; params: any; error: string | null; created_at: string; finished_at: string | null; point_metrics: any };
const tone = (s: string) => (s === 'done' ? 'good' : s === 'failed' ? 'bad' : 'warn');

function Compare({ ids }: { ids: string[] }) {
  const qs = useQueries({ queries: ids.map((id) => ({ queryKey: ['api', `v1/research/backtests/${id}`], queryFn: () => get<any>(`v1/research/backtests/${id}`) })) });
  if (ids.length < 2) return <EmptyState title="Select at least two runs" hint="Tick the boxes in Run history, then come back here." />;
  if (qs.some((q) => q.isLoading)) return <p role="status">Loading runs…</p>;
  const runs = qs.map((q) => q.data).filter(Boolean) as any[];
  const mixed = new Set(runs.map((r) => r.data_provenance)).size > 1;
  const metrics: [string, string][] = [['sharpe', 'Sharpe'], ['cagr', 'CAGR'], ['max_drawdown', 'Max drawdown'], ['total_return', 'Total return']];
  const cell = (r: any, k: string) => { const m = r.metrics?.report?.metric_uncertainty?.[k]; const iv = interval(m); return m ? `${fnum(m.point, 3)}${iv ? `  [${fnum(iv[0], 3)}, ${fnum(iv[1], 3)}]` : ' (no interval)'}` : 'n/a'; };
  return (
    <Card title={`Comparing ${runs.length} runs`} action={<div className="flex gap-2"><Button onClick={() => downloadCsv('apex-research-compare.csv', EXPORT_HEADER, exportRows(runs))}><Download className="size-4" aria-hidden />CSV</Button><Button onClick={() => downloadJson('apex-research-compare.json', runs)}><Download className="size-4" aria-hidden />JSON</Button></div>}>
      {mixed && <p role="alert" className="mb-3 rounded-lg bg-warn-soft p-3 text-[13px] text-warn">These runs have different data provenance. Do not compare synthetic and real results as if they measured the same thing.</p>}
      <div className="overflow-x-auto rounded-xl border border-line"><table className="w-full min-w-[640px] text-left text-[13px]"><caption className="sr-only">Run comparison: point estimate and 90% interval</caption>
        <thead className="bg-[#f6f8fb] text-[11px] uppercase tracking-wider text-muted"><tr><th scope="col" className="px-4 py-3">Metric: point [interval]</th>{runs.map((r) => <th key={r.id} scope="col" className="px-4 py-3"><Link className="text-accent underline" href={`/research/${r.id}`}>{r.label || r.id.slice(0, 8)}</Link><br /><ProvenanceBadge value={r.data_provenance} /></th>)}</tr></thead>
        <tbody>{metrics.map(([k, name]) => <tr key={k} className="border-t border-line"><th scope="row" className="px-4 py-3 font-medium">{name}</th>{runs.map((r) => <td key={r.id} className="tabular px-4 py-3">{cell(r, k)}</td>)}</tr>)}
          <tr className="border-t border-line"><th scope="row" className="px-4 py-3 font-medium">Strategies</th>{runs.map((r) => <td key={r.id} className="px-4 py-3 text-[12px]">{(r.params?.sleeves ?? []).map((s: any) => `${s.name} ${Math.round(s.allocation * 100)}%`).join(', ')}</td>)}</tr>
          <tr className="border-t border-line"><th scope="row" className="px-4 py-3 font-medium">Data</th>{runs.map((r) => <td key={r.id} className="px-4 py-3 text-[12px]">{r.params?.nBars} bars · seed {r.params?.seed} · {r.params?.venue} · delisted {r.params?.includeDelisted ? 'included' : 'excluded'}</td>)}</tr></tbody></table></div>
      <p className="mt-3 text-[12px] text-muted">When intervals overlap heavily, the difference between runs is within sampling noise.</p>
    </Card>
  );
}

export default function ResearchPage() {
  const runs = useWs<{ items: Run[] }>('research/backtests', '&limit=100');
  const [tab, setTab] = useState('history'); const [sel, setSel] = useState<string[]>([]);
  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  return (
    <NeedWorkspace>
      <PageHeader title="Backtesting & Research" description="Reproducible simulations on the researcher service, with confidence intervals, survivorship and lookahead statements, and data provenance on every result. Research only: nothing here can place an order." />
      <ResearcherStatusBar />
      <SyntheticNotice banner="Every backtest runs on the researcher's seeded SYNTHETIC generator unless real data has been loaded, and the label travels with each result and export. Synthetic results test the plumbing and statistics code; they are not evidence that any strategy has an edge." provenance="SYNTHETIC" />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'history', label: 'Run history' }, { id: 'new', label: 'New backtest' }, { id: 'compare', label: `Compare (${sel.length})` }]} />
      <TabPanel id="history" value={tab}>
        <Card title="Run history" action={<div className="flex gap-2"><Button onClick={() => setTab('compare')} disabled={sel.length < 2}>Compare selected</Button><Button variant="primary" onClick={() => setTab('new')}>New backtest</Button></div>}>
          <Async q={runs} empty={(d) => d.items.length === 0}>{(d) => <DataTable caption="Backtest runs" rows={d.items} cols={[
            { key: 'sel', header: 'Pick', render: (r) => <input type="checkbox" aria-label={`Select run ${r.label || r.id.slice(0, 8)} for comparison`} checked={sel.includes(r.id)} onChange={() => toggle(r.id)} className="size-5 accent-[#2758da]" />, text: () => '' },
            { key: 'created_at', header: 'Created', render: (r) => when(r.created_at), sort: (r) => r.created_at },
            { key: 'label', header: 'Run', render: (r) => <Link className="font-semibold text-accent underline" href={`/research/${r.id}`}>{r.label || r.id.slice(0, 8)}</Link>, text: (r) => r.label ?? r.id },
            { key: 'status', header: 'Status', filter: true, render: (r) => <Badge tone={tone(r.status)}>{r.status}</Badge> },
            { key: 'data_provenance', header: 'Provenance', filter: true, render: (r) => <ProvenanceBadge value={r.data_provenance} /> },
            { key: 'strategies', header: 'Strategies', text: (r) => (r.params?.sleeves ?? []).map((s: any) => s.name).join(' ') },
            { key: 'sharpe', header: 'Sharpe (point)', align: 'right', text: (r) => (typeof r.point_metrics?.sharpe === 'number' ? r.point_metrics.sharpe.toFixed(2) : r.error ? 'failed' : 'n/a'), sort: (r) => r.point_metrics?.sharpe ?? -999 }]} />}</Async>
          {runs.data?.items.length === 0 && <div className="mt-4"><EmptyState title="No backtests yet" hint="Create one with the wizard. Runs are stored with their parameters, provenance and metrics." /></div>}
        </Card>
      </TabPanel>
      <TabPanel id="new" value={tab}><BacktestWizard /></TabPanel>
      <TabPanel id="compare" value={tab}><Compare ids={sel} /></TabPanel>
    </NeedWorkspace>
  );
}
