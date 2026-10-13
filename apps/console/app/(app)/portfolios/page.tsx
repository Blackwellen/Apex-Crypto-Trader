'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Async, Badge, Button, Card, DataTable, EmptyState, Kpi, PageHeader, Stepper, TextInput, useToast, Dialog } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { useWs } from '@/components/hooks';
import { useCommand } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { formatUnits } from '@/lib/format';
import { EnvBadge, ReasonList, SegBadge, SegregationExplainer, liveLockReasons, useActionKey } from '@/components/capital/shared';

interface PRow { id: string; name: string; environment: 'paper' | 'live'; bucket_count: number; declared_physical: number; declared_logical: number; declared_protected: number; wallet_count: number; unassigned_buckets: number; shared_wallet_buckets: number; strategy_count: number }
interface Summary { portfolios: PRow[]; balances: { portfolio_id: string; symbol: string; decimals: number; chain_id: string; state: string; amount: string }[]; provenance: string }

/** Honest effective segregation: what the allocations actually are, not just what was declared. */
function segStatus(p: PRow) {
  if (p.bucket_count === 0) return { tone: 'neutral' as const, text: 'No buckets yet' };
  if (p.shared_wallet_buckets > 0) return { tone: 'warn' as const, text: `${p.shared_wallet_buckets} bucket(s) share a wallet: logical only` };
  if (p.unassigned_buckets > 0) return { tone: 'warn' as const, text: `${p.unassigned_buckets} bucket(s) have no wallet yet` };
  return { tone: 'good' as const, text: 'Dedicated wallets: physical isolation' };
}

function NewPortfolioWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { current } = useWorkspace(); const toast = useToast(); const create = useCommand('createPortfolio'); const risk = useWs<any>('risk'); const key = useActionKey();
  const [step, setStep] = useState(0); const [name, setName] = useState(''); const [env, setEnv] = useState<'paper' | 'live'>('paper');
  if (!current) return null;
  const locked = !current.live_allowed; const reasons = liveLockReasons(current, risk.data?.gates ?? null);
  const nameErr = name.trim().length === 0 ? 'Enter a name' : name.length > 120 ? 'At most 120 characters' : undefined;
  const close = () => { setStep(0); setName(''); setEnv('paper'); onClose(); };
  const submit = () => create.mutate({ body: { workspace: current.id, name: name.trim(), environment: env }, key: key.get() }, {
    onSuccess: () => { toast.push(`Portfolio "${name.trim()}" created (${env})`); key.rotate(); close(); }, onError: (e) => toast.push(e.message, 'bad') });
  return (
    <Dialog open={open} onClose={close} title="New portfolio" footer={<>
      {step > 0 && <Button onClick={() => setStep(0)}>Back</Button>}
      <Button onClick={close}>Cancel</Button>
      {step === 0 ? <Button variant="primary" disabled={!!nameErr} onClick={() => setStep(1)}>Review</Button> : <Button variant="primary" busy={create.isPending} onClick={submit}>Create portfolio</Button>}</>}>
      <Stepper steps={['Name & environment', 'Review']} current={step} />
      {step === 0 ? (
        <div className="space-y-4">
          <TextInput label="Portfolio name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. Core, Quant, Reserves" error={name && nameErr ? nameErr : undefined} />
          <fieldset className="space-y-2">
            <legend className="mb-1 text-[12px] font-semibold text-[#44546a]">Environment</legend>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
              <input type="radio" name="env" className="mt-1" checked={env === 'paper'} onChange={() => setEnv('paper')} />
              <span><span className="block text-[14px] font-semibold">Paper</span><span className="text-[12px] text-muted">Simulated ledger. Deposits are paper ledger funding; no signing, no real orders.</span></span></label>
            <label className={`flex items-start gap-3 rounded-xl border border-line p-3 ${locked ? 'cursor-not-allowed bg-[#f3f5f9] opacity-80' : 'cursor-pointer has-[:checked]:border-accent has-[:checked]:bg-accent-soft'}`}>
              <input type="radio" name="env" className="mt-1" disabled={locked} checked={env === 'live'} onChange={() => setEnv('live')} aria-describedby="live-lock" />
              <span><span className="block text-[14px] font-semibold">Live {locked && <Badge tone="bad">Locked</Badge>}</span>
                <span className="text-[12px] text-muted">Real funds. Only available when every deployment gate passes with evidence and the owner has opted in.</span></span></label>
            {locked && <div id="live-lock"><ReasonList title="Why live is locked (live_allowed = false)" reasons={reasons} /></div>}
          </fieldset>
        </div>
      ) : (
        <dl className="space-y-3 text-[14px]">
          <div><dt className="text-[12px] font-semibold uppercase tracking-wider text-muted">Name</dt><dd>{name.trim()}</dd></div>
          <div><dt className="text-[12px] font-semibold uppercase tracking-wider text-muted">Environment</dt><dd><EnvBadge env={env} /></dd></div>
          <p className="rounded-xl bg-accent-soft p-3 text-[13px] text-accent">A portfolio holds no funds by itself. Next you create buckets inside it, choose their segregation and assign wallets. This action is audited.</p>
        </dl>)}
    </Dialog>
  );
}

