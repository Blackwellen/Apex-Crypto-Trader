'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { LayoutGrid, Lock, Plus, Table2 } from 'lucide-react';
import { Async, Badge, Button, Card, DataTable, EmptyState, Kpi, PageHeader, useToast, cx, inputCls } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { useWs } from '@/components/hooks';
import { useCommand } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { chainCoverage, type CapMap } from '@/lib/chains';
import { cloneToWizard, stageLabel, type WizardState } from '@/lib/strategy';
import { StrategyWizard, type WizardDef } from '@/components/trading/strategy-wizard';
import { Note, stageTone } from '@/components/trading/parts';

interface Def { key: string; version: number; name: string; stage: string; catalogue_stage: string; spot_only: boolean; allowed_families: string[]; has_evidence: boolean; category: string; summary: string; data_sources: string[]; regimes: string[];
  param_bounds: WizardDef['param_bounds']; risk_budget: WizardDef['risk_budget']; workspace_id: string | null; cloned_from: string | null; intents: number; instances: { bucket_id: string; bucket: string; environment: string; enabled: boolean }[] }
interface Approval { id: string; subject: { strategy: string; version: number; from: string; to: string }; status: string; created_at: string }

function Approvals({ items, names }: { items: Approval[]; names: Map<string, string> }) {
  const { current, canOwn, canAdmin } = useWorkspace(); const toast = useToast(); const decide = useCommand('decideApproval'), apply = useCommand('applyStrategyStage');
  if (!current || items.length === 0) return null;
  return (
    <Card title="Pending deployment-stage approvals" className="mb-5">
      <ul className="divide-y divide-line text-[13px]">{items.map((a) => (
        <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <span><Link className="font-semibold text-accent hover:underline" href={`/strategies/${encodeURIComponent(a.subject.strategy)}`}>{names.get(a.subject.strategy) ?? a.subject.strategy}</Link>: {stageLabel(a.subject.from)} → <strong>{stageLabel(a.subject.to)}</strong> <Badge tone={a.status === 'approved' ? 'good' : 'warn'}>{a.status}</Badge></span>
          <span className="flex gap-2">
            {a.status === 'pending' && <>
              <Button disabled={!canOwn} title="Owner other than the requester" busy={decide.isPending} onClick={() => decide.mutate({ body: { approval: a.id, approve: true } }, { onSuccess: () => toast.push('Approved'), onError: (e) => toast.push(e.message, 'bad') })}>Approve</Button>
              <Button variant="danger" disabled={!canOwn} busy={decide.isPending} onClick={() => decide.mutate({ body: { approval: a.id, approve: false } }, { onSuccess: () => toast.push('Rejected'), onError: (e) => toast.push(e.message, 'bad') })}>Reject</Button></>}
            {a.status === 'approved' && <Button variant="primary" disabled={!canAdmin} busy={apply.isPending} onClick={() => apply.mutate({ body: { approval: a.id } }, { onSuccess: (r) => toast.push(`Stage is now ${stageLabel(r.result.stage)}`), onError: (e) => toast.push(e.message, 'bad') })}>Apply stage change</Button>}
          </span>
        </li>))}</ul>
    </Card>
  );
}

