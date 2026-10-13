'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Async, Badge, Button, Card, EmptyState, Kpi, PageHeader, Progress, Select, TabPanel, Tabs } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { useWs } from '@/components/hooks';
import { EnvBadge, Note, Table } from '@/components/ops/common';
import { PolicyWizard, type BucketLite } from '@/components/compounding/PolicyWizard';
import { TargetDialog } from '@/components/compounding/TargetDialog';
import { Simulator } from '@/components/compounding/Simulator';
import { useWorkspace } from '@/lib/workspace';
import { bps, formatUnits, when } from '@/lib/format';
import { progressBps, targetBase, type WaterfallPolicy } from '@/lib/waterfall';

const TABS = [{ id: 'global', label: 'Global' }, { id: 'portfolio', label: 'Portfolio' }, { id: 'bucket', label: 'Bucket' }, { id: 'basket', label: 'Basket' }, { id: 'strategy', label: 'Strategy' }];
const pct = (b: number) => bps(b);

function PolicyCells({ p }: { p: any }) {
  if (!p) return <Badge>no policy</Badge>;
  return <span className="tabular text-[12px]">v{p.version}: reinvest {pct(p.reinvest_bps)} / vault {pct(p.vault_bps)} / cross {pct(p.cross_bucket_bps)} / reserve {pct(p.reserve_bps)} / tax {pct(p.tax_provision_bps)}</span>;
}

