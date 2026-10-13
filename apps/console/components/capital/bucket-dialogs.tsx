'use client';
import { useMemo, useState } from 'react';
import { Badge, Button, Dialog, Select, TextInput, useToast } from '@/components/ui';
import { useCommand } from '@/lib/api';
import { useWs } from '@/components/hooks';
import { useWorkspace } from '@/lib/workspace';
import { formatUnits } from '@/lib/format';
import { fmtPct, parsePct } from '@/lib/capital/basket';
import { AmountInput, AssetSelect, PaperLabel, SegBadge, amountToBase, useActionKey, useAssets, useBuckets, useWalletAccounts, useWallets, type BucketRow } from './shared';

/** PAPER ledger funding: deposit into a wallet pool, or allocate a wallet pool balance into this bucket. */
export function PaperFundDialog({ bucket, mode, onClose }: { bucket: BucketRow; mode: 'deposit' | 'allocate' | null; onClose: () => void }) {
  const { current } = useWorkspace(); const toast = useToast(); const accts = useWalletAccounts(), assets = useAssets(), wallets = useWallets();
  const dep = useCommand('paperDeposit'), alloc = useCommand('allocate'); const key = useActionKey();
  const [wca, setWca] = useState(''); const [asset, setAsset] = useState(''); const [amt, setAmt] = useState('');
  const assignedWallets = new Set((wallets.data?.items ?? []).filter((w) => w.state === 'active' && w.allocations.some((a) => a.bucket_id === bucket.id)).map((w) => w.id));
  const myAccts = (accts.data?.accounts ?? []).filter((a) => assignedWallets.has(a.wallet_id));
  const acct = myAccts.find((a) => a.id === wca); const a = assets.data?.items.find((x) => x.id === asset);
  const pool = useMemo(() => accts.data?.balances.filter((b) => b.wca === wca && b.asset === asset && b.state === 'available' && !b.bucket_id && b.environment === 'paper').reduce((s, b) => s + BigInt(b.amount), 0n) ?? 0n, [accts.data, wca, asset]);
  const base = amountToBase(amt, a?.decimals ?? null);
  const ok = !!current && !!wca && !!asset && !!base && (mode === 'deposit' || BigInt(base) <= pool);
  const close = () => { setAmt(''); onClose(); };
  const m = mode === 'deposit' ? dep : alloc;
  const submit = () => m.mutate({ body: mode === 'deposit' ? { workspace: current!.id, walletChainAccount: wca, asset, amount: base! } : { workspace: current!.id, bucket: bucket.id, walletChainAccount: wca, asset, amount: base! }, key: key.get() } as any, {
    onSuccess: () => { toast.push(mode === 'deposit' ? `PAPER deposit of ${amt} ${a?.symbol} recorded` : `Allocated ${amt} ${a?.symbol} to ${bucket.name}`); key.rotate(); close(); }, onError: (e) => toast.push(e.message, 'bad') });
  return (
    <Dialog open={!!mode} onClose={close} title={mode === 'deposit' ? 'PAPER deposit into a wallet' : `Allocate to ${bucket.name}`} footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" disabled={!ok} busy={m.isPending} onClick={submit}>{mode === 'deposit' ? 'Record PAPER deposit' : 'Allocate'}</Button></>}>
      <div className="space-y-4">
        <div className="rounded-xl border border-[#f0dfb7] bg-warn-soft p-3 text-[13px] text-warn"><PaperLabel /> <p className="mt-1">{mode === 'deposit' ? 'This credits the simulated PAPER ledger for this wallet account. No on-chain transaction happens and no real funds move.' : 'This moves PAPER ledger value from the wallet pool into this bucket. It is an accounting allocation, not an on-chain transfer.'}</p></div>
        {bucket.environment !== 'paper' ? <p role="alert" className="text-[13px] text-bad">This is a live bucket. Live ledger funding is performed by the reconciliation service only and is not available here.</p> : myAccts.length === 0
          ? <p role="alert" className="text-[13px] text-bad">No active wallet with a chain account is assigned to this bucket. Assign a wallet (with at least one network) first.</p> : (<>
          <Select label="Wallet account (wallet · network)" value={wca} onChange={(e) => { setWca(e.target.value); setAsset(''); }} options={[{ value: '', label: 'Choose…' }, ...myAccts.map((x) => ({ value: x.id, label: `${x.nickname} · ${x.chain_name}` }))]} />
          <AssetSelect label="Asset" assets={assets.data?.items ?? []} value={asset} onChange={setAsset} filter={(x) => !acct || x.chain_id === acct.chain_id} />
          {mode === 'allocate' && asset && wca && <p className="text-[13px]">Wallet pool available to allocate: <strong className="tabular">{formatUnits(pool, a?.decimals ?? 0)} {a?.symbol}</strong></p>}
          <AmountInput label="Amount" symbol={a?.symbol} decimals={a?.decimals ?? null} value={amt} onChange={setAmt} max={mode === 'allocate' ? pool : undefined} />
        </>)}
      </div>
    </Dialog>
  );
}

