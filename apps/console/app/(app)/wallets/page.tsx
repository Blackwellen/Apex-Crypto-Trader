'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { LayoutGrid, Plus, Table2 } from 'lucide-react';
import { Async, Badge, Button, Card, DataTable, EmptyState, PageHeader } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { useWorkspace } from '@/lib/workspace';
import { formatUnits, shortAddr } from '@/lib/format';
import { WalletWizard } from '@/components/capital/wallet-wizard';
import { WalletLifecycle } from '@/components/capital/wallet-actions';
import { CapabilityBadge, Mono, NoKeysNote, SegBadge, WalletStateBadge, useBuckets, useWalletAccounts, useWallets, type AcctBalance, type WalletRow } from '@/components/capital/shared';

function useView() {
  const [v, setV] = useState<'cards' | 'table'>('cards');
  useEffect(() => { try { const s = localStorage.getItem('apex.wallets.view'); if (s === 'table' || s === 'cards') setV(s); } catch { /* convenience only */ } }, []);
  return [v, (n: 'cards' | 'table') => { setV(n); try { localStorage.setItem('apex.wallets.view', n); } catch { /* ignore */ } }] as const;
}

function ledgerSummary(wid: string, accts: { id: string; wallet_id: string }[], bal: AcctBalance[]) {
  const ids = new Set(accts.filter((a) => a.wallet_id === wid).map((a) => a.id)); const rows = bal.filter((b) => ids.has(b.wca));
  const syms = [...new Set(rows.map((r) => r.symbol))];
  return syms.map((s) => { const r = rows.filter((x) => x.symbol === s); const dec = r[0].decimals; const f = (st: string[]) => r.filter((x) => st.includes(x.state)).reduce((a, x) => a + BigInt(x.amount), 0n);
    return { symbol: s, pool: formatUnits(r.filter((x) => x.state === 'available' && !x.bucket_id).reduce((a, x) => a + BigInt(x.amount), 0n), dec), inBuckets: formatUnits(r.filter((x) => x.bucket_id && ['available', 'vault'].includes(x.state)).reduce((a, x) => a + BigInt(x.amount), 0n), dec), reserved: formatUnits(f(['reserved', 'pending_out', 'pending_bridge']), dec) }; });
}

