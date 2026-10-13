'use client';
import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { LayoutGrid, Plus, Star, Table2, Trash2 } from 'lucide-react';
import { Async, Badge, Button, Card, DataTable, Dialog, EmptyState, PageHeader, Select, TabPanel, Tabs, TextInput, useToast } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { useWs } from '@/components/hooks';
import { useCommand } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { shortAddr } from '@/lib/format';
import { CONTRACT_RE, NoFeedNotice, STAGES, StageBadge, marketHref, useChains } from '@/components/markets/common';

const TABS = [{ id: 'all', label: 'All assets' }, { id: 'cex', label: 'CEX' }, { id: 'dex', label: 'DEX' }, { id: 'launches', label: 'Launches' }, { id: 'graduated', label: 'Graduated' }, { id: 'watchlist', label: 'Watchlist' }];
const TAB_HELP: Record<string, string> = {
  all: 'Every identity known to the canonical registry, your watchlist or your lifecycle log.', cex: 'Assets on centralised-venue entries in the chain registry, or tokens you logged as CEX listed.',
  dex: 'On-chain tokens with no launch-phase stage logged, or logged as migrated / early DEX / mature DEX.', launches: 'Tokens you logged as observed, on a launchpad, on a bonding curve or graduating.',
  graduated: 'Tokens you logged as migrated, on a DEX or CEX listed.', watchlist: 'Tokens on your persisted watchlist.',
};
type Item = { chain_id: string; contract: string; symbol: string; decimals: number | null; in_registry: boolean; chain_name: string; family: string; stage: string | null; watched: boolean };
type View = { id: string; name: string; filters: { tab?: string; q?: string; chain?: string; stage?: string } };

