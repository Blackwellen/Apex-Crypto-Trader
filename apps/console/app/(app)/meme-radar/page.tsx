'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Radar, Star } from 'lucide-react';
import { Async, Badge, Button, Card, DataTable, EmptyState, PageHeader, TabPanel, Tabs, useToast } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { useWs } from '@/components/hooks';
import { useCommand } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { shortAddr, when } from '@/lib/format';
import { NoFeedNotice, ObservationDialog, STAGES, StageBadge, marketHref } from '@/components/markets/common';

type LC = { id: string; chain_id: string; chain_name: string; contract: string; symbol: string; stage: string; stage_observed_at: string; source: string; evidence_ref: string | null; note: string | null; watched: boolean; catalysts: number };
const UNAVAILABLE: [string, string][] = [
  ['New-launch discovery', 'needs a launchpad / pool-creation event stream. Tokens appear here only when you log them.'],
  ['Bonding-curve progress', 'needs a launchpad feed. Progress is never estimated from other numbers.'],
  ['Graduation countdown', 'needs a launchpad feed plus a model of its uncertainty. APEX shows no countdown rather than an invented one.'],
  ['Developer launch history', 'needs an indexer of deployer addresses. Enter a prior-rug count as a security-gate finding on the token page instead.'],
  ['Narrative velocity and smart-wallet clusters', 'need verified social and wallet-label sources. Unverified social posts are not signals (see Intelligence).'],
];