export default function WalletsPage() {
  const { canAdmin } = useWorkspace(); const wallets = useWallets(), buckets = useBuckets(), accts = useWalletAccounts(); const [wiz, setWiz] = useState(false); const [view, setView] = useView();
  const bname = useMemo(() => new Map((buckets.data?.items ?? []).map((b) => [b.id, b])), [buckets.data]);
  const exposure = (w: WalletRow) => w.allocations.length === 0 ? <span className="text-muted">Unassigned</span> : <ul className="space-y-1">{w.allocations.map((a) => { const b = bname.get(a.bucket_id); return <li key={a.bucket_id} className="flex flex-wrap items-center gap-1 text-[12px]">{b ? <Link className="font-semibold text-accent hover:underline" href={`/portfolios/${b.portfolio_id}/buckets/${b.id}`}>{b.name}</Link> : 'bucket'} <Badge tone={a.exclusive ? 'good' : 'warn'}>{a.exclusive ? 'exclusive' : 'shared'}</Badge><span className="text-muted">{(a.bps / 100).toFixed(2)}%</span></li>; })}</ul>;
  const led = (w: WalletRow) => { const s = accts.data ? ledgerSummary(w.id, accts.data.accounts, accts.data.balances) : []; return s.length === 0 ? <span className="text-muted">No ledger balance</span> : <ul>{s.map((x) => <li key={x.symbol} className="tabular text-[12px]"><strong>{x.symbol}</strong> pool {x.pool} · in buckets {x.inBuckets}{x.reserved !== '0' ? ` · reserved ${x.reserved}` : ''}</li>)}</ul>; };
  return (
    <NeedWorkspace>
      <PageHeader title="Wallets" description="Public addresses and exchange accounts known to APEX. Balances are the internal ledger (paper or reconciled); on-chain verification is not available until a certified read adapter is connected."
        actions={<>
          <div role="group" aria-label="View" className="flex rounded-xl border border-line bg-white p-0.5">
            <button aria-pressed={view === 'cards'} onClick={() => setView('cards')} className={`inline-flex min-h-9 items-center gap-1 rounded-lg px-3 text-[13px] font-semibold ${view === 'cards' ? 'bg-accent-soft text-accent' : 'text-muted'}`}><LayoutGrid className="size-4" aria-hidden />Cards</button>
            <button aria-pressed={view === 'table'} onClick={() => setView('table')} className={`inline-flex min-h-9 items-center gap-1 rounded-lg px-3 text-[13px] font-semibold ${view === 'table' ? 'bg-accent-soft text-accent' : 'text-muted'}`}><Table2 className="size-4" aria-hidden />Table</button></div>
          <Button variant="primary" onClick={() => setWiz(true)} disabled={!canAdmin} title={canAdmin ? undefined : 'Owner or admin role required'}><Plus className="size-4" aria-hidden />Connect wallet</Button></>} />
      <div className="mb-5"><NoKeysNote compact /></div>
      <Async q={wallets}>{(d) => d.items.length === 0
        ? <Card><EmptyState title="No wallets connected" hint="Register a public address (watch-only is safest) to start. APEX never asks for keys." action={canAdmin ? <Button variant="primary" onClick={() => setWiz(true)}>Connect wallet</Button> : undefined} /></Card>
        : view === 'table'
          ? <Card pad><DataTable caption="Wallets" rows={d.items} cols={[
            { key: 'nickname', header: 'Wallet', render: (w) => <Link className="font-semibold text-accent hover:underline" href={`/wallets/${w.id}`}>{w.nickname}</Link> },
            { key: 'family', header: 'Family', filter: true },
            { key: 'address', header: 'Address', render: (w) => <Mono title={w.address}>{shortAddr(w.address)}</Mono>, text: (w) => w.address },
            { key: 'capability', header: 'Capability', filter: true, render: (w) => <CapabilityBadge cap={w.capability} /> },
            { key: 'state', header: 'State', filter: true, render: (w) => <WalletStateBadge state={w.state} /> },
            { key: 'chains', header: 'Chains', text: (w) => w.chains.join(', ') || 'none' },
            { key: 'exposure', header: 'Exposure by bucket', text: (w) => w.allocations.map((a) => bname.get(a.bucket_id)?.name ?? '').join(' '), render: exposure },
            { key: 'ledger', header: 'Ledger balances', text: () => '', render: led },
          ]} /></Card>
          : <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Wallet cards">{d.items.map((w) => (
            <li key={w.id}><Card className="h-full" pad>
              <div className="flex items-start justify-between gap-2"><div className="min-w-0"><h2 className="truncate text-[16px] font-semibold"><Link href={`/wallets/${w.id}`} className="hover:underline">{w.nickname}</Link></h2><Mono className="text-muted">{shortAddr(w.address)}</Mono></div><WalletStateBadge state={w.state} /></div>
              <div className="mt-3 flex flex-wrap gap-1"><Badge>{w.family}</Badge><CapabilityBadge cap={w.capability} />{w.capability === 'watch_only' && <Badge tone="good" title="APEX cannot sign or move funds from this wallet">cannot sign</Badge>}</div>
              <dl className="mt-3 space-y-2 text-[13px]">
                <div><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Networks</dt><dd>{w.chains.length ? w.chains.join(', ') : 'No chain accounts'}</dd></div>
                <div><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Exposure by bucket</dt><dd>{exposure(w)}</dd></div>
                <div><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Ledger balances (not on-chain)</dt><dd>{led(w)}</dd></div>
                <div><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Approvals, gas left, pending tx</dt><dd className="text-muted">Not measured: no read adapter</dd></div>
              </dl>
              <div className="mt-3"><WalletLifecycle wallet={w} compact /></div>
            </Card></li>))}</ul>}</Async>
      <WalletWizard open={wiz} onClose={() => setWiz(false)} />
    </NeedWorkspace>
  );
}
