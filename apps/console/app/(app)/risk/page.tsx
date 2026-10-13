'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Async, Badge, Button, Card, EmptyState, Kpi, PageHeader, StackedBar, TabPanel, Tabs } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { useWs } from '@/components/hooks';
import { EnvBadge, Note, Table, useAction } from '@/components/ops/common';
import { EmergencyWizard, GateDialog, LiveOptIn, RiskPolicyWizard } from '@/components/risk/dialogs';
import { useWorkspace } from '@/lib/workspace';
import { formatUnits, when } from '@/lib/format';

const TABS = ['Global', 'Bucket', 'Wallet', 'Chain', 'Token', 'Strategy', 'Incidents'].map((l) => ({ id: l.toLowerCase(), label: l }));
const sevTone = (s: string) => (s === 'critical' ? 'bad' : s === 'warn' ? 'warn' : 'neutral') as 'bad' | 'warn' | 'neutral';
const gateTone = (s: string) => (s === 'PASS' ? 'good' : s === 'FAIL' ? 'bad' : s === 'BLOCKED' ? 'warn' : 'neutral') as 'good' | 'bad' | 'warn' | 'neutral';

interface Agg { id: string; key: string; label: string; env: string; symbol: string; decimals: number; asset_id: string; chain_id: string; available: bigint; inflight: bigint; protectedBal: bigint; feeReserve: bigint }
function aggregate(rows: any[], keyOf: (r: any) => [string, string]): Agg[] {
  const m = new Map<string, Agg>();
  for (const r of rows) {
    const [key, label] = keyOf(r); const id = `${key}|${r.asset_id}|${r.environment}`;
    const a = m.get(id) ?? { id, key, label, env: r.environment, symbol: r.symbol, decimals: r.decimals, asset_id: r.asset_id, chain_id: r.chain_id, available: 0n, inflight: 0n, protectedBal: 0n, feeReserve: 0n };
    const v = BigInt(r.amount);
    if (r.state === 'available') a.available += v; else if (['reserved', 'pending_out', 'pending_bridge'].includes(r.state)) a.inflight += v; else if (['vault', 'restricted'].includes(r.state)) a.protectedBal += v; else if (r.state === 'fee_reserve') a.feeReserve += v;
    m.set(id, a);
  }
  return [...m.values()].sort((x, y) => x.label.localeCompare(y.label) || x.symbol.localeCompare(y.symbol));
}
function ExposureTable({ rows, caption, labelHeader }: { rows: Agg[]; caption: string; labelHeader: string }) {
  if (rows.length === 0) return <EmptyState title="No ledger exposure" hint="Deposit and allocate paper funds to see exposure here." />;
  return <Table caption={caption} rows={rows} cols={[
    { key: 'label', header: labelHeader, filter: true }, { key: 'env', header: 'Env', render: (r: Agg) => <EnvBadge env={r.env} />, text: (r: Agg) => r.env },
    { key: 'symbol', header: 'Asset', filter: true },
    { key: 'available', header: 'Available', align: 'right', render: (r: Agg) => formatUnits(r.available, r.decimals), sort: (r: Agg) => r.available.toString().padStart(80, '0') },
    { key: 'inflight', header: 'Reserved / in flight', align: 'right', render: (r: Agg) => formatUnits(r.inflight, r.decimals) },
    { key: 'protectedBal', header: 'Vault / restricted', align: 'right', render: (r: Agg) => formatUnits(r.protectedBal, r.decimals) },
    { key: 'feeReserve', header: 'Fee / gas reserve', align: 'right', render: (r: Agg) => formatUnits(r.feeReserve, r.decimals) }]} />;
}
/** Concentration of one asset across keys, as basis points computed with BigInt (display only). */
function Concentration({ rows }: { rows: Agg[] }) {
  const byAsset = new Map<string, Agg[]>(); for (const r of rows) byAsset.set(r.asset_id + r.env, [...(byAsset.get(r.asset_id + r.env) ?? []), r]);
  const colors = ['#5277c9', '#5e9dac', '#b28c63', '#8c92bb', '#679783'];
  return <div className="space-y-4">{[...byAsset.values()].map((g) => { const tot = g.reduce((a, r) => a + r.available + r.inflight + r.protectedBal, 0n); if (tot === 0n) return null;
    return (<div key={g[0].id}><div className="mb-1 text-[12px] font-semibold">{g[0].symbol} ({g[0].env}) concentration</div>
      <StackedBar parts={g.map((r, i) => ({ label: r.label, value: Number(((r.available + r.inflight + r.protectedBal) * 10000n) / tot), color: colors[i % 5] }))} />
      <p className="mt-1 text-[11px] text-muted">{g.map((r) => `${r.label} ${(Number(((r.available + r.inflight + r.protectedBal) * 10000n) / tot) / 100).toFixed(1)}%`).join(' · ')}</p></div>); })}</div>;
}

