'use client';
import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, Select, TextInput, useToast } from '@/components/ui';
import { useWs } from '@/components/hooks';
import { useApi, useCommand } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { formatUnits, parseUnits } from '@/lib/format';
import { Note } from './parts';

interface Bucket { id: string; name: string; kind: string; environment: string; state: string }
interface Asset { id: string; chain_id: string; symbol: string; decimals: number; contract: string }
interface Acct { id: string; wallet_id: string; chain_id: string; chain_name: string; nickname: string }
interface Bal { wca: string; bucket_id: string | null; environment: string; state: string; asset: string; symbol: string; decimals: number; amount: string }
interface Wallet { id: string; allocations: { bucket_id: string }[] }

/** Manual PAPER order ticket. Creates an intent that stops at RISK_EVALUATING; the independent risk service must admit it. There is no live option. */
export function OrderTicket({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { current } = useWorkspace(); const toast = useToast(); const create = useCommand<object, { id: string; note: string }>('createPaperIntent');
  const buckets = useWs<{ items: Bucket[] }>('buckets'), accts = useWs<{ accounts: Acct[]; balances: Bal[] }>('wallets/accounts'), wallets = useWs<{ items: Wallet[] }>('wallets'), assets = useApi<{ items: Asset[] }>('v1/assets');
  const cat = useWs<{ items: { key: string; name: string; stage: string }[] }>('strategies/catalog');
  const [bucket, setBucket] = useState(''); const [wca, setWca] = useState(''); const [base, setBase] = useState(''); const [quote, setQuote] = useState(''); const [side, setSide] = useState('buy');
  const [qty, setQty] = useState(''); const [budget, setBudget] = useState(''); const [limit, setLimit] = useState(''); const [strategy, setStrategy] = useState('manual_paper'); const [err, setErr] = useState<Record<string, string>>({});
  useEffect(() => { if (open) { setErr({}); setQty(''); setBudget(''); setLimit(''); } }, [open]);

  const tb = (buckets.data?.items ?? []).filter((b) => b.kind === 'trading' && b.environment === 'paper' && b.state === 'active');
  const accountsForBucket = useMemo(() => {
    const allowed = new Set((wallets.data?.items ?? []).filter((w) => w.allocations.some((a) => a.bucket_id === bucket)).map((w) => w.id));
    return (accts.data?.accounts ?? []).filter((a) => allowed.has(a.wallet_id));
  }, [wallets.data, accts.data, bucket]);
  const acct = accountsForBucket.find((a) => a.id === wca);
  const chainAssets = (assets.data?.items ?? []).filter((a) => a.chain_id === acct?.chain_id);
  const baseA = chainAssets.find((a) => a.id === base), quoteA = chainAssets.find((a) => a.id === quote);
  const avail = (asset: string) => (accts.data?.balances ?? []).filter((b) => b.wca === wca && b.bucket_id === bucket && b.environment === 'paper' && b.state === 'available' && b.asset === asset).reduce((s, b) => s + BigInt(b.amount), 0n);
  const label = (a: Asset) => `${a.symbol}${a.contract === 'native' ? ' (native)' : ' · ' + a.contract.slice(0, 8)}`;
  const strategies = [{ value: 'manual_paper', label: 'Manual (no strategy budget)' }, ...(cat.data?.items ?? []).filter((s) => s.stage === 'paper' || s.stage === 'live_candidate').map((s) => ({ value: s.key, label: s.name }))];

  const submit = () => {
    if (!current) return; const e: Record<string, string> = {};
    if (!bucket) e.bucket = 'Choose a paper bucket'; if (!acct) e.wca = 'Choose a wallet account'; if (!baseA) e.base = 'Choose the base asset'; if (!quoteA) e.quote = 'Choose the quote asset';
    if (baseA && quoteA && baseA.id === quoteA.id) e.quote = 'Base and quote must differ';
    let quantity = '', notional = '';
    try { if (baseA) quantity = parseUnits(qty, baseA.decimals); if (BigInt(quantity || '0') === 0n) e.qty = 'Must be greater than zero'; } catch (x) { e.qty = (x as Error).message; }
    if (side === 'buy') { try { if (quoteA) notional = parseUnits(budget, quoteA.decimals); if (BigInt(notional || '0') === 0n) e.budget = 'Must be greater than zero'; } catch (x) { e.budget = (x as Error).message; } } else notional = quantity;
    if (limit && !/^[0-9]{1,22}(\.[0-9]{1,18})?$/.test(limit)) e.limit = 'Decimal price, up to 18 decimals';
    setErr(e); if (Object.keys(e).length) return;
    create.mutate({ body: { workspace: current.id, bucket, walletChainAccount: wca, baseAsset: base, quoteAsset: quote, side, quantity, notional, ...(limit ? { limitPrice: limit } : {}), strategy } },
      { onSuccess: (r) => { toast.push('Paper intent created: waiting for the risk service'); onClose(); void r; }, onError: (x) => toast.push(x.message, 'bad') });
  };
  const spendAsset = side === 'buy' ? quoteA : baseA;
  return (
    <Dialog open={open} onClose={onClose} side title="New paper order" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={create.isPending} onClick={submit}>Create paper intent</Button></>}>
      <div className="space-y-4">
        <Note tone="warn">PAPER only. The ticket creates an intent in <strong>RISK_EVALUATING</strong>. It cannot bypass risk: the independent risk service must ADMIT it before capital is reserved. If that service is not running, the intent waits.</Note>
        <Select label="Paper bucket" value={bucket} onChange={(e) => { setBucket(e.target.value); setWca(''); setBase(''); setQuote(''); }} options={[{ value: '', label: tb.length ? 'Choose a bucket…' : 'No active paper trading bucket' }, ...tb.map((b) => ({ value: b.id, label: b.name }))]} />
        {err.bucket && <p role="alert" className="text-[12px] text-bad">{err.bucket}</p>}
        <Select label="Wallet account (allocated to the bucket)" value={wca} onChange={(e) => { setWca(e.target.value); setBase(''); setQuote(''); }} disabled={!bucket} options={[{ value: '', label: accountsForBucket.length || !bucket ? 'Choose an account…' : 'No wallet allocated to this bucket' }, ...accountsForBucket.map((a) => ({ value: a.id, label: `${a.nickname} · ${a.chain_name}` }))]} />
        {err.wca && <p role="alert" className="text-[12px] text-bad">{err.wca}</p>}
        <div className="grid grid-cols-2 gap-3">
          <Select label="Base asset" value={base} onChange={(e) => setBase(e.target.value)} disabled={!wca} options={[{ value: '', label: 'Choose…' }, ...chainAssets.map((a) => ({ value: a.id, label: label(a) }))]} />
          <Select label="Quote asset" value={quote} onChange={(e) => setQuote(e.target.value)} disabled={!wca} options={[{ value: '', label: 'Choose…' }, ...chainAssets.map((a) => ({ value: a.id, label: label(a) }))]} />
        </div>
        {(err.base || err.quote) && <p role="alert" className="text-[12px] text-bad">{err.base ?? err.quote}</p>}
        <Select label="Side" value={side} onChange={(e) => setSide(e.target.value)} options={[{ value: 'buy', label: 'Buy base with quote' }, { value: 'sell', label: 'Sell base for quote' }]} />
        <TextInput label={`Quantity${baseA ? ` (${baseA.symbol})` : ''}`} inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} error={err.qty} />
        {side === 'buy' && <TextInput label={`Quote budget to reserve, including max fees${quoteA ? ` (${quoteA.symbol})` : ''}`} inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} error={err.budget} />}
        <TextInput label="Limit price (quote per base, optional, display only)" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} error={err.limit} />
        <Select label="Attribute to" value={strategy} onChange={(e) => setStrategy(e.target.value)} options={strategies} hint="Attributing to a strategy charges its capital budget when the execution service reserves." />
        {spendAsset && wca && <p className="text-[13px] text-muted">Available in this bucket: <strong className="tabular text-ink">{formatUnits(avail(spendAsset.id), spendAsset.decimals)} {spendAsset.symbol}</strong> (paper ledger). The database refuses tickets it could not reserve.</p>}
      </div>
    </Dialog>
  );
}
