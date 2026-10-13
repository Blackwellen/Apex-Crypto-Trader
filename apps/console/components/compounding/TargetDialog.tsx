'use client';
import { useState } from 'react';
import { Button, Dialog, Select, TextInput } from '@/components/ui';
import { Note, useAction } from '@/components/ops/common';
import { useApi } from '@/lib/api';
import { parseUnits } from '@/lib/format';
import { pctToBps } from '@/lib/waterfall';

export function TargetDialog({ open, onClose, workspace, buckets }: { open: boolean; onClose: () => void; workspace: string; buckets: { id: string; name: string }[] }) {
  const [bucket, setBucket] = useState(''); const [period, setPeriod] = useState('month'); const [asset, setAsset] = useState('');
  const [amt, setAmt] = useState(''); const [pct, setPct] = useState(''); const [eq, setEq] = useState('');
  const assets = useApi<{ items: any[] }>('v1/assets'); const act = useAction<any>('setCompoundingTarget');
  const list = assets.data?.items ?? []; const a = list.find((x) => x.id === asset) ?? list[0];
  let amtBase: string | undefined, eqBase = '0', err: string | undefined, pctBps: number | undefined;
  try { if (amt.trim()) amtBase = parseUnits(amt, a?.decimals ?? 0); } catch (e) { err = (e as Error).message; }
  try { if (eq.trim()) eqBase = parseUnits(eq, a?.decimals ?? 0); } catch (e) { err = (e as Error).message; }
  if (pct.trim()) { const p = pctToBps(pct); if (p === null) err = 'Percentage: up to 2 decimals'; else pctBps = p; }
  const ok = !!a && !err && (amtBase !== undefined || pctBps !== undefined) && !(pctBps !== undefined && amtBase === undefined && eqBase === '0');
  return (
    <Dialog open={open} onClose={onClose} title="New monitoring target" footer={<><Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!ok} busy={act.busy} onClick={() => act.run({ workspace, ...(bucket ? { bucket } : {}), period, asset: a.id, ...(amtBase !== undefined ? { targetAmount: amtBase } : {}), ...(pctBps !== undefined ? { targetPctBps: pctBps } : {}), startEquity: eqBase },
        { ok: 'Target saved (monitoring only)', onDone: () => { setAmt(''); setPct(''); setEq(''); onClose(); } })}>Save target</Button></>}>
      <div className="space-y-4">
        <Note>A target is <strong>monitoring only</strong>: it never opens, sizes or forces a trade, and missing it is informational. Progress is computed from net realised profit in the ledger, in the reporting asset below.</Note>
        <Select label="Scope" value={bucket} onChange={(e) => setBucket(e.target.value)} options={[{ value: '', label: 'Whole workspace' }, ...buckets.map((b) => ({ value: b.id, label: b.name }))]} />
        <Select label="Period" value={period} onChange={(e) => setPeriod(e.target.value)} options={['day', 'week', 'month', 'quarter', 'year'].map((p) => ({ value: p, label: p }))} />
        <Select label="Reporting asset" value={a?.id ?? ''} onChange={(e) => setAsset(e.target.value)} options={list.map((x) => ({ value: x.id, label: `${x.symbol} (${x.chain_id})` }))} />
        <TextInput label={`Absolute target (${a?.symbol ?? ''})`} value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" hint="Optional if a percentage is given." />
        <TextInput label="Percentage target (% of start equity)" value={pct} onChange={(e) => setPct(e.target.value)} inputMode="decimal" />
        <TextInput label={`Start equity (${a?.symbol ?? ''})`} value={eq} onChange={(e) => setEq(e.target.value)} inputMode="decimal" error={err} hint="Required for a percentage target. Entered by you; not read from a price feed." />
      </div>
    </Dialog>
  );
}