export default function RiskPage() {
  const { current, canOwn, canAdmin } = useWorkspace(); const [tab, setTab] = useState('global');
  const risk = useWs<any>('risk'), exp = useWs<any>('risk/exposure'), vio = useWs<any>('risk/violations'), inc = useWs<any>('risk/incidents'), buckets = useWs<{ items: any[] }>('buckets'), wallets = useWs<{ items: any[] }>('wallets'), alloc = useWs<any>('allocations');
  const [gate, setGate] = useState<any>(null); const [emerg, setEmerg] = useState(false); const [rbucket, setRbucket] = useState<any>(null);
  const resume = useAction<any>('resumeApproved'); const bres = useAction<any>('setBucketState'); const wres = useAction<any>('resumeWallet'); const ack = useAction<any>('acknowledgeAlert');
  const ledger: any[] = exp.data?.ledger ?? [];
  const byBucket = useMemo(() => aggregate(ledger.filter((r) => r.bucket_id), (r) => [r.bucket_id, r.bucket_name]), [ledger]);
  const byWallet = useMemo(() => aggregate(ledger.filter((r) => r.wallet_id), (r) => [r.wallet_id, r.wallet_nickname]), [ledger]);
  const byChain = useMemo(() => aggregate(ledger, (r) => [r.chain_id, r.chain_id]), [ledger]);
  const byToken = useMemo(() => aggregate(ledger, (r) => [r.asset_id, `${r.symbol} (${r.chain_id})`]), [ledger]);
  const limits: Record<string, number> = risk.data?.settings?.global_limits ?? {};
  const observe = { pendingTransfers: (alloc.data?.transfers ?? []).filter((t: any) => ['requested', 'pending_finality'].includes(t.status)).length, unknownOrders: risk.data?.unknownOrders ?? 0, openIntents: (exp.data?.strategies ?? []).reduce((n: number, s: any) => n + s.open_intents, 0), globalState: risk.data?.settings?.global_state ?? 'active' };
  if (!current) return <NeedWorkspace>{null}</NeedWorkspace>;

  return (
    <NeedWorkspace>
      <PageHeader title="Risk Command" description="Current violations with their authoritative source, deployment gates, live lock and scoped stop controls. Exposure is the internal ledger only: no market prices, VaR or correlation are shown because no price feed is connected."
        actions={<Button variant="danger" onClick={() => setEmerg(true)}>Emergency controls</Button>} />
      <Tabs tabs={TABS} value={tab} onChange={setTab} />

      <TabPanel id="global" value={tab}>
        <div className="grid gap-5">
          <Async q={risk}>{(r: any) => { const pass = r.gates.filter((g: any) => g.status === 'PASS').length; return (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Kpi label="Global state" value={r.settings.global_state.replace(/_/g, ' ')} sub={r.settings.global_state === 'active' ? 'Entries allowed (paper)' : 'New entries refused'} tone={r.settings.global_state === 'active' ? 'good' : 'bad'} />
              <Kpi label="Gates passing" value={`${pass} / ${r.gates.length}`} sub="Live needs all PASS with evidence" tone={pass === r.gates.length ? 'good' : 'warn'} />
              <Kpi label="UNKNOWN orders" value={r.unknownOrders} sub="Reconcile before any resubmit" tone={r.unknownOrders ? 'bad' : undefined} />
              <Kpi label="Risk vetoes recorded" value={r.decisions.find((d: any) => d.decision === 'VETO')?.n ?? 0} sub="risk_decisions" />
            </div>); }}</Async>

          <Card title="Current violations and their authority" action={risk.data?.settings?.global_state !== 'active' ? <Button variant="primary" disabled={!canAdmin} busy={resume.busy} onClick={() => resume.run({ workspace: current.id, reason: 'Resumed from Risk Command' }, { ok: 'Resumed' })}>Resume approved</Button> : undefined}>
            <Async q={vio} empty={(v: any) => v.items.length === 0}>{(v: any) => (
              <Table caption="Current violations" rows={v.items.map((x: any) => ({ ...x, id: x.key }))} cols={[
                { key: 'severity', header: 'Severity', filter: true, render: (x) => <Badge tone={sevTone(x.severity)}>{x.severity}</Badge> },
                { key: 'scope', header: 'Scope', filter: true }, { key: 'title', header: 'Violation', render: (x) => <div><div className="font-semibold">{x.title}</div><div className="text-[12px] text-muted">{x.detail}</div></div>, text: (x) => x.title },
                { key: 'source', header: 'Authoritative source', render: (x) => <div><code className="text-[12px]">{x.source}</code><div className="text-[12px] text-muted">{x.rule}</div></div>, text: (x) => x.source },
                { key: 'action', header: 'What to do' }]} />)}</Async>
            <p className="mt-2 text-[12px] text-muted">An empty list means no rule above is currently violated; it is not proof of health (no probes or price feeds run).</p>
          </Card>

          <Card title="Deployment gates (live lock)" action={<Badge tone="good">Live: {current.live_allowed ? 'ENABLED' : 'LOCKED'}</Badge>}>
            <Async q={risk}>{(r: any) => (<>
              <Table caption="Deployment gates" rows={r.gates.map((g: any) => ({ ...g, id: g.gate_key }))} cols={[
                { key: 'gate_key', header: 'Gate' }, { key: 'description', header: 'Requirement' },
                { key: 'status', header: 'Status', filter: true, render: (g) => <Badge tone={gateTone(g.status)}>{g.status}</Badge> },
                { key: 'evidence_ref', header: 'Evidence', render: (g) => g.evidence_ref ?? <span className="text-muted">none</span> },
                { key: 'commit_sha', header: 'Commit', render: (g) => (g.commit_sha ? <code className="text-[12px]">{g.commit_sha.slice(0, 12)}</code> : <span className="text-muted">none</span>) },
                { key: 'act', header: 'Sign-off', render: (g) => <Button disabled={!canOwn} title={canOwn ? undefined : 'Owner only'} onClick={() => setGate(g)} aria-label={`Sign off ${g.gate_key}`}>Sign off</Button> }]} />
              <p className="mt-2 text-[12px] text-muted">Every gate starts NOT_RUN. Do not record PASS without a real evidence file and the commit it was produced on.</p></>)}</Async>
          </Card>

          <Card title="Live opt-in">
            <Async q={risk}>{(r: any) => <LiveOptIn workspace={current.id} optIn={r.settings.live_opt_in ?? current.live_opt_in} flag={current.live_feature_flag} liveAllowed={current.live_allowed} gatesPassing={r.gates.filter((g: any) => g.status === 'PASS').length} gatesTotal={r.gates.length} />}</Async>
          </Card>

          <Card title="Global hard limits" action={<Link href="/settings" className="text-[13px] font-semibold text-accent">Tighten in Settings</Link>}>
            <Table searchable={false as any} caption="Global limits" rows={Object.entries(limits).map(([k, v]) => ({ id: k, k, v }))} cols={[{ key: 'k', header: 'Limit' }, { key: 'v', header: 'Value', align: 'right' }, { key: 'src', header: 'Authority', render: () => <code className="text-[12px]">workspace_settings.global_limits</code> }]} />
          </Card>

          <Card title="Recent risk vetoes"><Async q={risk} empty={(r: any) => r.vetoes.length === 0}>{(r: any) => <Table caption="Vetoes" rows={r.vetoes.map((v: any) => ({ ...v, id: v.intent_id }))} cols={[{ key: 'created_at', header: 'When', render: (v) => when(v.created_at) }, { key: 'intent_id', header: 'Intent', render: (v) => v.intent_id.slice(0, 8) }, { key: 'reasons', header: 'Reasons', render: (v) => JSON.stringify(v.reasons) }]} />}</Async></Card>
        </div>
      </TabPanel>

      <TabPanel id="bucket" value={tab}>
        <div className="grid gap-5">
          <Card title="Bucket risk"><Async q={buckets} empty={(b) => b.items.length === 0}>{(b) => (
            <Table caption="Bucket risk controls" rows={b.items} cols={[{ key: 'name', header: 'Bucket' }, { key: 'environment', header: 'Env', render: (x) => <EnvBadge env={x.environment} /> }, { key: 'state', header: 'State', filter: true, render: (x) => <Badge tone={x.state === 'active' ? 'good' : 'bad'}>{x.state.replace(/_/g, ' ')}</Badge> },
              { key: 'policy', header: 'Risk policy', render: (x) => <span className="font-mono text-[12px]">v{x.policy_version} {JSON.stringify(x.policy)}</span> },
              { key: 'act', header: 'Actions', render: (x) => <span className="flex flex-wrap gap-2"><Button disabled={!canAdmin} onClick={() => setRbucket(x)} aria-label={`Edit risk policy of ${x.name}`}>Edit policy</Button>
                {x.state !== 'active' && <Button variant="primary" disabled={!canAdmin} busy={bres.busy} onClick={() => bres.run({ bucket: x.id, state: 'active', reason: 'Resumed from Risk Command' }, { ok: 'Bucket resumed' })}>Resume</Button>}</span> }]} />)}</Async></Card>
          <Card title="Exposure by bucket (ledger)"><Async q={exp}>{() => <><ExposureTable rows={byBucket} caption="Exposure by bucket" labelHeader="Bucket" /><div className="mt-4"><Concentration rows={byBucket} /></div></>}</Async></Card>
        </div>
      </TabPanel>

      <TabPanel id="wallet" value={tab}>
        <div className="grid gap-5">
          <Card title="Wallet state"><Async q={wallets} empty={(w) => w.items.length === 0}>{(w) => <Table caption="Wallet states" rows={w.items} cols={[{ key: 'nickname', header: 'Wallet' }, { key: 'family', header: 'Family', filter: true }, { key: 'capability', header: 'Capability' }, { key: 'state', header: 'State', render: (x) => <Badge tone={x.state === 'active' ? 'good' : 'bad'}>{x.state}</Badge> },
            { key: 'act', header: 'Action', render: (x) => x.state === 'paused' ? <Button variant="primary" disabled={!canAdmin} busy={wres.busy} onClick={() => wres.run({ wallet: x.id, reason: 'Resumed from Risk Command' }, { ok: 'Wallet resumed' })}>Resume</Button> : <span className="text-muted">-</span> }]} />}</Async></Card>
          <Card title="Exposure and rescue-gas reserve by wallet"><Async q={exp}>{() => <><ExposureTable rows={byWallet} caption="Exposure by wallet" labelHeader="Wallet" /><p className="mt-2 text-[12px] text-muted">Rescue gas = the fee/gas reserve column (ledger fee_reserve). Real native-token gas balances on-chain are not probed.</p></>}</Async></Card>
        </div>
      </TabPanel>

      <TabPanel id="chain" value={tab}>
        <Card title="Exposure by chain"><Async q={exp}>{() => <><ExposureTable rows={byChain} caption="Exposure by chain" labelHeader="Chain" /><div className="mt-4"><Note>Chain health is <strong>NOT_MEASURED</strong>: no RPC probe worker is running, so no chain is shown healthy or unhealthy. <Link href="/chains" className="font-semibold underline">Chains</Link></Note></div></>}</Async></Card>
      </TabPanel>

      <TabPanel id="token" value={tab}>
        <Card title="Exposure by token"><Async q={exp}>{() => <><ExposureTable rows={byToken} caption="Exposure by token" labelHeader="Token" /><div className="mt-4"><Note>Token safety scores (honeypot / sell-path simulation) are not computed: no scanner is connected. Identity here is chain + contract, never the ticker alone.</Note></div></>}</Async></Card>
      </TabPanel>

      <TabPanel id="strategy" value={tab}>
        <div className="grid gap-5">
          <Card title="Open intents by strategy"><Async q={exp} empty={(e: any) => e.strategies.length === 0}>{(e: any) => <Table caption="Open intents by strategy" rows={e.strategies.map((s: any) => ({ ...s, id: s.strategy_key + s.environment + s.quote_symbol }))} cols={[{ key: 'strategy_key', header: 'Strategy', filter: true }, { key: 'environment', header: 'Env', render: (s) => <EnvBadge env={s.environment} /> }, { key: 'open_intents', header: 'Open intents', align: 'right' }, { key: 'open_notional', header: 'Open notional (quote units)', align: 'right', render: (s) => `${formatUnits(s.open_notional, s.quote_decimals)} ${s.quote_symbol}` }]} />}</Async></Card>
          <Card title="Capital budgets"><Async q={exp} empty={(e: any) => e.budgets.length === 0}>{(e: any) => <Table caption="Strategy budgets" rows={e.budgets.map((b: any) => ({ ...b, id: b.strategy_key + b.bucket_name + b.symbol }))} cols={[{ key: 'strategy_key', header: 'Strategy' }, { key: 'bucket_name', header: 'Bucket' }, { key: 'limit', header: 'Limit', align: 'right', render: (b) => `${formatUnits(b.limit_amount, b.decimals)} ${b.symbol}` }, { key: 'reserved', header: 'Reserved', align: 'right', render: (b) => `${formatUnits(b.reserved_amount, b.decimals)} ${b.symbol}` }]} />}</Async></Card>
        </div>
      </TabPanel>

      <TabPanel id="incidents" value={tab}>
        <div className="grid gap-5">
          <Async q={inc}>{(d: any) => (<>
            <Note>{d.note}</Note>
            <Card title="Alerts"><Table caption="Alerts" rows={d.alerts} cols={[{ key: 'created_at', header: 'When', render: (a) => when(a.created_at) }, { key: 'severity', header: 'Severity', filter: true, render: (a) => <Badge tone={sevTone(a.severity)}>{a.severity}</Badge> }, { key: 'class', header: 'Class' }, { key: 'message', header: 'Message' },
              { key: 'acknowledged', header: 'State', render: (a) => (a.acknowledged ? <Badge tone="good">acknowledged</Badge> : <Button disabled={!current || !['owner', 'admin', 'trader'].includes(current.role)} busy={ack.busy} onClick={() => ack.run({ alert: Number(a.id) }, { ok: 'Acknowledged' })}>Acknowledge</Button>), text: (a) => (a.acknowledged ? 'acknowledged' : 'open') }]} empty={<EmptyState title="No alerts" hint="Alerts are only written by explicit actions and services." />} /></Card>
            <Card title="Emergency actions"><Table caption="Emergency actions" rows={d.emergencyActions} cols={[{ key: 'created_at', header: 'When', render: (a) => when(a.created_at) }, { key: 'scope', header: 'Scope', filter: true }, { key: 'action', header: 'Action', filter: true }, { key: 'reason', header: 'Reason' }]} empty={<EmptyState title="No emergency actions recorded" />} /></Card>
            <Card title="Broken or unsettled settlement"><Table caption="Unsettled transfers" rows={d.brokenSettlement} cols={[{ key: 'created_at', header: 'When', render: (t) => when(t.created_at) }, { key: 'kind', header: 'Kind' }, { key: 'status', header: 'Status', render: (t) => <Badge tone={t.status === 'failed' ? 'bad' : 'warn'}>{t.status.replace('_', ' ')}</Badge> }, { key: 'amount', header: 'Amount (base units)', align: 'right' }]} empty={<EmptyState title="Nothing unsettled" />} /></Card>
            <Card title="UNKNOWN orders"><Table caption="Unknown orders" rows={d.unknownOrders} cols={[{ key: 'updated_at', header: 'Since', render: (o) => when(o.updated_at) }, { key: 'strategy_key', header: 'Strategy' }, { key: 'environment', header: 'Env' }, { key: 'id', header: 'Intent', render: (o) => o.id.slice(0, 8) }]} empty={<EmptyState title="No UNKNOWN orders" />} /></Card>
            <p className="text-[13px]">Full timelines and acknowledgements: <Link href="/operations/audit" className="font-semibold text-accent underline">Audit &amp; Incidents</Link>.</p></>)}</Async>
        </div>
      </TabPanel>

      {gate && <GateDialog open={!!gate} onClose={() => setGate(null)} workspace={current.id} gate={gate} />}
      <EmergencyWizard key={String(emerg)} open={emerg} onClose={() => setEmerg(false)} workspace={current.id} buckets={buckets.data?.items ?? []} wallets={wallets.data?.items ?? []} observe={observe} />
      {rbucket && <RiskPolicyWizard key={rbucket.id + rbucket.policy_version} open={!!rbucket} onClose={() => setRbucket(null)} bucket={rbucket} limits={limits} />}
    </NeedWorkspace>
  );
}
