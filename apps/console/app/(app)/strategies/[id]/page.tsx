'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ArrowLeft, Check, Lock } from 'lucide-react';
import { Async, Badge, Button, Card, ConfirmDialog, DataTable, Dialog, EmptyState, Kpi, PageHeader, Progress, Select, TabPanel, Tabs, TextInput, useToast, cx } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { useWs } from '@/components/hooks';
import { useApi, useCommand } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { formatUnits, parseUnits, when } from '@/lib/format';
import { STAGES, canEnableOnBucket, cloneToWizard, nextStage, promotionBlocker, stageLabel, type Stage, type WizardState } from '@/lib/strategy';
import { StrategyWizard, type WizardDef } from '@/components/trading/strategy-wizard';
import { EnvBadge, Note, amt, stageTone } from '@/components/trading/parts';

const TABS = ['Overview', 'Signals', 'Execution', 'Risk', 'Research', 'Jobs', 'Audit'].map((t) => ({ id: t.toLowerCase(), label: t }));
interface Detail {
  definition: { key: string; version: number; name: string; category: string; summary: string; spot_only: boolean; allowed_families: string[]; data_sources: string[]; regimes: string[]; evidence: Record<string, unknown>; workspace_id: string | null; cloned_from: string | null;
    param_bounds: Record<string, { min: number; max: number; default: number }>; risk_budget: { max_order_bps_of_budget?: number; max_daily_loss_bps?: number }; validation_plan: { paper_days?: number; min_trades?: number; notes?: string } };
  stage: Stage;
  instances: { id: string; bucket_id: string; bucket: string; bucket_state: string; environment: string; enabled: boolean; params: Record<string, any>; version: number; updated_at: string }[];
  budgets: { bucket_id: string; bucket: string; asset_id: string; symbol: string; decimals: number; limit_amount: string; reserved_amount: string }[];
  signals: { id: string; environment: string; side: string; state: string; created_at: string; base_symbol: string; quote_symbol: string }[];
  execution: { environment: string; symbol: string; decimals: number; fills: number; gross: string; fees: string }[];
  risk: { decision: string; n: number }[]; vetoes: { intent_id: string; reasons: unknown; created_at: string }[];
  runs: { id: string; kind: string; label: string | null; status: string; data_provenance: string; created_at: string; finished_at: string | null; metrics: Record<string, unknown> | null }[];
  jobs: { id: string; queue: string; status: string; attempts: number; last_error: string | null; created_at: string }[];
  audit: { id: number; action: string; entity: string; environment: string | null; detail: unknown; created_at: string }[];
  approvals: { id: string; subject: { from: string; to: string }; status: string; created_at: string }[];
}
interface Bucket { id: string; name: string; kind: string; environment: string; state: string; portfolio_id: string }
interface Asset { id: string; chain_id: string; symbol: string; decimals: number; contract: string }

function StageLadder({ stage }: { stage: Stage }) {
  const idx = STAGES.indexOf(stage);
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label="Deployment stage">
      {STAGES.map((s, i) => <li key={s} aria-current={s === stage ? 'step' : undefined} className={cx('flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold', s === stage ? 'bg-accent text-white' : i < idx ? 'bg-good-soft text-good' : 'bg-[#eef1f6] text-muted')}>{i < idx && <Check className="size-3.5" aria-hidden />}{stageLabel(s)}</li>)}
      <li className="flex items-center gap-1.5 rounded-full border border-dashed border-line px-3 py-1.5 text-[12px] font-semibold text-muted"><Lock className="size-3.5" aria-hidden />Live (locked behind gates)</li>
    </ol>
  );
}

