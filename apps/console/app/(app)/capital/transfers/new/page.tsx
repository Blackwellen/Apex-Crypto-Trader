'use client';
import { useMemo, useState } from 'react';
import { ArrowRight, Info } from 'lucide-react';
import { Async, Badge, Button, Card, EmptyState, PageHeader, Select, Stepper, TabPanel, Tabs, TextInput } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { useWs } from '@/components/hooks';
import { EnvBadge, Note, Table, useAction } from '@/components/ops/common';
import { useApi } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { formatUnits, parseUnits, when } from '@/lib/format';
import { destinationCreditedAtRequest, initialStatus, transferKind, transferProblems, type AccountRow } from '@/lib/transfer';

const STEPS = ['T-01 Source', 'T-02 Destination', 'T-03 Asset & amount', 'T-04 Fees & finality', 'T-05 Submit & track'];
const TABS = [{ id: 'new', label: 'New transfer' }, { id: 'track', label: 'Tracking' }, { id: 'vault', label: 'Protected vault release' }];
const statusTone = (s: string) => (s === 'confirmed' ? 'good' : s === 'failed' ? 'bad' : 'warn') as 'good' | 'bad' | 'warn';

function useCapital() {
  const cap = useWs<any>('capital/accounts'); const alloc = useWs<any>('allocations'); const assets = useApi<{ items: any[] }>('v1/assets');
  const assetMap = useMemo(() => Object.fromEntries((assets.data?.items ?? []).map((a: any) => [a.id, a])), [assets.data]);
  const bucketMap = useMemo(() => Object.fromEntries((cap.data?.buckets ?? []).map((b: any) => [b.id, b])), [cap.data]);
  return { cap, alloc, assets, assetMap, bucketMap };
}