export default function MemeRadar() {
  const { current, canWrite } = useWorkspace(); const toast = useToast();
  const [tab, setTab] = useState('tracked'); const [stage, setStage] = useState(''); const [open, setOpen] = useState(false);
  const lc = useWs<{ items: LC[]; strategies: { key: string; name: string; stage: string; allowed_families: string[] }[] }>('market/lifecycles');
  const wl = useWs<{ items: any[] }>('market/list', '&tab=watchlist');
  const risk = useWs<any>('risk');
  const watch = useCommand('watchAsset'), unwatch = useCommand('unwatchAsset');
  const toggle = (r: { chain_id: string; contract: string; symbol: string; watched: boolean }) => (r.watched ? unwatch : watch).mutate({ body: { workspace: current!.id, chain: r.chain_id, contract: r.contract, ...(r.watched ? {} : { symbol: r.symbol }) } }, { onSuccess: () => toast.push(r.watched ? 'Removed from watchlist' : 'Added to watchlist'), onError: (e: Error) => toast.push(e.message, 'bad') });
  return (
    <NeedWorkspace>
      <PageHeader title="Meme Radar" description="A lifecycle model for new tokens, fed by observations you log. There is no discovery feed, so nothing appears here unless an operator recorded it, and no countdown or progress figure is ever estimated."
        actions={<Button variant="primary" onClick={() => setOpen(true)} disabled={!canWrite}><Radar className="size-4" aria-hidden />Log observation</Button>} />
      <div role="note" className="mb-5 rounded-xl border border-[#bfe6d9] bg-good-soft p-4 text-[13px] text-good"><strong>No auto-buy.</strong> Nothing on this page places an order. Every entry must pass the universal security gate, then strategy admission, then the risk gate.</div>
      <NoFeedNotice />

      <Card title="Token lifecycle state model" className="mb-5">
        <Async q={lc}>{(d) => { const counts = Object.fromEntries(STAGES.map((s) => [s.id, d.items.filter((i) => i.stage === s.id).length]));
          return (<>
            <ol className="grid gap-2 sm:grid-cols-3 lg:grid-cols-9" aria-label="Lifecycle stages in order">{STAGES.map((s, i) => (
              <li key={s.id}><button onClick={() => { setStage(stage === s.id ? '' : s.id); setTab('tracked'); }} aria-pressed={stage === s.id} className={`h-full w-full rounded-xl border p-3 text-left text-[12px] ${stage === s.id ? 'border-accent bg-accent-soft' : 'border-line bg-white hover:bg-[#f9fbfe]'}`}>
                <span className="text-muted">{i + 1}</span><div className="font-semibold">{s.label}</div><div className="tabular text-[20px] font-bold">{counts[s.id]}</div><span className="sr-only"> tokens tracked in this stage</span></button></li>))}</ol>
            <p className="mt-3 text-[12px] text-muted">Order: observed → launchpad → bonding curve → graduating → migrated → early DEX → mature DEX → CEX listed → dormant. Counts are your logged tokens, not a market scan. Late observations are kept in history but never rewind a token&apos;s current stage.</p></>); }}</Async>
      </Card>

      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'tracked', label: 'Tracked tokens' }, { id: 'watchlist', label: 'Watchlist' }, { id: 'eligibility', label: 'Strategy eligibility' }, { id: 'signals', label: 'Signals not available' }]} />
      <TabPanel id="tracked" value={tab}>
        <Card title={stage ? `Tracked tokens: ${STAGES.find((s) => s.id === stage)?.label}` : 'Tracked tokens'} action={stage ? <Button variant="ghost" onClick={() => setStage('')}>Clear stage filter</Button> : undefined}>
          <Async q={lc} empty={(d) => d.items.length === 0}>{(d) => <DataTable caption="Tracked tokens" rows={d.items.filter((i) => !stage || i.stage === stage)} cols={[
            { key: 'symbol', header: 'Symbol', render: (r) => <Link className="font-semibold text-accent underline" href={marketHref(r.chain_id, r.contract)}>{r.symbol}</Link> },
            { key: 'chain_name', header: 'Chain', filter: true }, { key: 'contract', header: 'Contract', render: (r) => <span title={r.contract} className="font-mono text-[12px]">{shortAddr(r.contract)}</span> },
            { key: 'stage', header: 'Stage', filter: true, render: (r) => <StageBadge stage={r.stage} /> },
            { key: 'stage_observed_at', header: 'Observed', render: (r) => when(r.stage_observed_at), sort: (r) => r.stage_observed_at }, { key: 'source', header: 'Source' },
            { key: 'catalysts', header: 'Verified catalysts', align: 'right' },
            { key: 'watched', header: 'Watch', render: (r) => <button aria-label={`${r.watched ? 'Remove' : 'Add'} ${r.symbol} ${r.watched ? 'from' : 'to'} watchlist`} aria-pressed={r.watched} disabled={!canWrite} onClick={() => toggle(r)} className="rounded-lg p-2 hover:bg-[#f0f3f8] disabled:opacity-40"><Star className={`size-4 ${r.watched ? 'fill-[#d9a31c] text-[#d9a31c]' : 'text-muted'}`} aria-hidden /></button>, text: (r) => (r.watched ? 'watched' : '') }]} />}</Async>
          {lc.data?.items.length === 0 && <EmptyState title="No tokens tracked yet" hint="Use “Log observation” to record a token you saw, with its stage, source and time. This is the only way tokens enter the radar." action={<Button variant="primary" onClick={() => setOpen(true)} disabled={!canWrite}>Log observation</Button>} />}
        </Card>
      </TabPanel>
      <TabPanel id="watchlist" value={tab}>
        <Card title="Watchlist"><Async q={wl} empty={(d) => d.items.length === 0}>{(d) => <DataTable caption="Watchlist" rows={d.items.map((r) => ({ ...r, id: r.chain_id + r.contract }))} cols={[
          { key: 'symbol', header: 'Symbol', render: (r) => <Link className="font-semibold text-accent underline" href={marketHref(r.chain_id, r.contract)}>{r.symbol}</Link> }, { key: 'chain_name', header: 'Chain' },
          { key: 'contract', header: 'Contract', render: (r) => <span title={r.contract} className="font-mono text-[12px]">{shortAddr(r.contract)}</span> }, { key: 'stage', header: 'Stage', render: (r) => <StageBadge stage={r.stage} /> }]} />}</Async>
          {wl.data?.items.length === 0 && <EmptyState title="Watchlist is empty" hint="Star a tracked token, or add one from Markets." />}</Card>
      </TabPanel>
      <TabPanel id="eligibility" value={tab}>
        <Card title="Structured strategy eligibility">
          <p className="mb-4 rounded-xl bg-good-soft p-3 text-[13px] font-semibold text-good">No auto-buy; every entry passes the universal security gate + strategy admission + risk gate.</p>
          <ol className="mb-4 space-y-2 text-[13px]">
            <li className="rounded-xl border border-line p-3"><strong>1. Universal security gate</strong> (hard vetoes, unknown fails closed). Evaluated per token on its page: <span className="text-muted">not run from this page.</span></li>
            <li className="rounded-xl border border-line p-3"><strong>2. Strategy admission</strong> (liquidity, position vs exit depth, taxes, net edge after costs). Evaluated with the gate; only runs if stage 1 passes.</li>
            <li className="rounded-xl border border-line p-3"><strong>3. Risk gate</strong> (workspace limits). Current global state: <Async q={risk}>{(r) => <Badge tone={r.settings.global_state === 'active' ? 'good' : 'bad'}>{String(r.settings.global_state).replace(/_/g, ' ')}</Badge>}</Async></li>
          </ol>
          <h3 className="mb-2 text-[12px] font-bold uppercase tracking-wider text-muted">Registered strategies</h3>
          <Async q={lc} empty={(d) => d.strategies.length === 0}>{(d) => <DataTable searchable={false} caption="Registered strategies" rows={d.strategies.map((s) => ({ ...s, id: s.key }))} cols={[{ key: 'key', header: 'Key' }, { key: 'name', header: 'Name' }, { key: 'stage', header: 'Stage', render: (r) => <Badge>{r.stage}</Badge> }, { key: 'allowed_families', header: 'Chain families', text: (r) => (r.allowed_families ?? []).join(', ') }]} />}</Async>
          {lc.data?.strategies.length === 0 && <p className="text-[13px] text-muted">No strategy definitions are registered, so no token is eligible for any strategy.</p>}
        </Card>
      </TabPanel>
      <TabPanel id="signals" value={tab}>
        <Card title="Signals that are not available"><ul className="space-y-3 text-[13px]">{UNAVAILABLE.map(([k, v]) => <li key={k} className="rounded-xl border border-dashed border-line p-3"><div className="mb-1 flex items-center gap-2 font-semibold">{k} <Badge>Not connected</Badge></div><div className="text-muted">{v}</div></li>)}</ul></Card>
      </TabPanel>
      <ObservationDialog open={open} onClose={() => setOpen(false)} />
    </NeedWorkspace>
  );
}
