'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2 } from 'lucide-react';
import { Badge, Button, Dialog, Field, Select, Stepper, TextInput, inputCls, useToast } from '@/components/ui';
import { useCommand } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { WIZARD_STEPS, cloneToWizard, emptyWizard, slugify, toCommand, validateStep, type DefLite, type WizardState } from '@/lib/strategy';

const FAMILIES = [['cex', 'CEX / venue (spot)'], ['evm', 'EVM'], ['svm', 'Solana (SVM)'], ['sui', 'Sui'], ['aptos', 'Aptos'], ['tron', 'TRON'], ['cosmos', 'Cosmos'], ['bitcoin', 'Bitcoin'], ['ton', 'TON'], ['near', 'NEAR']];
const CATEGORIES = ['custom', 'cex_directional', 'cex_microstructure', 'cex_relative_value', 'arbitrage', 'allocation', 'onchain_research', 'intelligence', 'monitor', 'risk'];
const SOURCES = ['ohlcv', 'order_book_l1', 'order_book_l2', 'trades', 'pool_state', 'gas_quotes', 'balances', 'portfolio_state', 'news_feed', 'social_feed', 'holder_distribution', 'launch_feed', 'contract_scan', 'sell_simulation', 'wallet_activity', 'bridge_quotes', 'strategy_evidence'];
const REGIMES = ['trending', 'range', 'compression', 'expansion', 'liquid', 'stress', 'any'];

export type WizardDef = DefLite & { version: number };