function BudgetDialog({ open, onClose, bucket, strategy, assets, existing }: { open: boolean; onClose: () => void; bucket: Bucket | null; strategy: string; assets: Asset[]; existing?: Detail['budgets'][number] }) {
  const toast = useToast(); const set = useCommand('setStrategyBudget'); const [asset, setAsset] = useState(''); const [amount, setAmount] = useState(''); const [err, setErr] = useState('');
  useEffect(() => { if (open) { setAsset(existing?.asset_id ?? ''); setAmount(existing ? formatUnits(existing.limit_amount, existing.decimals, 18) : ''); setErr(''); } }, [open, existing]);
  const a = assets.find((x) => x.id === asset);
  if (!bucket) return null;
  const submit = () => {
    if (!a) { setErr('Choose the budget asset'); return; }
    let limit: string; try { limit = parseUnits(amount, a.decimals); } catch (e) { setErr((e as Error).message); return; }
    set.mutate({ body: { bucket: bucket.id, strategy, asset: a.id, limit } }, { onSuccess: () => { toast.push('Capital budget saved'); onClose(); }, onError: (e) => setErr(e.message) });
  };
  return (
    <Dialog open={open} onClose={onClose} title={`Capital budget: ${bucket.name}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={set.isPending} onClick={submit}>Save budget</Button></>}>
      <div className="space-y-4">
        <Select label="Budget asset" value={asset} onChange={(e) => setAsset(e.target.value)} options={[{ value: '', label: 'Choose an asset…' }, ...assets.map((x) => ({ value: x.id, label: `${x.symbol} · ${x.chain_id}${x.contract === 'native' ? '' : ' · ' + x.contract.slice(0, 8)}` }))]} />
        <TextInput label={`Limit${a ? ` (${a.symbol}, up to ${a.decimals} decimals)` : ''}`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} error={err} />
        <p className="text-[12px] text-muted">The budget caps how much of this bucket the strategy may reserve. It does not move funds. The change is audited.</p>
      </div>
    </Dialog>
  );
}

function ConfigDialog({ open, onClose, bucket, d }: { open: boolean; onClose: () => void; bucket: Bucket | null; d: Detail }) {
  const toast = useToast(); const cfg = useCommand('configureStrategyInstance'); const inst = d.instances.find((i) => i.bucket_id === bucket?.id);
  const [orderType, setOrderType] = useState('limit'); const [stop, setStop] = useState(''); const [maxOrder, setMaxOrder] = useState(''); const [tuned, setTuned] = useState<Record<string, string>>({}); const [err, setErr] = useState('');
  useEffect(() => { if (open) { const p = inst?.params ?? {}; setOrderType(p.order_type ?? 'limit'); setStop(p.stop_loss_bps != null ? String(p.stop_loss_bps) : ''); setMaxOrder(p.max_order_bps_of_budget != null ? String(p.max_order_bps_of_budget) : ''); setTuned(Object.fromEntries(Object.entries(p.tuned ?? {}).map(([k, v]) => [k, String(v)]))); setErr(''); } }, [open, inst]);
  if (!bucket) return null;
  const submit = () => {
    const params: Record<string, unknown> = { order_type: orderType };
    for (const [k, v, hi] of [['stop_loss_bps', stop, 10000], ['max_order_bps_of_budget', maxOrder, 10000]] as const) if (v.trim() !== '') { const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > hi) { setErr(`${k} must be a whole number 0-${hi}`); return; } params[k] = n; }
    const t: Record<string, number> = {};
    for (const [k, v] of Object.entries(tuned)) if (v.trim() !== '') { const n = Number(v); const b = d.definition.param_bounds[k]; if (!Number.isFinite(n) || !b || n < b.min || n > b.max) { setErr(`${k} must be within ${b?.min}-${b?.max}`); return; } t[k] = n; }
    if (Object.keys(t).length) params.tuned = t;
    cfg.mutate({ body: { bucket: bucket.id, strategy: d.definition.key, params } }, { onSuccess: () => { toast.push('Strategy settings saved'); onClose(); }, onError: (e) => setErr(e.message) });
  };
  return (
    <Dialog open={open} onClose={onClose} side title={`Settings: ${bucket.name}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={cfg.isPending} onClick={submit}>Save settings</Button></>}>
      <div className="space-y-4">
        <Select label="Order type" value={orderType} onChange={(e) => setOrderType(e.target.value)} options={[{ value: 'limit', label: 'Limit' }, { value: 'market', label: 'Market' }]} />
        <TextInput label="Stop loss (basis points)" inputMode="numeric" value={stop} onChange={(e) => setStop(e.target.value)} hint="Optional. 150 = 1.50%." />
        <TextInput label="Max order size (bps of budget)" inputMode="numeric" value={maxOrder} onChange={(e) => setMaxOrder(e.target.value)} hint={`Cannot exceed the definition cap (${d.definition.risk_budget.max_order_bps_of_budget ?? 10000}).`} />
        {Object.entries(d.definition.param_bounds).map(([k, b]) => <TextInput key={k} label={`${k} (${b.min} to ${b.max}, default ${b.default})`} inputMode="decimal" value={tuned[k] ?? ''} onChange={(e) => setTuned({ ...tuned, [k]: e.target.value })} />)}
        {err && <p role="alert" className="text-[13px] text-bad">{err}</p>}
        <p className="text-[12px] text-muted">Settings are validated against the declared bounds by the database and can only narrow, never relax, parent risk limits. Saving does not enable the strategy.</p>
      </div>
    </Dialog>
  );
}

