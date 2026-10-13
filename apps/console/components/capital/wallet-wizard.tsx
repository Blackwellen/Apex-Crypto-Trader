'use client';
import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Check, CircleAlert, Loader2, ShieldAlert } from 'lucide-react';
import { Badge, Button, Dialog, EmptyState, Stepper, TextInput, useToast } from '@/components/ui';
import { ApiError, get, useCommand } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { FAMILIES, validateAddress, type Family } from '@/lib/capital/address';
import { fmtPct, parsePct } from '@/lib/capital/basket';
import { CAPABILITY_LABEL, Mono, NoKeysNote, SegBadge, useBuckets, useChains, useWallets } from './shared';

const STEPS = ['Connector', 'Capability', 'Public address', 'Verify', 'Assign', 'Read-only check', 'Confirm'];
type Cap = 'watch_only' | 'user_signed' | 'cex_view_only' | 'cex_trade_only';
const CAPS: { id: Cap | 'managed_signer'; label: string; d: string; cex?: boolean; disabled?: string }[] = [
  { id: 'watch_only', label: 'Public address, watch-only', d: 'APEX can read this address but can never sign or move funds. No signature is requested. Safest option.' },
  { id: 'user_signed', label: 'User-signed orders', d: 'Orders are proposed by APEX and signed in YOUR wallet when you approve them. APEX stores the public address only. (No wallet-provider adapter is bundled in this release, so nothing can be signed yet; this records the intent.)' },
  { id: 'managed_signer', label: 'Scoped managed execution signer', d: 'Not creatable from the console. A managed signer is registered by the separate signer service with a KMS/MPC reference after its own attestation.', disabled: 'Needs the signer service and a KMS/MPC key reference, which this console never handles.' },
  { id: 'cex_view_only', label: 'CEX view-only', d: 'Read balances/fills of an exchange sub-account. Registers an account reference label only.', cex: true },
  { id: 'cex_trade_only', label: 'CEX trade-only', d: 'Trading without withdrawal rights. APEX never accepts a withdrawal-permitted key. The key itself must be added through server-side secret management (KMS reference), never in this form.', cex: true },
];
type Alloc = { share: string; shared: boolean; ack: boolean };

