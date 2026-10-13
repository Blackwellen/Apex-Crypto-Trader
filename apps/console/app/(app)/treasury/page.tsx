'use client';
import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { Async, Badge, Button, Card, Dialog, EmptyState, Kpi, PageHeader, Select, TextInput } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { useWs } from '@/components/hooks';
import { EnvBadge, Note, Table, useAction } from '@/components/ops/common';
import { useApi } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { formatUnits, parseUnits, when } from '@/lib/format';
import { downloadCsv } from '@/lib/csv';

const f = (v: string | bigint, d: number) => formatUnits(v, d);
function Export({ name, header, rows }: { name: string; header: string[]; rows: string[][] }) {
  return <Button onClick={() => downloadCsv(name, header, rows)} disabled={rows.length === 0} aria-label={`Export ${name}`}><Download className="size-4" aria-hidden />Export CSV</Button>;
}

function ExceptionDialog({ open, onClose, workspace, buckets }: { open: boolean; onClose: () => void; workspace: string; buckets: any[] }) {
  const assets = useApi<{ items: any[] }>('v1/assets'); const act = useAction<any>('addReconciliationException');
  const [bucket, setBucket] = useState(''); const [asset, setAsset] = useState(''); const [exp, setExp] = useState(''); const [obs, setObs] = useState(''); const [source, setSource] = useState(''); const [note, setNote] = useState('');
  const list = assets.data?.items ?? []; const a = list.find((x) => x.id === asset) ?? list[0];
  let e: string | undefined, o: string | undefined, err: string | undefined;
  try { if (exp.trim()) e = parseUnits(exp, a?.decimals ?? 0); } catch (x) { err = (x as Error).message; }
  try { if (obs.trim()) o = parseUnits(obs, a?.decimals ?? 0); } catch (x) { err = (x as Error).message; }
  const ok = !!a && e !== undefined && o !== undefined && e !== o && source.trim().length > 0 && !err;
  return (
    <Dialog open={open} onClose={onClose} title="Add reconciliation exception" footer={<><Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!ok} busy={act.busy} onClick={() => act.run({ workspace, ...(bucket ? { bucket } : {}), asset: a.id, expected: e!, observed: o!, source: source.trim(), ...(note.trim() ? { note: note.trim() } : {}) },
        { ok: 'Exception recorded', onDone: () => { setExp(''); setObs(''); setSource(''); setNote(''); onClose(); } })}>Record exception</Button></>}>
      <div className="space-y-4">
        <Note>Use this when an external statement or explorer disagrees with the internal ledger. It records the disagreement for human follow-up; it does not change any balance.</Note>
        <Select label="Bucket (optional)" value={bucket} onChange={(x) => setBucket(x.target.value)} options={[{ value: '', label: 'Workspace-level' }, ...buckets.map((b) => ({ value: b.id, label: b.name }))]} />
        <Select label="Asset" value={a?.id ?? ''} onChange={(x) => setAsset(x.target.value)} options={list.map((x) => ({ value: x.id, label: `${x.symbol} (${x.chain_id})` }))} />
        <TextInput label={`Ledger says (${a?.symbol ?? ''})`} value={exp} onChange={(x) => setExp(x.target.value)} inputMode="decimal" error={err} />
        <TextInput label={`External source says (${a?.symbol ?? ''})`} value={obs} onChange={(x) => setObs(x.target.value)} inputMode="decimal" error={e !== undefined && o !== undefined && e === o ? 'Equal amounts: nothing to reconcile' : undefined} />
        <TextInput label="Source of the external figure" value={source} onChange={(x) => setSource(x.target.value)} maxLength={200} hint="e.g. Coinbase statement 2026-10-01, Etherscan address page" />
        <TextInput label="Note (optional)" value={note} onChange={(x) => setNote(x.target.value)} maxLength={1000} />
      </div>
    </Dialog>
  );
}

