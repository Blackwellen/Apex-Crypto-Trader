'use client';
import { useState } from 'react';
import { Pause, Play, Archive, Ban, ArrowRightLeft } from 'lucide-react';
import { Badge, Button, Dialog, Field, Select, TextInput, inputCls, useToast } from '@/components/ui';
import { useApi, useCommand } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { Mono, WalletStateBadge, useBuckets, type BucketRow, type WalletRow } from './shared';

type Kind = 'pause' | 'resume' | 'archive' | 'revoke';
const META: Record<Kind, { cmd: string; title: string; verb: string; phrase?: string; body: string; danger?: boolean }> = {
  pause: { cmd: 'pauseWallet', title: 'Pause wallet', verb: 'Pause', body: 'A paused wallet cannot be assigned, funded or allocated to. Existing ledger balances are untouched. You can resume it later.' },
  resume: { cmd: 'resumeWallet', title: 'Resume wallet', verb: 'Resume', body: 'The wallet becomes active again.' },
  archive: { cmd: 'archiveWallet', title: 'Archive wallet', verb: 'Archive', phrase: 'ARCHIVE', body: 'Archiving is permanent. It is refused while the wallet has open reservations, in-flight funds or unconfirmed transfers.', danger: true },
  revoke: { cmd: 'revokeWallet', title: 'Revoke wallet', verb: 'Revoke', phrase: 'REVOKE', body: 'Revoking permanently removes the wallet from use and is audited. It is refused while the wallet has open reservations, in-flight funds or unconfirmed transfers. To use the address again you must register a new wallet.', danger: true },
};

