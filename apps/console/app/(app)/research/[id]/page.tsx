'use client';
import Link from 'next/link';
import { use } from 'react';
import { ArrowLeft, Download } from 'lucide-react';
import { Async, Badge, Button, Card, EmptyState, PageHeader } from '@/components/ui';
import { useApi } from '@/lib/api';
import { when } from '@/lib/format';
import { downloadCsv } from '@/lib/csv';
import { EXPORT_HEADER, exportRows } from '@/lib/research/results';
import { downloadJson } from '@/components/research/common';
import { CostsCard, EquityCard, MethodStatements, MetricsTable, MonteCarlo, RunBanner, SplitSections, WarningsCard } from '@/components/research/results';

export default function RunDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const q = useApi<any>(/^[0-9a-f-]{36}$/i.test(id) ? `v1/research/backtests/${id}` : null);
  return (
    <>
      <Link href="/research" className="mb-3 inline-flex items-center gap-1 text-[13px] font-semibold text-accent"><ArrowLeft className="size-4" aria-hidden />All runs</Link>
      <Async q={q}>{(run) => { const rep = run.metrics?.report;
        return (<>
          <PageHeader title={run.label || `Backtest ${run.id.slice(0, 8)}`} description={`Started ${when(run.created_at)}${run.finished_at ? ` · finished ${when(run.finished_at)}` : ''} · ${run.params?.nBars ?? '?'} bars · seed ${run.params?.seed ?? '?'} · ${String(run.params?.venue ?? '').toUpperCase()}`}
            actions={<><Badge tone={run.status === 'done' ? 'good' : run.status === 'failed' ? 'bad' : 'warn'}>{run.status}</Badge>
              <Button onClick={() => downloadCsv(`apex-run-${run.id.slice(0, 8)}.csv`, EXPORT_HEADER, exportRows([run]))} disabled={!rep}><Download className="size-4" aria-hidden />CSV</Button>
              <Button onClick={() => downloadJson(`apex-run-${run.id.slice(0, 8)}.json`, run)}><Download className="size-4" aria-hidden />JSON</Button></>} />
          <RunBanner run={run} />
          {run.status === 'failed' && <div role="alert" className="mb-5 rounded-xl border border-[#f3c9c5] bg-bad-soft p-4 text-[13px] text-bad"><strong>Run failed:</strong> {run.error ?? 'no detail recorded'}. No metrics exist for this run.</div>}
          {(run.status === 'queued' || run.status === 'running') && <div role="status" className="mb-5 rounded-xl border border-line bg-card p-4 text-[13px]">This run is <strong>{run.status}</strong>. It will update automatically.</div>}
          {rep ? <div className="space-y-5">
            <MethodStatements report={rep} />
            <MetricsTable report={rep} />
            <div className="grid gap-5 xl:grid-cols-2"><EquityCard report={rep} provenance={run.data_provenance} /><SplitSections report={rep} /></div>
            <MonteCarlo report={rep} />
            <CostsCard report={rep} />
            <WarningsCard report={rep} />
          </div> : run.status === 'done' ? <Card><EmptyState title="This run has no report body" hint="It was recorded by an older writer that stored a reduced metric set. Raw stored metrics are available through the JSON export." /></Card> : null}
          <details className="mt-5 text-[13px]"><summary className="cursor-pointer font-semibold">Stored parameters</summary><pre className="mt-2 overflow-x-auto rounded-lg bg-[#f6f8fb] p-3 text-[12px]">{JSON.stringify(run.params, null, 2)}</pre></details>
        </>); }}</Async>
    </>
  );
}