function Assignments({ d, buckets, assets }: { d: Detail; buckets: Bucket[]; assets: Asset[] }) {
  const { current, canAdmin } = useWorkspace(); const toast = useToast(); const en = useCommand('setStrategyEnabled');
  const [budget, setBudget] = useState<Bucket | null>(null); const [config, setConfig] = useState<Bucket | null>(null); const [toggle, setToggle] = useState<{ b: Bucket; on: boolean } | null>(null);
  const trading = buckets.filter((b) => b.kind === 'trading');
  if (trading.length === 0) return <EmptyState title="No trading buckets" hint="Create a bucket to assign this strategy a capital budget." action={<Link className="font-semibold text-accent underline" href="/buckets">Go to Buckets</Link>} />;
  const stageOk = canEnableOnBucket(d.stage);
  return (<>
    {!stageOk && <div className="mb-3"><Note tone="warn">This strategy is in <strong>Research</strong>. It cannot be enabled on a bucket until it is promoted to Paper (approval required). Budgets can be prepared in the meantime.</Note></div>}
    <DataTable caption="Bucket assignments" searchable={false} rows={trading.map((b) => {
      const inst = d.instances.find((i) => i.bucket_id === b.id); const bud = d.budgets.find((x) => x.bucket_id === b.id);
      return { id: b.id, b, inst, bud };
    })} cols={[
      { key: 'bucket', header: 'Bucket', text: (r) => r.b.name, render: (r) => <div><Link className="font-semibold text-accent hover:underline" href={`/portfolios/${r.b.portfolio_id}/buckets/${r.b.id}`}>{r.b.name}</Link> <EnvBadge env={r.b.environment} /></div> },
      { key: 'budget', header: 'Capital budget', text: (r) => (r.bud ? amt(r.bud.limit_amount, r.bud.decimals, r.bud.symbol) : 'None set'), render: (r) => r.bud ? <div className="space-y-1"><span className="tabular">{amt(r.bud.limit_amount, r.bud.decimals, r.bud.symbol)}</span>
        <div className="text-[11px] text-muted">reserved {amt(r.bud.reserved_amount, r.bud.decimals)}</div></div> : <span className="text-muted">None set</span> },
      { key: 'enabled', header: 'Enabled', text: (r) => (r.inst?.enabled ? 'on' : 'off'), filter: true, render: (r) => (
        <button role="switch" aria-checked={!!r.inst?.enabled} aria-label={`Enable ${d.definition.name} on ${r.b.name}`} disabled={!canAdmin || (!r.inst?.enabled && !stageOk)} onClick={() => setToggle({ b: r.b, on: !r.inst?.enabled })}
          className={cx('relative inline-flex h-7 w-12 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50', r.inst?.enabled ? 'border-accent bg-accent' : 'border-line bg-[#dfe5ee]')}>
          <span className={cx('inline-block size-5 rounded-full bg-white shadow transition-transform', r.inst?.enabled ? 'translate-x-6' : 'translate-x-1')} /><span className="sr-only">{r.inst?.enabled ? 'On' : 'Off'}</span></button>) },
      { key: 'settings', header: 'Settings', text: (r) => (r.inst ? Object.keys(r.inst.params).join(', ') || 'defaults' : '—') },
      { key: 'act', header: '', text: () => '', render: (r) => <span className="flex gap-2"><Button disabled={!canAdmin} onClick={() => setBudget(r.b)}>Set budget</Button><Button disabled={!canAdmin} onClick={() => setConfig(r.b)}>Settings</Button></span> }]} />
    <BudgetDialog open={!!budget} onClose={() => setBudget(null)} bucket={budget} strategy={d.definition.key} assets={assets} existing={d.budgets.find((x) => x.bucket_id === budget?.id)} />
    <ConfigDialog open={!!config} onClose={() => setConfig(null)} bucket={config} d={d} />
    <ConfirmDialog open={!!toggle} onClose={() => setToggle(null)} busy={en.isPending} confirmLabel={toggle?.on ? 'Enable' : 'Disable'} danger={!toggle?.on} title={`${toggle?.on ? 'Enable' : 'Disable'} on ${toggle?.b.name ?? ''}`}
      body={toggle?.on ? <p>The strategy will be allowed to propose <strong>{toggle.b.environment}</strong> order intents from this bucket within its capital budget. Every intent still passes the independent risk service; {toggle.b.environment === 'live' ? 'live is blocked unless all gates pass' : 'nothing here touches a real wallet'}.</p> : <p>The strategy stops proposing new intents from this bucket. Open orders keep settling and exits are unaffected.</p>}
      onConfirm={() => { if (!toggle || !current) return; en.mutate({ body: { bucket: toggle.b.id, strategy: d.definition.key, enabled: toggle.on } }, { onSuccess: () => { toast.push(toggle.on ? 'Strategy enabled' : 'Strategy disabled'); setToggle(null); }, onError: (e) => { toast.push(e.message, 'bad'); setToggle(null); } }); }} />
  </>);
}