export function LifecycleDialog({ wallet, kind, onClose }: { wallet: WalletRow; kind: Kind | null; onClose: () => void }) {
  const toast = useToast(); const m = kind ? META[kind] : null; const cmd = useCommand(m?.cmd ?? 'pauseWallet'); const [reason, setReason] = useState(''); const [phrase, setPhrase] = useState('');
  const ob = useApi<{ obligations: { reservations: number; in_flight_accounts: number; pending_transfers: number } }>(kind && (kind === 'archive' || kind === 'revoke') ? `v1/wallets/${wallet.id}/obligations` : null);
  const o = ob.data?.obligations; const blocked = !!o && (o.reservations > 0 || o.in_flight_accounts > 0 || o.pending_transfers > 0);
  const ok = reason.trim().length >= 3 && (!m?.phrase || phrase.trim().toUpperCase() === m.phrase);
  const close = () => { setReason(''); setPhrase(''); onClose(); };
  return (
    <Dialog open={!!kind} onClose={close} title={m ? `${m.title}: ${wallet.nickname}` : ''} footer={<><Button onClick={close}>Cancel</Button>
      <Button variant={m?.danger ? 'danger' : 'primary'} disabled={!ok || blocked} busy={cmd.isPending}
        onClick={() => cmd.mutate({ body: { wallet: wallet.id, reason: reason.trim() } }, { onSuccess: () => { toast.push(`Wallet ${kind === 'resume' ? 'resumed' : kind + (kind === 'pause' ? 'd' : 'd')}`); close(); }, onError: (e) => toast.push(e.message, 'bad') })}>{m?.verb}</Button></>}>
      {m && <div className="space-y-4 text-[14px]">
        <p>{m.body}</p>
        {(kind === 'archive' || kind === 'revoke') && (blocked
          ? <div role="alert" className="rounded-xl border border-[#f3c9c5] bg-bad-soft p-3 text-[13px] text-bad"><strong>Refused:</strong> {o!.reservations} open reservation(s), {o!.in_flight_accounts} in-flight balance(s), {o!.pending_transfers} unconfirmed transfer(s). Release or settle them first.</div>
          : o ? <p className="text-[12px] text-good">No open reservations or in-flight funds right now.</p> : <p className="text-[12px] text-muted">Checking open obligations…</p>)}
        <Field label="Reason (recorded in the audit log)"><textarea className={`${inputCls} min-h-20`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
        {m.phrase && <TextInput label={`Type ${m.phrase} to confirm`} value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" />}
      </div>}
    </Dialog>
  );
}

export function MoveDialog({ wallet, open, onClose, fromBucket }: { wallet: WalletRow; open: boolean; onClose: () => void; fromBucket?: string }) {
  const toast = useToast(); const buckets = useBuckets(); const move = useCommand('moveWalletBucket');
  const [from, setFrom] = useState(fromBucket ?? wallet.allocations[0]?.bucket_id ?? ''); const [to, setTo] = useState(''); const [shared, setShared] = useState(false); const [ack, setAck] = useState(false);
  const all = buckets.data?.items ?? []; const fromB = all.find((b) => b.id === (fromBucket ?? from)); const dest = all.filter((b) => b.id !== (fromBucket ?? from) && (!fromB || b.environment === fromB.environment));
  const toB = all.find((b) => b.id === to); const physical = !!toB && toB.segregation !== 'logical';
  const close = () => { setTo(''); setShared(false); setAck(false); onClose(); };
  return (
    <Dialog open={open} onClose={close} title={`Move ${wallet.nickname} to another bucket`} footer={<><Button onClick={close}>Cancel</Button>
      <Button variant="primary" disabled={!to || !(fromBucket ?? from) || (shared && !ack)} busy={move.isPending}
        onClick={() => move.mutate({ body: { wallet: wallet.id, fromBucket: fromBucket ?? from, toBucket: to, exclusive: !shared || physical, maxAllocationBps: 10000, logicalAck: shared && ack } }, { onSuccess: () => { toast.push('Wallet moved'); close(); }, onError: (e) => toast.push(e.message, 'bad') })}>Move wallet</Button></>}>
      <div className="space-y-4 text-[14px]">
        <p className="text-[13px] text-muted">Moving is refused while the wallet still holds ledger balance or open reservations for the old bucket. Transfer the funds out first (Capital transfers), so the ledger, not this screen, stays the source of truth.</p>
        {!fromBucket && <Select label="From bucket" value={from} onChange={(e) => setFrom(e.target.value)} options={wallet.allocations.map((a) => ({ value: a.bucket_id, label: all.find((b) => b.id === a.bucket_id)?.name ?? a.bucket_id }))} />}
        <Select label="To bucket" value={to} onChange={(e) => { setTo(e.target.value); setShared(false); setAck(false); }} options={[{ value: '', label: 'Choose…' }, ...dest.map((b: BucketRow) => ({ value: b.id, label: `${b.name} (${b.segregation})` }))]} />
        {toB && !physical && <label className="flex items-start gap-2 text-[13px]"><input type="checkbox" className="mt-0.5" checked={shared} onChange={(e) => { setShared(e.target.checked); setAck(false); }} />Share this wallet with other buckets (logical)</label>}
        {shared && <label className="flex items-start gap-2 rounded-lg bg-warn-soft p-2 text-[12px] text-warn"><input type="checkbox" className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} />I understand this is logical separation only.</label>}
        {physical && <p className="text-[12px] text-muted">The destination is {toB!.segregation}: the wallet will be assigned exclusively.</p>}
      </div>
    </Dialog>
  );
}

/** Lifecycle controls. Anything not implemented renders disabled with the reason (never hidden, never faked). */
export function WalletLifecycle({ wallet, compact }: { wallet: WalletRow; compact?: boolean }) {
  const { canAdmin } = useWorkspace(); const [kind, setKind] = useState<Kind | null>(null); const [mv, setMv] = useState(false);
  const off = !canAdmin ? 'Owner or admin role required' : undefined; const terminal = wallet.state === 'archived' || wallet.state === 'revoked';
  const terminalWhy = terminal ? `Wallet is ${wallet.state} (terminal)` : undefined;
  const b = (label: string, icon: React.ReactNode, onClick: () => void, why?: string, variant: 'secondary' | 'danger' = 'secondary') =>
    <Button key={label} variant={variant} onClick={onClick} disabled={!!why} title={why} aria-label={`${label} wallet ${wallet.nickname}`} className={compact ? 'min-h-9 px-3' : ''}>{icon}{label}</Button>;
  return (<>
    <div className="flex flex-wrap items-center gap-2">
      {wallet.state === 'paused' ? b('Resume', <Play className="size-4" aria-hidden />, () => setKind('resume'), off ?? terminalWhy) : b('Pause', <Pause className="size-4" aria-hidden />, () => setKind('pause'), off ?? terminalWhy)}
      {!compact && b('Move bucket', <ArrowRightLeft className="size-4" aria-hidden />, () => setMv(true), off ?? terminalWhy ?? (wallet.allocations.length === 0 ? 'Wallet is not assigned to a bucket' : undefined))}
      {b('Archive', <Archive className="size-4" aria-hidden />, () => setKind('archive'), off ?? terminalWhy, 'danger')}
      {b('Revoke', <Ban className="size-4" aria-hidden />, () => setKind('revoke'), off ?? terminalWhy, 'danger')}
    </div>
    <LifecycleDialog wallet={wallet} kind={kind} onClose={() => setKind(null)} />
    {mv && <MoveDialog wallet={wallet} open={mv} onClose={() => setMv(false)} />}
  </>);
}

export const NOT_IMPLEMENTED: { label: string; why: string }[] = [
  { label: 'Rotate / reconnect', why: 'Needs a wallet-provider adapter or the signer service; none is connected to this console.' },
  { label: 'Downgrade to watch-only', why: 'Needs a capability-change command with fresh re-authentication, which does not exist yet.' },
  { label: 'Revoke token allowances', why: 'Allowances can only be listed and revoked through a certified chain read/sign adapter.' },
  { label: 'Address allowlist & withdrawal delay', why: 'Policy storage for allowlists/delays is not in the schema yet.' },
  { label: 'Signer attestation & status', why: 'Provided by the signer service/KMS integration, which is not part of this release.' },
];
export function DisabledControls() {
  return <ul className="grid gap-2 sm:grid-cols-2">{NOT_IMPLEMENTED.map((n) => (
    <li key={n.label} className="rounded-xl border border-line bg-[#f9fafc] p-3"><Button disabled aria-describedby={`ni-${n.label.replace(/\W/g, '')}`} className="mb-1">{n.label}</Button><p id={`ni-${n.label.replace(/\W/g, '')}`} className="text-[12px] text-muted">Disabled: {n.why}</p></li>))}</ul>;
}
export { WalletStateBadge, Mono, Badge };
