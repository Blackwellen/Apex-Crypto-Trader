'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { Async, Badge, Button, Card, ConfirmDialog, DataTable, Kpi, PageHeader, Progress, StackedBar, useToast, EmptyState } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { useWs } from '@/components/hooks';
import { useCommand } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { formatUnits, when } from '@/lib/format';

const COLORS = ['#5277c9', '#5e9dac', '#b28c63', '#8c92bb', '#679783'];
type Bal = { environment: string; state: string; symbol: string; decimals: number; amount: string };

function sum(b: Bal[], states: string[], symbol: string) { return b.filter((x) => states.includes(x.state) && x.symbol === symbol).reduce((a, x) => a + BigInt(x.amount), 0n); }

function Controls() {
  const { current, canWrite } = useWorkspace(); const toast = useToast(); const [confirm, setConfirm] = useState<'pause' | 'exit' | null>(null);
  const start = useCommand('startPaper'), stop = useCommand('stopPaper'), pause = useCommand('pauseNewEntries'), exitOnly = useCommand('enterExitOnly'), resume = useCommand('resumeApproved');
  if (!current) return null;
  const halted = current.global_state !== 'active'; const err = (e: Error) => toast.push(e.message, 'bad');
  return (<>
    {halted
      ? <Button variant="primary" disabled={!current.role || !['owner', 'admin'].includes(current.role)} onClick={() => resume.mutate({ body: { workspace: current.id, reason: 'Resumed from console' } }, { onSuccess: () => toast.push('Resumed (paper)'), onError: err })} busy={resume.isPending} title="Owner/admin only"><Play className="size-4" aria-hidden />Resume approved</Button>
      : current.paper_running
        ? <Button onClick={() => stop.mutate({ body: { workspace: current.id } }, { onSuccess: () => toast.push('Paper engine stopped'), onError: err })} busy={stop.isPending} disabled={!canWrite}><Pause className="size-4" aria-hidden />Stop paper engine</Button>
        : <Button variant="primary" onClick={() => start.mutate({ body: { workspace: current.id } }, { onSuccess: () => toast.push('Paper engine flagged to run'), onError: err })} busy={start.isPending} disabled={!canWrite}><Play className="size-4" aria-hidden />Start paper engine</Button>}
    <Button onClick={() => setConfirm('pause')} disabled={!canWrite || halted}>Pause new entries</Button>
    <Button onClick={() => setConfirm('exit')} disabled={!canWrite || halted}>Exit-only</Button>
    <ConfirmDialog open={confirm !== null} onClose={() => setConfirm(null)} title={confirm === 'pause' ? 'Pause new entries' : 'Enter exit-only mode'} confirmLabel="Confirm"
      body={<p>{confirm === 'pause' ? 'No new positions will be opened. Existing orders keep settling.' : 'Only risk-reducing exits are allowed; no new entries.'} Resuming requires an owner or admin.</p>}
      onConfirm={() => { const m = confirm === 'pause' ? pause : exitOnly; m.mutate({ body: { workspace: current.id, reason: `${confirm} from console` } }, { onSuccess: () => { toast.push('State updated'); setConfirm(null); }, onError: err }); }} />
  </>);
}