function Overview({ d, buckets, assets }: { d: Detail; buckets: Bucket[]; assets: Asset[] }) {
  const def = d.definition; const hasEvidence = Object.keys(def.evidence ?? {}).length > 0; const blocker = promotionBlocker(d.stage, hasEvidence);
  return (<div className="space-y-6">
    <section aria-label="Definition" className="grid gap-5 lg:grid-cols-2">
      <div className="space-y-3 text-[13px]">
        <p>{def.summary || 'No description.'}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
          <dt className="font-semibold">Eligibility</dt><dd><Badge>{def.spot_only ? 'spot only' : 'non-spot'}</Badge> families: {def.allowed_families.join(', ')}</dd>
          <dt className="font-semibold">Regimes</dt><dd>{def.regimes.join(', ') || '—'}</dd>
          <dt className="font-semibold">Data sources</dt><dd>{def.data_sources.join(', ') || '—'} <span className="text-muted">(declared; not necessarily connected)</span></dd>
          <dt className="font-semibold">Risk budget</dt><dd>max order {def.risk_budget.max_order_bps_of_budget ?? '—'} bps of budget{def.risk_budget.max_daily_loss_bps != null ? ` · daily loss ${def.risk_budget.max_daily_loss_bps} bps` : ''}</dd>
          <dt className="font-semibold">Validation plan</dt><dd>{def.validation_plan.paper_days ? `${def.validation_plan.paper_days} days, ${def.validation_plan.min_trades} trades` : 'not specified'}</dd>
          <dt className="font-semibold">Evidence</dt><dd>{hasEvidence ? <Badge tone="good">Recorded</Badge> : <span>None recorded. <span className="text-muted">No backtest, paper or live metric exists.</span></span>}</dd>
        </dl>
      </div>
      <div>
        <h3 className="mb-2 text-[13px] font-semibold">Parameter bounds</h3>
        {Object.keys(def.param_bounds).length === 0 ? <p className="text-[13px] text-muted">No tunable parameters declared.</p>
          : <table className="w-full text-left text-[13px]"><caption className="sr-only">Parameter bounds</caption><thead className="text-[11px] uppercase text-muted"><tr><th scope="col" className="py-1">Parameter</th><th scope="col">Min</th><th scope="col">Default</th><th scope="col">Max</th></tr></thead>
            <tbody>{Object.entries(def.param_bounds).map(([k, b]) => <tr key={k} className="border-t border-line"><td className="py-1.5">{k}</td><td className="tabular">{b.min}</td><td className="tabular">{b.default}</td><td className="tabular">{b.max}</td></tr>)}</tbody></table>}
      </div>
    </section>
    <section aria-label="Deployment stage"><h3 className="mb-2 text-[13px] font-semibold">Deployment stage</h3><StageLadder stage={d.stage} />
      <Promotion d={d} blocker={blocker} /></section>
    <section aria-label="Bucket assignment"><h3 className="mb-2 text-[13px] font-semibold">Bucket assignment and capital budget</h3><Assignments d={d} buckets={buckets} assets={assets} /></section>
  </div>);
}

