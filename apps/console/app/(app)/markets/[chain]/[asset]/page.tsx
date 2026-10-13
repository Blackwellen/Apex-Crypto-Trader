'use client';
import Link from 'next/link';
import { use, useState } from 'react';
import { ArrowLeft, ExternalLink, Star } from 'lucide-react';
import { Async, Badge, Button, Card, EmptyState, PageHeader, useToast } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { useWs } from '@/components/hooks';
import { useCommand } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { shortAddr, when } from '@/lib/format';
import { NoFeedNotice, ObservationDialog, StageBadge } from '@/components/markets/common';
import { SecurityGate, emptyGateForm, type GateForm, type GateResult } from '@/components/markets/gate';
import { TradePlanner } from '@/components/markets/planner';

const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

function Body({ chain, contract }: { chain: string; contract: string }) {
  const { current, canWrite } = useWorkspace(); const toast = useToast();
  const q = useWs<any>('market/asset', `&chain=${encodeURIComponent(chain)}&contract=${encodeURIComponent(contract)}`);
  const watch = useCommand('watchAsset'), unwatch = useCommand('unwatchAsset');
  const [obs, setObs] = useState(false);
  const [form, setForm] = useState<GateForm | null>(null); const [gate, setGate] = useState<GateResult | null>(null);
  return (
    <Async q={q}>{(d) => {
      const symbol = d.asset?.symbol ?? d.lifecycle?.symbol ?? d.watch?.symbol ?? '(unnamed)';
      const family = d.chain.family === 'svm' ? 'solana' : 'evm';
      const f = form ?? emptyGateForm(family);
      const watched = !!d.watch;
      const explorer = typeof d.chain.explorer_url === 'string' && /^https:\/\//.test(d.chain.explorer_url) ? d.chain.explorer_url : null;
      return (<>
        <PageHeader title={symbol} description={`${d.chain.name} · ${d.chain.id} · ${shortAddr(contract)}`}
          actions={<>
            <Button onClick={() => (watched ? unwatch : watch).mutate({ body: { workspace: current!.id, chain, contract, ...(watched ? {} : { symbol: symbol === '(unnamed)' ? undefined : symbol }) } }, { onSuccess: () => toast.push(watched ? 'Removed from watchlist' : 'Added to watchlist'), onError: (e) => toast.push(e.message, 'bad') })} disabled={!canWrite} aria-pressed={watched}>
              <Star className={`size-4 ${watched ? 'fill-[#d9a31c] text-[#d9a31c]' : ''}`} aria-hidden />{watched ? 'Watching' : 'Add to watchlist'}</Button>
            <Button onClick={() => setObs(true)} disabled={!canWrite}>Log lifecycle observation</Button></>} />
        <Card title="Canonical identity" className="mb-5">
          <dl className="grid gap-x-6 gap-y-3 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Chain</dt><dd>{d.chain.name} <span className="font-mono text-[12px] text-muted">({d.chain.id})</span></dd></div>
            <div className="sm:col-span-2"><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Contract / mint</dt><dd className="break-all font-mono text-[12px]" data-testid="contract">{contract}</dd></div>
            <div><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Decimals</dt><dd>{d.asset ? d.asset.decimals : 'unknown'}</dd></div>
            <div><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Registry</dt><dd>{d.identity.inRegistry ? <Badge tone="good">In canonical asset registry</Badge> : <Badge tone="warn">Not in registry</Badge>}</dd></div>
            <div><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Lifecycle</dt><dd><StageBadge stage={d.lifecycle?.stage} /></dd></div>
            <div><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Chain status</dt><dd>{d.chain.enabled ? 'Enabled' : 'Not enabled for monitoring/trading'} · {d.chain.finality_model}</dd></div>
            {explorer && <div><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Explorer</dt><dd><a className="inline-flex items-center gap-1 font-semibold text-accent underline" href={explorer} target="_blank" rel="noreferrer noopener">{new URL(explorer).host}<ExternalLink className="size-3" aria-hidden /></a></dd></div>}
          </dl>
          {!d.identity.inRegistry && <p className="mt-3 rounded-lg bg-warn-soft p-3 text-[13px] text-warn">This chain + contract is not in the canonical asset registry. It is known only from your watchlist or lifecycle log, so symbol and decimals are unverified. Check it against the explorer before trusting any copy of its name: same-symbol imitators exist.</p>}
        </Card>

        <NoFeedNotice />
        <div className="mb-5 grid gap-5 xl:grid-cols-3">
          <Card title="Market, pools and holders" className="xl:col-span-2"><EmptyState title="No data connected for pools, order books, holders or transactions" hint="Price, DEX pools, order-book depth, liquidity, largest wallets, wallet graph and recent transactions need a market-data feed and an on-chain indexer. None is connected, so nothing is shown. Enter findings you verified yourself in the security gate below." /></Card>
          <Card title="Lifecycle history" action={<StageBadge stage={d.lifecycle?.stage} />}>
            {d.events.length === 0 ? <EmptyState title="No observations logged" hint="Log what you saw, where and when." /> :
              <ol className="space-y-3 text-[13px]">{d.events.map((e: any) => <li key={e.id} className="border-l-2 border-line pl-3"><div className="font-semibold"><StageBadge stage={e.stage} /> <span className="ml-1 font-normal text-muted">{when(e.observed_at)}</span></div><div className="text-muted">Source: {e.source}{e.evidence_ref ? ` · ${e.evidence_ref}` : ''}</div>{e.note && <div>{e.note}</div>}</li>)}</ol>}
            {d.catalysts.length > 0 && <div className="mt-4"><h3 className="mb-1 text-[12px] font-bold uppercase tracking-wider text-muted">Verified catalysts</h3><ul className="space-y-1 text-[13px]">{d.catalysts.map((c: any) => <li key={c.id}>{c.headline} <span className="text-muted">({c.source_name}, {when(c.published_at)})</span></li>)}</ul></div>}
          </Card>
        </div>

        <div className="space-y-5">
          <SecurityGate form={f} setForm={setForm} result={gate} setResult={setGate} />
          <TradePlanner gate={gate} taxHint={{ buy: f.nums.buy_tax_bps && /^\d+$/.test(f.nums.buy_tax_bps) ? f.nums.buy_tax_bps : undefined, sell: f.nums.sell_tax_bps && /^\d+$/.test(f.nums.sell_tax_bps) ? f.nums.sell_tax_bps : undefined }} />
        </div>
        <ObservationDialog open={obs} onClose={() => setObs(false)} preset={{ chain, contract, symbol: symbol === '(unnamed)' ? '' : symbol }} />
      </>); }}</Async>
  );
}

export default function AssetPage({ params }: { params: Promise<{ chain: string; asset: string }> }) {
  const p = use(params); const chain = dec(p.chain), contract = dec(p.asset);
  return (<NeedWorkspace>
    <Link href="/markets" className="mb-3 inline-flex items-center gap-1 text-[13px] font-semibold text-accent"><ArrowLeft className="size-4" aria-hidden />Markets</Link>
    <Body chain={chain} contract={contract} />
  </NeedWorkspace>);
}
