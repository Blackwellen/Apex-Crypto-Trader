'use client';
import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, CircleAlert, Loader2, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, Dialog, Field, Select, Stepper, TextInput, inputCls, useToast } from '@/components/ui';
import { useWs } from '@/components/hooks';
import { ApiError, useCommand } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { AmountInput, AssetSelect, NoKeysNote, SegBadge, SegregationExplainer, amountToBase, useAssets, useBuckets, usePortfolios, useWalletAccounts, useWallets, type WalletRow } from './shared';
import { LIMITS, buildPolicy } from '@/lib/capital/policy';
import { parsePct, fmtPct } from '@/lib/capital/basket';

const STEPS = ['Classify', 'Capital policy', 'Assign wallets', 'Strategies & compounding', 'Review & confirm'];
const KINDS = [
  { v: 'trading', l: 'Trading', d: 'Funds that strategy workers may reserve and trade.' },
  { v: 'research', l: 'Research', d: 'Small experimental budget, same ledger rules.' },
  { v: 'gas_reserve', l: 'Gas reserve', d: 'Native-token reserve for fees. Compounding does not apply.' },
  { v: 'protected_vault', l: 'Protected vault', d: 'Never tradeable. Always protected segregation. Leaving the vault needs owner approval and a delay.' },
];
type Sel = { share: string; shared: boolean; ack: boolean };
type Budget = { strategy: string; asset: string; limit: string };
type Step = { id: string; label: string; status: 'pending' | 'running' | 'done' | 'failed'; error?: string };