export default function PortfoliosPage() {
  const { canAdmin } = useWorkspace(); const q = useWs<Summary>('portfolios/summary'); const [wiz, setWiz] = useState(false);
  return (
    <NeedWorkspace>
      <PageHeader title="Portfolios" description="Separate pools of capital, each holding accounting buckets. Segregation is shown as it really is: dedicated wallets are physical isolation; shared wallets are logical separation only."
        actions={<Button variant="primary" onClick={() => setWiz(true)} disabled={!canAdmin} title={canAdmin ? undefined : 'Owner or admin role required'}><Plus className="size-4" aria-hidden />New portfolio</Button>} />
      <Async q={q}>{(d) => {
        const bal = (pid: string) => d.balances.filter((b) => b.portfolio_id === pid);
        return (<>
          <div className="mb-5 grid gap-4 sm:grid-cols-3">
            <Kpi label="Portfolios" value={d.portfolios.length} sub={`${d.portfolios.filter((p) => p.environment === 'paper').length} paper · ${d.portfolios.filter((p) => p.environment === 'live').length} live`} />
            <Kpi label="Buckets" value={d.portfolios.reduce((a, p) => a + p.bucket_count, 0)} sub="Accounting buckets across portfolios" />
            <Kpi label="Wallets in use" value={d.portfolios.reduce((a, p) => a + p.wallet_count, 0)} sub="Distinct wallet assignments per portfolio" />
          </div>
          <Card title="All portfolios" pad>
            {d.portfolios.length === 0 ? <EmptyState title="No portfolios yet" hint="Create a portfolio, then add buckets and assign wallets." action={canAdmin ? <Button variant="primary" onClick={() => setWiz(true)}>New portfolio</Button> : undefined} /> :
              <DataTable caption="Portfolios" rows={d.portfolios} cols={[
                { key: 'name', header: 'Portfolio', render: (r) => <Link className="font-semibold text-accent hover:underline" href={`/buckets?portfolio=${r.id}`}>{r.name}</Link> },
                { key: 'environment', header: 'Environment', filter: true, render: (r) => <EnvBadge env={r.environment} /> },
                { key: 'bucket_count', header: 'Buckets', sort: (r) => r.bucket_count, align: 'right' },
                { key: 'seg', header: 'Declared segregation', text: (r) => `${r.declared_physical} physical ${r.declared_logical} logical ${r.declared_protected} protected`, render: (r) => (
                  <div className="flex flex-wrap gap-1">{r.declared_physical > 0 && <span className="flex items-center gap-1"><SegBadge seg="physical" />×{r.declared_physical}</span>}{r.declared_logical > 0 && <span className="flex items-center gap-1"><SegBadge seg="logical" />×{r.declared_logical}</span>}{r.declared_protected > 0 && <span className="flex items-center gap-1"><SegBadge seg="protected" />×{r.declared_protected}</span>}{r.bucket_count === 0 && '—'}</div>) },
                { key: 'status', header: 'Segregation status', text: (r) => segStatus(r).text, render: (r) => { const s = segStatus(r); return <Badge tone={s.tone}>{s.text}</Badge>; } },
                { key: 'wallet_count', header: 'Wallets', sort: (r) => r.wallet_count, align: 'right' },
                { key: 'strategy_count', header: 'Strategy budgets', sort: (r) => r.strategy_count, align: 'right' },
              ]} />}
          </Card>
          {d.portfolios.length > 0 && (
            <div className="mt-5 grid gap-5 xl:grid-cols-3">
              <Card title="Ledger holdings by portfolio" className="xl:col-span-2">
                {d.balances.length === 0 ? <EmptyState title="No ledger balances yet" hint="Open a bucket, add a PAPER deposit and allocate it. Equity is shown per asset in base units; there is no market-price valuation, so no fiat total is shown." /> :
                  <div className="space-y-4">{d.portfolios.filter((p) => bal(p.id).length).map((p) => {
                    const syms = [...new Set(bal(p.id).map((b) => b.symbol))];
                    return <div key={p.id}><h3 className="mb-1 text-[13px] font-semibold">{p.name} <EnvBadge env={p.environment} /></h3>
                      <div className="overflow-x-auto rounded-xl border border-line"><table className="w-full min-w-[480px] text-left text-[13px]"><caption className="sr-only">{p.name} holdings by asset and state</caption>
                        <thead className="bg-[#f6f8fb] text-[11px] uppercase tracking-wider text-muted"><tr><th scope="col" className="px-4 py-2">Asset</th><th scope="col" className="px-4 py-2 text-right">Spendable</th><th scope="col" className="px-4 py-2 text-right">Reserved / in flight</th><th scope="col" className="px-4 py-2 text-right">Vault / restricted / fee reserve</th></tr></thead>
                        <tbody>{syms.map((s) => { const rows = bal(p.id).filter((b) => b.symbol === s); const dec = rows[0].decimals; const sum = (st: string[]) => rows.filter((r) => st.includes(r.state)).reduce((a, r) => a + BigInt(r.amount), 0n);
                          return <tr key={s} className="border-t border-line"><th scope="row" className="px-4 py-2 font-semibold">{s}</th><td className="tabular px-4 py-2 text-right">{formatUnits(sum(['available']), dec)}</td><td className="tabular px-4 py-2 text-right">{formatUnits(sum(['reserved', 'pending_out', 'pending_bridge']), dec)}</td><td className="tabular px-4 py-2 text-right">{formatUnits(sum(['vault', 'restricted', 'fee_reserve']), dec)}</td></tr>; })}</tbody></table></div></div>; })}</div>}
                <p className="mt-3 text-[12px] text-muted">{d.provenance}</p>
              </Card>
              <Card title="Heat map &amp; factor correlation"><EmptyState title="Not available yet" hint="An allocation heat map and factor correlation need market prices and return history. No price feed is connected, so APEX does not draw them. Segregation facts on this page are real." /></Card>
            </div>)}
          <div className="mt-5"><Card title="Physical vs logical segregation"><SegregationExplainer /></Card></div>
        </>);
      }}</Async>
      <NewPortfolioWizard open={wiz} onClose={() => setWiz(false)} />
    </NeedWorkspace>
  );
}