function Promotion({ d, blocker }: { d: Detail; blocker: string | null }) {
  const { current, canAdmin, canOwn } = useWorkspace(); const toast = useToast(); const req = useCommand('requestStrategyStage'), decide = useCommand('decideApproval'), apply = useCommand('applyStrategyStage'); const [open, setOpen] = useState(false);
  const to = nextStage(d.stage); const pending = d.approvals.filter((a) => a.status === 'pending' || a.status === 'approved');
  if (!current) return null; const err = (e: Error) => toast.push(e.message, 'bad');
  return (
    <div className="mt-3 space-y-3 text-[13px]">
      {blocker && <p className="text-muted">{blocker}</p>}
      {pending.map((a) => (
        <div key={a.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3">
          <span>Pending: {stageLabel(a.subject.from)} → <strong>{stageLabel(a.subject.to)}</strong> <Badge tone={a.status === 'approved' ? 'good' : 'warn'}>{a.status}</Badge> <span className="text-muted">requested {when(a.created_at)}</span></span>
          {a.status === 'pending' && <><Button disabled={!canOwn} title="A different owner than the requester must approve" busy={decide.isPending} onClick={() => decide.mutate({ body: { approval: a.id, approve: true } }, { onSuccess: () => toast.push('Approved'), onError: err })}>Approve</Button>
            <Button variant="danger" disabled={!canOwn} busy={decide.isPending} onClick={() => decide.mutate({ body: { approval: a.id, approve: false } }, { onSuccess: () => toast.push('Rejected'), onError: err })}>Reject</Button></>}
          {a.status === 'approved' && <Button variant="primary" disabled={!canAdmin} busy={apply.isPending} onClick={() => apply.mutate({ body: { approval: a.id } }, { onSuccess: (r) => toast.push(`Stage is now ${stageLabel(r.result.stage)}`), onError: err })}>Apply stage change</Button>}
        </div>))}
      {to && !blocker && pending.length === 0 && <Button variant="primary" disabled={!canAdmin} onClick={() => setOpen(true)}>Request promotion to {stageLabel(to)}</Button>}
      <ConfirmDialog open={open} onClose={() => setOpen(false)} busy={req.isPending} confirmLabel="Request approval" title={`Request promotion to ${to ? stageLabel(to) : ''}`}
        body={<><p>This creates an approval request. A <strong>different workspace owner</strong> must approve it, then it must be applied; nothing changes until then.</p>
          <p className="text-muted">{to === 'paper' ? 'Paper lets the strategy be enabled on paper buckets. It still passes the risk service and never touches a real wallet.' : 'A live candidate is still not live: live execution needs every deployment gate to PASS with evidence.'}</p></>}
        onConfirm={() => to && req.mutate({ body: { workspace: current.id, strategy: d.definition.key, version: d.definition.version, to } }, { onSuccess: () => { toast.push('Approval requested'); setOpen(false); }, onError: (e) => { toast.push(e.message, 'bad'); setOpen(false); } })} />
    </div>
  );
}

function Body({ id }: { id: string }) {
  const q = useWs<Detail>(`strategies/${id}/detail`); const bq = useWs<{ items: Bucket[] }>('buckets'); const aq = useApi<{ items: Asset[] }>('v1/assets');
  const [tab, setTab] = useState('overview'); const [wizard, setWizard] = useState<WizardState | null>(null); const { canAdmin, current } = useWorkspace(); const toast = useToast(); const dis = useCommand('disableStrategy'); const [off, setOff] = useState(false); const [reason, setReason] = useState('');
  const cat = useWs<{ items: WizardDef[] }>('strategies/catalog');
  useEffect(() => { const h = window.location.hash.slice(1); if (TABS.some((t) => t.id === h)) setTab(h); }, []);
  const pick = (t: string) => { setTab(t); try { window.history.replaceState(null, '', `#${t}`); } catch { /* ignore */ } };
  return (
    <Async q={q}>{(d) => {
      const def = d.definition; const buckets = bq.data?.items ?? []; const assets = aq.data?.items ?? [];
      const nEnabled = d.instances.filter((i) => i.enabled).length;
      return (<>
        <PageHeader title={def.name} description={`${def.key} · v${def.version} · ${def.category.replace(/_/g, ' ')}${def.cloned_from ? ` · cloned from ${def.cloned_from}` : ''}`}
          actions={<>
            <Link href="/strategies" className="inline-flex min-h-10 items-center gap-1 rounded-xl border border-line bg-white px-4 text-[13px] font-semibold"><ArrowLeft className="size-4" aria-hidden />All strategies</Link>
            <Button disabled={!canAdmin} onClick={() => setWizard(cloneToWizard(def as never))}>Clone</Button>
            <Button variant="danger" disabled={!canAdmin} onClick={() => { setReason(''); setOff(true); }}>Disable</Button></>} />
        <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi label="Stage" value={<Badge tone={stageTone(d.stage)}>{stageLabel(d.stage)}</Badge>} sub="In this workspace" />
          <Kpi label="Enabled buckets" value={nEnabled} sub={nEnabled ? d.instances.filter((i) => i.enabled).map((i) => i.bucket).join(', ') : 'None enabled'} />
          <Kpi label="Order intents" value={d.signals.length >= 50 ? '50+' : d.signals.length} sub={d.signals.length ? 'Recorded for this strategy' : 'No runs yet'} />
          <Kpi label="Evidence" value={Object.keys(def.evidence ?? {}).length ? 'Recorded' : 'None'} sub={def.spot_only ? 'Spot only' : ''} tone="warn" />
        </div>
        <Card><Tabs tabs={TABS} value={tab} onChange={pick} />
          <TabPanel id="overview" value={tab}><Overview d={d} buckets={buckets} assets={assets} /></TabPanel>
          <TabPanel id="signals" value={tab}>{d.signals.length === 0 ? <EmptyState title="No signals yet" hint="Order intents created for this strategy appear here. Nothing is shown that was not recorded." /> :
            <DataTable caption="Strategy signals" rows={d.signals} cols={[{ key: 'created_at', header: 'Time', text: (s) => when(s.created_at), sort: (s) => s.created_at }, { key: 'environment', header: 'Env', filter: true, render: (s) => <EnvBadge env={s.environment} /> },
              { key: 'pair', header: 'Pair', text: (s) => `${s.base_symbol}/${s.quote_symbol}` }, { key: 'side', header: 'Side', filter: true }, { key: 'state', header: 'State', filter: true, render: (s) => <Badge tone={s.state === 'UNKNOWN' ? 'warn' : 'neutral'}>{s.state}</Badge> }]} />}</TabPanel>
          <TabPanel id="execution" value={tab}>{d.execution.length === 0 ? <EmptyState title="No fills yet" hint="Execution economics (fees, notional) come from recorded fills." /> :
            <DataTable caption="Execution by environment" rows={d.execution.map((e, i) => ({ ...e, id: String(i) }))} cols={[{ key: 'environment', header: 'Env', filter: true, render: (e) => <EnvBadge env={e.environment} /> }, { key: 'fills', header: 'Fills', align: 'right', sort: (e) => e.fills },
              { key: 'gross', header: 'Gross notional', align: 'right', text: (e) => amt(e.gross, e.decimals, e.symbol) }, { key: 'fees', header: 'Fees', align: 'right', text: (e) => amt(e.fees, e.decimals, e.symbol) }]} />}
            <div className="mt-4"><Note>Instance settings: {d.instances.length ? d.instances.map((i) => `${i.bucket}: ${Object.keys(i.params).length ? JSON.stringify(i.params) : 'defaults'}`).join(' · ') : 'no instances configured'}</Note></div></TabPanel>
          <TabPanel id="risk" value={tab}>
            <div className="grid gap-5 lg:grid-cols-2">
              <div><h3 className="mb-2 text-[13px] font-semibold">Risk decisions</h3>{d.risk.length === 0 ? <EmptyState title="No risk decisions yet" hint="The risk service records an ADMIT or VETO for each intent." /> :
                <ul className="text-[13px]">{d.risk.map((r) => <li key={r.decision} className="flex justify-between border-t border-line py-2"><span>{r.decision}</span><strong>{r.n}</strong></li>)}</ul>}
                {d.vetoes.length > 0 && <ul className="mt-3 space-y-1 text-[12px] text-muted">{d.vetoes.map((v) => <li key={v.intent_id}>{when(v.created_at)} · {JSON.stringify(v.reasons).slice(0, 140)}</li>)}</ul>}</div>
              <div><h3 className="mb-2 text-[13px] font-semibold">Budget utilisation</h3>{d.budgets.length === 0 ? <EmptyState title="No capital budget" hint="Set a budget per bucket on the Overview tab." /> :
                <ul className="space-y-3 text-[13px]">{d.budgets.map((b) => { const lim = BigInt(b.limit_amount); const pct = lim === 0n ? 0 : Number((BigInt(b.reserved_amount) * 10000n) / lim) / 100;
                  return <li key={b.bucket_id + b.asset_id}><div className="flex justify-between"><span>{b.bucket}</span><span className="tabular">{amt(b.reserved_amount, b.decimals)} / {amt(b.limit_amount, b.decimals, b.symbol)}</span></div><Progress value={pct} label={`Budget used in ${b.bucket}`} /></li>; })}</ul>}
                <p className="mt-3 text-[12px] text-muted">Definition cap: {def.risk_budget.max_order_bps_of_budget ?? '—'} bps per order.</p></div>
            </div></TabPanel>
          <TabPanel id="research" value={tab}>{d.runs.length === 0 ? <div className="space-y-3"><EmptyState title="No runs yet" hint="No backtest or replay referencing this strategy exists. Metrics are never shown without a recorded run." action={<Link className="font-semibold text-accent underline" href="/research">Open Research</Link>} /></div> :
            <DataTable caption="Research runs" rows={d.runs} cols={[{ key: 'created_at', header: 'Started', text: (r) => when(r.created_at), sort: (r) => r.created_at }, { key: 'label', header: 'Run', render: (r) => <Link className="font-semibold text-accent hover:underline" href={`/research/${r.id}`}>{r.label ?? r.id.slice(0, 8)}</Link>, text: (r) => r.label ?? r.id },
              { key: 'kind', header: 'Kind', filter: true }, { key: 'status', header: 'Status', filter: true }, { key: 'data_provenance', header: 'Data provenance', filter: true, render: (r) => <Badge tone={r.data_provenance === 'SYNTHETIC' ? 'warn' : 'neutral'}>{r.data_provenance}</Badge> }]} />}</TabPanel>
          <TabPanel id="jobs" value={tab}>{d.jobs.length === 0 ? <EmptyState title="No jobs" hint="Queue jobs that reference this strategy appear here." /> :
            <DataTable caption="Jobs" rows={d.jobs} cols={[{ key: 'created_at', header: 'Created', text: (j) => when(j.created_at) }, { key: 'queue', header: 'Queue', filter: true }, { key: 'status', header: 'Status', filter: true }, { key: 'attempts', header: 'Attempts', align: 'right' }, { key: 'last_error', header: 'Last error', text: (j) => j.last_error ?? '—' }]} />}</TabPanel>
          <TabPanel id="audit" value={tab}>{d.audit.length === 0 ? <EmptyState title="No audit events" /> :
            <DataTable caption="Audit trail" rows={d.audit.map((a) => ({ ...a, id: String(a.id) }))} cols={[{ key: 'created_at', header: 'Time', text: (a) => when(a.created_at) }, { key: 'action', header: 'Action', filter: true }, { key: 'environment', header: 'Env', text: (a) => a.environment ?? '—' }, { key: 'detail', header: 'Detail', text: (a) => JSON.stringify(a.detail).slice(0, 160) }]} />}</TabPanel>
        </Card>
        <StrategyWizard open={!!wizard} onClose={() => setWizard(null)} initial={wizard} defs={cat.data?.items ?? []} />
        <ConfirmDialog open={off} onClose={() => setOff(false)} danger phrase="DISABLE" confirmLabel="Disable strategy" busy={dis.isPending} title={`Disable ${def.name}`}
          body={<><p>Switches the strategy off on <strong>{nEnabled}</strong> bucket(s) and returns it to <strong>Research</strong> in this workspace. Open orders keep settling. Re-enabling needs a new approved promotion.</p>
            <TextInput label="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></>}
          onConfirm={() => { if (!current) return; if (reason.trim().length < 3) { toast.push('A reason of at least 3 characters is required', 'bad'); return; }
            dis.mutate({ body: { workspace: current.id, strategy: def.key, reason: reason.trim() } }, { onSuccess: (r) => { toast.push(`Strategy disabled (${r.result.instancesDisabled} instance(s) switched off)`); setOff(false); }, onError: (e) => toast.push(e.message, 'bad') }); }} />
      </>);
    }}</Async>
  );
}

export default function StrategyDetailPage() {
  const { id } = useParams<{ id: string }>(); let key = id; try { key = decodeURIComponent(id); } catch { /* keep raw */ }
  return <NeedWorkspace><Body id={key} /></NeedWorkspace>;
}
