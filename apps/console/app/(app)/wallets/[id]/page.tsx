'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Async, Badge, Button, Card, DataTable, EmptyState, PageHeader, TabPanel, Tabs } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { useApi } from '@/lib/api';
import { formatUnits, when } from '@/lib/format';
import { DisabledControls, MoveDialog, WalletLifecycle } from '@/components/capital/wallet-actions';
import { CapabilityBadge, Mono, NoKeysNote, PaperLabel, SegBadge, WalletStateBadge, useAssets, useBuckets, useChains, type WalletRow } from '@/components/capital/shared';

const TABS = ['balances', 'assets', 'permissions', 'buckets', 'activity', 'fees', 'connections'].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) }));
const STATE_LABEL: Record<string, string> = { available: 'Available (pool / bucket)', reserved: 'Reserved for orders', pending_out: 'In flight (out)', pending_bridge: 'In flight (bridge)', vault: 'Protected vault', restricted: 'Restricted / tax provision', fee_reserve: 'Fee reserve' };

interface Detail { wallet: any; chainAccounts: { id: string; chain_id: string; name: string; native_symbol: string }[]; balances: { state: string; bucket_id: string | null; symbol: string; decimals: number; wallet_chain_account_id: string; amount: string }[]; allocations: { bucket_id: string; exclusive: boolean; max_allocation_bps: number; logical_ack: boolean }[]; onChainBalanceNote: string }

