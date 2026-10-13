'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { LayoutGrid, Table2 } from 'lucide-react';
import { Async, Badge, Button, Card, ConfirmDialog, DataTable, EmptyState, Kpi, PageHeader, TextInput, inputCls, useToast, cx } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { useWs } from '@/components/hooks';
import { useCommand } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { ALL_CAPABILITIES, healthLabel, readiness, type CapMap } from '@/lib/chains';
import { HealthBadge, ReadinessBadges, ms, amt, Note, type Health } from '@/components/trading/parts';

interface Chain { id: string; family: string; name: string; is_testnet: boolean; native_symbol: string; native_decimals: number; finality_model: string; address_format: string; capabilities: CapMap; enabled: boolean; policy_reason: string | null; registry_unverified: boolean; unverified_fields: string[];
  health: Health; walletCount: number; enabledStrategies: number; exposure: { environment: string; symbol: string; decimals: number; state: string; amount: string }[] }

function CapSummary({ caps }: { caps: CapMap }) {
  const r = readiness(caps); const c = r.counts;
  return (
    <p className="text-[12px] text-muted" aria-label="Capability summary">
      <strong className="text-ink">{c.CERTIFIED}</strong> certified · <strong className="text-ink">{c.READ_ONLY}</strong> read-only · {c.PENDING} pending · {c.UNSUPPORTED} unsupported · {c.UNRECORDED} unrecorded <span className="sr-only">of {ALL_CAPABILITIES.length} capabilities</span>
    </p>
  );
}
function Exposure({ c }: { c: Chain }) {
  if (c.exposure.length === 0) return <span className="text-muted">None in ledger</span>;
  const bySym = new Map<string, { e: string; s: string; d: number; v: bigint }>();
  for (const x of c.exposure) { const k = x.environment + x.symbol; const cur = bySym.get(k) ?? { e: x.environment, s: x.symbol, d: x.decimals, v: 0n }; cur.v += BigInt(x.amount); bySym.set(k, cur); }
  return <ul className="space-y-0.5">{[...bySym.values()].map((x) => <li key={x.e + x.s} className="tabular">{amt(x.v.toString(), x.d, x.s)} <span className="text-[11px] uppercase text-muted">{x.e}</span></li>)}</ul>;
}

function Toggle({ c }: { c: Chain }) {
  const { current, canAdmin } = useWorkspace(); const toast = useToast(); const [open, setOpen] = useState(false); const [reason, setReason] = useState('');
  const en = useCommand('enableChain'), dis = useCommand('disableChain'); const turningOff = c.enabled;
  const m = turningOff ? dis : en;
  if (!current) return null;
  return (<>
    <Button variant={turningOff ? 'secondary' : 'primary'} disabled={!canAdmin} title={canAdmin ? undefined : 'Owner or admin only'} onClick={() => { setReason(''); setOpen(true); }} aria-label={`${turningOff ? 'Disable' : 'Enable'} ${c.name}`}>{turningOff ? 'Disable' : 'Enable monitoring'}</Button>
    <ConfirmDialog open={open} onClose={() => setOpen(false)} danger={turningOff} phrase={turningOff ? 'DISABLE' : undefined} confirmLabel={turningOff ? 'Disable chain' : 'Enable monitoring'} busy={m.isPending}
      title={`${turningOff ? 'Disable' : 'Enable'} ${c.name}`}
      body={<>
        {turningOff
          ? <p>New entries on <strong>{c.name}</strong> must be refused for this workspace. Open orders, settlement watchers and reconciliation keep running. This is recorded in the audit log and as a DISABLE_CHAIN emergency action.</p>
          : <p>Enable <strong>monitoring</strong> for {c.name} in this workspace. <strong>This does not grant trading</strong>: trading additionally requires CERTIFIED capabilities with evidence and every deployment gate to pass.</p>}
        <TextInput label={turningOff ? 'Reason (required)' : 'Reason (optional)'} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      </>}
      onConfirm={() => {
        if (turningOff && reason.trim().length < 3) { toast.push('A reason of at least 3 characters is required', 'bad'); return; }
        m.mutate({ body: { workspace: current.id, chain: c.id, ...(reason.trim().length >= 3 ? { reason: reason.trim() } : {}) } }, { onSuccess: () => { toast.push(`${c.name} ${turningOff ? 'disabled' : 'enabled for monitoring'}`); setOpen(false); }, onError: (e) => toast.push(e.message, 'bad') });
      }} />
  </>);
}