export function BucketWizard({ open, onClose, defaultPortfolio }: { open: boolean; onClose: () => void; defaultPortfolio?: string }) {
  const { current } = useWorkspace(); const toast = useToast(); const router = useRouter();
  const portfolios = usePortfolios(), buckets = useBuckets(), wallets = useWallets(), accts = useWalletAccounts(), assets = useAssets(), strategies = useWs<{ items: { key: string; version: number; name: string; stage: string }[] }>('strategies');
  const create = useCommand('createBucket'), updPolicy = useCommand('updateBucketPolicy'), assign = useCommand('assignWalletToBucket'), budgetCmd = useCommand('setStrategyBudget'), waterfall = useCommand('applyWaterfallPolicy');
  const [step, setStep] = useState(0);
  const [pid, setPid] = useState(defaultPortfolio ?? ''); const [name, setName] = useState(''); const [kind, setKind] = useState('trading'); const [seg, setSeg] = useState<'physical' | 'logical' | 'protected'>('physical');
  const [limits, setLimits] = useState<Record<string, string>>({}); const [extra, setExtra] = useState('');
  const [sel, setSel] = useState<Record<string, Sel>>({});
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [comp, setComp] = useState({ on: false, mode: 'proportional', reinvest: '100', vault: '0', cross: '0', reserve: '0', tax: '0', vaultBucket: '', vaultWca: '', crossBucket: '', crossWca: '' });
  const [steps, setSteps] = useState<Step[]>([]); const [running, setRunning] = useState(false);
  const created = useRef<{ bucket?: string; done: Set<string>; runKey: string }>({ done: new Set(), runKey: '' });

  const portfolio = portfolios.data?.items.find((p) => p.id === (pid || portfolios.data?.items[0]?.id));
  const effPid = portfolio?.id ?? '';
  const effSeg = kind === 'protected_vault' ? 'protected' : seg;
  const policy = buildPolicy(limits, extra);
  const nameErr = !name.trim() ? 'Enter a name' : name.length > 120 ? 'At most 120 characters' : (buckets.data?.items.some((b) => b.portfolio_id === effPid && b.name.toLowerCase() === name.trim().toLowerCase()) ? 'A bucket with this name already exists in the portfolio' : undefined);

  // wallet eligibility derived from real allocations
  const eligibility = (w: WalletRow): string | null => {
    if (w.state !== 'active') return `Wallet is ${w.state}`;
    if (w.allocations.some((a) => a.exclusive)) return 'Exclusively assigned to another bucket (physical segregation forbids sharing)';
    if (effSeg !== 'logical' && w.allocations.length > 0) return `A ${effSeg} bucket needs a dedicated wallet; this one is already shared`;
    if (w.allocations.reduce((a, x) => a + x.bps, 0) >= 10000) return 'Wallet is already fully allocated (100%)';
    return null;
  };
  const used = (w: WalletRow) => w.allocations.reduce((a, x) => a + x.bps, 0);
  const toggleWallet = (w: WalletRow, on: boolean) => setSel((s) => { const n = { ...s }; if (!on) { delete n[w.id]; return n; } const shared = effSeg === 'logical'; n[w.id] = { shared, ack: false, share: shared ? String((10000 - used(w)) / 100) : '100' }; return n; });
  const walletProblems = Object.entries(sel).flatMap(([id, s]) => {
    const w = wallets.data?.items.find((x) => x.id === id); if (!w) return [];
    const out: string[] = []; const bps = parsePct(s.share);
    if (bps === null || bps < 1) out.push(`${w.nickname}: enter a share between 0.01% and 100%`); else if (bps > 10000 - used(w)) out.push(`${w.nickname}: only ${fmtPct(10000 - used(w))} of this wallet is still unallocated`);
    if (s.shared && !s.ack) out.push(`${w.nickname}: acknowledge logical sharing`);
    return out;
  });

  const totalBudgetsOk = budgets.every((b) => b.strategy && b.asset && amountToBase(b.limit, assets.data?.items.find((a) => a.id === b.asset)?.decimals ?? null));
  const pcts = { reinvest: parsePct(comp.reinvest), vault: parsePct(comp.vault), cross: parsePct(comp.cross), reserve: parsePct(comp.reserve), tax: parsePct(comp.tax) };
  const wfTotal = (pcts.reinvest ?? 0) + (pcts.vault ?? 0) + (pcts.cross ?? 0) + (pcts.reserve ?? 0);
  const compAllowed = kind === 'trading' || kind === 'research';
  const compProblems: string[] = [];
  if (comp.on && compAllowed) {
    if (Object.values(pcts).some((p) => p === null)) compProblems.push('Enter every percentage with at most 2 decimals');
    if (wfTotal !== 10000) compProblems.push(`Reinvest + vault + cross-bucket + reserve must total 100% (now ${fmtPct(wfTotal)})`);
    if ((pcts.vault ?? 0) > 0 && !(comp.vaultBucket && comp.vaultWca)) compProblems.push('Choose a protected-vault bucket and wallet account for the vault share');
    if ((pcts.cross ?? 0) > 0 && !(comp.crossBucket && comp.crossWca)) compProblems.push('Choose a destination bucket and wallet account for the cross-bucket share');
  }

  const stepValid = [!nameErr && !!effPid, policy.errors.length === 0, walletProblems.length === 0, totalBudgetsOk && compProblems.length === 0, true][step];

  const vaultBuckets = (buckets.data?.items ?? []).filter((b) => b.portfolio_id === effPid && b.kind === 'protected_vault');
  const otherBuckets = (buckets.data?.items ?? []).filter((b) => b.portfolio_id === effPid);
  const acctsFor = (bucketId: string) => { const ws = new Set((wallets.data?.items ?? []).filter((w) => w.allocations.some((a) => a.bucket_id === bucketId)).map((w) => w.id)); return (accts.data?.accounts ?? []).filter((a) => ws.has(a.wallet_id)); };

  const reset = () => { setStep(0); setName(''); setKind('trading'); setSeg('physical'); setLimits({}); setExtra(''); setSel({}); setBudgets([]); setComp({ on: false, mode: 'proportional', reinvest: '100', vault: '0', cross: '0', reserve: '0', tax: '0', vaultBucket: '', vaultWca: '', crossBucket: '', crossWca: '' }); setSteps([]); created.current = { done: new Set(), runKey: '' }; };
  const close = () => { if (running) return; reset(); onClose(); };

  const plan = useMemo(() => {
    const p: { id: string; label: string }[] = [{ id: 'create', label: `Create ${effSeg} bucket "${name.trim()}"` }];
    if (Object.keys(policy.policy).length) p.push({ id: 'policy', label: 'Save capital policy (version 2, checked against workspace hard limits)' });
    Object.keys(sel).forEach((id) => p.push({ id: 'wallet:' + id, label: `Assign wallet ${wallets.data?.items.find((w) => w.id === id)?.nickname ?? id} (${sel[id].shared ? 'shared, logical' : 'exclusive'})` }));
    budgets.forEach((b, i) => p.push({ id: 'budget:' + i, label: `Strategy budget: ${b.strategy} · ${assets.data?.items.find((a) => a.id === b.asset)?.symbol ?? ''} ${b.limit}` }));
    if (comp.on && compAllowed) p.push({ id: 'comp', label: `Compounding policy (${comp.mode}): ${fmtPct(pcts.reinvest ?? 0)} reinvest / ${fmtPct(pcts.vault ?? 0)} vault / ${fmtPct(pcts.cross ?? 0)} cross / ${fmtPct(pcts.reserve ?? 0)} reserve` });
    return p;
  }, [effSeg, name, policy.policy, sel, budgets, comp, compAllowed, wallets.data, assets.data]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run() {
    if (!current || running) return;
    const c = created.current; if (!c.runKey) c.runKey = crypto.randomUUID().slice(0, 18);
    setRunning(true);
    const st: Step[] = plan.map((p) => ({ ...p, status: c.done.has(p.id) ? 'done' : 'pending' })); setSteps([...st]);
    const mark = (i: number, patch: Partial<Step>) => { st[i] = { ...st[i], ...patch }; setSteps([...st]); };
    const k = (s: string) => `${c.runKey}-${s}`.replace(/[^A-Za-z0-9._:-]/g, '_');
    try {
      for (let i = 0; i < plan.length; i++) {
        const id = plan[i].id; if (c.done.has(id)) continue; mark(i, { status: 'running' });
        try {
          if (id === 'create') { const r = await create.mutateAsync({ body: { portfolio: effPid, name: name.trim(), kind, segregation: effSeg, policy: {} }, key: k('create') }); c.bucket = r.result.id; }
          else if (id === 'policy') await updPolicy.mutateAsync({ body: { bucket: c.bucket!, expectedVersion: 1, policy: policy.policy }, key: k('policy') });
          else if (id.startsWith('wallet:')) { const wid = id.slice(7); const s = sel[wid]; await assign.mutateAsync({ body: { wallet: wid, bucket: c.bucket!, exclusive: !s.shared, maxAllocationBps: parsePct(s.share)!, logicalAck: s.shared && s.ack }, key: k(id) }); }
          else if (id.startsWith('budget:')) { const b = budgets[Number(id.slice(7))]; const a = assets.data!.items.find((x) => x.id === b.asset)!; await budgetCmd.mutateAsync({ body: { bucket: c.bucket!, strategy: b.strategy, asset: b.asset, limit: amountToBase(b.limit, a.decimals)! }, key: k(id) }); }
          else if (id === 'comp') await waterfall.mutateAsync({ body: { bucket: c.bucket!, mode: comp.mode, reinvestBps: pcts.reinvest!, vaultBps: pcts.vault!, crossBucketBps: pcts.cross!, reserveBps: pcts.reserve!, taxProvisionBps: pcts.tax ?? 0,
            ...((pcts.vault ?? 0) > 0 ? { vaultBucket: comp.vaultBucket, vaultWalletChainAccount: comp.vaultWca } : {}), ...((pcts.cross ?? 0) > 0 ? { crossBucket: comp.crossBucket, crossWalletChainAccount: comp.crossWca } : {}) }, key: k(id) });
          c.done.add(id); mark(i, { status: 'done' });
        } catch (e) { mark(i, { status: 'failed', error: e instanceof ApiError ? e.message : String(e) }); throw e; }
      }
      toast.push(`Bucket "${name.trim()}" created`); const bid = c.bucket!; reset(); onClose(); router.push(`/portfolios/${effPid}/buckets/${bid}`);
    } catch (e) { toast.push((e as Error).message, 'bad'); } finally { setRunning(false); }
  }

  const failed = steps.some((s) => s.status === 'failed');
  return (
    <Dialog open={open} onClose={close} title="New bucket" footer={<>
      {step > 0 && step < 4 && <Button onClick={() => setStep(step - 1)}>Back</Button>}
      <Button onClick={close} disabled={running}>{created.current.bucket ? 'Close (bucket already created)' : 'Cancel'}</Button>
      {step < 4 ? <Button variant="primary" disabled={!stepValid} onClick={() => setStep(step + 1)}>Next</Button>
        : <Button variant="primary" busy={running} onClick={run} disabled={!current}>{failed ? 'Retry remaining steps' : 'Create bucket'}</Button>}</>}>
      <Stepper steps={STEPS.map((s, i) => `B-0${i + 1} ${s}`)} current={step} />
      {step === 0 && (
        <div className="space-y-4">
          <Select label="Portfolio" value={effPid} onChange={(e) => setPid(e.target.value)} options={portfolios.data?.items.length ? portfolios.data.items.map((p) => ({ value: p.id, label: `${p.name} (${p.environment})` })) : [{ value: '', label: 'Create a portfolio first' }]} />
          <TextInput label="Bucket name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} error={name ? nameErr : undefined} />
          <fieldset><legend className="mb-1 text-[12px] font-semibold text-[#44546a]">Type</legend>
            <div className="grid gap-2 sm:grid-cols-2">{KINDS.map((k) => (
              <label key={k.v} className="flex cursor-pointer items-start gap-2 rounded-xl border border-line p-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                <input type="radio" name="kind" className="mt-1" checked={kind === k.v} onChange={() => setKind(k.v)} /><span><span className="block text-[13px] font-semibold">{k.l}</span><span className="text-[12px] text-muted">{k.d}</span></span></label>))}</div></fieldset>
          <fieldset><legend className="mb-1 text-[12px] font-semibold text-[#44546a]">Segregation</legend>
            <div className="grid gap-2 sm:grid-cols-3">{(['physical', 'logical', 'protected'] as const).map((s) => (
              <label key={s} className={`flex cursor-pointer items-center gap-2 rounded-xl border border-line p-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft ${kind === 'protected_vault' && s !== 'protected' ? 'opacity-50' : ''}`}>
                <input type="radio" name="seg" disabled={kind === 'protected_vault' && s !== 'protected'} checked={effSeg === s} onChange={() => setSeg(s)} /><SegBadge seg={s} /></label>))}</div>
            {kind === 'protected_vault' && <p className="mt-1 text-[12px] text-muted">Protected vault buckets are always protected (database rule).</p>}</fieldset>
          <SegregationExplainer highlight={effSeg} />
        </div>)}
      {step === 1 && (
        <div className="space-y-4">
          <p className="text-[13px] text-muted">Limits are stored as the bucket policy (JSON) and saved through the versioned policy command, so the database checks them against the workspace hard limits. Child limits can never be looser than the global ones. Leave a field empty to not set it.</p>
          <div className="grid gap-3 sm:grid-cols-2">{LIMITS.map((l) => <TextInput key={l.key} label={`${l.label} (${l.unit})`} hint={l.hint} inputMode="numeric" value={limits[l.key] ?? ''} onChange={(e) => setLimits({ ...limits, [l.key]: e.target.value })} />)}</div>
          <Field label="Advanced policy JSON (optional, merged)" hint="Object only. Do not put secrets here."><textarea className={`${inputCls} min-h-24 font-mono text-[12px]`} value={extra} onChange={(e) => setExtra(e.target.value)} spellCheck={false} /></Field>
          {policy.errors.length > 0 && <ul role="alert" className="list-disc pl-5 text-[12px] text-bad">{policy.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
          <pre className="max-h-40 overflow-auto rounded-xl bg-[#f6f8fb] p-3 text-[12px]" aria-label="Policy preview">{JSON.stringify(policy.policy, null, 2)}</pre>
        </div>)}
      {step === 2 && (
        <div className="space-y-3">
          <p className="text-[13px] text-muted">Assign existing wallets now, or skip and assign later. {effSeg === 'logical' ? 'Logical buckets may share a wallet; each shared wallet needs your explicit acknowledgement.' : `A ${effSeg} bucket accepts dedicated (exclusive) wallets only.`}</p>
          {wallets.isLoading ? <p>Loading wallets…</p> : (wallets.data?.items.length ?? 0) === 0 ? <p className="rounded-xl border border-dashed border-line p-4 text-[13px] text-muted">No wallets registered yet. You can finish this bucket now and use the Wallets page to register one and assign it later.</p> :
            <ul className="space-y-2">{wallets.data!.items.map((w) => { const why = eligibility(w); const s = sel[w.id]; return (
              <li key={w.id} className="rounded-xl border border-line p-3">
                <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" disabled={!!why} checked={!!s} onChange={(e) => toggleWallet(w, e.target.checked)} />
                  <span className="min-w-0 text-[13px]"><span className="font-semibold">{w.nickname}</span> <Badge>{w.family}</Badge> <span className="block break-all font-mono text-[11px] text-muted">{w.address}</span>{why && <span className="block text-[12px] text-warn">Unavailable: {why}</span>}</span></label>
                {s && <div className="mt-2 grid gap-2 pl-6 sm:grid-cols-2">
                  <TextInput label="Max share of this wallet (%)" value={s.share} onChange={(e) => setSel({ ...sel, [w.id]: { ...s, share: e.target.value } })} inputMode="decimal" />
                  {effSeg === 'logical' && <label className="flex items-start gap-2 text-[12px]"><input type="checkbox" className="mt-0.5" checked={s.shared} onChange={(e) => setSel({ ...sel, [w.id]: { ...s, shared: e.target.checked, ack: false } })} />Share this wallet with other buckets</label>}
                  {s.shared && <label className="flex items-start gap-2 rounded-lg bg-warn-soft p-2 text-[12px] text-warn sm:col-span-2"><input type="checkbox" className="mt-0.5" checked={s.ack} onChange={(e) => setSel({ ...sel, [w.id]: { ...s, ack: e.target.checked } })} />I understand this is logical separation only: buckets on this wallet are separated by the APEX ledger, not by wallet-level security.</label>}</div>}
              </li>); })}</ul>}
          {walletProblems.length > 0 && <ul role="alert" className="list-disc pl-5 text-[12px] text-bad">{walletProblems.map((e) => <li key={e}>{e}</li>)}</ul>}
        </div>)}
      {step === 3 && (
        <div className="space-y-5">
          <section aria-labelledby="bw-budgets"><h3 id="bw-budgets" className="mb-2 text-[14px] font-semibold">Strategy capital budgets</h3>
            <p className="mb-2 text-[12px] text-muted">A budget caps how much of one asset a strategy may reserve from this bucket. Optional.</p>
            {budgets.map((b, i) => { const a = assets.data?.items.find((x) => x.id === b.asset); return (
              <div key={i} className="mb-3 grid gap-2 rounded-xl border border-line p-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
                <Select label="Strategy" value={b.strategy} onChange={(e) => setBudgets(budgets.map((x, j) => j === i ? { ...x, strategy: e.target.value } : x))} options={[{ value: '', label: strategies.data?.items.length ? 'Choose…' : 'No strategies registered' }, ...[...new Set((strategies.data?.items ?? []).map((s) => s.key))].map((k) => ({ value: k, label: `${k} (${strategies.data!.items.find((s) => s.key === k)!.stage})` }))]} />
                <AssetSelect label="Asset" assets={assets.data?.items ?? []} value={b.asset} onChange={(v) => setBudgets(budgets.map((x, j) => j === i ? { ...x, asset: v } : x))} />
                <AmountInput label="Limit" symbol={a?.symbol} decimals={a?.decimals ?? null} value={b.limit} onChange={(v) => setBudgets(budgets.map((x, j) => j === i ? { ...x, limit: v } : x))} />
                <Button aria-label={`Remove budget ${i + 1}`} onClick={() => setBudgets(budgets.filter((_, j) => j !== i))}><Trash2 className="size-4" aria-hidden /></Button></div>); })}
            <Button onClick={() => setBudgets([...budgets, { strategy: '', asset: '', limit: '' }])}><Plus className="size-4" aria-hidden />Add budget</Button></section>
          <section aria-labelledby="bw-comp"><h3 id="bw-comp" className="mb-2 text-[14px] font-semibold">Compounding waterfall</h3>
            {!compAllowed ? <p className="rounded-xl bg-[#f3f5f9] p-3 text-[13px] text-muted">Compounding policies do not apply to {kind.replace('_', ' ')} buckets (database rule).</p> : (<>
              <label className="mb-2 flex items-center gap-2 text-[13px]"><input type="checkbox" checked={comp.on} onChange={(e) => setComp({ ...comp, on: e.target.checked })} />Configure a compounding policy now (applies only to realised, reconciled profit)</label>
              {comp.on && <div className="space-y-3">
                <Select label="Mode" value={comp.mode} onChange={(e) => setComp({ ...comp, mode: e.target.value })} options={['fixed', 'proportional', 'target_vol', 'anti_martingale', 'defensive_decompound', 'stair_step'].map((m) => ({ value: m, label: m.replace(/_/g, ' ') }))} />
                <div className="grid gap-2 sm:grid-cols-5">{(['reinvest', 'vault', 'cross', 'reserve', 'tax'] as const).map((f) => <TextInput key={f} label={`${f === 'cross' ? 'Cross-bucket' : f[0].toUpperCase() + f.slice(1)} %`} value={comp[f]} onChange={(e) => setComp({ ...comp, [f]: e.target.value })} inputMode="decimal" />)}</div>
                <p className={`text-[12px] ${wfTotal === 10000 ? 'text-good' : 'text-bad'}`} role="status">Reinvest + vault + cross + reserve = {fmtPct(wfTotal)} (must be 100.00%). Tax provision is an accounting provision taken first, not tax advice.</p>
                {(pcts.vault ?? 0) > 0 && <div className="grid gap-2 sm:grid-cols-2"><Select label="Vault bucket" value={comp.vaultBucket} onChange={(e) => setComp({ ...comp, vaultBucket: e.target.value, vaultWca: '' })} options={[{ value: '', label: vaultBuckets.length ? 'Choose…' : 'No protected vault bucket in this portfolio' }, ...vaultBuckets.map((b) => ({ value: b.id, label: b.name }))]} />
                  <Select label="Vault wallet account" value={comp.vaultWca} onChange={(e) => setComp({ ...comp, vaultWca: e.target.value })} options={[{ value: '', label: 'Choose…' }, ...acctsFor(comp.vaultBucket).map((a) => ({ value: a.id, label: `${a.nickname} · ${a.chain_name}` }))]} /></div>}
                {(pcts.cross ?? 0) > 0 && <div className="grid gap-2 sm:grid-cols-2"><Select label="Destination bucket" value={comp.crossBucket} onChange={(e) => setComp({ ...comp, crossBucket: e.target.value, crossWca: '' })} options={[{ value: '', label: 'Choose…' }, ...otherBuckets.map((b) => ({ value: b.id, label: b.name }))]} />
                  <Select label="Destination wallet account" value={comp.crossWca} onChange={(e) => setComp({ ...comp, crossWca: e.target.value })} options={[{ value: '', label: 'Choose…' }, ...acctsFor(comp.crossBucket).map((a) => ({ value: a.id, label: `${a.nickname} · ${a.chain_name}` }))]} /></div>}
                {compProblems.length > 0 && <ul role="alert" className="list-disc pl-5 text-[12px] text-bad">{compProblems.map((e) => <li key={e}>{e}</li>)}</ul>}</div>}</>)}</section>
        </div>)}
      {step === 4 && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-[13px]"><strong>{name.trim()}</strong><SegBadge seg={effSeg} /><Badge>{kind.replace('_', ' ')}</Badge><Badge tone="accent">{portfolio?.environment}</Badge></div>
          <p className="rounded-xl bg-accent-soft p-3 text-[13px] text-accent">{effSeg === 'physical' ? 'Physical: each assigned wallet belongs exclusively to this bucket.' : effSeg === 'logical' ? 'Logical: accounting separation only. Shared wallets carry no wallet-level security segregation.' : 'Protected: funds need owner approval and a delay to leave.'} The steps below run one after another and are audited; if one fails you can fix it and retry the rest, nothing is repeated.</p>
          <ol className="space-y-2" aria-label="Steps to run">{plan.map((p, i) => { const s = steps[i]; return (
            <li key={p.id} className="flex items-start gap-2 rounded-lg border border-line p-2 text-[13px]">
              <span className="mt-0.5">{s?.status === 'done' ? <Check className="size-4 text-good" aria-label="done" /> : s?.status === 'running' ? <Loader2 className="size-4 animate-spin" aria-label="running" /> : s?.status === 'failed' ? <CircleAlert className="size-4 text-bad" aria-label="failed" /> : <span className="inline-block size-4 rounded-full border border-line" aria-label="pending" />}</span>
              <span>{p.label}{s?.error && <span role="alert" className="block text-bad">{s.error}</span>}</span></li>); })}</ol>
          <NoKeysNote compact />
        </div>)}
    </Dialog>
  );
}
