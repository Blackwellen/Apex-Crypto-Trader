'use client';
import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Async, Badge, Button, Card, DataTable, Dialog, EmptyState, PageHeader, Select, StackedBar, TextInput, useToast } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { useWs } from '@/components/hooks';
import { useCommand } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { formatUnits } from '@/lib/format';
import { basketOverlaps, chainConcentration, fmtPct, parsePct, rebalancePreview, weightSummary } from '@/lib/capital/basket';
import { AssetSelect, EnvBadge, useActionKey, useAssets, useBuckets } from '@/components/capital/shared';

const COLORS = ['#2758da', '#5e9dac', '#b28c63', '#8c92bb', '#679783', '#c47a7a'];
interface BasketData { baskets: { id: string; name: string; bucket_id: string; bucket_name: string; environment: string; members: { asset: string; symbol: string; decimals: number; chain_id: string; weight_bps: number }[] }[]; holdings: { bucket_id: string; asset: string; symbol: string; decimals: number; amount: string }[]; note: string }

function CreateBasket({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast(); const buckets = useBuckets(), assets = useAssets(); const create = useCommand('createBasket'); const key = useActionKey();
  const [bucket, setBucket] = useState(''); const [name, setName] = useState(''); const [rows, setRows] = useState<{ asset: string; pct: string }[]>([{ asset: '', pct: '' }]);
  const parsed = rows.map((r) => ({ asset: r.asset, bps: parsePct(r.pct) })); const s = weightSummary(parsed);
  const ok = s.canSave && !!bucket && name.trim().length > 0;
  const close = () => { setName(''); setRows([{ asset: '', pct: '' }]); onClose(); };
  const fillRest = (i: number) => setRows(rows.map((r, j) => j === i ? { ...r, pct: ((s.remaining + (parsed[i].bps ?? 0)) / 100).toFixed(2) } : r));
  return (
    <Dialog open={open} onClose={close} title="New basket" footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" disabled={!ok} busy={create.isPending}
      onClick={() => create.mutate({ body: { bucket, name: name.trim(), members: parsed.map((p) => ({ asset: p.asset, weight_bps: p.bps! })) }, key: key.get() }, { onSuccess: () => { toast.push(`Basket "${name.trim()}" created`); key.rotate(); close(); }, onError: (e) => toast.push(e.message, 'bad') })}>Save basket</Button></>}>
      <div className="space-y-4">
        <Select label="Bucket" value={bucket} onChange={(e) => setBucket(e.target.value)} options={[{ value: '', label: buckets.data?.items.length ? 'Choose…' : 'No buckets yet' }, ...(buckets.data?.items ?? []).map((b) => ({ value: b.id, label: `${b.name} (${b.environment})` }))]} />
        <TextInput label="Basket name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        <fieldset><legend className="mb-1 text-[12px] font-semibold text-[#44546a]">Target weights</legend>
          {rows.map((r, i) => (
            <div key={i} className="mb-2 grid gap-2 sm:grid-cols-[1fr_8rem_auto_auto] sm:items-end">
              <AssetSelect label={`Asset ${i + 1}`} assets={assets.data?.items ?? []} value={r.asset} onChange={(v) => setRows(rows.map((x, j) => j === i ? { ...x, asset: v } : x))} filter={(a) => a.id === r.asset || !rows.some((x) => x.asset === a.id)} />
              <TextInput label="Weight %" inputMode="decimal" value={r.pct} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, pct: e.target.value } : x))} error={r.pct && parsed[i].bps === null ? 'Max 2 decimals, 0 to 100' : undefined} />
              <Button onClick={() => fillRest(i)} disabled={s.remaining + (parsed[i].bps ?? 0) <= 0} title="Set this weight to whatever is left">Fill rest</Button>
              <Button aria-label={`Remove asset ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))} disabled={rows.length === 1}><Trash2 className="size-4" aria-hidden /></Button></div>))}
          <Button onClick={() => setRows([...rows, { asset: '', pct: '' }])}><Plus className="size-4" aria-hidden />Add asset</Button></fieldset>
        <div role="status" aria-live="polite" className={`rounded-xl p-3 text-[13px] ${s.remaining === 0 && s.canSave ? 'bg-good-soft text-good' : 'bg-warn-soft text-warn'}`}>
          <p><strong>Total {fmtPct(s.total)}</strong> of 100.00%</p>{s.problems.length > 0 && <ul className="list-disc pl-5">{s.problems.map((p) => <li key={p}>{p}</li>)}</ul>}</div>
      </div>
    </Dialog>
  );
}

export default function BasketsPage() {
  const { canAdmin } = useWorkspace(); const q = useWs<BasketData>('baskets'); const [wiz, setWiz] = useState(false); const [pick, setPick] = useState('');
  const overlaps = useMemo(() => basketOverlaps((q.data?.baskets ?? []).map((b) => ({ id: b.id, name: b.name, members: b.members }))), [q.data]);
  return (
    <NeedWorkspace>
      <PageHeader title="Baskets" description="Target-weight sets of assets inside a bucket. Weights are integer basis points and must total exactly 100%."
        actions={<Button variant="primary" disabled={!canAdmin} title={canAdmin ? undefined : 'Owner or admin role required'} onClick={() => setWiz(true)}><Plus className="size-4" aria-hidden />New basket</Button>} />
      <Async q={q}>{(d) => {
        const sel = d.baskets.find((b) => b.id === pick) ?? d.baskets[0];
        const pv = sel ? rebalancePreview(sel.members, d.holdings.filter((h) => h.bucket_id === sel.bucket_id)) : null;
        return (<>
          <Card title="Baskets">{d.baskets.length === 0 ? <EmptyState title="No baskets yet" hint="Create a basket to define target weights for a bucket." action={canAdmin ? <Button variant="primary" onClick={() => setWiz(true)}>New basket</Button> : undefined} /> :
            <DataTable caption="Baskets" rows={d.baskets} cols={[
              { key: 'name', header: 'Basket', render: (b) => <button className="font-semibold text-accent hover:underline" onClick={() => setPick(b.id)} aria-label={`Preview rebalance for ${b.name}`}>{b.name}</button> },
              { key: 'bucket_name', header: 'Bucket', filter: true }, { key: 'environment', header: 'Env', filter: true, render: (b) => <EnvBadge env={b.environment} /> },
              { key: 'members', header: 'Target weights', text: (b) => b.members.map((m) => m.symbol).join(' '), render: (b) => <div className="min-w-40 space-y-1"><StackedBar parts={b.members.map((m, i) => ({ label: m.symbol, value: m.weight_bps, color: COLORS[i % COLORS.length] }))} /><span className="text-[12px] text-muted">{b.members.map((m) => `${m.symbol} ${fmtPct(m.weight_bps)}`).join(' · ')}</span></div> }]} />}</Card>
          {sel && pv && (
            <Card className="mt-5" title={<span>Rebalancing preview: {sel.name}</span>}>
              <div role="note" className="mb-3 rounded-xl border border-[#f0dfb7] bg-warn-soft p-3 text-[13px] text-warn">{d.note} Treat this as meaningful only when the basket's assets are comparable per unit (for example stablecoins). Nothing here places an order.</div>
              {pv.totalNormalised === 0n ? <EmptyState title="This bucket holds none of the basket's assets" hint="Allocate funds to the bucket first; the preview then compares current units with target weights." /> :
                <DataTable searchable={false} caption={`Rebalance preview for ${sel.name}`} rows={pv.rows.map((r) => ({ ...r, id: r.asset }))} cols={[
                  { key: 'symbol', header: 'Asset' }, { key: 'cur', header: 'Held (ledger units)', align: 'right', render: (r) => formatUnits(r.currentUnits, r.decimals) },
                  { key: 'currentBps', header: 'Current weight', align: 'right', render: (r) => fmtPct(r.currentBps), sort: (r) => r.currentBps }, { key: 'targetBps', header: 'Target', align: 'right', render: (r) => fmtPct(r.targetBps), sort: (r) => r.targetBps },
                  { key: 'driftBps', header: 'Drift', align: 'right', render: (r) => `${r.driftBps > 0 ? '+' : ''}${fmtPct(r.driftBps)}`, sort: (r) => r.driftBps },
                  { key: 'delta', header: 'Units to trade', align: 'right', text: (r) => r.action, render: (r) => <span><Badge tone={r.action === 'buy' ? 'good' : r.action === 'sell' ? 'warn' : 'neutral'}>{r.action}</Badge> {r.action !== 'hold' && formatUnits((r.deltaUnits < 0n ? -r.deltaUnits : r.deltaUnits).toString(), r.decimals)}</span> }]} />}
              {pv.outside.length > 0 && <p className="mt-2 text-[12px] text-muted">Held in the bucket but outside this basket (not rebalanced): {pv.outside.map((o) => `${formatUnits(o.amount, o.decimals)} ${o.symbol}`).join(', ')}.</p>}
            </Card>)}
          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <Card title="Factor overlap">{overlaps.length === 0 ? <p className="text-[13px] text-muted">{d.baskets.length < 2 ? 'Needs at least two baskets to compare.' : 'No asset appears in more than one basket.'}</p> :
              <div role="alert" className="rounded-xl border border-[#f0dfb7] bg-warn-soft p-3 text-[13px] text-warn"><p className="font-semibold">Same asset in several baskets (hidden double exposure)</p><ul className="mt-1 list-disc pl-5">{overlaps.map((o) => <li key={o.asset}>{o.symbol}: {o.baskets.join(', ')}</li>)}</ul></div>}
              <p className="mt-3 text-[12px] text-muted">Return correlation and common-factor exposure are not computed: they need price history and no market-data feed is connected.</p></Card>
            <Card title="Chain concentration">{sel ? <ul className="space-y-1 text-[13px]">{chainConcentration(sel.members).map((c) => <li key={c.chain} className="flex justify-between"><span className="font-mono text-[12px]">{c.chain}</span><span className="tabular">{fmtPct(c.bps)}</span></li>)}</ul> : <p className="text-[13px] text-muted">Select a basket.</p>}
              <p className="mt-3 text-[12px] text-muted">Share of target weight per chain for the selected basket. Capacity and liquidity checks need market depth data, which is not connected.</p></Card>
          </div>
        </>);
      }}</Async>
      <CreateBasket open={wiz} onClose={() => setWiz(false)} />
    </NeedWorkspace>
  );
}