function ResolveDialog({ row, onClose }: { row: any; onClose: () => void }) {
  const act = useAction<any>('resolveReconciliationException'); const [res, setRes] = useState('');
  return (
    <Dialog open={!!row} onClose={onClose} title="Resolve exception" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={res.trim().length < 3} busy={act.busy} onClick={() => act.run({ id: row.id, resolution: res.trim() }, { ok: 'Exception resolved', onDone: () => { setRes(''); onClose(); } })}>Mark resolved</Button></>}>
      {row && <div className="space-y-3 text-[13px]"><p>Ledger {f(row.expected, row.decimals)} vs external {f(row.observed, row.decimals)} {row.symbol} ({row.source}).</p>
        <TextInput label="Resolution note (required)" value={res} onChange={(x) => setRes(x.target.value)} maxLength={500} /></div>}
    </Dialog>
  );
}

export default function TreasuryPage() {
  const { current, canAdmin } = useWorkspace();
  const cf = useWs<any>('treasury/cashflow'), ex = useWs<any>('treasury/exceptions'), bk = useWs<{ items: any[] }>('buckets');
  const [add, setAdd] = useState(false); const [resolve, setResolve] = useState<any>(null);
  const recon = useMemo(() => (cf.data?.flows ?? []).map((r: any) => {
    const pool = BigInt(cf.data.pool.find((p: any) => p.asset_id === r.asset_id && p.environment === r.environment)?.balance ?? '0');
    const expected = BigInt(r.deposits) - BigInt(r.allocations) + BigInt(r.vault_releases);
    return { ...r, id: r.environment + r.asset_id, poolBal: pool, expectedPool: expected, diff: pool - expected };
  }), [cf.data]);
  if (!current) return <NeedWorkspace>{null}</NeedWorkspace>;
  return (
    <NeedWorkspace>
      <PageHeader title="Treasury and Tax" description="Cash-flow reconciliation, fees, realised results and protected balances, all derived from the internal ledger. Internal transfers are shown separately and excluded from performance."
        actions={<Button variant="primary" disabled={!canAdmin} title={canAdmin ? undefined : 'Owner/admin only'} onClick={() => setAdd(true)}>Add reconciliation exception</Button>} />
      <Async q={cf}>{(d: any) => (<div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        <Note>{d.notes.scope}</Note>
        <Card title="Cash-flow reconciliation" action={<Export name="cashflow-reconciliation.csv" header={['environment', 'asset', 'deposits', 'allocations', 'vault_releases', 'expected_pool', 'ledger_pool', 'difference', 'decimals']}
          rows={recon.map((r: any) => [r.environment, r.symbol, r.deposits, r.allocations, r.vault_releases, r.expectedPool.toString(), r.poolBal.toString(), r.diff.toString(), String(r.decimals)])} />}>
          {recon.length === 0 ? <EmptyState title="No ledger movements yet" hint="Add a paper deposit and allocate it to a bucket." /> : (
            <Table caption="Cash-flow reconciliation" rows={recon} cols={[
              { key: 'environment', header: 'Env', render: (r: any) => <EnvBadge env={r.environment} />, text: (r: any) => r.environment, filter: true }, { key: 'symbol', header: 'Asset', filter: true },
              { key: 'deposits', header: 'Deposits', align: 'right', render: (r: any) => f(r.deposits, r.decimals) },
              { key: 'allocations', header: 'Allocated to buckets', align: 'right', render: (r: any) => f(r.allocations, r.decimals) },
              { key: 'vault_releases', header: 'Vault releases', align: 'right', render: (r: any) => f(r.vault_releases, r.decimals) },
              { key: 'expectedPool', header: 'Expected wallet pool', align: 'right', render: (r: any) => f(r.expectedPool, r.decimals) },
              { key: 'poolBal', header: 'Ledger wallet pool', align: 'right', render: (r: any) => f(r.poolBal, r.decimals) },
              { key: 'diff', header: 'Difference', align: 'right', render: (r: any) => (r.diff === 0n ? <Badge tone="good">reconciled</Badge> : <Badge tone="bad">{f(r.diff, r.decimals)}</Badge>), text: (r: any) => (r.diff === 0n ? 'reconciled' : 'difference') }]} />)}
          <p className="mt-2 text-[12px] text-muted">Expected pool = deposits - allocations + vault releases. This checks the ledger against itself, not against any chain or exchange.</p>
        </Card>

        <Card title="Internal transfers (excluded from performance)">
          <Table searchable={false as any} caption="Internal transfer volume" rows={recon} cols={[{ key: 'environment', header: 'Env', render: (r: any) => <EnvBadge env={r.environment} />, text: (r: any) => r.environment }, { key: 'symbol', header: 'Asset' },
            { key: 'transfers_in', header: 'Credited to destinations', align: 'right', render: (r: any) => f(r.transfers_in, r.decimals) }, { key: 'transfers_pending', header: 'Pending out (not credited)', align: 'right', render: (r: any) => f(r.transfers_pending, r.decimals) }]} />
          <p className="mt-2 text-[12px] text-muted">Moving capital between your own buckets is not profit or loss and is not counted in realised PnL or fees below.</p>
        </Card>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-2">
          <Card title="Fees paid by asset and bucket" action={<Export name="fees.csv" header={['environment', 'bucket', 'asset', 'fees_base_units', 'decimals']} rows={d.fees.map((x: any) => [x.environment, x.bucket_name ?? '', x.symbol, x.fees, String(x.decimals)])} />}>
            {d.fees.length === 0 ? <EmptyState title="No fees recorded" /> : <Table caption="Fees" rows={d.fees.map((x: any, i: number) => ({ ...x, id: String(i) }))} cols={[{ key: 'bucket_name', header: 'Bucket', filter: true }, { key: 'symbol', header: 'Asset', filter: true }, { key: 'fees', header: 'Fees', align: 'right', render: (x: any) => f(x.fees, x.decimals) }, { key: 'environment', header: 'Env', render: (x: any) => <EnvBadge env={x.environment} />, text: (x: any) => x.environment }]} />}
          </Card>
          <Card title="Realised PnL by bucket" action={<Export name="realised-pnl.csv" header={['environment', 'bucket', 'quote_asset', 'realised_base_units', 'decimals']} rows={d.realised.map((x: any) => [x.environment, x.bucket_name, x.symbol, x.realised, String(x.decimals)])} />}>
            {d.realised.length === 0 ? <EmptyState title="No realised results" hint="Closed trades with fills produce realised PnL." /> : <Table caption="Realised PnL" rows={d.realised.map((x: any, i: number) => ({ ...x, id: String(i) }))} cols={[{ key: 'bucket_name', header: 'Bucket', filter: true }, { key: 'symbol', header: 'Quote asset' }, { key: 'realised', header: 'Realised (net of fees)', align: 'right', render: (x: any) => f(x.realised, x.decimals) }, { key: 'environment', header: 'Env', render: (x: any) => <EnvBadge env={x.environment} />, text: (x: any) => x.environment }]} />}
            <p className="mt-2 text-[12px] text-muted">Unrealised PnL is not computed: no price feed is connected.</p>
          </Card>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-2">
          <Card title="Protected vault balances" action={<Export name="vault-balances.csv" header={['environment', 'bucket', 'asset', 'balance_base_units', 'decimals']} rows={d.held.filter((h: any) => h.state === 'vault').map((x: any) => [x.environment, x.bucket_name, x.symbol, x.balance, String(x.decimals)])} />}>
            {(() => { const v = d.held.filter((h: any) => h.state === 'vault'); return v.length === 0 ? <EmptyState title="Nothing in protected vaults" /> : <Table caption="Protected vault balances" rows={v.map((x: any, i: number) => ({ ...x, id: String(i) }))} cols={[{ key: 'bucket_name', header: 'Vault' }, { key: 'symbol', header: 'Asset' }, { key: 'balance', header: 'Balance', align: 'right', render: (x: any) => f(x.balance, x.decimals) }]} />; })()}
          </Card>
          <Card title="Tax provisions (restricted balances)" action={<Export name="tax-provisions.csv" header={['environment', 'bucket', 'asset', 'provision_base_units', 'decimals']} rows={d.held.filter((h: any) => h.state === 'restricted').map((x: any) => [x.environment, x.bucket_name, x.symbol, x.balance, String(x.decimals)])} />}>
            <Note tone="warn">An accounting set-aside from the policy percentage. It is not tax advice, not a tax computation and no tax has been paid.</Note>
            <div className="mt-3">{(() => { const v = d.held.filter((h: any) => h.state === 'restricted'); return v.length === 0 ? <EmptyState title="No provisions held" /> : <Table caption="Tax provisions" rows={v.map((x: any, i: number) => ({ ...x, id: String(i) }))} cols={[{ key: 'bucket_name', header: 'Bucket' }, { key: 'symbol', header: 'Asset' }, { key: 'balance', header: 'Provision', align: 'right', render: (x: any) => f(x.balance, x.decimals) }]} />; })()}</div>
          </Card>
        </div>

        <Card title="Cost-basis lots (position average cost)" action={<Export name="position-lots.csv" header={['environment', 'bucket', 'base_asset', 'quote_asset', 'quantity_base_units', 'cost_basis_quote_base_units', 'realised_quote_base_units', 'base_decimals', 'quote_decimals']}
          rows={d.lots.map((l: any) => [l.environment, l.bucket_name, l.base_symbol, l.quote_symbol, l.qty, l.cost_basis, l.realised, String(l.base_decimals), String(l.quote_decimals)])} />}>
          <Note tone="warn">{d.notes.gbp} This is not an accountant-ready disposal report.</Note>
          <div className="mt-3">{d.lots.length === 0 ? <EmptyState title="No positions" /> : <Table caption="Position lots" rows={d.lots.map((l: any, i: number) => ({ ...l, id: String(i) }))} cols={[
            { key: 'bucket_name', header: 'Bucket', filter: true }, { key: 'base_symbol', header: 'Asset' }, { key: 'qty', header: 'Quantity', align: 'right', render: (l: any) => f(l.qty, l.base_decimals) },
            { key: 'cost_basis', header: 'Cost basis', align: 'right', render: (l: any) => `${f(l.cost_basis, l.quote_decimals)} ${l.quote_symbol}` },
            { key: 'avg', header: 'Average cost / unit', align: 'right', render: (l: any) => (BigInt(l.qty) === 0n ? '-' : `${f((BigInt(l.cost_basis) * 10n ** BigInt(l.base_decimals)) / BigInt(l.qty), l.quote_decimals)} ${l.quote_symbol}`) },
            { key: 'realised', header: 'Realised', align: 'right', render: (l: any) => `${f(l.realised, l.quote_decimals)} ${l.quote_symbol}` }]} />}</div>
        </Card>
      </div>)}</Async>

      <Card className="mt-5" title="Manual reconciliation exceptions" action={<Export name="reconciliation-exceptions.csv" header={['status', 'environment', 'bucket', 'asset', 'ledger_expected', 'external_observed', 'source', 'note', 'created_at', 'resolution']}
        rows={(ex.data?.items ?? []).map((x: any) => [x.status, x.environment, x.bucket_name ?? '', x.symbol, x.expected, x.observed, x.source, x.note ?? '', x.created_at, x.resolution ?? ''])} />}>
        <Async q={ex} empty={(e: any) => e.items.length === 0}>{(e: any) => <Table caption="Reconciliation exceptions" rows={e.items} cols={[
          { key: 'status', header: 'Status', filter: true, render: (x) => <Badge tone={x.status === 'open' ? 'bad' : 'good'}>{x.status}</Badge> }, { key: 'bucket_name', header: 'Bucket', render: (x) => x.bucket_name ?? 'workspace' },
          { key: 'symbol', header: 'Asset' }, { key: 'expected', header: 'Ledger', align: 'right', render: (x) => f(x.expected, x.decimals) }, { key: 'observed', header: 'External', align: 'right', render: (x) => f(x.observed, x.decimals) },
          { key: 'source', header: 'Source' }, { key: 'created_at', header: 'Recorded', render: (x) => when(x.created_at) },
          { key: 'act', header: 'Action', render: (x) => (x.status === 'open' ? <Button disabled={!canAdmin} onClick={() => setResolve(x)}>Resolve</Button> : <span className="text-[12px] text-muted">{x.resolution}</span>) }]} />}</Async>
        {(ex.data?.items ?? []).length === 0 && !ex.isLoading && <p className="mt-2 text-[12px] text-muted">No exceptions recorded. Record one whenever an external figure disagrees with the ledger.</p>}
      </Card>
      <ExceptionDialog open={add} onClose={() => setAdd(false)} workspace={current.id} buckets={bk.data?.items ?? []} />
      {resolve && <ResolveDialog row={resolve} onClose={() => setResolve(null)} />}
    </NeedWorkspace>
  );
}