export function BudgetDialog({ bucket, open, onClose }: { bucket: BucketRow; open: boolean; onClose: () => void }) {
  const toast = useToast(); const strategies = useWs<{ items: { key: string; stage: string }[] }>('strategies'); const assets = useAssets(); const cmd = useCommand('setStrategyBudget');
  const [strategy, setStrategy] = useState(''); const [asset, setAsset] = useState(''); const [limit, setLimit] = useState('');
  const a = assets.data?.items.find((x) => x.id === asset); const base = amountToBase(limit, a?.decimals ?? null); const keys = [...new Set((strategies.data?.items ?? []).map((s) => s.key))];
  const close = () => { setLimit(''); onClose(); };
  return (
    <Dialog open={open} onClose={close} title={`Strategy budget: ${bucket.name}`} footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" disabled={!strategy || !asset || !base} busy={cmd.isPending}
      onClick={() => cmd.mutate({ body: { bucket: bucket.id, strategy, asset, limit: base! } }, { onSuccess: () => { toast.push('Budget saved'); close(); }, onError: (e) => toast.push(e.message, 'bad') })}>Save budget</Button></>}>
      <div className="space-y-4"><p className="text-[13px] text-muted">A budget caps how much of one asset a strategy may reserve from this bucket. Saving an existing strategy/asset budget updates its limit (it cannot go below what is already reserved).</p>
        <Select label="Strategy" value={strategy} onChange={(e) => setStrategy(e.target.value)} options={[{ value: '', label: keys.length ? 'Choose…' : 'No strategies registered' }, ...keys.map((k) => ({ value: k, label: k }))]} />
        <AssetSelect label="Asset" assets={assets.data?.items ?? []} value={asset} onChange={setAsset} />
        <AmountInput label="Budget limit" symbol={a?.symbol} decimals={a?.decimals ?? null} value={limit} onChange={setLimit} /></div>
    </Dialog>
  );
}

export function WaterfallDialog({ bucket, open, onClose }: { bucket: BucketRow; open: boolean; onClose: () => void }) {
  const toast = useToast(); const cmd = useCommand('applyWaterfallPolicy'); const buckets = useBuckets(), wallets = useWallets(), accts = useWalletAccounts();
  const [f, setF] = useState({ mode: 'proportional', reinvest: '100', vault: '0', cross: '0', reserve: '0', tax: '0', vb: '', vw: '', cb: '', cw: '' });
  const p = { reinvest: parsePct(f.reinvest), vault: parsePct(f.vault), cross: parsePct(f.cross), reserve: parsePct(f.reserve), tax: parsePct(f.tax) };
  const total = (p.reinvest ?? 0) + (p.vault ?? 0) + (p.cross ?? 0) + (p.reserve ?? 0);
  const all = (buckets.data?.items ?? []).filter((b) => b.portfolio_id === bucket.portfolio_id && b.id !== bucket.id);
  const acctsFor = (bid: string) => { const ws = new Set((wallets.data?.items ?? []).filter((w) => w.allocations.some((a) => a.bucket_id === bid)).map((w) => w.id)); return (accts.data?.accounts ?? []).filter((a) => ws.has(a.wallet_id)); };
  const problems: string[] = [];
  if (Object.values(p).some((x) => x === null)) problems.push('Enter every percentage with at most 2 decimals');
  if (total !== 10000) problems.push(`Reinvest + vault + cross-bucket + reserve must total 100% (now ${fmtPct(total)})`);
  if ((p.vault ?? 0) > 0 && !(f.vb && f.vw)) problems.push('Choose a vault bucket and wallet account');
  if ((p.cross ?? 0) > 0 && !(f.cb && f.cw)) problems.push('Choose a destination bucket and wallet account');
  const noApply = bucket.kind === 'protected_vault' || bucket.kind === 'gas_reserve';
  const close = () => onClose();
  return (
    <Dialog open={open} onClose={close} title={`Compounding waterfall: ${bucket.name}`} footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" disabled={problems.length > 0 || noApply} busy={cmd.isPending}
      onClick={() => cmd.mutate({ body: { bucket: bucket.id, mode: f.mode, reinvestBps: p.reinvest!, vaultBps: p.vault!, crossBucketBps: p.cross!, reserveBps: p.reserve!, taxProvisionBps: p.tax!, ...((p.vault ?? 0) > 0 ? { vaultBucket: f.vb, vaultWalletChainAccount: f.vw } : {}), ...((p.cross ?? 0) > 0 ? { crossBucket: f.cb, crossWalletChainAccount: f.cw } : {}) } }, { onSuccess: () => { toast.push('New compounding policy version saved'); close(); }, onError: (e) => toast.push(e.message, 'bad') })}>Save as new version</Button></>}>
      <div className="space-y-4">
        {noApply && <p role="alert" className="text-[13px] text-bad">Compounding policies do not apply to {bucket.kind.replace('_', ' ')} buckets.</p>}
        <p className="text-[13px] text-muted">Policies are immutable and versioned: saving creates the next version. The waterfall only ever distributes realised, reconciled profit, after recovering any deficit.</p>
        <Select label="Mode" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })} options={['fixed', 'proportional', 'target_vol', 'anti_martingale', 'defensive_decompound', 'stair_step'].map((m) => ({ value: m, label: m.replace(/_/g, ' ') }))} />
        <div className="grid gap-2 sm:grid-cols-5">{(['reinvest', 'vault', 'cross', 'reserve', 'tax'] as const).map((k) => <TextInput key={k} label={`${k === 'cross' ? 'Cross-bucket' : k[0].toUpperCase() + k.slice(1)} %`} inputMode="decimal" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />)}</div>
        <p role="status" className={`text-[12px] ${total === 10000 ? 'text-good' : 'text-bad'}`}>Total of the four splits: {fmtPct(total)}</p>
        {(p.vault ?? 0) > 0 && <div className="grid gap-2 sm:grid-cols-2"><Select label="Vault bucket" value={f.vb} onChange={(e) => setF({ ...f, vb: e.target.value, vw: '' })} options={[{ value: '', label: 'Choose…' }, ...all.filter((b) => b.kind === 'protected_vault').map((b) => ({ value: b.id, label: b.name }))]} /><Select label="Vault wallet account" value={f.vw} onChange={(e) => setF({ ...f, vw: e.target.value })} options={[{ value: '', label: 'Choose…' }, ...acctsFor(f.vb).map((a) => ({ value: a.id, label: `${a.nickname} · ${a.chain_name}` }))]} /></div>}
        {(p.cross ?? 0) > 0 && <div className="grid gap-2 sm:grid-cols-2"><Select label="Destination bucket" value={f.cb} onChange={(e) => setF({ ...f, cb: e.target.value, cw: '' })} options={[{ value: '', label: 'Choose…' }, ...all.map((b) => ({ value: b.id, label: b.name }))]} /><Select label="Destination wallet account" value={f.cw} onChange={(e) => setF({ ...f, cw: e.target.value })} options={[{ value: '', label: 'Choose…' }, ...acctsFor(f.cb).map((a) => ({ value: a.id, label: `${a.nickname} · ${a.chain_name}` }))]} /></div>}
        {problems.length > 0 && <ul role="alert" className="list-disc pl-5 text-[12px] text-bad">{problems.map((e) => <li key={e}>{e}</li>)}</ul>}
      </div>
    </Dialog>
  );
}