export default function Dashboard() {
  const ov = useWs<any>('overview'), buckets = useWs<{ items: any[] }>('buckets'), orders = useWs<{ items: any[] }>('orders', '&limit=8'), risk = useWs<any>('risk'), analytics = useWs<any>('analytics');
  const { current } = useWorkspace();
  return (
    <NeedWorkspace>
      <PageHeader title="Command Centre" description="Ledger-backed view of segregated capital, risk gates and paper trading. Amounts come from the authoritative double-entry ledger; nothing here is a market-price valuation." actions={<Controls />} />
      <Async q={ov}>{(d: any) => {
        const paper: Bal[] = d.balances.filter((b: Bal) => b.environment === 'paper');
        const symbols = [...new Set(paper.map((b) => b.symbol))];
        const live = d.balances.filter((b: Bal) => b.environment === 'live');
        return (<>
          {live.length === 0 && <p className="mb-4 text-[13px] text-muted">Live balances: <Badge>none — live is locked</Badge></p>}
          {symbols.length === 0
            ? <Card><EmptyState title="No balances yet" hint="Connect a wallet, assign it to a bucket, then add a paper deposit and allocate it." action={<Link className="font-semibold text-accent underline" href="/wallets">Go to Wallets</Link>} /></Card>
            : symbols.map((s) => { const dec = paper.find((b) => b.symbol === s)!.decimals; const f = (x: bigint) => formatUnits(x, dec);
              return (<div key={s} className="mb-5"><h2 className="mb-2 text-[12px] font-bold uppercase tracking-wider text-muted">{s} · paper ledger</h2>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <Kpi label="Tradeable (available)" value={f(sum(paper, ['available'], s))} sub="Unreserved bucket funds" />
                  <Kpi label="Reserved / in flight" value={f(sum(paper, ['reserved', 'pending_out', 'pending_bridge'], s))} sub="Not spendable until settled" tone="warn" />
                  <Kpi label="Protected vault & restricted" value={f(sum(paper, ['vault', 'restricted'], s))} sub="Never tradeable by strategy workers" />
                  <Kpi label="Fee / gas reserve" value={f(sum(paper, ['fee_reserve'], s))} sub="Held back from trading" />
                </div></div>); })}
        </>);
      }}</Async>

      <div className="mt-2 grid gap-5 xl:grid-cols-3">
        <Card title="Equity history" className="xl:col-span-2"><EmptyState title="No equity history recorded yet" hint="Balance snapshots are not yet being captured, and no market-price feed is connected, so APEX will not draw an equity curve it cannot support. Realised PnL below is real ledger data." />
          <Async q={analytics}>{(a: any) => <p className="mt-3 text-[12px] text-muted">{a.provenance} Fills recorded: <strong>{a.fills.n}</strong>.</p>}</Async></Card>
        <Card title="Segregated capital" action={<Link href="/buckets" className="text-[13px] font-semibold text-accent">Manage</Link>}>
          <Async q={buckets} empty={(b) => b.items.length === 0}>{(b) => (
            <div className="space-y-3"><StackedBar parts={b.items.map((x, i) => ({ label: x.name, value: 1, color: COLORS[i % 5] }))} />
              {b.items.map((x, i) => <div key={x.id} className="flex items-center justify-between border-t border-line pt-3 text-[13px]">
                <div><Link href={`/portfolios/${x.portfolio_id}/buckets/${x.id}`} className="font-semibold hover:underline">{x.name}</Link><div className="text-[12px] text-muted"><span style={{ color: COLORS[i % 5] }}>●</span> {x.kind.replace('_', ' ')} · {x.segregation} · {x.wallet_count} wallet(s)</div></div>
                <Badge tone={x.state === 'active' ? 'good' : 'warn'}>{x.state.replace(/_/g, ' ')}</Badge></div>)}</div>)}</Async>
        </Card>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Card title="Recent orders" action={<Link href="/trading" className="text-[13px] font-semibold text-accent">All orders</Link>} className="xl:col-span-2">
          <Async q={orders} empty={(o) => o.items.length === 0}>{(o) => <DataTable searchable={false} caption="Recent orders" rows={o.items} cols={[
            { key: 'strategy_key', header: 'Strategy' }, { key: 'side', header: 'Side' }, { key: 'state', header: 'State', render: (r) => <Badge tone={r.state === 'UNKNOWN' ? 'warn' : 'neutral'}>{r.state}</Badge> },
            { key: 'environment', header: 'Env' }, { key: 'created_at', header: 'Created', render: (r) => when(r.created_at) }]} />}</Async>
        </Card>
        <Card title="Risk gate & live lock" action={<Link href="/risk" className="text-[13px] font-semibold text-accent">Risk Command</Link>}>
          <Async q={risk}>{(r: any) => { const pass = r.gates.filter((g: any) => g.status === 'PASS').length; return (
            <div className="space-y-3 text-[13px]"><div className="flex justify-between"><span>Deployment gates passed</span><strong>{pass} / {r.gates.length}</strong></div>
              <Progress label="Deployment gates passed" value={(pass / Math.max(1, r.gates.length)) * 100} tone="good" />
              <div className="flex justify-between"><span>Global state</span><Badge tone={r.settings.global_state === 'active' ? 'good' : 'bad'}>{r.settings.global_state.replace(/_/g, ' ')}</Badge></div>
              <div className="flex justify-between"><span>UNKNOWN orders awaiting reconciliation</span><strong>{r.unknownOrders}</strong></div>
              <div className="flex justify-between"><span>Risk vetoes recorded</span><strong>{r.decisions.find((d: any) => d.decision === 'VETO')?.n ?? 0}</strong></div>
              <p className="rounded-lg bg-warn-soft p-3 text-warn">Live execution {current?.live_allowed ? 'is enabled' : 'is locked'}. No gate has passed unless it shows evidence in Risk Command.</p></div>); }}</Async>
        </Card>
      </div>
    </NeedWorkspace>
  );
}