function Body() {
  const cat = useWs<{ items: Def[]; approvals: Approval[] }>('strategies/catalog');
  const chains = useWs<{ items: { id: string; family: string; capabilities: CapMap }[] }>('chains/overview');
  const [view, setView] = useState<'table' | 'cards'>('table'); const [s, setS] = useState(''); const [stage, setStage] = useState(''); const [wizard, setWizard] = useState<{ open: boolean; init: WizardState | null }>({ open: false, init: null });
  const { canAdmin } = useWorkspace();
  const chainList = chains.data?.items ?? [];
  return (<>
    <PageHeader title="Strategies" description="Spec strategy definitions and workspace strategies by deployment stage. All start in research with no evidence; promotion needs approval and live stays locked behind the deployment gates."
      actions={<Button variant="primary" onClick={() => setWizard({ open: true, init: null })} disabled={!canAdmin} title={canAdmin ? undefined : 'Owner or admin only'}><Plus className="size-4" aria-hidden />New strategy</Button>} />
    <Async q={cat}>{(d) => {
      const names = new Map(d.items.map((x) => [x.key, x.name]));
      const rows = d.items.filter((x) => (!stage || x.stage === stage) && (!s || (x.name + x.key + x.category + x.summary).toLowerCase().includes(s.toLowerCase())));
      const count = (st: string) => d.items.filter((x) => x.stage === st).length;
      const enabled = d.items.reduce((a, x) => a + x.instances.filter((i) => i.enabled).length, 0);
      const cover = (x: Def) => chainCoverage(x.allowed_families, chainList);
      const coverageText = (x: Def) => { const c = cover(x); return `${x.allowed_families.join(', ')}${c.chains ? ` · ${c.tradingCertified}/${c.chains} chains trading-certified` : ''}`; };
      const actions = (x: Def) => <Button variant="ghost" disabled={!canAdmin} onClick={(e) => { e.stopPropagation(); setWizard({ open: true, init: cloneToWizard(x as never) }); }} aria-label={`Clone ${x.name}`}>Clone</Button>;
      return (<>
        <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi label="Definitions" value={d.items.length} sub={`${d.items.filter((x) => x.workspace_id).length} workspace-defined`} />
          <Kpi label="Research / Paper" value={`${count('research')} / ${count('paper')}`} sub="Stage in this workspace" />
          <Kpi label="Live candidates" value={count('live_candidate')} sub="Live itself is locked behind the gates" tone="warn" />
          <Kpi label="Enabled on buckets" value={enabled} sub={enabled === 0 ? 'None running' : 'Strategy instances switched on'} />
        </div>
        <Approvals items={d.approvals} names={names} />
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input aria-label="Search strategies" placeholder="Search strategies…" value={s} onChange={(e) => setS(e.target.value)} className={cx(inputCls, 'max-w-xs')} />
          <select aria-label="Filter by stage" value={stage} onChange={(e) => setStage(e.target.value)} className={cx(inputCls, 'w-auto')}><option value="">Stage: all</option><option value="research">Research</option><option value="paper">Paper</option><option value="live_candidate">Live candidate</option></select>
          <div className="ml-auto inline-flex rounded-xl border border-line bg-white p-1" role="group" aria-label="View">
            <button aria-pressed={view === 'table'} onClick={() => setView('table')} className={cx('inline-flex min-h-8 items-center gap-1 rounded-lg px-3 text-[13px] font-semibold', view === 'table' ? 'bg-accent-soft text-accent' : 'text-muted')}><Table2 className="size-4" aria-hidden />Table</button>
            <button aria-pressed={view === 'cards'} onClick={() => setView('cards')} className={cx('inline-flex min-h-8 items-center gap-1 rounded-lg px-3 text-[13px] font-semibold', view === 'cards' ? 'bg-accent-soft text-accent' : 'text-muted')}><LayoutGrid className="size-4" aria-hidden />Cards</button>
          </div>
        </div>
        {view === 'table'
          ? <DataTable caption="Strategy definitions" rows={rows.map((x) => ({ ...x, id: `${x.key}@${x.version}` }))} cols={[
            { key: 'name', header: 'Strategy', render: (x) => <div><Link className="font-semibold text-accent hover:underline" href={`/strategies/${encodeURIComponent(x.key)}`}>{x.name}</Link><div className="text-[11px] text-muted">v{x.version} · {x.category.replace(/_/g, ' ')}</div></div> },
            { key: 'stage', header: 'Stage', filter: true, text: (x) => stageLabel(x.stage), render: (x) => <Badge tone={stageTone(x.stage)}>{stageLabel(x.stage)}</Badge> },
            { key: 'elig', header: 'Eligibility', text: (x) => `${x.spot_only ? 'spot only' : ''} ${x.regimes.join(' ')}`, render: (x) => <span className="text-[12px]"><Badge>spot only</Badge> <span className="text-muted">{x.regimes.join(', ') || '—'}</span></span> },
            { key: 'cov', header: 'Chain coverage', text: coverageText },
            { key: 'evidence', header: 'Evidence', filter: true, text: (x) => (x.has_evidence ? 'recorded' : 'none'), render: (x) => (x.has_evidence ? <Badge tone="good">Recorded</Badge> : <span className="text-muted">None</span>) },
            { key: 'enabled', header: 'Enabled buckets', text: (x) => { const e = x.instances.filter((i) => i.enabled); return e.length ? e.map((i) => i.bucket).join(', ') : 'none'; } },
            { key: 'act', header: '', text: () => '', render: actions }]} />
          : rows.length === 0 ? <EmptyState title="No matching strategies" hint="Adjust your search or stage filter." />
          : <div className="grid gap-5 lg:grid-cols-2 2xl:grid-cols-3">{rows.map((x) => (
            <article key={`${x.key}@${x.version}`} className="flex flex-col rounded-2xl border border-line bg-card p-5 shadow-card" aria-label={x.name}>
              <header className="flex items-start justify-between gap-2"><h2 className="text-[15px] font-semibold"><Link className="hover:underline" href={`/strategies/${encodeURIComponent(x.key)}`}>{x.name}</Link></h2><Badge tone={stageTone(x.stage)}>{stageLabel(x.stage)}</Badge></header>
              <p className="mt-2 text-[13px] text-muted">{x.summary || 'No description.'}</p>
              <dl className="mt-3 space-y-1 text-[12px]"><div><dt className="inline font-semibold">Coverage: </dt><dd className="inline text-muted">{coverageText(x)}</dd></div>
                <div><dt className="inline font-semibold">Evidence: </dt><dd className="inline text-muted">{x.has_evidence ? 'recorded' : 'none recorded (No runs yet)'}</dd></div>
                <div><dt className="inline font-semibold">Enabled on: </dt><dd className="inline text-muted">{x.instances.filter((i) => i.enabled).map((i) => i.bucket).join(', ') || 'no bucket'}</dd></div></dl>
              <footer className="mt-auto flex gap-2 pt-3">{actions(x)}</footer>
            </article>))}</div>}
        <div className="mt-5"><Note tone="warn"><Lock className="mr-1 inline size-4" aria-hidden />No strategy is live. Backtest, paper and live metrics appear only after real runs exist ("No runs yet" otherwise); see <Link className="font-semibold underline" href="/research">Research</Link>. Live execution needs every deployment gate to PASS with evidence plus your explicit opt-in.</Note></div>
        <StrategyWizard open={wizard.open} onClose={() => setWizard({ open: false, init: null })} initial={wizard.init} defs={d.items.map((x) => x as unknown as WizardDef)} />
      </>);
    }}</Async>
  </>);
}

export default function StrategiesPage() {
  return (
    <NeedWorkspace><Body /></NeedWorkspace>
  );
}