export function WalletWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { current } = useWorkspace(); const toast = useToast();
  const chains = useChains(), buckets = useBuckets(), wallets = useWallets();
  const connect = useCommand('connectWallet'), assign = useCommand('assignWalletToBucket');
  const [step, setStep] = useState(0); const [family, setFamily] = useState<Family | ''>(''); const [cap, setCap] = useState<Cap | ''>('');
  const [nick, setNick] = useState(''); const [addr, setAddr] = useState(''); const [chainSel, setChainSel] = useState<string[]>([]); const [anti, setAnti] = useState(false);
  const [alloc, setAlloc] = useState<Record<string, Alloc>>({});
  const [progress, setProgress] = useState<{ label: string; status: 'running' | 'done' | 'failed'; error?: string }[]>([]); const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ wallet: string; audit: any | null } | null>(null);
  const state = useRef<{ wallet?: string; done: Set<string>; key: string }>({ done: new Set(), key: '' });

  const fam = FAMILIES.find((f) => f.id === family);
  const v = useMemo(() => (family ? validateAddress(family, addr) : null), [family, addr]);
  const famChains = (chains.data?.items ?? []).filter((c) => c.family === family);
  const dupe = v?.ok ? wallets.data?.items.find((w) => w.family === family && w.address.toLowerCase() === v.normalized.toLowerCase()) : undefined;
  const caps = CAPS.filter((c) => (fam?.kind === 'cex') === !!c.cex || c.id === 'managed_signer');
  const bList = (buckets.data?.items ?? []);
  const chosen = Object.keys(alloc);
  const allocProblems: string[] = [];
  chosen.forEach((id) => { const b = bList.find((x) => x.id === id)!; const a = alloc[id]; const bps = parsePct(a.share); if (bps === null || bps < 1) allocProblems.push(`${b.name}: enter a share between 0.01% and 100%`); if (a.shared && !a.ack) allocProblems.push(`${b.name}: acknowledge logical sharing`); });
  if (chosen.length > 1 && chosen.some((id) => !alloc[id].shared)) allocProblems.push('A wallet in more than one bucket cannot be exclusive: mark every selection as shared (logical) or pick one bucket');
  const total = chosen.reduce((a, id) => a + (parsePct(alloc[id].share) ?? 0), 0); if (total > 10000) allocProblems.push(`Shares total ${fmtPct(total)}; a wallet can be allocated at most 100%`);

  const valid = [!!family, !!cap, nick.trim().length > 0 && nick.length <= 80 && !!v?.ok && !dupe, !!v?.ok && anti, allocProblems.length === 0, true, true][step];

  const reset = () => { setStep(0); setFamily(''); setCap(''); setNick(''); setAddr(''); setChainSel([]); setAnti(false); setAlloc({}); setProgress([]); setResult(null); state.current = { done: new Set(), key: '' }; };
  const close = () => { if (running) return; reset(); onClose(); };

  async function submit() {
    if (!current || !family || !cap || !v?.ok || running) return;
    const s = state.current; if (!s.key) s.key = crypto.randomUUID().slice(0, 18); setRunning(true);
    const steps = [{ id: 'connect', label: `Register ${fam!.label.split(' (')[0]} wallet "${nick.trim()}" (${CAPABILITY_LABEL[cap]})` }, ...chosen.map((id) => ({ id: 'assign:' + id, label: `Assign to ${bList.find((b) => b.id === id)!.name}` }))];
    const prog = steps.map((x) => ({ label: x.label, status: (s.done.has(x.id) ? 'done' : 'running') as 'done' | 'running' | 'failed', error: undefined as string | undefined })); setProgress([...prog]);
    try {
      for (let i = 0; i < steps.length; i++) {
        const id = steps[i].id; if (s.done.has(id)) continue; prog[i].status = 'running'; setProgress([...prog]);
        try {
          if (id === 'connect') { const r = await connect.mutateAsync({ body: { workspace: current.id, nickname: nick.trim(), family, address: v.normalized, capability: cap, chains: chainSel }, key: `${s.key}-connect` }); s.wallet = r.result.id; }
          else { const bid = id.slice(7); const a = alloc[bid]; await assign.mutateAsync({ body: { wallet: s.wallet!, bucket: bid, exclusive: !a.shared, maxAllocationBps: parsePct(a.share)!, logicalAck: a.shared && a.ack }, key: `${s.key}-${bid}` }); }
          s.done.add(id); prog[i].status = 'done'; setProgress([...prog]);
        } catch (e) { prog[i].status = 'failed'; prog[i].error = e instanceof ApiError ? e.message : String(e); setProgress([...prog]); throw e; }
      }
      const aud = await get<{ items: any[] }>(`v1/audit?workspace=${current.id}&limit=50`).then((r) => r.items.find((x) => x.action === 'wallet.connect' && x.entity_id === s.wallet) ?? null).catch(() => null);
      setResult({ wallet: s.wallet!, audit: aud }); toast.push(`Wallet "${nick.trim()}" registered`);
    } catch (e) { toast.push((e as Error).message, 'bad'); } finally { setRunning(false); }
  }

  const failed = progress.some((p) => p.status === 'failed');
  return (
    <Dialog open={open} onClose={close} title="Connect a wallet" footer={result ? <Button variant="primary" onClick={close}>Done</Button> : <>
      {step > 0 && <Button onClick={() => setStep(step - 1)} disabled={running || (step === 6 && progress.length > 0)}>Back</Button>}
      <Button onClick={close} disabled={running}>Cancel</Button>
      {step < 6 ? <Button variant="primary" disabled={!valid} onClick={() => setStep(step + 1)}>Next</Button> : <Button variant="primary" busy={running} onClick={submit}>{failed ? 'Retry remaining steps' : 'Register wallet & write audit record'}</Button>}</>}>
      <div className="mb-4"><NoKeysNote /></div>
      <Stepper steps={STEPS.map((s, i) => `W-0${i + 1} ${s}`)} current={step} />
      {step === 0 && (
        <fieldset><legend className="mb-2 text-[13px] font-semibold">Choose the connector family</legend>
          <div className="grid gap-2 sm:grid-cols-2">{FAMILIES.map((f) => (
            <label key={f.id} className="flex cursor-pointer items-start gap-2 rounded-xl border border-line p-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
              <input type="radio" name="family" className="mt-1" checked={family === f.id} onChange={() => { setFamily(f.id); setCap(''); setChainSel([]); setAddr(''); }} /><span><span className="block text-[13px] font-semibold">{f.label}</span><span className="text-[12px] text-muted">{f.connector}</span></span></label>))}</div></fieldset>)}
      {step === 1 && (
        <fieldset><legend className="mb-2 text-[13px] font-semibold">Choose the capability</legend>
          <div className="space-y-2">{caps.map((c) => (
            <label key={c.id} className={`flex items-start gap-2 rounded-xl border border-line p-3 ${c.disabled ? 'cursor-not-allowed bg-[#f3f5f9]' : 'cursor-pointer has-[:checked]:border-accent has-[:checked]:bg-accent-soft'}`}>
              <input type="radio" name="cap" className="mt-1" disabled={!!c.disabled} checked={cap === c.id} onChange={() => setCap(c.id as Cap)} aria-describedby={`cap-${c.id}`} />
              <span><span className="block text-[13px] font-semibold">{c.label} {c.disabled && <Badge tone="warn">Not available here</Badge>}</span><span id={`cap-${c.id}`} className="text-[12px] text-muted">{c.d}{c.disabled && <strong className="block text-warn">{c.disabled}</strong>}</span></span></label>))}</div>
          <p className="mt-2 text-[12px] text-muted">Standard trading API keys never get withdrawal permission in APEX.</p></fieldset>)}
      {step === 2 && fam && (
        <div className="space-y-3">
          <div className="rounded-xl border border-line bg-[#f6f8fb] p-3 text-[13px]"><strong>Authentication.</strong> {cap === 'watch_only' ? 'Watching a public address needs no signature and no login to a wallet provider.' : 'No wallet-provider (browser extension, hardware, WalletConnect) adapter is bundled in this console yet, so APEX cannot request a connection or signature. You register the public address only; signing capability is recorded but cannot be exercised until an adapter and the signer path exist.'}</div>
          <TextInput label="Wallet nickname" value={nick} onChange={(e) => setNick(e.target.value)} maxLength={80} />
          <TextInput label={fam.kind === 'cex' ? 'Exchange sub-account reference (a label, not a key)' : 'Public address'} value={addr} onChange={(e) => setAddr(e.target.value)} autoComplete="off" spellCheck={false} placeholder={fam.example}
            error={addr && v && !v.ok ? v.reason : dupe ? `Already registered as "${dupe.nickname}"` : undefined} hint="Paste the PUBLIC address only. Never a seed phrase, private key or API secret." />
          {v?.ok && v.warnings.map((w) => <p key={w} className="text-[12px] text-warn">{w}</p>)}
          {addr && v && !v.ok && v.secret && <div role="alert" className="flex items-start gap-2 rounded-xl border border-[#f3c9c5] bg-bad-soft p-3 text-[13px] text-bad"><ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden /><p><strong>Secret material detected and refused.</strong> Clear this field. If you pasted real keys anywhere, treat them as compromised and move your funds.</p></div>}
        </div>)}
      {step === 3 && fam && v?.ok && (
        <div className="space-y-4">
          <div><h3 className="mb-1 text-[13px] font-semibold">Address to be registered</h3><p className="rounded-xl bg-[#f6f8fb] p-3"><Mono className="text-[14px]">{v.normalized}</Mono></p>
            <p className="mt-1 text-[12px] text-muted">Structural checks passed for {fam.label}. Checksum-level validation (EIP-55, Base58Check, TON CRC) is performed by the chain packages, not in the browser; the API re-checks structure independently.</p></div>
          <div><h3 className="mb-1 text-[13px] font-semibold">Networks</h3>
            {fam.kind === 'cex' ? <p className="text-[12px] text-muted">Exchange accounts have no on-chain networks.</p> : chains.isLoading ? <p>Loading chain registry…</p> : famChains.length === 0
              ? <EmptyState title="No chains registered for this family" hint="The chain registry has no entries for this family yet (it is seeded by the chain integration work). The wallet can still be registered, but it cannot hold ledger balances until chain accounts exist." />
              : <div className="space-y-1" role="group" aria-label="Networks for this wallet">{famChains.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={chainSel.includes(c.id)} onChange={(e) => setChainSel(e.target.checked ? [...chainSel, c.id] : chainSel.filter((x) => x !== c.id))} />{c.name} <Mono className="text-muted">{c.id}</Mono>{c.is_testnet && <Badge>testnet</Badge>}{!c.enabled && <Badge tone="warn">monitoring off</Badge>}</label>))}
                <p className="text-[12px] text-muted">The same address string is registered once and gets a separate chain account (and separate balances) per network.</p></div>}</div>
          <label className="flex items-start gap-2 rounded-xl border border-[#f0dfb7] bg-warn-soft p-3 text-[13px] text-warn"><input type="checkbox" className="mt-0.5" checked={anti} onChange={(e) => setAnti(e.target.checked)} />Anti-phishing check: I compared the first 6 and last 6 characters above with the address shown in my own wallet or exchange, on a device I trust.</label>
        </div>)}
      {step === 4 && (
        <div className="space-y-3">
          <p className="text-[13px] text-muted">Optional: assign the wallet to bucket(s) now. The default is exclusive (physical). Sharing a wallet between buckets is logical separation only and needs your explicit acknowledgement. You can skip this and assign later.</p>
          {bList.length === 0 ? <p className="rounded-xl border border-dashed border-line p-4 text-[13px] text-muted">No buckets exist yet. Register the wallet now and assign it from a bucket later.</p> :
            <ul className="space-y-2">{bList.map((b) => { const a = alloc[b.id]; const physical = b.segregation !== 'logical'; return (
              <li key={b.id} className="rounded-xl border border-line p-3">
                <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={!!a} onChange={(e) => setAlloc((s) => { const n = { ...s }; if (!e.target.checked) delete n[b.id]; else n[b.id] = { share: '100', shared: !physical && Object.keys(s).length > 0, ack: false }; return n; })} /><span className="font-semibold">{b.name}</span><SegBadge seg={b.segregation} /><Badge tone="accent">{b.environment}</Badge></label>
                {a && <div className="mt-2 grid gap-2 pl-6 sm:grid-cols-2">
                  <TextInput label="Max share of this wallet (%)" inputMode="decimal" value={a.share} onChange={(e) => setAlloc({ ...alloc, [b.id]: { ...a, share: e.target.value } })} />
                  {!physical && <label className="flex items-start gap-2 text-[12px]"><input type="checkbox" className="mt-0.5" checked={a.shared} onChange={(e) => setAlloc({ ...alloc, [b.id]: { ...a, shared: e.target.checked, ack: false } })} />Share this wallet with other buckets (logical)</label>}
                  {physical && <p className="text-[12px] text-muted">This {b.segregation} bucket takes a dedicated (exclusive) wallet only.</p>}
                  {a.shared && <label className="flex items-start gap-2 rounded-lg bg-warn-soft p-2 text-[12px] text-warn sm:col-span-2"><input type="checkbox" className="mt-0.5" checked={a.ack} onChange={(e) => setAlloc({ ...alloc, [b.id]: { ...a, ack: e.target.checked } })} />I understand this is logical separation only, with no wallet-level security segregation.</label>}</div>}</li>); })}</ul>}
          {allocProblems.length > 0 && <ul role="alert" className="list-disc pl-5 text-[12px] text-bad">{allocProblems.map((e) => <li key={e}>{e}</li>)}</ul>}
        </div>)}
      {step === 5 && (
        <div className="space-y-3">
          <div role="status" className="rounded-xl border border-[#f0dfb7] bg-warn-soft p-4 text-[13px] text-warn"><strong>On-chain balance verification not available until a certified read adapter is connected.</strong> The API exposes no balance-read endpoint, so APEX cannot confirm what this address holds. Balances shown after registration are internal-ledger (paper) balances only.</div>
          {fam?.kind !== 'cex' && chainSel.length > 0 && <div><h3 className="mb-1 text-[13px] font-semibold">Selected networks: registry capability status</h3><ul className="space-y-1 text-[12px]">{chainSel.map((id) => { const c = chains.data?.items.find((x) => x.id === id)!; const caps = Object.entries(c.capabilities ?? {}); return <li key={id}><strong>{c.name}</strong>: {caps.length ? caps.map(([k, x]) => `${k} ${x.status}`).join(', ') : 'no capability evidence recorded'}</li>; })}</ul></div>}
          <p className="text-[12px] text-muted">An optional test transaction is a separate, user-authorised, costed action and is not offered here. Nothing is spent by this wizard.</p>
        </div>)}
      {step === 6 && !result && (
        <div className="space-y-3">
          <dl className="grid gap-x-4 gap-y-2 text-[13px] sm:grid-cols-2">
            <div><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Nickname</dt><dd>{nick.trim()}</dd></div>
            <div><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Family</dt><dd>{fam?.label}</dd></div>
            <div><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Capability</dt><dd>{cap && CAPABILITY_LABEL[cap]}</dd></div>
            <div><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Networks</dt><dd>{chainSel.length ? chainSel.join(', ') : 'none selected'}</dd></div>
            <div className="sm:col-span-2"><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Address</dt><dd>{v?.ok && <Mono>{v.normalized}</Mono>}</dd></div>
            <div className="sm:col-span-2"><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Assignments</dt><dd>{chosen.length ? chosen.map((id) => `${bList.find((b) => b.id === id)?.name} (${alloc[id].shared ? 'shared' : 'exclusive'}, ${alloc[id].share}%)`).join('; ') : 'none (assign later)'}</dd></div>
            <div className="sm:col-span-2"><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Wallet health, allowances, expiry</dt><dd className="text-muted">Not measured: no read adapter is connected. Allowances and token accounts cannot be listed.</dd></div>
          </dl>
          {progress.length > 0 && <ol className="space-y-1" aria-label="Registration progress">{progress.map((p) => <li key={p.label} className="flex items-start gap-2 text-[13px]">{p.status === 'done' ? <Check className="mt-0.5 size-4 text-good" aria-label="done" /> : p.status === 'running' ? <Loader2 className="mt-0.5 size-4 animate-spin" aria-label="running" /> : <CircleAlert className="mt-0.5 size-4 text-bad" aria-label="failed" />}<span>{p.label}{p.error && <span role="alert" className="block text-bad">{p.error}</span>}</span></li>)}</ol>}
          <p className="text-[12px] text-muted">Registering writes an audit record. It cannot move funds.</p>
        </div>)}
      {step === 6 && result && (
        <div className="space-y-3" role="status"><p className="flex items-center gap-2 text-[15px] font-semibold text-good"><Check className="size-5" aria-hidden />Wallet registered and audited</p>
          <p className="text-[13px]">{result.audit ? <>Audit record #{result.audit.id}: <strong>{result.audit.action}</strong> at {new Date(result.audit.created_at).toLocaleString('en-GB')}.</> : 'The audit record is being written; see the Audit tab on the wallet.'}</p>
          <Link className="font-semibold text-accent underline" href={`/wallets/${result.wallet}`} onClick={close}>Open wallet detail</Link></div>)}
    </Dialog>
  );
}