export default function CompoundingPage() {
  const { current, canAdmin } = useWorkspace();
  const [tab, setTab] = useState('global');
  const ov = useWs<any>('compounding/overview'), core = useWs<any>('compounding'), alloc = useWs<any>('allocations'), baskets = useWs<any>('baskets'), pfs = useWs<{ items: any[] }>('portfolios');
  const [wizard, setWizard] = useState(false); const [target, setTarget] = useState(false); const [bsel, setBsel] = useState('');
  const buckets: BucketLite[] = ov.data?.buckets ?? [];
  const sel = buckets.find((b) => b.id === bsel) ?? buckets[0];
  const bucketName = useMemo(() => Object.fromEntries([...(ov.data?.buckets ?? []), ...(ov.data?.vaults ?? [])].map((b: any) => [b.id, b.name])), [ov.data]);
  const execTransferIds = useMemo(() => new Set((core.data?.executions ?? []).flatMap((e: any) => [e.vault_transfer, e.cross_transfer].filter(Boolean))), [core.data]);
  const pending = (alloc.data?.transfers ?? []).filter((t: any) => ['requested', 'pending_finality'].includes(t.status));

  return (
    <NeedWorkspace>
      <PageHeader title="Compounding Studio" description="Reinvestment waterfalls, protected-profit sweeps and monitoring targets. Everything is computed from the double-entry ledger; targets never force a trade and nothing here is a forecast."
        actions={<Button variant="primary" disabled={!canAdmin} title={canAdmin ? undefined : 'Owner/admin only'} onClick={() => setTarget(true)}>New target</Button>} />
      <Tabs tabs={TABS} value={tab} onChange={setTab} />

      <TabPanel id="global" value={tab}>
        <div className="grid gap-5">
          <Async q={ov}>{(d: any) => (<>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Kpi label="Buckets with a policy" value={`${d.buckets.filter((b: any) => b.latest_policy).length} / ${d.buckets.length}`} sub="Latest immutable version" />
              <Kpi label="Open deficits" value={d.buckets.reduce((n: number, b: any) => n + b.deficits.length, 0)} sub="Recovered before any sweep" tone="warn" />
              <Kpi label="Pending cross/vault transfers" value={pending.length} sub="Destination not credited until finality" tone="warn" />
              <Kpi label="Monitoring targets" value={d.targets.length} sub="Never force trades" />
            </div>
            <Card title="Targets and progress" action={<Badge>monitoring only</Badge>}>
              <Note>Targets are monitoring only. Progress is net <strong>realised</strong> profit from the ledger in each target&apos;s reporting asset (profit events since the period start). No unrealised or marked PnL is shown because no price feed is connected.</Note>
              <div className="mt-4 space-y-5">
                {d.targets.length === 0 ? <EmptyState title="No targets yet" hint="Create a monitoring target to track realised profit against it." /> : d.targets.map((t: any) => {
                  const tb = targetBase(t); const realised = t.realised_in_period === null ? null : BigInt(t.realised_in_period); const pb = realised === null ? null : progressBps(realised, tb);
                  return (<div key={t.id} data-testid="target-row">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]"><span className="font-semibold">{t.bucket_name ?? 'Whole workspace'} · {t.period}</span>
                      <span className="tabular text-muted">{realised === null ? 'no reporting asset on this plan' : `${formatUnits(realised, t.decimals)} of ${tb === null ? '?' : formatUnits(tb, t.decimals)} ${t.symbol}`}</span></div>
                    <div className="mt-1"><Progress label={`Progress for ${t.bucket_name ?? 'workspace'} ${t.period} target`} value={pb === null ? 0 : pb / 100} tone={pb !== null && pb >= 10000 ? 'good' : 'accent'} /></div>
                    <p className="mt-1 text-[12px] text-muted">{pb === null ? 'Progress unavailable.' : `${(pb / 100).toFixed(2)}% of target`} · window from {when(t.window_start)} · target of absolute {t.target_amount ?? '-'}{t.target_pct_bps !== null ? `, ${pct(t.target_pct_bps)} of start equity` : ''}</p>
                  </div>); })}
              </div>
            </Card>
          </>)}</Async>
          <Card title="Pending cross-compound and vault transfers" action={<Link href="/capital/transfers/new" className="text-[13px] font-semibold text-accent">Transfer tracking</Link>}>
            <Async q={alloc}>{() => pending.length === 0 ? <EmptyState title="No pending transfers" hint="Waterfall sweeps to another wallet appear here until finality." /> : (
              <Table searchable={false} caption="Pending transfers" rows={pending} cols={[
                { key: 'kind', header: 'Kind' }, { key: 'status', header: 'Status', render: (t) => <Badge tone="warn">{t.status.replace('_', ' ')}</Badge> },
                { key: 'src_bucket', header: 'From', render: (t) => bucketName[t.src_bucket] ?? t.src_bucket.slice(0, 8) }, { key: 'dst_bucket', header: 'To', render: (t) => bucketName[t.dst_bucket] ?? t.dst_bucket.slice(0, 8) },
                { key: 'amount', header: 'Amount (base units)', align: 'right' }, { key: 'src', header: 'Origin', render: (t) => (execTransferIds.has(t.id) ? <Badge tone="accent">waterfall</Badge> : <Badge>manual</Badge>) },
                { key: 'created_at', header: 'Requested', render: (t) => when(t.created_at) }]} />)}</Async>
          </Card>
          <Card title="Waterfall executions">
            <Async q={core} empty={(c: any) => c.executions.length === 0}>{(c: any) => (
              <Table caption="Waterfall executions" rows={c.executions} cols={[
                { key: 'created_at', header: 'When', render: (e) => when(e.created_at), sort: (e) => e.created_at },
                { key: 'gross_s', header: 'Gross', align: 'right' }, { key: 'deficit_recovered', header: 'Deficit recovered', align: 'right' }, { key: 'eligible_s', header: 'Eligible', align: 'right' },
                { key: 'tax_provision', header: 'Tax prov.', align: 'right' }, { key: 'to_reinvest', header: 'Reinvest', align: 'right' }, { key: 'to_vault', header: 'Vault', align: 'right' },
                { key: 'to_cross', header: 'Cross', align: 'right' }, { key: 'to_reserve', header: 'Reserve', align: 'right' }]} />)}</Async>
          </Card>
          <Card title="Signed, versioned policies" action={<Badge tone="good">immutable</Badge>}>
            <Async q={core} empty={(c: any) => c.policies.length === 0}>{(c: any) => (<>
              <Note>Each save creates a new version; a database trigger rejects any update or delete of an existing version. Versions are attributed to the author (<code>created_by</code>) and recorded in the audit log. They are <strong>not cryptographically signed</strong>.</Note>
              <div className="mt-3"><Table caption="Compounding policy versions" rows={c.policies} cols={[
                { key: 'bucket_id', header: 'Bucket', render: (p) => bucketName[p.bucket_id] ?? p.bucket_id.slice(0, 8), text: (p) => bucketName[p.bucket_id] ?? p.bucket_id, filter: true },
                { key: 'version', header: 'Version', sort: (p) => p.version }, { key: 'mode', header: 'Mode', filter: true },
                { key: 'reinvest_bps', header: 'Reinvest', render: (p) => pct(p.reinvest_bps) }, { key: 'vault_bps', header: 'Vault', render: (p) => pct(p.vault_bps) },
                { key: 'cross_bucket_bps', header: 'Cross', render: (p) => pct(p.cross_bucket_bps) }, { key: 'reserve_bps', header: 'Reserve', render: (p) => pct(p.reserve_bps) },
                { key: 'tax_provision_bps', header: 'Tax prov.', render: (p) => pct(p.tax_provision_bps) },
                { key: 'created_by', header: 'Author', render: (p) => <span className="font-mono text-[11px]">{String(p.created_by ?? '').slice(0, 8)}</span> }, { key: 'created_at', header: 'Created', render: (p) => when(p.created_at), sort: (p) => p.created_at }]} /></div></>)}</Async>
          </Card>
        </div>
      </TabPanel>

      <TabPanel id="portfolio" value={tab}>
        <Card title="Portfolio view">
          <Note>Compounding policies are stored per bucket, so a portfolio view aggregates its buckets&apos; latest policies. There is no separate portfolio-level policy object yet.</Note>
          <div className="mt-4 space-y-5">
            <Async q={pfs} empty={(p) => p.items.length === 0}>{(p) => (<>{p.items.map((pf: any) => (
              <section key={pf.id} aria-label={`Portfolio ${pf.name}`}><h3 className="mb-2 flex items-center gap-2 text-[14px] font-semibold">{pf.name} <EnvBadge env={pf.environment} /></h3>
                <Table searchable={false} caption={`Buckets of ${pf.name}`} rows={buckets.filter((b: any) => b.portfolio_id === pf.id)} cols={[
                  { key: 'name', header: 'Bucket' }, { key: 'policy', header: 'Latest policy', render: (b: any) => <PolicyCells p={b.latest_policy} /> },
                  { key: 'hwm', header: 'High-water mark', align: 'right', render: (b: any) => b.hwm ?? 'not recorded' }]} /></section>))}</>)}</Async>
          </div>
        </Card>
      </TabPanel>

      <TabPanel id="bucket" value={tab}>
        {buckets.length === 0 ? <Card><EmptyState title="No compounding-eligible buckets" hint="Create a trading bucket first. Vault and gas-reserve buckets do not take compounding policies." action={<Link className="font-semibold text-accent underline" href="/buckets">Go to Buckets</Link>} /></Card> : sel && (
          <div className="grid gap-5">
            <Card title="Bucket" action={<Button variant="primary" disabled={!canAdmin} title={canAdmin ? undefined : 'Owner/admin only'} onClick={() => setWizard(true)}>{sel.latest_policy ? 'Edit waterfall (new version)' : 'Create waterfall policy'}</Button>}>
              <div className="grid gap-4 md:grid-cols-2">
                <Select label="Bucket" value={sel.id} onChange={(e) => setBsel(e.target.value)} options={buckets.map((b) => ({ value: b.id, label: `${b.name} (${b.environment})` }))} />
                <div className="text-[13px]"><div className="mb-1 text-[12px] font-semibold text-[#44546a]">Current policy</div><PolicyCells p={sel.latest_policy} />
                  {sel.latest_policy && <div className="mt-1 text-[12px] text-muted">mode {sel.latest_policy.mode} · drawdown limit {pct(sel.latest_policy.drawdown_limit_bps)} · min ticket {sel.latest_policy.min_ticket} base units · saved {when(sel.latest_policy.created_at)}</div>}</div>
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <Kpi label="High-water mark" value={(sel as any).hwm ?? 'Not recorded'} sub={(sel as any).hwm ? 'base units, ratchets up only' : 'No equity snapshot job feeds this yet'} />
                <Kpi label="Open deficits" value={(sel.deficits ?? []).length ? (sel.deficits ?? []).map((d) => `${formatUnits(d.amount, d.decimals)} ${d.symbol}`).join(', ') : 'None'} sub="Recovered before profit is distributed" tone={(sel.deficits ?? []).length ? 'warn' : undefined} />
                <Kpi label="Net realised (ledger)" value={((sel as any).realised ?? []).length ? ((sel as any).realised as any[]).map((r) => `${formatUnits(r.realised, r.decimals)} ${r.symbol}`).join(', ') : 'None'} sub="From profit events; no unrealised PnL" />
              </div>
            </Card>
            <Card title="Policy versions for this bucket">
              <Async q={core}>{(c: any) => { const rows = c.policies.filter((p: any) => p.bucket_id === sel.id); return rows.length === 0 ? <EmptyState title="No versions yet" /> : (
                <Table searchable={false} caption="Versions" rows={rows} cols={[{ key: 'version', header: 'Version', sort: (p) => p.version }, { key: 'mode', header: 'Mode' },
                  { key: 'p', header: 'Waterfall', render: (p) => <PolicyCells p={p} /> }, { key: 'created_at', header: 'Created', render: (p) => when(p.created_at) }]} />); }}</Async>
            </Card>
            <Card title="Scenario simulator">
              {sel.latest_policy ? (() => { const p = sel.latest_policy; const wp: WaterfallPolicy = { taxBps: p.tax_provision_bps, reinvestBps: p.reinvest_bps, vaultBps: p.vault_bps, crossBps: p.cross_bucket_bps, reserveBps: p.reserve_bps, minTicket: 0n };
                return <Simulator policy={wp} symbol="units" decimals={0} />; })() : <EmptyState title="Save a policy to simulate it" />}
              <p className="mt-2 text-[12px] text-muted">Units are abstract here (0 decimals) because the simulator has no market data; it demonstrates how your percentages move a balance.</p>
            </Card>
            {current && wizard && <PolicyWizard key={sel.id + (sel.latest_policy?.version ?? 0)} open={wizard} onClose={() => setWizard(false)} workspace={current.id} bucket={sel} buckets={[...buckets, ...((ov.data?.vaults ?? []).map((v: any) => ({ ...v, kind: 'protected_vault' })))]} />}
          </div>)}
      </TabPanel>

      <TabPanel id="basket" value={tab}>
        <Card title="Baskets">
          <Note>A basket inherits the compounding policy of its bucket; there is no basket-specific override stored yet. Basket weights govern rebalancing, not profit distribution.</Note>
          <div className="mt-4"><Async q={baskets} empty={(b: any) => (b.baskets ?? []).length === 0}>{(b: any) => (
            <Table caption="Baskets and inherited policy" rows={b.baskets} cols={[{ key: 'name', header: 'Basket' }, { key: 'bucket_name', header: 'Bucket', filter: true },
              { key: 'members', header: 'Members', render: (k) => k.members.map((m: any) => `${m.symbol} ${pct(m.weight_bps)}`).join(', ') },
              { key: 'pol', header: 'Inherited policy', render: (k) => <PolicyCells p={buckets.find((x) => x.id === k.bucket_id)?.latest_policy} /> }]} />)}</Async></div>
        </Card>
      </TabPanel>

      <TabPanel id="strategy" value={tab}>
        <Card title="Strategy budgets and inherited policy">
          <Note>Strategies compound through their bucket&apos;s waterfall; a strategy-level override is not stored. Budgets cap how much a strategy may reserve.</Note>
          <div className="mt-4"><Async q={alloc} empty={(a: any) => a.budgets.length === 0}>{(a: any) => (
            <Table caption="Strategy budgets" rows={a.budgets} cols={[{ key: 'strategy_key', header: 'Strategy', filter: true }, { key: 'b', header: 'Bucket', render: (r) => bucketName[r.bucket_id] ?? r.bucket_id.slice(0, 8) },
              { key: 'limit_amount', header: 'Limit (base units)', align: 'right' }, { key: 'reserved_amount', header: 'Reserved', align: 'right' },
              { key: 'pol', header: 'Inherited policy', render: (r) => <PolicyCells p={buckets.find((x) => x.id === r.bucket_id)?.latest_policy} /> }]} />)}</Async></div>
        </Card>
      </TabPanel>

      {current && <TargetDialog open={target} onClose={() => setTarget(false)} workspace={current.id} buckets={buckets} />}
    </NeedWorkspace>
  );
}