function ChainCard({ c }: { c: Chain }) {
  return (
    <article className="flex min-w-0 flex-col rounded-2xl border border-line bg-card p-5 shadow-card" aria-label={c.name}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0"><h2 className="text-[16px] font-semibold tracking-tight"><Link className="hover:underline" href={`/chains/${encodeURIComponent(c.id)}`}>{c.name}</Link></h2>
          <p className="text-[12px] text-muted">{c.id}</p></div>
        <div className="flex flex-wrap justify-end gap-1.5"><Badge>{c.family}</Badge>{c.is_testnet && <Badge tone="warn">testnet</Badge>}<Badge tone={c.enabled ? 'accent' : 'neutral'}>{c.enabled ? 'Monitoring on' : 'Disabled'}</Badge>{c.registry_unverified && <Badge tone="warn" title={`Registry fields not yet verified against primary sources: ${c.unverified_fields.join(', ') || 'unspecified'}`}>Unverified record</Badge>}</div>
      </header>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-[13px]">
        <div><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Native asset</dt><dd>{c.native_symbol} · {c.native_decimals} dp</dd></div>
        <div><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Finality</dt><dd>{c.finality_model}</dd></div>
        <div><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Health</dt><dd className="space-y-1"><HealthBadge health={c.health} />
          <div className="text-[12px] text-muted">{c.health.status === 'NOT_MEASURED' ? 'Not measured' : `RPC ${ms(c.health.rpcLatencyMs)} · block age ${ms(c.health.blockAgeMs)}`}</div></dd></div>
        <div><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Wallets / strategies</dt><dd>{c.walletCount} wallet(s) · {c.enabledStrategies} enabled strategy instance(s)</dd></div>
        <div className="col-span-2"><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Ledger exposure</dt><dd><Exposure c={c} /></dd></div>
      </dl>
      <div className="mt-4 space-y-2 border-t border-line pt-4"><ReadinessBadges caps={c.capabilities} /><CapSummary caps={c.capabilities} /></div>
      <footer className="mt-4 flex flex-wrap items-center gap-2"><Toggle c={c} /><Link href={`/chains/${encodeURIComponent(c.id)}`} className="inline-flex min-h-10 items-center rounded-xl px-3 text-[13px] font-semibold text-accent hover:bg-accent-soft">Details and capability matrix</Link></footer>
    </article>
  );
}

