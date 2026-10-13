'use client';
import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Badge, Button, ConfirmDialog, Dialog, Select, Stepper, TextInput } from '@/components/ui';
import { Note, useAction } from '@/components/ops/common';
import { useApi } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';

// ---------------------------------------------------------------- gate sign-off (owner only; evidence + commit SHA mandatory)
export function GateDialog({ open, onClose, workspace, gate }: { open: boolean; onClose: () => void; workspace: string; gate: any }) {
  const [status, setStatus] = useState('PASS'); const [ev, setEv] = useState(''); const [sha, setSha] = useState('');
  const act = useAction<any>('approveDeploymentGate');
  const evOk = ev.trim().length >= 3, shaOk = /^[0-9a-fA-F]{7,64}$/.test(sha.trim());
  const need = status !== 'NOT_RUN'; const ok = !need || (evOk && shaOk);
  return (
    <Dialog open={open} onClose={onClose} title={`Sign off gate: ${gate?.gate_key ?? ''}`} footer={<><Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!ok} busy={act.busy} onClick={() => act.run({ workspace, gate: gate.gate_key, status: status as any, ...(need ? { evidenceRef: ev.trim(), commitSha: sha.trim() } : {}) }, { ok: `Gate ${gate.gate_key} recorded as ${status}`, onDone: () => { setEv(''); setSha(''); onClose(); } })}>Record {status}</Button></>}>
      <div className="space-y-4">
        <p className="text-[13px] text-muted">{gate?.description}</p>
        <Note tone="warn">Only record a result you have evidence for. A PASS without a verifiable evidence reference and the commit SHA it was produced on is refused by the API and the database. Live execution unlocks only when <strong>every</strong> gate is PASS, the owner opts in, <em>and</em> the operator feature flag is set.</Note>
        <Select label="Result" value={status} onChange={(e) => setStatus(e.target.value)} options={['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'].map((s) => ({ value: s, label: s }))} />
        {need && <>
          <TextInput label="Evidence reference (log path, run id, report URL)" value={ev} onChange={(e) => setEv(e.target.value)} error={ev && !evOk ? 'At least 3 characters' : undefined} hint="e.g. docs/evidence/runs/20260101T000000Z-ledger.log" />
          <TextInput label="Commit SHA (7-64 hex characters)" value={sha} onChange={(e) => setSha(e.target.value)} error={sha && !shaOk ? 'Hex characters only, 7 to 64' : undefined} />
        </>}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- live opt-in (high friction)
export function LiveOptIn({ workspace, optIn, flag, liveAllowed, gatesPassing, gatesTotal }: { workspace: string; optIn: boolean; flag: boolean; liveAllowed: boolean; gatesPassing: number; gatesTotal: number }) {
  const { canOwn } = useWorkspace(); const [open, setOpen] = useState(false); const act = useAction<any>('setLiveOptIn');
  return (<div className="space-y-3 text-[13px]">
    <div className="flex flex-wrap gap-2"><Badge tone={optIn ? 'warn' : 'neutral'}>Owner opt-in: {optIn ? 'ON' : 'OFF'}</Badge><Badge tone={flag ? 'warn' : 'neutral'}>Operator flag: {flag ? 'SET' : 'NOT SET'}</Badge>
      <Badge tone={gatesPassing === gatesTotal ? 'good' : 'bad'}>Gates: {gatesPassing}/{gatesTotal} PASS</Badge><Badge tone={liveAllowed ? 'bad' : 'good'}>Live execution: {liveAllowed ? 'ENABLED' : 'LOCKED'}</Badge></div>
    <p className="text-muted">Live stays <strong>locked</strong> unless <strong>all</strong> deployment gates PASS with evidence <em>and</em> the operator flag is set, <em>and</em> you opt in. Turning the opt-in on does not unlock live by itself, and the operator flag cannot be set from this console.</p>
    <Button variant={optIn ? 'secondary' : 'danger'} disabled={!canOwn} title={canOwn ? undefined : 'Owner only'} onClick={() => setOpen(true)} data-testid="live-optin-toggle">{optIn ? 'Turn live opt-in OFF' : 'Turn live opt-in ON'}</Button>
    <ConfirmDialog open={open} onClose={() => setOpen(false)} danger={!optIn} phrase={optIn ? undefined : 'ENABLE LIVE'} confirmLabel={optIn ? 'Turn off' : 'Record opt-in'} busy={act.busy}
      title={optIn ? 'Turn live opt-in off' : 'Opt in to live trading'}
      body={optIn ? <p>Live opt-in will be withdrawn. Live execution stays locked.</p> : (<div className="space-y-2"><p>You are recording an <strong>intent</strong> to allow live trading in the future. It does <strong>not</strong> unlock live by itself:</p>
        <ul className="list-disc pl-5"><li>All {gatesTotal} deployment gates must be PASS with evidence ({gatesPassing} are).</li><li>The operator feature flag must be set ({flag ? 'it is' : 'it is not'}).</li><li>The global state must be active.</li></ul><p>This action is audited.</p></div>)}
      onConfirm={() => act.run({ workspace, on: !optIn }, { ok: optIn ? 'Live opt-in off' : 'Live opt-in recorded (live remains locked until every condition holds)', onDone: () => setOpen(false) })} />
  </div>);
}

// ---------------------------------------------------------------- emergency workflow E-01..E-04
const STEPS_E = ['E-01 Scope', 'E-02 Exit policy', 'E-03 Confirm', 'E-04 Observe'];
export function EmergencyWizard({ open, onClose, workspace, buckets, wallets, observe }: { open: boolean; onClose: () => void; workspace: string; buckets: any[]; wallets: any[]; observe: { pendingTransfers: number; unknownOrders: number; openIntents: number; globalState: string } }) {
  const { canWrite } = useWorkspace();
  const [step, setStep] = useState(0); const [scope, setScope] = useState<'global' | 'bucket' | 'wallet'>('global'); const [target, setTarget] = useState(''); const [policy, setPolicy] = useState('halt'); const [reason, setReason] = useState(''); const [typed, setTyped] = useState(''); const [done, setDone] = useState<string | null>(null);
  const pause = useAction<any>('pauseNewEntries'), exit = useAction<any>('enterExitOnly'), stop = useAction<any>('emergencyStop'), bstate = useAction<any>('setBucketState'), wpause = useAction<any>('pauseWallet');
  const phrase = scope === 'wallet' ? 'PAUSE' : policy === 'halt' ? 'HALT' : policy === 'exit' ? 'EXIT ONLY' : 'STOP';
  const busy = pause.busy || exit.busy || stop.busy || bstate.busy || wpause.busy;
  const reasonOk = reason.trim().length >= 3;
  const scopeOk = scope === 'global' || !!target;
  const run = async () => {
    const why = reason.trim(); let r: any;
    if (scope === 'global') r = await (policy === 'halt' ? pause : policy === 'exit' ? exit : stop).run({ workspace, reason: why }, { ok: 'Applied' });
    else if (scope === 'bucket') r = await bstate.run({ bucket: target, state: policy === 'halt' ? 'halt_new_entries' : policy === 'exit' ? 'exit_only' : 'disabled', reason: why }, { ok: 'Applied to bucket' });
    else r = await wpause.run({ wallet: target, reason: why }, { ok: 'Wallet paused' });
    if (r) { setDone(`${scope}:${policy}`); setStep(3); }
  };
  const reset = () => { setStep(0); setScope('global'); setTarget(''); setPolicy('halt'); setReason(''); setTyped(''); setDone(null); onClose(); };
  return (
    <Dialog open={open} onClose={reset} title="Emergency controls" footer={<>
      {step < 3 && <Button onClick={() => (step === 0 ? reset() : setStep(step - 1))}>{step === 0 ? 'Cancel' : 'Back'}</Button>}
      {step < 2 && <Button variant="primary" disabled={step === 0 ? !scopeOk : !reasonOk} onClick={() => setStep(step + 1)}>Next</Button>}
      {step === 2 && <Button variant="danger" disabled={!canWrite || typed.trim().toUpperCase() !== phrase} busy={busy} onClick={run}>Apply now</Button>}
      {step === 3 && <Button variant="primary" onClick={reset}>Close</Button>}</>}>
      <Stepper steps={STEPS_E} current={step} />
      {step === 0 && <div className="space-y-4">
        <Select label="Scope" value={scope} onChange={(e) => { setScope(e.target.value as any); setTarget(''); }} options={[{ value: 'global', label: 'Global (whole workspace)' }, { value: 'bucket', label: 'One bucket' }, { value: 'wallet', label: 'One wallet' }]} />
        {scope === 'bucket' && <Select label="Bucket" value={target} onChange={(e) => setTarget(e.target.value)} options={[{ value: '', label: 'Select a bucket' }, ...buckets.map((b) => ({ value: b.id, label: `${b.name} (${b.state})` }))]} />}
        {scope === 'wallet' && <Select label="Wallet" value={target} onChange={(e) => setTarget(e.target.value)} options={[{ value: '', label: 'Select a wallet' }, ...wallets.map((w) => ({ value: w.id, label: `${w.nickname} (${w.state})` }))]} />}
        <Note>Chain, strategy and venue scopes are <strong>not available</strong>: the schema has no workspace-scoped disable switch for them yet, so they are not offered rather than faked.</Note>
        <TextInput label="Reason (recorded in the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} error={reason && !reasonOk ? 'At least 3 characters' : undefined} />
      </div>}
      {step === 1 && <div className="space-y-4">
        {scope === 'wallet' ? <Note>Pausing a wallet takes it out of service. Owner/admin only. Wallets with open obligations can still be paused; archiving/revoking is refused until they settle.</Note> : <Select label="Exit policy" value={policy} onChange={(e) => setPolicy(e.target.value)} options={[
          { value: 'halt', label: 'Halt new entries (existing orders keep settling)' }, { value: 'exit', label: 'Exit-only (only risk-reducing exits allowed)' }, { value: 'stop', label: scope === 'global' ? 'Emergency stop (halts entries and stops the paper engine)' : 'Disable bucket' }]} />}
        <Note>All of these stop <strong>new entries only</strong>. Settlement watchers and risk-reducing exit capacity keep running by design. Cancel-safe-orders and reduce-position actions need an execution engine and are not available yet. Resuming requires an owner or admin.</Note>
      </div>}
      {step === 2 && <div className="space-y-4">
        <div className="rounded-xl border border-[#f3c9c5] bg-bad-soft p-4 text-[13px] text-bad"><AlertTriangle className="mr-1 inline size-4" aria-hidden />You are about to apply <strong>{scope === 'global' ? 'a GLOBAL' : `a ${scope}`} {scope === 'wallet' ? 'pause' : policy === 'halt' ? 'halt of new entries' : policy === 'exit' ? 'exit-only mode' : 'emergency stop'}</strong>. Reason: {reason}</div>
        <TextInput label={`Type ${phrase} to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
      </div>}
      {step === 3 && <div className="space-y-3" data-testid="emergency-observe">
        <Note>Applied ({done}). Now observe that settlement continues. These figures refresh automatically:</Note>
        <dl className="grid gap-3 text-[13px] sm:grid-cols-2">
          <div><dt className="text-muted">Global state</dt><dd className="font-semibold">{observe.globalState.replace(/_/g, ' ')}</dd></div>
          <div><dt className="text-muted">Transfers still settling</dt><dd className="font-semibold">{observe.pendingTransfers}</dd></div>
          <div><dt className="text-muted">UNKNOWN orders awaiting reconciliation</dt><dd className="font-semibold">{observe.unknownOrders}</dd></div>
          <div><dt className="text-muted">Open order intents</dt><dd className="font-semibold">{observe.openIntents}</dd></div></dl>
        <p className="text-[12px] text-muted">No settlement worker is deployed in this stack, so pending items only advance when something (a worker, or the paper lifecycle buttons) advances them.</p>
      </div>}
    </Dialog>
  );
}

// ---------------------------------------------------------------- risk policy update R-01..R-04 (bucket policy)
const STEPS_R = ['R-01 Current', 'R-02 Edit & diff', 'R-03 Conflicts', 'R-04 Approve'];
export function RiskPolicyWizard({ open, onClose, bucket, limits }: { open: boolean; onClose: () => void; bucket: any; limits: Record<string, number> }) {
  const { canAdmin } = useWorkspace();
  const detail = useApi<any>(open ? `v1/buckets/${bucket.id}` : null);
  const cur = bucket.policy ?? {};
  const [step, setStep] = useState(0); const [slip, setSlip] = useState(String(cur.max_slippage_bps ?? '')); const [notional, setNotional] = useState(String(cur.max_order_notional_bps_of_bucket ?? '')); const [typed, setTyped] = useState('');
  const act = useAction<any>('updateBucketPolicy'); const err = act.error;
  const num = (s: string) => (s.trim() === '' ? undefined : /^\d{1,6}$/.test(s.trim()) ? Number(s) : NaN);
  const n1 = num(slip), n2 = num(notional);
  const bad = Number.isNaN(n1) || Number.isNaN(n2);
  const next: Record<string, unknown> = { ...cur }; if (n1 !== undefined && !Number.isNaN(n1)) next.max_slippage_bps = n1; if (n2 !== undefined && !Number.isNaN(n2)) next.max_order_notional_bps_of_bucket = n2;
  const keys = [...new Set([...Object.keys(cur), ...Object.keys(next)])];
  const changed = keys.filter((k) => JSON.stringify(cur[k]) !== JSON.stringify(next[k]));
  const conflicts: string[] = [];
  if (n1 !== undefined && !Number.isNaN(n1) && limits.max_slippage_bps !== undefined && n1 > limits.max_slippage_bps) conflicts.push(`max_slippage_bps ${n1} exceeds the global hard limit ${limits.max_slippage_bps}`);
  if (n2 !== undefined && !Number.isNaN(n2) && limits.max_order_notional_bps_of_bucket !== undefined && n2 > limits.max_order_notional_bps_of_bucket) conflicts.push(`max_order_notional_bps_of_bucket ${n2} exceeds the global hard limit ${limits.max_order_notional_bps_of_bucket}`);
  const submit = async () => {
    await act.run({ bucket: bucket.id, expectedVersion: bucket.policy_version, policy: next } as any, { ok: `Policy v${bucket.policy_version + 1} saved`, onDone: () => { setStep(0); onClose(); } });
  };
  return (
    <Dialog open={open} onClose={onClose} title={`Risk policy: ${bucket.name}`} footer={<><Button onClick={() => (step === 0 ? onClose() : setStep(step - 1))}>{step === 0 ? 'Cancel' : 'Back'}</Button>
      {step < 3 ? <Button variant="primary" disabled={step === 1 && (bad || changed.length === 0)} onClick={() => setStep(step + 1)}>Next</Button>
        : <Button variant="primary" disabled={!canAdmin || typed.trim() !== bucket.name} busy={act.busy} onClick={submit}>Save policy version {bucket.policy_version + 1}</Button>}</>}>
      <Stepper steps={STEPS_R} current={step} />
      {step === 0 && <div className="space-y-3 text-[13px]"><Note>Hierarchy: global &gt; portfolio &gt; bucket &gt; wallet &gt; basket &gt; strategy &gt; order. A child limit can never exceed the global hard limit.</Note>
        <dl className="grid gap-2 sm:grid-cols-2"><div><dt className="text-muted">Current version</dt><dd className="font-semibold">v{bucket.policy_version}</dd></div>
          <div><dt className="text-muted">Global limits</dt><dd className="font-mono text-[12px]">{JSON.stringify(limits)}</dd></div></dl>
        <div><div className="text-muted">Current policy</div><pre className="overflow-x-auto rounded-xl bg-[#f6f8fb] p-3 text-[12px]">{JSON.stringify(cur, null, 2)}</pre></div>
        <div><div className="text-muted">Previous versions</div>{(detail.data?.policyVersions ?? []).length === 0 ? <p>None loaded.</p> : <ul className="list-disc pl-5">{detail.data.policyVersions.map((v: any) => <li key={v.version}>v{v.version}: <span className="font-mono text-[12px]">{JSON.stringify(v.policy)}</span></li>)}</ul>}</div></div>}
      {step === 1 && <div className="space-y-4">
        <TextInput label="Max slippage (bps)" value={slip} onChange={(e) => setSlip(e.target.value)} inputMode="numeric" error={Number.isNaN(n1) ? 'Whole number' : undefined} hint={`Global hard limit: ${limits.max_slippage_bps ?? 'n/a'}`} />
        <TextInput label="Max order notional (bps of bucket)" value={notional} onChange={(e) => setNotional(e.target.value)} inputMode="numeric" error={Number.isNaN(n2) ? 'Whole number' : undefined} hint={`Global hard limit: ${limits.max_order_notional_bps_of_bucket ?? 'n/a'}`} />
        <div className="overflow-x-auto rounded-xl border border-line"><table className="w-full min-w-[320px] text-[13px]" data-testid="policy-diff"><caption className="sr-only">Policy diff</caption><thead className="bg-[#f6f8fb] text-left text-[11px] uppercase text-muted"><tr><th className="px-3 py-2">Field</th><th className="px-3 py-2">Current</th><th className="px-3 py-2">New</th></tr></thead>
          <tbody>{changed.length === 0 ? <tr><td colSpan={3} className="px-3 py-3 text-muted">No change yet.</td></tr> : changed.map((k) => <tr key={k} className="border-t border-line"><td className="px-3 py-2 font-mono text-[12px]">{k}</td><td className="px-3 py-2">{JSON.stringify(cur[k]) ?? 'unset'}</td><td className="px-3 py-2 font-semibold">{JSON.stringify(next[k]) ?? 'unset'}</td></tr>)}</tbody></table></div></div>}
      {step === 2 && <div className="space-y-3">
        {conflicts.length === 0 ? <Note>No conflict with the global hard limits was found in the fields you changed.</Note> : conflicts.map((c) => <Note key={c} tone="bad">{c}. The API will reject this as written; you can still submit to see the exact server message.</Note>)}
        <Note>Exposure impact: policy changes apply to <strong>new</strong> intents only. Existing positions and reservations are not modified.</Note>
      </div>}
      {step === 3 && <div className="space-y-4">
        <Note tone="warn">Privileged change: recorded as policy version {bucket.policy_version + 1} with your identity in the audit log. Optimistic concurrency applies: if someone else changed the policy meanwhile, the save is refused (409).</Note>
        <TextInput label={`Type the bucket name (${bucket.name}) to approve`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        {!canAdmin && <Note tone="bad">Owner or admin role required.</Note>}
        {err && <div role="alert" className="rounded-xl border border-[#f3c9c5] bg-bad-soft p-3 text-[13px] text-bad" data-testid="policy-error">{err}</div>}
      </div>}
    </Dialog>
  );
}
