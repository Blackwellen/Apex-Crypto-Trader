'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ArrowDownToLine, Landmark, Plus, Wallet } from 'lucide-react';
import { Async, Badge, Button, Card, DataTable, EmptyState, Kpi, PageHeader, Progress, StackedBar, TabPanel, Tabs } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { useWs } from '@/components/hooks';
import { useApi } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { formatUnits, when } from '@/lib/format';
import { fmtPct } from '@/lib/capital/basket';
import { waterfallPreview } from '@/lib/capital/waterfall';
import { AmountInput, EnvBadge, Mono, PaperLabel, SegBadge, amountToBase, useAssets, useBuckets, usePortfolios, useWalletAccounts, useWallets, type BucketRow } from '@/components/capital/shared';
import { AssignDialog, BudgetDialog, PaperFundDialog, WaterfallDialog } from '@/components/capital/bucket-dialogs';
import { PolicyEditor } from '@/components/capital/policy-editor';
import { MoveDialog } from '@/components/capital/wallet-actions';

const TABS = ['overview', 'assets', 'wallets', 'baskets', 'allocations', 'strategies', 'compounding', 'limits', 'transfers', 'audit'].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) }));
interface Bal { state: string; symbol: string; decimals: number; chain_id: string; wallet_chain_account_id: string | null; amount: string }
interface Detail { bucket: BucketRow; balances: Bal[]; wallets: { id: string; nickname: string; family: string; address: string; capability: string; exclusive: boolean; max_allocation_bps: number; logical_ack: boolean }[]; compoundingPolicies: any[]; policyVersions: { version: number; policy: Record<string, unknown>; created_at: string }[]; highWaterMark: string | null; deficits: { quote_asset: string; amount: string }[]; segregationNote: string }
const sum = (b: Bal[], st: string[]) => b.filter((x) => st.includes(x.state)).reduce((a, x) => a + BigInt(x.amount), 0n);