function Body() {
  const q = useWs<{ items: Chain[]; probes: { configured: boolean; note: string } }>('chains/overview');
  const [view, setView] = useState<'cards' | 'table'>('cards'); const [fam, setFam] = useState(''); const [s, setS] = useState('');
  return (
    <Async q={q}>{(d) => {
      const all = d.items;
      if (all.length === 0) return <EmptyState title="The chain registry is empty" hint="Chains appear here once the chain-registry migrations have been applied (packages/chain-registry seeds chain_registry and chain_capabilities). Run packages/db/migrate.sh against this database; nothing is shown that is not in the registry." />; const fams = [...new Set(all.map((c) => c.family))];
      const shown = all.filter((c) => (!fam || c.family === fam) && (!s || (c.name + c.id + c.native_symbol).toLowerCase().includes(s.toLowerCase())));
      const tradingCert = all.filter((c) => readiness(c.capabilities).trading === 'certified').length;
      return (<>
        <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi label="Registered chains" value={all.length} sub={`${fams.length} families`} />
          <Kpi label="Monitoring enabled" value={all.filter((c) => c.enabled).length} sub="This workspace" />
          <Kpi label="Trading-certified" value={tradingCert} sub={tradingCert === 0 ? 'None: nothing is certified unless the database says so' : 'All required capabilities CERTIFIED'} tone={tradingCert ? 'good' : 'warn'} />
          <Kpi label="Health measured" value={all.filter((c) => c.health.status !== 'NOT_MEASURED').length} sub={d.probes.configured ? 'Probing enabled on the API' : 'Probing is off on the API'} tone="warn" />
        </div>
        {all.every((c) => c.health.status === 'NOT_MEASURED') && <div className="mb-5"><Note tone="warn">Chain health is <strong>Not measured</strong>. {d.probes.note} To measure: run the API with <code>APEX_PROBES=1</code> and <code>APEX_PROBES_DATABASE_URL</code>, and enable the chain below (only enabled chains are probed).</Note></div>}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input aria-label="Search chains" placeholder="Search chains…" value={s} onChange={(e) => setS(e.target.value)} className={cx(inputCls, 'max-w-xs')} />
          <select aria-label="Filter by family" value={fam} onChange={(e) => setFam(e.target.value)} className={cx(inputCls, 'w-auto')}><option value="">Family: all</option>{fams.map((f) => <option key={f}>{f}</option>)}</select>
          <div className="ml-auto inline-flex rounded-xl border border-line bg-white p-1" role="group" aria-label="View">
            <button aria-pressed={view === 'cards'} onClick={() => setView('cards')} className={cx('inline-flex min-h-8 items-center gap-1 rounded-lg px-3 text-[13px] font-semibold', view === 'cards' ? 'bg-accent-soft text-accent' : 'text-muted')}><LayoutGrid className="size-4" aria-hidden />Cards</button>
            <button aria-pressed={view === 'table'} onClick={() => setView('table')} className={cx('inline-flex min-h-8 items-center gap-1 rounded-lg px-3 text-[13px] font-semibold', view === 'table' ? 'bg-accent-soft text-accent' : 'text-muted')}><Table2 className="size-4" aria-hidden />Table</button>
          </div>
        </div>
        {shown.length === 0 ? <EmptyState title="No matching chains" hint="Adjust your search or family filter." />
          : view === 'cards' ? <div className="grid gap-5 lg:grid-cols-2 2xl:grid-cols-3">{shown.map((c) => <ChainCard key={c.id} c={c} />)}</div>
          : <DataTable caption="Chain registry" rows={shown.map((c) => ({ ...c, id: c.id }))} cols={[
            { key: 'name', header: 'Chain', render: (c) => <Link className="font-semibold text-accent hover:underline" href={`/chains/${encodeURIComponent(c.id)}`}>{c.name}</Link> },
            { key: 'family', header: 'Family', filter: true },
            { key: 'native_symbol', header: 'Native' },
            { key: 'finality_model', header: 'Finality' },
            { key: 'health', header: 'Health', text: (c) => healthLabel(c.health.status), filter: true, render: (c) => <HealthBadge health={c.health} /> },
            { key: 'research', header: 'Research', text: (c) => readiness(c.capabilities).research === 'read_only_available' ? 'read-only' : 'none', filter: true },
            { key: 'trading', header: 'Trading', text: (c) => readiness(c.capabilities).trading.replace('_', ' '), filter: true },
            { key: 'enabled', header: 'Monitoring', text: (c) => (c.enabled ? 'on' : 'off'), filter: true },
            { key: 'walletCount', header: 'Wallets', align: 'right', sort: (c) => c.walletCount }]} />}
      </>);
    }}</Async>
  );
}

export default function ChainsPage() {
  return (
    <NeedWorkspace>
      <PageHeader title="Chains" description="Registry-backed chain cards. Capabilities, readiness and health are shown exactly as recorded: nothing is CERTIFIED unless the database says so, and health is Not measured until a probe records samples." />
      <Body />
      <Card title="How to read this page" className="mt-6">
        <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted">
          <li><strong>Research</strong> readiness needs at least one CERTIFIED or READ_ONLY read capability. <strong>Trading</strong> readiness needs every required capability (swap, submit, simulate, fee quote, transaction status, finality, policy signing) CERTIFIED with an evidence reference.</li>
          <li>Enabling a chain turns on monitoring for this workspace only. It never grants trading, and live execution stays locked behind the deployment gates.</li>
          <li>Disabling a chain is audited and recorded as an emergency action so the risk service can refuse new entries on it.</li>
        </ul>
      </Card>
    </NeedWorkspace>
  );
}
