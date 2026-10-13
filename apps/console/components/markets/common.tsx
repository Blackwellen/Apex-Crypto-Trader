'use client';
import { useState } from 'react';
import { Badge, Button, Dialog, Select, TextInput, useToast } from '@/components/ui';
import { useApi, useCommand } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';

export const STAGES = [
  { id: 'observed', label: 'Observed' }, { id: 'launchpad', label: 'Launchpad' }, { id: 'bonding_curve', label: 'Bonding curve' }, { id: 'graduating', label: 'Graduating' },
  { id: 'migrated', label: 'Migrated' }, { id: 'early_dex', label: 'Early DEX' }, { id: 'mature_dex', label: 'Mature DEX' }, { id: 'cex_listed', label: 'CEX listed' }, { id: 'dormant', label: 'Dormant' },
] as const;
export const stageLabel = (s?: string | null) => STAGES.find((x) => x.id === s)?.label ?? 'No lifecycle logged';
export const stageTone = (s?: string | null): 'neutral' | 'accent' | 'good' | 'warn' | 'bad' => (!s ? 'neutral' : s === 'dormant' ? 'bad' : ['launchpad', 'bonding_curve', 'graduating', 'observed'].includes(s) ? 'warn' : 'good');
export const StageBadge = ({ stage }: { stage?: string | null }) => <Badge tone={stageTone(stage)}>{stageLabel(stage)}</Badge>;

export interface ChainRow { id: string; name: string; family: string; native_symbol: string; enabled: boolean; explorer_url: string | null; address_format: string; finality_model: string }
export const useChains = () => useApi<{ items: ChainRow[] }>('v1/market/chains', { refetchInterval: false as any });

export const CONTRACT_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const marketHref = (chain: string, contract: string) => `/markets/${encodeURIComponent(chain)}/${encodeURIComponent(contract)}`;

/** Why there are no quotes, and exactly how to get them. Shown instead of any price column. */
export function NoFeedNotice() {
  return (
    <div role="note" className="mb-5 rounded-xl border border-[#f0dfb7] bg-warn-soft p-4 text-[13px] text-warn" data-testid="no-feed">
      <div className="mb-1 flex items-center gap-2"><Badge tone="warn">No market data feed connected</Badge></div>
      <p>APEX shows no prices, volumes, market caps or pool depth because no feed is connected. Rows below are token identities from the canonical registry, your watchlist and the lifecycle observations you logged.</p>
      <details className="mt-2"><summary className="cursor-pointer font-semibold">How to connect market data</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li><strong>CEX quotes (Coinbase public market data):</strong> run a market-data worker that uses the <code>CoinbasePublicVenue</code> adapter in <code>packages/exchange-adapters</code> (public REST/WebSocket endpoints, no API key, rate-limited). The worker that persists ticks and exposes them to this page is not built yet.</li>
          <li><strong>DEX pools and new pairs:</strong> add a DEX indexer adapter (pool-creation events or a trusted indexer API). Vendor data is additive evidence only and must carry its timestamp so stale data is shown as stale.</li>
          <li>Until a feed exists, quotes stay absent. Nothing on this page is delayed, cached or estimated.</li>
        </ol></details>
    </div>
  );
}

/** Operator command: log a manual lifecycle observation (the real data model behind the Meme Radar). */
export function ObservationDialog({ open, onClose, preset }: { open: boolean; onClose: () => void; preset?: { chain?: string; contract?: string; symbol?: string } }) {
  const { current, canWrite } = useWorkspace(); const toast = useToast(); const chains = useChains(); const log = useCommand('logTokenObservation');
  const [v, setV] = useState({ chain: preset?.chain ?? '', contract: preset?.contract ?? '', symbol: preset?.symbol ?? '', stage: 'observed', at: '', source: '', evidence: '', note: '' });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  const chain = v.chain || chains.data?.items[0]?.id || '';
  const errs = [!CONTRACT_RE.test(v.contract.trim()) && v.contract ? 'Contract/mint may contain only letters, digits and . _ : -' : '', v.at && Number.isNaN(Date.parse(v.at)) ? 'Observation time is not valid' : '', v.at && Date.parse(v.at) > Date.now() + 300_000 ? 'Observation time cannot be in the future' : ''].filter(Boolean);
  const ready = !!current && canWrite && chain && CONTRACT_RE.test(v.contract.trim()) && v.symbol.trim() && v.at && v.source.trim().length >= 2 && errs.length === 0;
  return (
    <Dialog open={open} onClose={onClose} title="Log a lifecycle observation" footer={<><Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!ready} busy={log.isPending} onClick={() => log.mutate({ body: { workspace: current!.id, chain, contract: v.contract.trim(), symbol: v.symbol.trim(), stage: v.stage, observedAt: new Date(v.at).toISOString(), source: v.source.trim(), ...(v.evidence.trim() ? { evidenceRef: v.evidence.trim() } : {}), ...(v.note.trim() ? { note: v.note.trim() } : {}) } },
        { onSuccess: (r: any) => { toast.push(r.result.appliedAsCurrent ? 'Observation recorded' : 'Recorded in history (older than the current stage, so the current stage is unchanged)'); onClose(); }, onError: (e) => toast.push(e.message, 'bad') })}>Record observation</Button></>}>
      <div className="space-y-3">
        <p className="text-[13px] text-muted">This is an operator log, not a feed. Record only what you actually saw, where you saw it and when. Nothing here triggers a trade.</p>
        <Select label="Chain" value={chain} onChange={set('chain')} options={(chains.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.id})` }))} />
        <TextInput label="Contract / mint address" value={v.contract} onChange={set('contract')} maxLength={128} autoComplete="off" />
        <TextInput label="Symbol" value={v.symbol} onChange={set('symbol')} maxLength={40} />
        <Select label="Stage observed" value={v.stage} onChange={set('stage')} options={STAGES.map((s) => ({ value: s.id, label: s.label }))} />
        <TextInput label="Observed at" type="datetime-local" value={v.at} onChange={set('at')} hint="When you saw this stage (your local time)." />
        <TextInput label="Source" value={v.source} onChange={set('source')} maxLength={200} hint="e.g. 'launchpad UI', 'explorer: create tx', 'exchange listing notice'." />
        <TextInput label="Evidence link / tx hash (optional)" value={v.evidence} onChange={set('evidence')} maxLength={500} />
        <TextInput label="Note (optional)" value={v.note} onChange={set('note')} maxLength={500} />
        {errs.length > 0 && <ul role="alert" className="list-disc pl-5 text-[13px] text-bad">{errs.map((e) => <li key={e}>{e}</li>)}</ul>}
        {!canWrite && <p className="text-[13px] text-bad">Your role is read-only.</p>}
      </div>
    </Dialog>
  );
}