function Explorer() {
  const sp = useSearchParams(); const { current, canWrite } = useWorkspace(); const toast = useToast();
  const [tab, setTab] = useState('all'); const [q, setQ] = useState(sp.get('q') ?? ''); const [dq, setDq] = useState(q); const [chain, setChain] = useState(''); const [stage, setStage] = useState('');
  const [mode, setMode] = useState<'table' | 'cards'>('table'); const [saveOpen, setSaveOpen] = useState(false); const [addOpen, setAddOpen] = useState(false); const [viewName, setViewName] = useState('');
  const [add, setAdd] = useState({ chain: '', contract: '', symbol: '' });
  useEffect(() => { const t = setTimeout(() => setDq(q), 250); return () => clearTimeout(t); }, [q]);
  const chains = useChains();
  const qs = `&tab=${tab}&q=${encodeURIComponent(dq.trim())}&chain=${encodeURIComponent(chain)}${stage ? `&stage=${stage}` : ''}`;
  const list = useWs<{ items: Item[]; total: number }>('market/list', qs);
  const views = useWs<{ items: View[] }>('market/views', '&page=markets');
  const watch = useCommand('watchAsset'), unwatch = useCommand('unwatchAsset'), saveView = useCommand('saveMarketView'), delView = useCommand('deleteMarketView');
  const err = (e: Error) => toast.push(e.message, 'bad');
  const toggle = (r: Item) => (r.watched ? unwatch : watch).mutate({ body: { workspace: current!.id, chain: r.chain_id, contract: r.contract, ...(r.watched ? {} : { symbol: r.symbol === '(unnamed)' ? undefined : r.symbol }) } }, { onSuccess: () => toast.push(r.watched ? 'Removed from watchlist' : 'Added to watchlist'), onError: err });
  const applyView = (id: string) => { const v = views.data?.items.find((x) => x.id === id); if (!v) return; setTab(v.filters.tab ?? 'all'); setQ(v.filters.q ?? ''); setDq(v.filters.q ?? ''); setChain(v.filters.chain ?? ''); setStage(v.filters.stage ?? ''); toast.push(`Applied view "${v.name}"`); };
  const chainOpts = [{ value: '', label: 'All chains' }, ...(chains.data?.items ?? []).map((c) => ({ value: c.id, label: c.name }))];
  const filters = { ...(tab !== 'all' ? { tab } : {}), ...(q.trim() ? { q: q.trim() } : {}), ...(chain ? { chain } : {}), ...(stage ? { stage } : {}) };
  return (<>
    <NoFeedNotice />
    <Tabs tabs={TABS} value={tab} onChange={setTab} />
    <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
    <p className="-mt-2 mb-4 text-[12px] text-muted" id="tab-help">{TAB_HELP[tab]}</p>
    <Card pad>
      <div className="mb-4 grid gap-3 lg:grid-cols-[1fr_200px_200px]">
        <div><label htmlFor="mkt-q" className="mb-1 block text-[12px] font-semibold text-[#44546a]">Search symbol, chain, contract or BASE/QUOTE pair</label>
          <input id="mkt-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. USDC, eip155:1, 0xa0b8…, ETH/USDC" className="min-h-10 w-full rounded-xl border border-line px-3 text-[14px]" aria-describedby="tab-help" /></div>
        <Select label="Native chain" value={chain} onChange={(e) => setChain(e.target.value)} options={chainOpts} />
        <Select label="Lifecycle stage" value={stage} onChange={(e) => setStage(e.target.value)} options={[{ value: '', label: 'Any stage' }, ...STAGES.map((s) => ({ value: s.id, label: s.label }))]} />
      </div>
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <div className="min-w-[200px]"><Select label="Saved views" value="" onChange={(e) => applyView(e.target.value)} options={[{ value: '', label: views.data?.items.length ? 'Choose a saved view…' : 'No saved views yet' }, ...(views.data?.items ?? []).map((v) => ({ value: v.id, label: v.name }))]} /></div>
        <Button onClick={() => { setViewName(''); setSaveOpen(true); }} disabled={!canWrite}>Save current filters</Button>
        <Button onClick={() => setAddOpen(true)} disabled={!canWrite}><Plus className="size-4" aria-hidden />Add token to watchlist</Button>
        <div className="ml-auto flex gap-1" role="group" aria-label="Display mode">
          <Button variant={mode === 'table' ? 'primary' : 'secondary'} onClick={() => setMode('table')} aria-pressed={mode === 'table'}><Table2 className="size-4" aria-hidden />Table</Button>
          <Button variant={mode === 'cards' ? 'primary' : 'secondary'} onClick={() => setMode('cards')} aria-pressed={mode === 'cards'}><LayoutGrid className="size-4" aria-hidden />Cards</Button></div>
      </div>
      {(views.data?.items.length ?? 0) > 0 && <ul className="mb-4 flex flex-wrap gap-2" aria-label="Saved view shortcuts">{views.data!.items.map((v) => <li key={v.id} className="flex items-center gap-1 rounded-full bg-[#eef1f6] py-1 pl-3 pr-1 text-[12px]"><button className="font-semibold" onClick={() => applyView(v.id)}>{v.name}</button>
        <button aria-label={`Delete saved view ${v.name}`} disabled={!canWrite} className="rounded-full p-1 hover:bg-white" onClick={() => delView.mutate({ body: { view: v.id } }, { onSuccess: () => toast.push('View deleted'), onError: err })}><Trash2 className="size-3.5" aria-hidden /></button></li>)}</ul>}
      <Async q={list}>{(d) => d.items.length === 0
        ? <EmptyState title={d.total === 0 ? 'No tokens known yet' : 'No tokens match these filters'} hint={d.total === 0 ? 'The canonical registry is empty and you have not added any token. Add a token to your watchlist or log a lifecycle observation on the Meme Radar.' : 'Clear the search or filters, or switch tab.'} />
        : mode === 'table'
          ? <DataTable caption="Markets" searchable={false} rows={d.items.map((r) => ({ ...r, id: `${r.chain_id}|${r.contract}` }))} cols={[
              { key: 'watched', header: 'Watch', render: (r) => <button aria-label={`${r.watched ? 'Remove' : 'Add'} ${r.symbol} ${r.watched ? 'from' : 'to'} watchlist`} aria-pressed={r.watched} disabled={!canWrite} onClick={() => toggle(r)} className="rounded-lg p-2 hover:bg-[#f0f3f8] disabled:opacity-40"><Star className={`size-4 ${r.watched ? 'fill-[#d9a31c] text-[#d9a31c]' : 'text-muted'}`} aria-hidden /></button>, text: (r) => (r.watched ? 'watched' : '') , sort: (r) => (r.watched ? 0 : 1) },
              { key: 'symbol', header: 'Symbol', render: (r) => <Link className="font-semibold text-accent underline" href={marketHref(r.chain_id, r.contract)}>{r.symbol}</Link> },
              { key: 'chain_name', header: 'Chain', render: (r) => <span>{r.chain_name}<br /><span className="font-mono text-[11px] text-muted">{r.chain_id}</span></span>, text: (r) => `${r.chain_name} ${r.chain_id}` },
              { key: 'contract', header: 'Contract', render: (r) => <span title={r.contract} className="font-mono text-[12px]">{shortAddr(r.contract)}</span> },
              { key: 'stage', header: 'Lifecycle', render: (r) => <StageBadge stage={r.stage} />, text: (r) => r.stage ?? '' },
              { key: 'in_registry', header: 'Identity', render: (r) => (r.in_registry ? <Badge tone="good">Registry</Badge> : <Badge tone="warn" title="Not in the canonical asset registry; identity is whatever you logged">Unregistered</Badge>), text: (r) => (r.in_registry ? 'registry' : 'unregistered') },
            ]} />
          : <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{d.items.map((r) => <li key={r.chain_id + r.contract} className="rounded-2xl border border-line p-4">
              <div className="flex items-start justify-between gap-2"><Link className="text-[16px] font-bold text-accent underline" href={marketHref(r.chain_id, r.contract)}>{r.symbol}</Link>
                <button aria-label={`${r.watched ? 'Remove' : 'Add'} ${r.symbol} ${r.watched ? 'from' : 'to'} watchlist`} aria-pressed={r.watched} disabled={!canWrite} onClick={() => toggle(r)} className="rounded-lg p-2 hover:bg-[#f0f3f8] disabled:opacity-40"><Star className={`size-4 ${r.watched ? 'fill-[#d9a31c] text-[#d9a31c]' : 'text-muted'}`} aria-hidden /></button></div>
              <div className="text-[12px] text-muted">{r.chain_name} · <span className="font-mono">{shortAddr(r.contract)}</span></div>
              <div className="mt-2 flex flex-wrap gap-2"><StageBadge stage={r.stage} />{r.in_registry ? <Badge tone="good">Registry</Badge> : <Badge tone="warn">Unregistered</Badge>}</div>
              <div className="mt-2 text-[12px] text-muted">Price: no feed connected</div></li>)}</ul>}</Async>
    </Card>
    </div>
    <Dialog open={saveOpen} onClose={() => setSaveOpen(false)} title="Save current filters" footer={<><Button onClick={() => setSaveOpen(false)}>Cancel</Button>
      <Button variant="primary" disabled={!viewName.trim()} busy={saveView.isPending} onClick={() => saveView.mutate({ body: { workspace: current!.id, page: 'markets', name: viewName.trim(), filters } }, { onSuccess: () => { toast.push('View saved'); setSaveOpen(false); }, onError: err })}>Save view</Button></>}>
      <div className="space-y-3"><TextInput label="View name" value={viewName} onChange={(e) => setViewName(e.target.value)} maxLength={80} /><p className="text-[13px] text-muted">Saves: tab <strong>{tab}</strong>, search “{q.trim() || '—'}”, chain {chain || 'any'}, stage {stage || 'any'}. Views are stored in your workspace and shared with its members.</p></div>
    </Dialog>
    <Dialog open={addOpen} onClose={() => setAddOpen(false)} title="Add token to watchlist" footer={<><Button onClick={() => setAddOpen(false)}>Cancel</Button>
      <Button variant="primary" busy={watch.isPending} disabled={!CONTRACT_RE.test(add.contract.trim())} onClick={() => watch.mutate({ body: { workspace: current!.id, chain: add.chain || chains.data?.items[0]?.id, contract: add.contract.trim(), ...(add.symbol.trim() ? { symbol: add.symbol.trim() } : {}) } }, { onSuccess: () => { toast.push('Added to watchlist'); setAddOpen(false); setAdd({ chain: '', contract: '', symbol: '' }); }, onError: err })}>Add to watchlist</Button></>}>
      <div className="space-y-3"><p className="text-[13px] text-muted">Identity is chain + contract/mint. A same-symbol imitator on another contract is a different token.</p>
        <Select label="Chain" value={add.chain || chains.data?.items[0]?.id || ''} onChange={(e) => setAdd({ ...add, chain: e.target.value })} options={chainOpts.slice(1)} />
        <TextInput label="Contract / mint address" value={add.contract} onChange={(e) => setAdd({ ...add, contract: e.target.value })} maxLength={128} autoComplete="off" />
        <TextInput label="Symbol (optional)" value={add.symbol} onChange={(e) => setAdd({ ...add, symbol: e.target.value })} maxLength={40} /></div>
    </Dialog>
  </>);
}

export default function MarketsPage() {
  return (<NeedWorkspace>
    <PageHeader title="Market Explorer" description="Token identities by canonical chain + contract, with your watchlist, saved views and lifecycle log. No quotes are shown because no feed is connected." />
    <Suspense fallback={null}><Explorer /></Suspense>
  </NeedWorkspace>);
}