function Wizard({ workspace }: { workspace: string }) {
  const { cap, alloc, assetMap, bucketMap } = useCapital();
  const { canAdmin } = useWorkspace();
  const [step, setStep] = useState(0);
  const [sb, setSb] = useState(''); const [sw, setSw] = useState(''); const [db, setDb] = useState(''); const [dw, setDw] = useState(''); const [asset, setAsset] = useState(''); const [amt, setAmt] = useState('');
  const [txId, setTxId] = useState<string | null>(null);
  const submit = useAction<any>('requestCapitalTransfer'); const confirm = useAction<any>('confirmPaperTransfer'); const fail = useAction<any>('failPaperTransfer');
  const accounts: AccountRow[] = cap.data?.accounts ?? []; const buckets: any[] = cap.data?.buckets ?? []; const balances: any[] = cap.data?.balances ?? [];
  const forBucket = (bid: string) => accounts.filter((a) => a.allocations.some((x) => x.bucket_id === bid));
  const src = accounts.find((a) => a.wca === sw), dst = accounts.find((a) => a.wca === dw);
  const sBucket = bucketMap[sb], dBucket = bucketMap[db];
  const kind = sw && dw ? transferKind(sw, dw) : null;
  const problems = transferProblems({ srcBucket: sBucket, dstBucket: dBucket, src, dst, srcBucketId: sb, dstBucketId: db });
  const srcAssets = useMemo(() => [...new Map(balances.filter((b) => b.bucket_id === sb && b.wca === sw && b.state === 'available').map((b) => [b.asset_id, b])).values()], [balances, sb, sw]);
  const a = assetMap[asset];
  const avail = BigInt(balances.find((b) => b.bucket_id === sb && b.wca === sw && b.asset_id === asset && b.state === 'available')?.amount ?? '0');
  let amountBase: bigint | null = null, amtErr: string | undefined;
  if (amt.trim() && a) { try { amountBase = BigInt(parseUnits(amt, a.decimals)); if (amountBase <= 0n) { amountBase = null; amtErr = 'Amount must be greater than zero'; } } catch (e) { amtErr = (e as Error).message; } }
  const over = amountBase !== null && amountBase > avail;
  const canNext = [!!sb && !!sw && sBucket?.kind !== 'protected_vault', !!db && !!dw && !(sb === db && sw === dw), !!asset && amountBase !== null && !over, problems.length === 0 && amountBase !== null && !over, true][step];
  const tr = txId ? (alloc.data?.transfers ?? []).find((t: any) => t.id === txId) : null;

  const doSubmit = () => submit.run({ workspace, srcBucket: sb, srcWalletChainAccount: sw, dstBucket: db, dstWalletChainAccount: dw, asset, amount: amountBase!.toString() }, { ok: 'Transfer requested', onDone: (r) => setTxId(r.id) });
  const reset = () => { setStep(0); setSb(''); setSw(''); setDb(''); setDw(''); setAsset(''); setAmt(''); setTxId(null); };

  return (
    <Card title="Capital transfer">
      <Stepper steps={STEPS} current={step} />
      <Async q={cap}>{() => buckets.length < 1 ? <EmptyState title="No buckets" hint="Create buckets and assign wallets first." /> : (<div className="space-y-4">
        {step === 0 && <div className="grid gap-4 md:grid-cols-2">
          <Select label="Source bucket" value={sb} onChange={(e) => { setSb(e.target.value); setSw(''); setAsset(''); }} options={[{ value: '', label: 'Select a bucket' }, ...buckets.map((b) => ({ value: b.id, label: `${b.name} (${b.kind.replace('_', ' ')}, ${b.environment})` }))]} />
          <Select label="Source wallet / chain account" value={sw} onChange={(e) => { setSw(e.target.value); setAsset(''); }} disabled={!sb}
            options={[{ value: '', label: sb ? (forBucket(sb).length ? 'Select an account' : 'No wallet is assigned to this bucket') : 'Select a bucket first' }, ...forBucket(sb).map((x) => ({ value: x.wca, label: `${x.nickname} on ${x.chain_name}` }))]} />
          {sBucket?.kind === 'protected_vault' && <div className="md:col-span-2"><Note tone="bad">Protected vault funds are never moved by an ordinary transfer. Use the <strong>Protected vault release</strong> tab (approval, delay, second owner).</Note></div>}
          {sBucket && <div className="md:col-span-2"><Note>{sBucket.segregation === 'logical' ? 'Logical bucket: accounting separation only; its wallet may be shared.' : sBucket.segregation === 'physical' ? 'Physical bucket: wallet(s) dedicated to this bucket.' : 'Protected bucket.'} Environment: <EnvBadge env={sBucket.environment} /></Note></div>}
        </div>}
        {step === 1 && <div className="grid gap-4 md:grid-cols-2">
          <Select label="Destination bucket" value={db} onChange={(e) => { setDb(e.target.value); setDw(''); }} options={[{ value: '', label: 'Select a bucket' }, ...buckets.map((b) => ({ value: b.id, label: `${b.name} (${b.kind.replace('_', ' ')}, ${b.environment})` }))]} />
          <Select label="Destination wallet / chain account" value={dw} onChange={(e) => setDw(e.target.value)} disabled={!db}
            options={[{ value: '', label: db ? (forBucket(db).length ? 'Select an account' : 'No wallet is assigned to this bucket') : 'Select a bucket first' }, ...forBucket(db).map((x) => ({ value: x.wca, label: `${x.nickname} on ${x.chain_name}` }))]} />
          {sb === db && sw === dw && sb && <div className="md:col-span-2"><Note tone="bad">Source and destination are identical.</Note></div>}
        </div>}
        {step === 2 && <div className="grid gap-4 md:grid-cols-2">
          <Select label="Asset (from the source account's available balance)" value={asset} onChange={(e) => setAsset(e.target.value)} options={[{ value: '', label: srcAssets.length ? 'Select an asset' : 'No available balance in the source account' }, ...srcAssets.map((b: any) => ({ value: b.asset_id, label: `${b.symbol} on ${b.chain_id}` }))]} />
          <TextInput label={`Amount${a ? ` (${a.symbol})` : ''}`} value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" disabled={!a} error={amtErr ?? (over ? 'Exceeds the available balance' : undefined)} hint={a ? `Available: ${formatUnits(avail, a.decimals)} ${a.symbol}. Converted to integer base units with BigInt.` : undefined} />
        </div>}
        {step === 3 && src && dst && a && amountBase !== null && kind && <div className="space-y-4" data-testid="transfer-preview">
          <div className={`rounded-xl border p-4 ${kind === 'logical' ? 'border-[#bfe6d9] bg-good-soft' : 'border-[#f0dfb7] bg-warn-soft'}`}>
            <div className="flex flex-wrap items-center gap-2"><Badge tone={kind === 'logical' ? 'good' : 'warn'}>{kind === 'logical' ? 'LOGICAL' : 'PHYSICAL'}</Badge>
              <span className="text-[14px] font-semibold">{kind === 'logical' ? 'Same wallet account: atomic ledger reassignment, instant, no on-chain movement' : 'Different wallets: real token movement, pending until finality'}</span></div>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px]">
              {kind === 'logical' ? (<><li>Both ledger accounts move in <strong>one atomic entry</strong>; status will be <strong>{initialStatus(kind)}</strong> immediately.</li><li>Destination is credited now (it is only an accounting assignment on the same wallet).</li></>)
                : (<><li>Status will be <strong>{initialStatus(kind)}</strong>. The amount leaves the source&apos;s <em>available</em> balance into <em>pending out</em> now and is unavailable to anything.</li>
                  <li>The destination is <strong>NOT credited</strong> ({String(destinationCreditedAtRequest(kind))}) until finality is confirmed. Finality model of {src.chain_name}: <strong>{src.finality_model}</strong>.</li>
                  <li>If it fails, the pending amount returns to the source; it is not recreated independently.</li></>)}
            </ul></div>
          <dl className="grid gap-3 text-[13px] sm:grid-cols-2">
            <div><dt className="text-muted">Route</dt><dd className="font-semibold">{src.nickname} ({bucketMap[sb]?.name}) <ArrowRight className="inline size-4" aria-hidden /> {dst.nickname} ({bucketMap[db]?.name})</dd></div>
            <div><dt className="text-muted">Amount</dt><dd className="tabular font-semibold">{formatUnits(amountBase, a.decimals)} {a.symbol}</dd></div>
            <div><dt className="text-muted">Source available after</dt><dd className="tabular font-semibold">{formatUnits(avail - amountBase, a.decimals)} {a.symbol} (was {formatUnits(avail, a.decimals)})</dd></div>
            <div><dt className="text-muted">Network fee</dt><dd className="font-semibold">{kind === 'logical' ? 'None: no on-chain transaction' : 'Not estimated: no fee oracle is connected. Recorded fee at request: 0.'}</dd></div>
            <div><dt className="text-muted">Bridge route</dt><dd className="font-semibold">{kind === 'logical' ? 'Not applicable' : (src.chain_id === dst.chain_id ? `Same-chain transfer on ${src.chain_name}` : 'Cross-chain: not supported')}</dd></div>
            <div><dt className="text-muted">Signer approval</dt><dd className="font-semibold">{kind === 'logical' ? 'Not needed (no signing)' : 'No signer exists. Paper: simulated; live: blocked.'}</dd></div>
          </dl>
          {sBucket?.environment === 'live' && <Note tone="bad">Live ledger movements are restricted to the reconciliation service. The API will refuse this request.</Note>}
          {problems.map((p) => <Note key={p} tone="bad">{p}</Note>)}
          <Note><Info className="mr-1 inline size-4" aria-hidden />A pure internal ledger assignment is different from an actual token transfer. Only same-wallet transfers are pure ledger assignments.</Note>
        </div>}
        {step === 4 && <div className="space-y-4">
          {!txId ? (<>
            <p className="text-[14px]">Submitting sends <code>requestCapitalTransfer</code> with an idempotency key. Pressing the button twice cannot create two transfers.</p>
            <Note>{kind === 'physical' ? 'This is PHYSICAL: after submitting it will show as pending_finality and the destination will not be credited.' : 'This is LOGICAL: it will be confirmed atomically.'}</Note>
            {!canAdmin && <Note tone="warn">Only owners and admins may request transfers; the database will refuse otherwise.</Note>}
            <Button variant="primary" busy={submit.busy} disabled={!canAdmin} onClick={doSubmit}>Submit transfer</Button>
          </>) : (
            <div data-testid="transfer-tracking" className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-[14px]"><span className="font-semibold">Transfer {txId.slice(0, 8)}</span>{tr ? <Badge tone={statusTone(tr.status)}>{tr.status.replace('_', ' ')}</Badge> : <Badge>loading</Badge>}{tr && <Badge>{tr.kind}</Badge>}</div>
              {tr?.status === 'pending_finality' && <>
                <Note tone="warn">Pending finality: the destination has not been credited. In this paper environment you can simulate the outcome:</Note>
                <div className="flex flex-wrap gap-2"><Button variant="primary" busy={confirm.busy} disabled={!canAdmin} onClick={() => confirm.run({ transfer: txId }, { ok: 'Transfer confirmed (paper simulation)' })}>Simulate finality (confirm)</Button>
                  <Button variant="danger" busy={fail.busy} disabled={!canAdmin} onClick={() => fail.run({ transfer: txId }, { ok: 'Transfer failed; funds returned to source' })}>Simulate failure</Button></div></>}
              {tr?.status === 'confirmed' && <Note>Confirmed. The destination has been credited by the ledger.</Note>}
              {tr?.status === 'failed' && <Note tone="bad">Failed. The pending amount was returned to the source account.</Note>}
              <Button onClick={reset}>Start another transfer</Button>
            </div>)}
        </div>}
        <div className="flex justify-between border-t border-line pt-4">
          <Button onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0 || (step === 4 && !!txId)}>Back</Button>
          {step < 4 && <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>Next</Button>}
        </div></div>)}</Async>
    </Card>
  );
}