function Body({ id }: { id: string }) {
  const q = useApi<Detail>(`v1/wallets/${id}`); const activity = useApi<any>(`v1/wallets/${id}/activity`), fees = useApi<any>(`v1/wallets/${id}/fees`);
  const buckets = useBuckets(), assets = useAssets(), chains = useChains(); const [tab, setTab] = useState('balances'); const [mv, setMv] = useState<string | null>(null);
  const bname = (bid: string | null) => { if (!bid) return 'Wallet pool (unassigned)'; const b = buckets.data?.items.find((x) => x.id === bid); return b ? b.name : 'bucket'; };
  return (
    <Async q={q}>{(d) => {
      const w = d.wallet; const row: WalletRow = { ...w, chains: d.chainAccounts.map((c) => c.chain_id), allocations: d.allocations.map((a) => ({ bucket_id: a.bucket_id, exclusive: a.exclusive, bps: a.max_allocation_bps })) };
      const managed = w.capability === 'managed_signer';
      return (<>
        <PageHeader title={w.nickname} description="Wallet detail. The same address string can exist on several networks; each network is a separate chain account with its own balances."
          actions={<WalletLifecycle wallet={row} />} />
        <div className="mb-5 flex flex-wrap items-center gap-2"><Badge>{w.family}</Badge><CapabilityBadge cap={w.capability} /><WalletStateBadge state={w.state} />
          <Badge tone={managed ? 'warn' : 'good'} title={managed ? 'A separate signer service holds signing authority' : 'APEX holds no signing authority for this wallet'}>{managed ? 'Managed signer' : 'Watch-only / not managed: APEX cannot sign'}</Badge></div>
        <div className="mb-5 rounded-xl border border-line bg-white p-4"><div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Public address (same string on every network)</div><Mono className="text-[14px]">{w.address}</Mono>
          <div className="mt-2 flex flex-wrap gap-2">{d.chainAccounts.length === 0 ? <span className="text-[12px] text-muted">No chain accounts: registered without networks.</span> : d.chainAccounts.map((c) => <Badge key={c.id} tone="accent">{c.name}</Badge>)}</div></div>
        <Tabs tabs={TABS} value={tab} onChange={setTab} />
        <TabPanel id="balances" value={tab}>
          <p className="mb-3 text-[13px] text-muted">{d.onChainBalanceNote} <PaperLabel /></p>
          {d.chainAccounts.length === 0 ? <EmptyState title="No chain accounts" hint="This wallet was registered without networks, so it cannot hold ledger balances." /> :
            <div className="space-y-5">{d.chainAccounts.map((c) => { const rows = d.balances.filter((b) => b.wallet_chain_account_id === c.id); return (
              <Card key={c.id} title={<span>{c.name} <span className="font-mono text-[11px] text-muted">{c.chain_id}</span></span>}>
                {rows.length === 0 ? <p className="text-[13px] text-muted">No ledger balance on this network.</p> :
                  <DataTable searchable={false} caption={`Balances on ${c.name}`} rows={rows.map((r, i) => ({ ...r, id: String(i) }))} cols={[
                    { key: 'symbol', header: 'Asset' }, { key: 'state', header: 'State', text: (r) => STATE_LABEL[r.state] ?? r.state }, { key: 'bucket', header: 'Held for', text: (r) => bname(r.bucket_id) },
                    { key: 'amount', header: 'Amount (ledger)', align: 'right', sort: (r) => r.amount.padStart(80, '0'), render: (r) => formatUnits(r.amount, r.decimals) }]} />}
              </Card>); })}</div>}
        </TabPanel>
        <TabPanel id="assets" value={tab}>
          <Async q={assets}>{(a) => { const cs = new Set(d.chainAccounts.map((c) => c.chain_id)); const list = a.items.filter((x) => cs.has(x.chain_id));
            return list.length === 0 ? <EmptyState title="No registered assets on this wallet's networks" hint="Assets are identified by chain + contract/mint, never by ticker. Token inventory needs a read adapter." /> :
              <DataTable caption="Assets on this wallet's networks" rows={list} cols={[{ key: 'symbol', header: 'Symbol' }, { key: 'chain_id', header: 'Chain', filter: true }, { key: 'contract', header: 'Contract / mint', render: (r) => <Mono>{r.contract}</Mono> }, { key: 'decimals', header: 'Decimals', align: 'right' },
                { key: 'held', header: 'Ledger balance', align: 'right', text: (r) => formatUnits(d.balances.filter((b) => b.symbol === r.symbol && d.chainAccounts.find((c) => c.id === b.wallet_chain_account_id)?.chain_id === r.chain_id).reduce((s, b) => s + BigInt(b.amount), 0n), r.decimals) }]} />; }}</Async>
        </TabPanel>
        <TabPanel id="permissions" value={tab}>
          <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
            <Card title="Active authorisation scope"><dl className="space-y-2 text-[13px]">
              <div><dt className="font-semibold">Capability</dt><dd><CapabilityBadge cap={w.capability} /></dd></div>
              <div><dt className="font-semibold">Can APEX sign?</dt><dd>{managed ? 'Only via the separate signer service under its own scope.' : 'No. APEX holds no keys for this wallet.'}</dd></div>
              <div><dt className="font-semibold">Withdrawals</dt><dd>Never granted to APEX trading access.</dd></div>
              <div><dt className="font-semibold">Token approvals / allowances</dt><dd className="text-muted">Not listed: needs a certified read adapter.</dd></div></dl>
              <div className="mt-4"><NoKeysNote compact /></div></Card>
            <Card title="Lifecycle"><div className="mb-3"><WalletLifecycle wallet={row} /></div><h3 className="mb-2 text-[13px] font-semibold">Not available yet</h3><DisabledControls /></Card>
          </div>
        </TabPanel>
        <TabPanel id="buckets" value={tab}>
          {d.allocations.length === 0 ? <EmptyState title="Not assigned to any bucket" hint="Assign this wallet from a bucket, or use the wallet wizard on the Wallets page." /> :
            <DataTable searchable={false} caption="Bucket assignments" rows={d.allocations.map((a) => ({ ...a, id: a.bucket_id }))} cols={[
              { key: 'bucket', header: 'Bucket', text: (a) => bname(a.bucket_id), render: (a) => { const b = buckets.data?.items.find((x) => x.id === a.bucket_id); return b ? <Link className="font-semibold text-accent hover:underline" href={`/portfolios/${b.portfolio_id}/buckets/${b.id}`}>{b.name}</Link> : 'bucket'; } },
              { key: 'segregation', header: 'Bucket segregation', render: (a) => { const b = buckets.data?.items.find((x) => x.id === a.bucket_id); return b ? <SegBadge seg={b.segregation} /> : null; }, text: () => '' },
              { key: 'exclusive', header: 'Wallet use', text: (a) => (a.exclusive ? 'exclusive' : 'shared'), render: (a) => <Badge tone={a.exclusive ? 'good' : 'warn'}>{a.exclusive ? 'exclusive (physical)' : `shared, ack ${a.logical_ack ? 'given' : 'missing'}`}</Badge> },
              { key: 'max_allocation_bps', header: 'Max share', align: 'right', render: (a) => `${(a.max_allocation_bps / 100).toFixed(2)}%`, sort: (a) => a.max_allocation_bps },
              { key: 'move', header: 'Action', text: () => '', render: (a) => <Button className="min-h-9" onClick={() => setMv(a.bucket_id)} disabled={w.state === 'archived' || w.state === 'revoked'}>Move…</Button> }]} />}
          {mv && <MoveDialog wallet={row} fromBucket={mv} open onClose={() => setMv(null)} />}
        </TabPanel>
        <TabPanel id="activity" value={tab}>
          <Async q={activity}>{(a: any) => (<div className="space-y-5"><p className="text-[13px] text-muted">{a.note}</p>
            <Card title="Ledger entries">{a.entries.length === 0 ? <p className="text-[13px] text-muted">No ledger activity.</p> : <DataTable searchable={false} caption="Ledger entries" rows={a.entries} cols={[
              { key: 'created_at', header: 'When', render: (e: any) => when(e.created_at), sort: (e: any) => e.created_at }, { key: 'kind', header: 'Kind', filter: true }, { key: 'environment', header: 'Env', filter: true },
              { key: 'legs', header: 'Legs touching this wallet', text: (e: any) => e.legs.map((l: any) => `${l.symbol} ${l.state}`).join(' '), render: (e: any) => <ul>{e.legs.map((l: any, i: number) => <li key={i} className="tabular text-[12px]">{l.symbol} {l.state}: {BigInt(l.amount) > 0n ? '+' : ''}{formatUnits(l.amount, l.decimals)}</li>)}</ul> }]} />}</Card>
            <Card title="Audit trail for this wallet">{a.audit.length === 0 ? <p className="text-[13px] text-muted">No audit events.</p> : <DataTable searchable={false} caption="Wallet audit" rows={a.audit.map((x: any) => ({ ...x, id: String(x.id) }))} cols={[{ key: 'created_at', header: 'When', render: (e: any) => when(e.created_at) }, { key: 'action', header: 'Action' }, { key: 'detail', header: 'Detail', text: (e: any) => JSON.stringify(e.detail) }]} />}</Card></div>)}</Async>
        </TabPanel>
        <TabPanel id="fees" value={tab}>
          <Async q={fees}>{(f: any) => (<div className="space-y-5"><p className="text-[13px] text-muted">{f.note}</p>
            <Card title="Fee reserve held">{f.reserves.length === 0 ? <p className="text-[13px] text-muted">No fee reserve recorded on this wallet.</p> : <DataTable searchable={false} caption="Fee reserves" rows={f.reserves.map((r: any, i: number) => ({ ...r, id: String(i) }))} cols={[{ key: 'chain_id', header: 'Chain' }, { key: 'symbol', header: 'Asset' }, { key: 'amount', header: 'Reserved', align: 'right', render: (r: any) => formatUnits(r.amount, r.decimals) }]} />}</Card>
            <Card title="Transfer fees paid">{f.transferFees.length === 0 ? <p className="text-[13px] text-muted">No transfer fees recorded.</p> : <DataTable searchable={false} caption="Transfer fees" rows={f.transferFees} cols={[{ key: 'created_at', header: 'When', render: (r: any) => when(r.created_at) }, { key: 'kind', header: 'Kind' }, { key: 'status', header: 'Status' }, { key: 'fee', header: 'Fee', align: 'right', render: (r: any) => `${formatUnits(r.fee, r.decimals)} ${r.symbol}` }]} />}</Card></div>)}</Async>
        </TabPanel>
        <TabPanel id="connections" value={tab}>
          <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
            <Card title="Chain accounts">{d.chainAccounts.length === 0 ? <p className="text-[13px] text-muted">None.</p> : <ul className="space-y-2">{d.chainAccounts.map((c) => { const reg = chains.data?.items.find((x) => x.id === c.chain_id); const caps = Object.entries(reg?.capabilities ?? {}); return (
              <li key={c.id} className="rounded-xl border border-line p-3 text-[13px]"><strong>{c.name}</strong> <Mono className="text-muted">{c.chain_id}</Mono><div className="mt-1 text-[12px] text-muted">Registry capability evidence: {caps.length ? caps.map(([k, x]) => `${k} ${x.status}`).join(', ') : 'none recorded'}</div></li>); })}</ul>}</Card>
            <Card title="Provider connection"><EmptyState title="No wallet provider connected" hint="This wallet is registered as a public address. A provider/signer connection (browser wallet, hardware, WalletConnect, KMS) is not part of this release, so there is no session, signature scope or expiry to show." /></Card>
          </div>
        </TabPanel>
      </>);
    }}</Async>
  );
}
export default function WalletDetailPage() { const { id } = useParams<{ id: string }>(); return <NeedWorkspace><Body id={id} /></NeedWorkspace>; }