export function StrategyWizard({ open, onClose, initial, defs }: { open: boolean; onClose: () => void; initial: WizardState | null; defs: WizardDef[] }) {
  const { current } = useWorkspace(); const toast = useToast(); const router = useRouter();
  const [w, setW] = useState<WizardState>(emptyWizard()); const [step, setStep] = useState(0); const [err, setErr] = useState<Record<string, string>>({}); const [custom, setCustom] = useState('');
  const create = useCommand<object, { key: string }>('createStrategy'); const stage = useCommand('requestStrategyStage');
  useEffect(() => { if (open) { setW(initial ?? emptyWizard()); setStep(0); setErr({}); setCustom(''); } }, [open, initial]);
  const set = (p: Partial<WizardState>) => setW((x) => ({ ...x, ...p }));
  const toggle = (k: 'families' | 'dataSources' | 'regimes', v: string) => set({ [k]: w[k].includes(v) ? w[k].filter((x) => x !== v) : [...w[k], v] } as Partial<WizardState>);
  const next = () => { const e = validateStep(step, w); setErr(e); if (Object.keys(e).length === 0) setStep(step + 1); };
  const submit = () => {
    if (!current) return;
    for (let s = 0; s <= 4; s++) { const e = validateStep(s, w); if (Object.keys(e).length) { setStep(s); setErr(e); return; } }
    create.mutate({ body: toCommand(w, current.id) }, {
      onSuccess: (r) => {
        const key = r.result.key;
        const done = (msg: string) => { toast.push(msg); onClose(); router.push(`/strategies/${encodeURIComponent(key)}`); };
        if (w.requestPaper) stage.mutate({ body: { workspace: current.id, strategy: key, version: 1, to: 'paper' } }, { onSuccess: () => done('Strategy created in research stage; paper promotion awaits approval'), onError: (e) => { toast.push(`Created, but the paper request failed: ${e.message}`, 'bad'); onClose(); router.push(`/strategies/${encodeURIComponent(key)}`); } });
        else done('Strategy created in research stage');
      },
      onError: (e) => toast.push(e.message, 'bad'),
    });
  };
  const busy = create.isPending || stage.isPending;
  return (
    <Dialog open={open} onClose={onClose} side title={w.clonedFrom ? 'Clone strategy' : 'New strategy'}
      footer={<>
        {step > 0 && <Button onClick={() => { setErr({}); setStep(step - 1); }} disabled={busy}>Back</Button>}
        {step < 5 ? <Button variant="primary" onClick={next}>Continue</Button> : <Button variant="primary" busy={busy} onClick={submit}>Create in research stage</Button>}
      </>}>
      <Stepper steps={WIZARD_STEPS.map((s, i) => `S-0${i + 1} ${s}`)} current={step} />
      {step === 0 && <div className="space-y-4">
        {defs.length > 0 && <Select label="Start from (optional)" value={w.clonedFrom ?? ''} onChange={(e) => { const d = defs.find((x) => x.key === e.target.value); set(d ? cloneToWizard(d) : { ...emptyWizard(), name: w.name, slug: w.slug }); }}
          options={[{ value: '', label: 'Blank definition' }, ...defs.map((d) => ({ value: d.key, label: d.name }))]} hint="Cloning copies bounds and budgets, never evidence or stage." />}
        <TextInput label="Name" value={w.name} error={err.name} onChange={(e) => set({ name: e.target.value, slug: w.slug === slugify(w.name) || !w.slug ? slugify(e.target.value) : w.slug })} maxLength={120} />
        <TextInput label="Key (slug)" value={w.slug} error={err.slug} onChange={(e) => set({ slug: e.target.value })} maxLength={40} hint="Stored as ws.<workspace>.<slug>" />
        <Select label="Type" value={w.category} onChange={(e) => set({ category: e.target.value })} options={CATEGORIES.map((c) => ({ value: c, label: c.replace(/_/g, ' ') }))} />
        <Field label="Summary"><textarea className={inputCls + ' min-h-20 py-2'} value={w.summary} maxLength={600} onChange={(e) => set({ summary: e.target.value })} /></Field>
        <fieldset><legend className="mb-1 text-[12px] font-semibold text-[#44546a]">Eligible chain families / venue kinds (spot only)</legend>
          <div className="flex flex-wrap gap-2">{FAMILIES.map(([v, l]) => <label key={v} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-line px-3 text-[13px]"><input type="checkbox" checked={w.families.includes(v)} onChange={() => toggle('families', v)} />{l}</label>)}</div>
          {err.families && <p role="alert" className="mt-1 text-[12px] text-bad">{err.families}</p>}</fieldset>
        <p className="text-[12px] text-muted">Derivatives are not available: every strategy definition is spot-only, enforced by the database.</p>
      </div>}
      {step === 1 && <div className="space-y-4">
        <fieldset><legend className="mb-1 text-[12px] font-semibold text-[#44546a]">Data sources</legend>
          <div className="flex flex-wrap gap-2">{[...new Set([...SOURCES, ...w.dataSources])].map((v) => <label key={v} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-line px-3 text-[13px]"><input type="checkbox" checked={w.dataSources.includes(v)} onChange={() => toggle('dataSources', v)} />{v}</label>)}</div></fieldset>
        <div className="flex items-end gap-2"><div className="flex-1"><TextInput label="Add custom source tag" value={custom} onChange={(e) => setCustom(e.target.value.toLowerCase())} placeholder="e.g. venue_funding" /></div>
          <Button onClick={() => { if (/^[a-z0-9_:.-]{2,60}$/.test(custom) && !w.dataSources.includes(custom)) { set({ dataSources: [...w.dataSources, custom] }); setCustom(''); } }} disabled={!/^[a-z0-9_:.-]{2,60}$/.test(custom)}><Plus className="size-4" aria-hidden />Add</Button></div>
        <fieldset><legend className="mb-1 text-[12px] font-semibold text-[#44546a]">Market regimes where it is eligible</legend>
          <div className="flex flex-wrap gap-2">{REGIMES.map((v) => <label key={v} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-line px-3 text-[13px]"><input type="checkbox" checked={w.regimes.includes(v)} onChange={() => toggle('regimes', v)} />{v}</label>)}</div></fieldset>
        <p className="text-[12px] text-muted">Declaring a data source does not connect it. The strategy cannot run until the feed exists and the research gates pass.</p>
      </div>}
      {step === 2 && <div className="space-y-3">
        <p className="text-[13px] text-muted">Declare the numeric parameters the strategy may use and their hard bounds. Instances can tune a value only inside these bounds.</p>
        {w.bounds.map((b, i) => (
          <div key={i} className="rounded-xl border border-line p-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <TextInput label="Name" value={b.name} error={err[`b${i}.name`]} onChange={(e) => set({ bounds: w.bounds.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
              <TextInput label="Min" inputMode="decimal" value={b.min} onChange={(e) => set({ bounds: w.bounds.map((x, j) => (j === i ? { ...x, min: e.target.value } : x)) })} />
              <TextInput label="Default" inputMode="decimal" value={b.def} error={err[`b${i}.def`]} onChange={(e) => set({ bounds: w.bounds.map((x, j) => (j === i ? { ...x, def: e.target.value } : x)) })} />
              <TextInput label="Max" inputMode="decimal" value={b.max} onChange={(e) => set({ bounds: w.bounds.map((x, j) => (j === i ? { ...x, max: e.target.value } : x)) })} />
            </div>
            <Button variant="ghost" className="mt-2" onClick={() => set({ bounds: w.bounds.filter((_, j) => j !== i) })} aria-label={`Remove parameter ${b.name || i + 1}`}><Trash2 className="size-4" aria-hidden />Remove</Button>
          </div>))}
        <Button onClick={() => set({ bounds: [...w.bounds, { name: '', min: '0', max: '100', def: '50' }] })}><Plus className="size-4" aria-hidden />Add parameter</Button>
      </div>}
      {step === 3 && <div className="space-y-4">
        <TextInput label="Max order size (basis points of the strategy budget)" inputMode="numeric" value={w.maxOrderBps} error={err.maxOrderBps} onChange={(e) => set({ maxOrderBps: e.target.value })} hint="2500 = 25.00%. The risk service enforces the stricter of this, the bucket and the global limit." />
        <TextInput label="Max daily loss (basis points of the strategy budget)" inputMode="numeric" value={w.maxDailyLossBps} error={err.maxDailyLossBps} onChange={(e) => set({ maxDailyLossBps: e.target.value })} />
        <p className="text-[12px] text-muted">A definition's risk budget can only narrow what parent policies allow; it can never relax a hard veto.</p>
      </div>}
      {step === 4 && <div className="space-y-4">
        <TextInput label="Paper validation period (days)" inputMode="numeric" value={w.paperDays} error={err.paperDays} onChange={(e) => set({ paperDays: e.target.value })} />
        <TextInput label="Minimum number of paper trades" inputMode="numeric" value={w.minTrades} error={err.minTrades} onChange={(e) => set({ minTrades: e.target.value })} />
        <Field label="Notes"><textarea className={inputCls + ' min-h-20 py-2'} value={w.notes} maxLength={500} onChange={(e) => set({ notes: e.target.value })} /></Field>
        <p className="rounded-lg bg-warn-soft p-3 text-[13px] text-warn">This is a validation <strong>plan</strong>. Evidence is recorded only by completed research or paper runs; creating a strategy never creates evidence, and it starts with none.</p>
      </div>}
      {step === 5 && <div className="space-y-4 text-[13px]">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
          <dt className="font-semibold">Name</dt><dd>{w.name}</dd><dt className="font-semibold">Key</dt><dd>ws.….{w.slug}</dd><dt className="font-semibold">Families</dt><dd>{w.families.join(', ')}</dd>
          <dt className="font-semibold">Data sources</dt><dd>{w.dataSources.join(', ') || 'none declared'}</dd><dt className="font-semibold">Parameters</dt><dd>{w.bounds.map((b) => b.name).join(', ') || 'none'}</dd>
          <dt className="font-semibold">Risk budget</dt><dd>{w.maxOrderBps} bps per order · {w.maxDailyLossBps} bps daily loss</dd><dt className="font-semibold">Validation</dt><dd>{w.paperDays} days · {w.minTrades} trades</dd>
          <dt className="font-semibold">Initial stage</dt><dd><Badge>Research</Badge> evidence: none</dd></dl>
        <label className="flex items-start gap-2 rounded-xl border border-line p-3"><input type="checkbox" className="mt-1" checked={w.requestPaper} onChange={(e) => set({ requestPaper: e.target.checked })} />
          <span>Also request promotion to <strong>Paper</strong>. A different workspace owner must approve it; until then the strategy cannot be enabled on any bucket.</span></label>
        <p className="text-muted">Live and live-candidate stages stay locked: live needs every deployment gate to pass with evidence, and a live candidate needs recorded validation evidence.</p>
      </div>}
    </Dialog>
  );
}