function Tracking({ workspace }: { workspace: string }) {
  const { cap, alloc, assetMap, bucketMap } = useCapital(); const { canAdmin } = useWorkspace();
  const confirm = useAction<any>('confirmPaperTransfer'); const fail = useAction<any>('failPaperTransfer');
  void workspace; void cap;
  return (
    <Card title="Transfer tracking">
      <Note>Status comes straight from <code>internal_transfers</code>. <strong>pending finality</strong> means the destination has not been credited. Paper transfers can be confirmed or failed here to exercise the lifecycle; live transfers are settled only by the settlement service.</Note>
      <div className="mt-4"><Async q={alloc} empty={(a: any) => a.transfers.length === 0}>{(d: any) => (
        <Table caption="Capital transfers" rows={d.transfers} cols={[
          { key: 'created_at', header: 'Requested', render: (t) => when(t.created_at), sort: (t) => t.created_at },
          { key: 'kind', header: 'Kind', filter: true, render: (t) => <Badge tone={t.kind === 'logical' ? 'good' : 'warn'}>{t.kind}</Badge>, text: (t) => t.kind },
          { key: 'status', header: 'Status', filter: true, render: (t) => <Badge tone={statusTone(t.status)}>{t.status.replace('_', ' ')}</Badge>, text: (t) => t.status },
          { key: 'env', header: 'Env', render: (t) => <EnvBadge env={bucketMap[t.src_bucket]?.environment ?? '?'} />, text: (t) => bucketMap[t.src_bucket]?.environment ?? '?' },
          { key: 'route', header: 'From to', render: (t) => `${bucketMap[t.src_bucket]?.name ?? '?'} to ${bucketMap[t.dst_bucket]?.name ?? '?'}`, text: (t) => `${bucketMap[t.src_bucket]?.name} ${bucketMap[t.dst_bucket]?.name}` },
          { key: 'amount', header: 'Amount', align: 'right', render: (t) => { const a = assetMap[t.asset_id]; return a ? `${formatUnits(t.amount, a.decimals)} ${a.symbol}` : t.amount; }, sort: (t) => String(t.amount).padStart(80, '0') },
          { key: 'act', header: 'Paper actions', render: (t) => t.status === 'pending_finality' && bucketMap[t.src_bucket]?.environment === 'paper'
            ? <span className="flex gap-2"><Button disabled={!canAdmin} busy={confirm.busy} onClick={() => confirm.run({ transfer: t.id }, { ok: 'Transfer confirmed (paper)' })}>Confirm</Button><Button variant="danger" disabled={!canAdmin} busy={fail.busy} onClick={() => fail.run({ transfer: t.id }, { ok: 'Transfer failed; funds returned' })}>Fail</Button></span> : <span className="text-muted">-</span> }]} />)}</Async></div>
    </Card>
  );
}