export function AssignDialog({ bucket, open, onClose }: { bucket: BucketRow; open: boolean; onClose: () => void }) {
  const toast = useToast(); const wallets = useWallets(); const cmd = useCommand('assignWalletToBucket'); const [wid, setWid] = useState(''); const [share, setShare] = useState('100'); const [shared, setShared] = useState(false); const [ack, setAck] = useState(false);
  const logical = bucket.segregation === 'logical';
  const eligible = (wallets.data?.items ?? []).filter((w) => w.state === 'active' && !w.allocations.some((a) => a.bucket_id === bucket.id) && !w.allocations.some((a) => a.exclusive) && (logical || w.allocations.length === 0));
  const bps = parsePct(share); const w = eligible.find((x) => x.id === wid);
  const used = w ? w.allocations.reduce((a, x) => a + x.bps, 0) : 0;
  const ok = !!w && bps !== null && bps >= 1 && bps <= 10000 - used && (!shared || ack);
  const close = () => { setWid(''); setShared(false); setAck(false); onClose(); };
  return (
    <Dialog open={open} onClose={close} title={`Assign a wallet to ${bucket.name}`} footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" disabled={!ok} busy={cmd.isPending}
      onClick={() => cmd.mutate({ body: { wallet: wid, bucket: bucket.id, exclusive: !shared, maxAllocationBps: bps!, logicalAck: shared && ack } }, { onSuccess: () => { toast.push('Wallet assigned'); close(); }, onError: (e) => toast.push(e.message, 'bad') })}>Assign wallet</Button></>}>
      <div className="space-y-4"><p className="text-[13px] text-muted">{logical ? 'Logical bucket: the wallet may be shared with other buckets.' : `This ${bucket.segregation} bucket accepts a dedicated (exclusive) wallet only.`} <SegBadge seg={bucket.segregation} /></p>
        <Select label="Wallet" value={wid} onChange={(e) => { setWid(e.target.value); setShared(false); setAck(false); }} options={[{ value: '', label: eligible.length ? 'Choose…' : 'No eligible wallets' }, ...eligible.map((x) => ({ value: x.id, label: `${x.nickname} (${x.family})` }))]} />
        <TextInput label="Max share of this wallet (%)" inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} hint={w ? `Up to ${fmtPct(10000 - used)} is still unallocated.` : undefined} />
        {logical && <label className="flex items-start gap-2 text-[13px]"><input type="checkbox" className="mt-0.5" checked={shared} onChange={(e) => { setShared(e.target.checked); setAck(false); }} />Share this wallet with other buckets</label>}
        {shared && <label className="flex items-start gap-2 rounded-lg bg-warn-soft p-2 text-[12px] text-warn"><input type="checkbox" className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} />I understand this is logical separation only, with no wallet-level security segregation.</label>}
      </div>
    </Dialog>
  );
}
export { Badge };