function Body({ id }: { id: string }) {
  const { canAdmin } = useWorkspace();
  const q = useApi<Detail>(`v1/buckets/${id}`); const alloc = useWs<any>('allocations'); const wf = useApi<any>(`v1/buckets/${id}/waterfall`); const audit = useWs<{ items: any[] }>('audit', '&limit=500');
  const baskets = useWs<any>('baskets'); const assets = useAssets(); const accts = useWalletAccounts(); const wallets = useWallets(); const buckets = useBuckets(); const portfolios = usePortfolios();
  const [tab, setTab] = useState('overview'); const [fund, setFund] = useState<'deposit' | 'allocate' | null>(null); const [budget, setBudget] = useState(false); const [wfd, setWfd] = useState(false); const [assign, setAssign] = useState(false); const [mv, setMv] = useState<string | null>(null);
  const [sample, setSample] = useState('1000'); const [sampleAsset, setSampleAsset] = useState('');
  return (
    <Async q={q}>{(d) => {
      const b = d.bucket; const symbols = [...new Set(d.balances.map((x) => x.symbol))]; const pf = portfolios.data?.items.find((p) => p.id === b.portfolio_id);
      const paper = b.environment === 'paper'; const fundWhy = !canAdmin ? 'Owner or admin role required' : !paper ? 'Live ledger funding is reconciliation-service only' : undefined;
      const assetsHeld = (() => { const m = new Map<string, Bal[]>(); d.balances.forEach((x) => { const k = `${x.symbol}|${x.chain_id}`; m.set(k, [...(m.get(k) ?? []), x]); }); return [...m.entries()].map(([k, rows]) => ({ id: k, symbol: rows[0].symbol, chain: rows[0].chain_id, decimals: rows[0].decimals, rows })); })();
      const bAcc = alloc.data; const transfers = (bAcc?.transfers ?? []).filter((t: any) => t.src_bucket === id || t.dst_bucket === id);
      const budgets = (bAcc?.budgets ?? []).filter((x: any) => x.bucket_id === id); const reservations = (bAcc?.reservations ?? []).filter((x: any) => x.bucket_id === id);
      const policyIds = new Set(d.compoundingPolicies.map((p) => p.id)); const budgetIds = new Set(budgets.map((x: any) => x.id));
      const auditRows = (audit.data?.items ?? []).filter((e) => e.entity_id === id || e.detail?.bucket === id || e.detail?.from === id || e.detail?.to === id || policyIds.has(e.entity_id) || budgetIds.has(e.entity_id));
      const pol = d.compoundingPolicies[0]; const assetOf = (aid: string) => assets.data?.items.find((a) => a.id === aid);
      const pwallets = wallets.data?.items ?? [];
      return (<>
        <PageHeader title={b.name} description={`${pf?.name ?? 'Portfolio'} · ${b.kind.replace('_', ' ')} bucket`}
          actions={<>
            <Button onClick={() => setFund('deposit')} disabled={!!fundWhy} title={fundWhy}><ArrowDownToLine className="size-4" aria-hidden />PAPER deposit</Button>
            <Button variant="primary" onClick={() => setFund('allocate')} disabled={!!fundWhy} title={fundWhy}><Landmark className="size-4" aria-hidden />Allocate to bucket</Button></>} />
        <div className="mb-4 flex flex-wrap items-center gap-2"><EnvBadge env={b.environment} /><SegBadge seg={b.segregation} /><Badge tone={b.state === 'active' ? 'good' : 'warn'}>{b.state.replace(/_/g, ' ')}</Badge><Badge>policy v{b.policy_version}</Badge></div>
        <div role="note" className={`mb-5 rounded-xl border p-4 text-[13px] ${b.segregation === 'logical' ? 'border-[#f0dfb7] bg-warn-soft text-warn' : b.segregation === 'protected' ? 'border-[#c9d6f5] bg-accent-soft text-accent' : 'border-[#bfe6d9] bg-good-soft text-good'}`}>
          <strong>{b.segregation[0].toUpperCase() + b.segregation.slice(1)} segregation.</strong> {d.segregationNote}{b.segregation === 'physical' && d.wallets.length === 0 && ' No wallet is assigned yet, so nothing is isolated until one is.'}{b.segregation === 'physical' && d.wallets.some((w) => !w.exclusive) && ' WARNING: a shared wallet is attached, so this bucket is NOT physically isolated.'}</div>
        <Tabs tabs={TABS} value={tab} onChange={setTab} />

        <TabPanel id="overview" value={tab}>
          {symbols.length === 0 ? <Card><EmptyState title="No ledger balance in this bucket" hint={paper ? 'Assign a wallet with a network, record a PAPER deposit into the wallet, then allocate it to this bucket.' : 'Live balances come from reconciliation only.'} /></Card> :
            symbols.map((s) => { const r = d.balances.filter((x) => x.symbol === s); const dec = r[0].decimals; const f = (st: string[]) => formatUnits(sum(r, st), dec);
              return <div key={s} className="mb-5"><h2 className="mb-2 text-[12px] font-bold uppercase tracking-wider text-muted">{s} · {paper ? 'paper ledger' : 'live ledger'}</h2>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
                  <Kpi label="Spendable" value={f(['available'])} sub="Unreserved, tradeable" />
                  <Kpi label="Reserved for orders" value={f(['reserved'])} sub="Held by open reservations" tone="warn" />
                  <Kpi label="In flight" value={f(['pending_out', 'pending_bridge'])} sub="Pending transfers/bridges" tone="warn" />
                  <Kpi label="Protected vault" value={f(['vault'])} sub="Never tradeable" />
                  <Kpi label="Fee reserve" value={f(['fee_reserve'])} sub={`Restricted/tax: ${f(['restricted'])}`} /></div></div>; })}
          <div className="grid gap-5 lg:grid-cols-3">
            <Card title="Bucket facts"><dl className="space-y-2 text-[13px]"><div className="flex justify-between"><dt>High-water mark</dt><dd className="tabular">{d.highWaterMark ?? 'not set'}</dd></div><div className="flex justify-between"><dt>Wallets</dt><dd>{d.wallets.length}</dd></div><div className="flex justify-between"><dt>Strategy budgets</dt><dd>{budgets.length}</dd></div><div className="flex justify-between"><dt>Open reservations</dt><dd>{reservations.filter((r: any) => r.status === 'held').length}</dd></div>
              <div className="flex justify-between"><dt>Deficits to recover</dt><dd>{d.deficits.length ? d.deficits.map((x) => `${formatUnits(x.amount, assetOf(x.quote_asset)?.decimals ?? 0)} ${assetOf(x.quote_asset)?.symbol ?? ''}`).join(', ') : 'none'}</dd></div></dl></Card>
            <Card title="Fee reserve widget" className="lg:col-span-2">{(() => { const fr = d.balances.filter((x) => x.state === 'fee_reserve'); return fr.length === 0 ? <p className="text-[13px] text-muted">No fee reserve is held in this bucket. Chain-specific gas telemetry needs a certified chain adapter; none is connected.</p> : <ul className="space-y-1 text-[13px]">{fr.map((x, i) => <li key={i} className="tabular"><strong>{x.chain_id}</strong>: {formatUnits(x.amount, x.decimals)} {x.symbol}</li>)}</ul>; })()}</Card>
          </div>
        </TabPanel>

        <TabPanel id="assets" value={tab}>
          {assetsHeld.length === 0 ? <EmptyState title="No assets held" hint="Balances appear after a PAPER deposit is allocated to this bucket." /> :
            <DataTable caption="Assets by state" rows={assetsHeld} cols={[{ key: 'symbol', header: 'Asset' }, { key: 'chain', header: 'Chain', filter: true },
              ...([['Spendable', ['available']], ['Reserved', ['reserved']], ['In flight', ['pending_out', 'pending_bridge']], ['Vault', ['vault']], ['Fee reserve', ['fee_reserve']], ['Restricted', ['restricted']]] as [string, string[]][]).map(([h, st]) => ({ key: h, header: h, align: 'right' as const, text: (r: typeof assetsHeld[number]) => formatUnits(sum(r.rows, st), r.decimals), sort: (r: typeof assetsHeld[number]) => sum(r.rows, st).toString().padStart(80, '0') }))]} />}
          <p className="mt-3 text-[12px] text-muted">Assets are identified by chain + contract/mint, not ticker text. Amounts are internal-ledger balances.</p>
        </TabPanel>

        <TabPanel id="wallets" value={tab}>
          <div className="mb-3 flex justify-end"><Button variant="primary" onClick={() => setAssign(true)} disabled={!canAdmin} title={canAdmin ? undefined : 'Owner or admin role required'}><Plus className="size-4" aria-hidden />Assign wallet</Button></div>
          {d.wallets.length === 0 ? <EmptyState title="No wallets assigned" hint={b.segregation === 'physical' ? 'A physical bucket needs a dedicated wallet.' : 'Assign a wallet to hold this bucket\'s funds.'} /> :
            <DataTable searchable={false} caption="Assigned wallets" rows={d.wallets} cols={[
              { key: 'nickname', header: 'Wallet', render: (w) => <Link className="font-semibold text-accent hover:underline" href={`/wallets/${w.id}`}>{w.nickname}</Link> }, { key: 'family', header: 'Family' }, { key: 'address', header: 'Address', render: (w) => <Mono>{w.address}</Mono> },
              { key: 'use', header: 'Use', text: (w) => (w.exclusive ? 'exclusive' : 'shared'), render: (w) => <Badge tone={w.exclusive ? 'good' : 'warn'}>{w.exclusive ? 'exclusive (physical)' : `shared, ack ${w.logical_ack ? 'given' : 'missing'}`}</Badge> },
              { key: 'max_allocation_bps', header: 'Max share', align: 'right', render: (w) => fmtPct(w.max_allocation_bps) },
              { key: 'move', header: 'Action', text: () => '', render: (w) => { const held = d.balances.some((x) => accts.data?.accounts.find((a) => a.id === x.wallet_chain_account_id)?.wallet_id === w.id); return <Button className="min-h-9" onClick={() => setMv(w.id)} disabled={!canAdmin || held} title={held ? 'This wallet holds ledger balance for the bucket; transfer the funds out first' : undefined}>Move…</Button>; } }]} />}
          {mv && pwallets.find((w) => w.id === mv) && <MoveDialog wallet={pwallets.find((w) => w.id === mv)!} fromBucket={id} open onClose={() => setMv(null)} />}
        </TabPanel>

        <TabPanel id="baskets" value={tab}>
          <Async q={baskets}>{(bk: any) => { const mine = bk.baskets.filter((x: any) => x.bucket_id === id); return mine.length === 0 ? <EmptyState title="No baskets in this bucket" hint="Baskets are target-weight sets of assets." action={<Link className="font-semibold text-accent underline" href="/baskets">Go to Baskets</Link>} /> :
            <ul className="space-y-3">{mine.map((x: any) => <li key={x.id} className="rounded-xl border border-line p-4"><div className="font-semibold">{x.name}</div><div className="mt-1 text-[13px] text-muted">{x.members.map((m: any) => `${m.symbol} ${fmtPct(m.weight_bps)}`).join(' · ')}</div></li>)}</ul>; }}</Async>
        </TabPanel>

        <TabPanel id="allocations" value={tab}>
          <div className="space-y-5">
            <Card title="Wallet allocations (ledger)">{(() => { const rows = d.balances.filter((x) => ['available', 'vault', 'reserved'].includes(x.state) && x.wallet_chain_account_id); return rows.length === 0 ? <p className="text-[13px] text-muted">Nothing is allocated from any wallet yet.</p> :
              <DataTable searchable={false} caption="Per-wallet bucket allocations" rows={rows.map((r, i) => ({ ...r, id: String(i) }))} cols={[
                { key: 'wallet', header: 'Wallet · network', text: (r) => { const a = accts.data?.accounts.find((x) => x.id === r.wallet_chain_account_id); return a ? `${a.nickname} · ${a.chain_name}` : 'wallet'; } },
                { key: 'symbol', header: 'Asset' }, { key: 'state', header: 'State', filter: true }, { key: 'amount', header: 'Amount', align: 'right', sort: (r) => r.amount.padStart(80, '0'), render: (r) => formatUnits(r.amount, r.decimals) }]} />; })()}</Card>
            <Card title="Reservations"><Async q={alloc}>{() => reservations.length === 0 ? <p className="text-[13px] text-muted">No reservations.</p> : <DataTable searchable={false} caption="Capital reservations" rows={reservations} cols={[{ key: 'created_at', header: 'When', render: (r: any) => when(r.created_at) }, { key: 'status', header: 'Status', filter: true }, { key: 'amount', header: 'Amount', align: 'right', render: (r: any) => formatUnits(r.amount, assetOf(r.asset_id)?.decimals ?? 0) + ' ' + (assetOf(r.asset_id)?.symbol ?? '') }]} />}</Async></Card>
          </div>
        </TabPanel>

        <TabPanel id="strategies" value={tab}>
          <div className="mb-3 flex justify-end"><Button variant="primary" onClick={() => setBudget(true)} disabled={!canAdmin} title={canAdmin ? undefined : 'Owner or admin role required'}><Plus className="size-4" aria-hidden />Set strategy budget</Button></div>
          <Async q={alloc}>{() => budgets.length === 0 ? <EmptyState title="No strategy budgets" hint="A strategy cannot reserve capital from this bucket until it has a budget." /> :
            <ul className="space-y-3">{budgets.map((x: any) => { const a = assetOf(x.asset_id); const dec = a?.decimals ?? 0; const used = BigInt(x.limit_amount) === 0n ? 0 : Number((BigInt(x.reserved_amount) * 10000n) / BigInt(x.limit_amount)) / 100;
              return <li key={x.id} className="rounded-xl border border-line p-4"><div className="mb-1 flex justify-between text-[13px]"><strong>{x.strategy_key} · {a?.symbol}</strong><span className="tabular">{formatUnits(x.reserved_amount, dec)} / {formatUnits(x.limit_amount, dec)}</span></div><Progress value={used} label={`${x.strategy_key} budget used`} /></li>; })}</ul>}</Async>
        </TabPanel>

        <TabPanel id="compounding" value={tab}>
          <div className="mb-3 flex justify-end"><Button variant="primary" onClick={() => setWfd(true)} disabled={!canAdmin} title={canAdmin ? undefined : 'Owner or admin role required'}>Apply waterfall policy</Button></div>
          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="Active waterfall policy">{!pol ? <EmptyState title="No compounding policy" hint="Until a policy exists, realised profit is not distributed by the waterfall." /> : (<div className="space-y-3 text-[13px]">
              <p>Version {pol.version} · mode <strong>{pol.mode.replace(/_/g, ' ')}</strong> · saved {when(pol.created_at)}</p>
              <StackedBar parts={[{ label: 'Reinvest', value: pol.reinvest_bps, color: '#2758da' }, { label: 'Vault', value: pol.vault_bps, color: '#006f55' }, { label: 'Cross-bucket', value: pol.cross_bucket_bps, color: '#8a5f10' }, { label: 'Reserve', value: pol.reserve_bps, color: '#7a8aa5' }]} />
              <ul className="grid grid-cols-2 gap-1"><li><span style={{ color: '#2758da' }}>■</span> Reinvest {fmtPct(pol.reinvest_bps)}</li><li><span style={{ color: '#006f55' }}>■</span> Vault {fmtPct(pol.vault_bps)}</li><li><span style={{ color: '#8a5f10' }}>■</span> Cross-bucket {fmtPct(pol.cross_bucket_bps)}</li><li><span style={{ color: '#7a8aa5' }}>■</span> Reserve {fmtPct(pol.reserve_bps)}</li></ul>
              <p className="text-muted">Tax provision {fmtPct(pol.tax_provision_bps)} (accounting provision, taken first; not tax advice). Drawdown limit {fmtPct(pol.drawdown_limit_bps)}.</p></div>)}</Card>
            <Card title="What-if calculator (illustrative, not a forecast)">{!pol ? <p className="text-[13px] text-muted">Needs a policy.</p> : (() => { const a = assetOf(sampleAsset) ?? assets.data?.items.find((x) => d.balances.some((bb) => bb.symbol === x.symbol)); const dec = a?.decimals ?? 0; const base = amountToBase(sample, dec); const def = d.deficits.find((x) => x.quote_asset === a?.id)?.amount ?? '0';
              const r = base ? waterfallPreview(BigInt(base), BigInt(def), { reinvestBps: pol.reinvest_bps, vaultBps: pol.vault_bps, crossBucketBps: pol.cross_bucket_bps, reserveBps: pol.reserve_bps, taxProvisionBps: pol.tax_provision_bps }) : null; const f = (x: bigint) => formatUnits(x, dec);
              return (<div className="space-y-3"><AmountInput label="Hypothetical realised profit" symbol={a?.symbol} decimals={a ? dec : null} value={sample} onChange={setSample} />
                {r && <dl className="grid grid-cols-2 gap-1 text-[13px] tabular"><dt>Deficit recovered first</dt><dd>{f(r.deficitRecovered)}</dd><dt>Eligible</dt><dd>{f(r.eligible)}</dd><dt>Tax provision</dt><dd>{f(r.tax)}</dd><dt>To vault</dt><dd>{f(r.vault)}</dd><dt>To cross-bucket</dt><dd>{f(r.cross)}</dd><dt>To reserve</dt><dd>{f(r.reserve)}</dd><dt>Reinvested (remainder)</dt><dd>{f(r.reinvest)}</dd></dl>}
                <p className="text-[12px] text-muted">Mirrors the database waterfall rules. Only realised, reconciled profit is ever distributed.</p></div>); })()}</Card>
          </div>
          <Card className="mt-5" title="Capital-flow executions"><Async q={wf}>{(w: any) => w.executions.length === 0 ? <EmptyState title="No profit has been distributed yet" hint={w.note} /> :
            <DataTable searchable={false} caption="Waterfall executions" rows={w.executions} cols={[{ key: 'created_at', header: 'When', render: (e: any) => when(e.created_at) }, { key: 'symbol', header: 'Asset' }, { key: 'policy_version', header: 'Policy v', align: 'right' },
              ...(['gross', 'deficit_recovered', 'eligible', 'tax_provision', 'to_reinvest', 'to_vault', 'to_cross', 'to_reserve'] as const).map((k) => ({ key: k, header: k.replace(/_/g, ' '), align: 'right' as const, render: (e: any) => formatUnits(e[k], e.decimals) }))]} />}</Async></Card>
        </TabPanel>

        <TabPanel id="limits" value={tab}><PolicyEditor key={b.id} bucket={b} versions={d.policyVersions} refetch={() => q.refetch()} /></TabPanel>

        <TabPanel id="transfers" value={tab}>
          <p className="mb-3 text-[13px] text-muted">Internal transfers touching this bucket. Same-wallet transfers are logical (one atomic entry); cross-wallet transfers stay in flight until finality. Need to move funds? <Link className="font-semibold text-accent underline" href="/capital/transfers/new">Open the capital transfer wizard</Link>.</p>
          <Async q={alloc}>{() => transfers.length === 0 ? <EmptyState title="No transfers" /> : <DataTable searchable={false} caption="Internal transfers" rows={transfers} cols={[{ key: 'created_at', header: 'When', render: (t: any) => when(t.created_at) }, { key: 'kind', header: 'Kind', filter: true }, { key: 'status', header: 'Status', filter: true }, { key: 'dir', header: 'Direction', text: (t: any) => (t.src_bucket === id ? 'out' : 'in') },
            { key: 'amount', header: 'Amount', align: 'right', render: (t: any) => `${formatUnits(t.amount, assetOf(t.asset_id)?.decimals ?? 0)} ${assetOf(t.asset_id)?.symbol ?? ''}` }]} />}</Async>
        </TabPanel>

        <TabPanel id="audit" value={tab}>
          <Async q={audit}>{() => auditRows.length === 0 ? <EmptyState title="No audit events for this bucket" /> :
            <DataTable caption="Bucket audit events" rows={auditRows.map((e) => ({ ...e, id: String(e.id) }))} cols={[{ key: 'created_at', header: 'When', render: (e: any) => when(e.created_at), sort: (e: any) => e.created_at }, { key: 'action', header: 'Action', filter: true }, { key: 'environment', header: 'Env' }, { key: 'detail', header: 'Detail', text: (e: any) => JSON.stringify(e.detail) }]} />}</Async>
        </TabPanel>

        <PaperFundDialog bucket={b} mode={fund} onClose={() => setFund(null)} />
        <BudgetDialog bucket={b} open={budget} onClose={() => setBudget(false)} />
        <WaterfallDialog bucket={b} open={wfd} onClose={() => setWfd(false)} />
        <AssignDialog bucket={b} open={assign} onClose={() => setAssign(false)} />
      </>);
    }}</Async>
  );
}
export default function BucketDetailPage() { const { bucket } = useParams<{ portfolio: string; bucket: string }>(); return <NeedWorkspace><Body id={bucket} /></NeedWorkspace>; }