function VaultRelease({ workspace }: { workspace: string }) {
  const { cap, alloc, assetMap, bucketMap } = useCapital(); const { canOwn } = useWorkspace();
  const members = useWs<any>('settings/members');
  const [vb, setVb] = useState(''); const [wca, setWca] = useState(''); const [asset, setAsset] = useState(''); const [amt, setAmt] = useState('');
  const req = useAction<any>('requestVaultRelease'); const decide = useAction<any>('decideApproval'); const release = useAction<any>('releaseVault');
  const me = (members.data?.items ?? []).find((m: any) => m.is_you)?.user_id;
  const vaults = (cap.data?.buckets ?? []).filter((b: any) => b.kind === 'protected_vault');
  const accounts: AccountRow[] = (cap.data?.accounts ?? []).filter((a: AccountRow) => a.allocations.some((x) => x.bucket_id === vb));
  const vbal = (cap.data?.balances ?? []).filter((b: any) => b.bucket_id === vb && b.wca === wca && b.state === 'vault');
  const a = assetMap[asset]; let base: bigint | null = null, err: string | undefined;
  if (amt.trim() && a) { try { base = BigInt(parseUnits(amt, a.decimals)); } catch (e) { err = (e as Error).message; } }
  const held = BigInt(vbal.find((b: any) => b.asset_id === asset)?.amount ?? '0'); const over = base !== null && base > held;
  const rows = (alloc.data?.approvals ?? []).filter((x: any) => x.kind === 'vault_release');
  const now = Date.now();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <Card title="Four-eyes and delay rules">
        <ul className="list-disc space-y-1 pl-5 text-[13px] text-[#44546a]"><li>Only an <strong>owner</strong> can request a release.</li><li>A <strong>different owner</strong> must approve: the requester can never approve their own request (database rule <code>approver_differs</code>).</li>
          <li>Funds can be released only after the delay stored on the request (<code>not_before</code>, 24 hours from request) and only by an owner.</li><li>Release is one idempotent ledger entry; executing twice is a no-op.</li></ul>
      </Card>
      <Card title="Request a release">
        {vaults.length === 0 ? <EmptyState title="No protected vault bucket" hint="Create a bucket of kind protected vault first." /> : (
          <div className="grid gap-4 md:grid-cols-2">
            <Select label="Vault bucket" value={vb} onChange={(e) => { setVb(e.target.value); setWca(''); setAsset(''); }} options={[{ value: '', label: 'Select a vault' }, ...vaults.map((b: any) => ({ value: b.id, label: b.name }))]} />
            <Select label="Wallet / chain account" value={wca} onChange={(e) => { setWca(e.target.value); setAsset(''); }} disabled={!vb} options={[{ value: '', label: 'Select an account' }, ...accounts.map((x) => ({ value: x.wca, label: `${x.nickname} on ${x.chain_name}` }))]} />
            <Select label="Asset (vault balance)" value={asset} onChange={(e) => setAsset(e.target.value)} disabled={!wca} options={[{ value: '', label: vbal.length ? 'Select an asset' : 'No vault balance here' }, ...vbal.map((b: any) => ({ value: b.asset_id, label: `${b.symbol}: ${formatUnits(b.amount, b.decimals)}` }))]} />
            <TextInput label={`Amount${a ? ` (${a.symbol})` : ''}`} value={amt} onChange={(e) => setAmt(e.target.value)} disabled={!a} inputMode="decimal" error={err ?? (over ? 'Exceeds the vault balance' : undefined)} />
            <div className="md:col-span-2"><Button variant="primary" disabled={!canOwn || !a || base === null || base <= 0n || over} busy={req.busy}
              title={canOwn ? undefined : 'Owner only'} onClick={() => req.run({ workspace, vaultBucket: vb, walletChainAccount: wca, asset, amount: base!.toString() }, { ok: 'Release requested. A second owner must approve; the delay applies.', onDone: () => setAmt('') })}>Request release</Button></div>
          </div>)}
      </Card>
      <Card title="Release requests">
        <Async q={alloc} empty={() => rows.length === 0}>{() => (
          <Table caption="Vault release requests" rows={rows.map((r: any) => ({ ...r, amount: r.subject?.amount, assetId: r.subject?.asset, vault: r.subject?.vault_bucket }))} cols={[
            { key: 'status', header: 'Status', filter: true, render: (r) => <Badge tone={r.status === 'executed' ? 'good' : r.status === 'rejected' ? 'bad' : 'warn'}>{r.status}</Badge> },
            { key: 'vault', header: 'Vault', render: (r) => bucketMap[r.vault]?.name ?? '?' },
            { key: 'amount', header: 'Amount', align: 'right', render: (r) => { const x = assetMap[r.assetId]; return x ? `${formatUnits(r.amount, x.decimals)} ${x.symbol}` : r.amount; } },
            { key: 'requested_by', header: 'Requested by', render: (r) => (r.requested_by === me ? 'you' : String(r.requested_by).slice(0, 8)) },
            { key: 'approved_by', header: 'Approved by', render: (r) => (r.approved_by ? (r.approved_by === me ? 'you' : String(r.approved_by).slice(0, 8)) : '-') },
            { key: 'not_before', header: 'Delay / not before', render: (r) => { const left = new Date(r.not_before).getTime() - now; return `${when(r.not_before)} ${left > 0 ? `(${Math.ceil(left / 3600000)}h remaining)` : '(elapsed)'}`; } },
            { key: 'act', header: 'Action', render: (r) => {
              const left = new Date(r.not_before).getTime() - now;
              if (r.status === 'pending') return <span className="flex flex-wrap gap-2"><Button variant="primary" disabled={!canOwn || r.requested_by === me} title={r.requested_by === me ? 'Four-eyes: you requested this, a different owner must approve' : canOwn ? undefined : 'Owner only'} busy={decide.busy} onClick={() => decide.run({ approval: r.id, approve: true }, { ok: 'Approved' })}>Approve</Button>
                <Button variant="danger" disabled={!canOwn || r.requested_by === me} busy={decide.busy} onClick={() => decide.run({ approval: r.id, approve: false }, { ok: 'Rejected' })}>Reject</Button></span>;
              if (r.status === 'approved') return <Button variant="primary" disabled={!canOwn || left > 0} title={left > 0 ? 'Delay has not elapsed' : undefined} busy={release.busy} onClick={() => release.run({ approval: r.id }, { ok: 'Vault funds released to the wallet pool' })}>Execute release</Button>;
              return <span className="text-muted">-</span>; } }]} />)}</Async>
      </Card>
    </div>
  );
}

export default function TransfersPage() {
  const { current } = useWorkspace(); const [tab, setTab] = useState('new');
  return (
    <NeedWorkspace>
      <PageHeader title="Capital transfers" description="Move capital between buckets. A same-wallet move is an atomic ledger assignment; a cross-wallet move is a real transfer that stays pending until finality, and the destination is never credited early." />
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      {current && <>
        <TabPanel id="new" value={tab}><Wizard workspace={current.id} /></TabPanel>
        <TabPanel id="track" value={tab}><Tracking workspace={current.id} /></TabPanel>
        <TabPanel id="vault" value={tab}><VaultRelease workspace={current.id} /></TabPanel></>}
    </NeedWorkspace>
  );
}
