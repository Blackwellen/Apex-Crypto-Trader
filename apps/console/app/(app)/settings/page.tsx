'use client';
import { useState } from 'react';
import { Async, Badge, Button, Card, EmptyState, PageHeader, TextInput } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { useWs } from '@/components/hooks';
import { Note, Table, useAction } from '@/components/ops/common';
import { useWorkspace } from '@/lib/workspace';
import { when } from '@/lib/format';

const LIMITS: { key: string; label: string; unit: string }[] = [
  { key: 'max_order_notional_bps_of_bucket', label: 'Max order notional', unit: 'bps of bucket' },
  { key: 'max_slippage_bps', label: 'Max slippage', unit: 'bps' },
  { key: 'max_quote_age_ms', label: 'Max quote age', unit: 'ms' }];
// Derived from the assert_role() calls in migrations 0005/0006/0200/0220 (the database is the authority, this table only explains it).
const MATRIX: [string, string, string, string, string][] = [
  ['View all workspace data', 'yes', 'yes', 'yes', 'yes'],
  ['Halt new entries / pause jobs / scoped halt', 'yes', 'yes', 'yes', 'no'],
  ['Acknowledge incidents', 'yes', 'yes', 'yes', 'no'],
  ['Resume after a halt (global, bucket, wallet)', 'yes', 'yes', 'no', 'no'],
  ['Create portfolios, buckets, wallets; allocate; transfers; policies', 'yes', 'yes', 'no', 'no'],
  ['Compounding policies and targets', 'yes', 'yes', 'no', 'no'],
  ['Confirm / fail paper transfers; retry jobs; reconciliation exceptions', 'yes', 'yes', 'no', 'no'],
  ['Sign off deployment gates; live opt-in', 'yes', 'no', 'no', 'no'],
  ['Vault release request / approve / execute', 'yes', 'no', 'no', 'no'],
  ['Tighten or request changes to global limits', 'yes', 'no', 'no', 'no']];

function Limits({ workspace, limits, approvals, canOwn, me }: { workspace: string; limits: Record<string, number>; approvals: any[]; canOwn: boolean; me?: string }) {
  const [vals, setVals] = useState<Record<string, string>>({}); const tighten = useAction<any>('tightenGlobalLimits'); const incr = useAction<any>('requestLimitIncrease');
  const decide = useAction<any>('decideApproval'); const apply = useAction<any>('applyLimitIncrease'); const [why, setWhy] = useState('');
  const parsed: Record<string, number> = {}; let bad = false;
  for (const l of LIMITS) { const v = (vals[l.key] ?? '').trim(); if (v === '') continue; if (!/^\d{1,9}$/.test(v)) { bad = true; continue; } parsed[l.key] = Number(v); }
  const entries = Object.entries(parsed); const tighter = entries.filter(([k, v]) => v < limits[k]); const looser = entries.filter(([k, v]) => v > limits[k]);
  const reasonOk = why.trim().length >= 3;
  const pend = approvals.filter((a) => a.kind === 'permission_increase');
  return (
    <div className="space-y-5">
      <Table searchable={false as any} caption="Global hard limits" rows={LIMITS.map((l) => ({ id: l.key, ...l, v: limits[l.key] }))} cols={[{ key: 'label', header: 'Limit' }, { key: 'unit', header: 'Unit' }, { key: 'v', header: 'Current value', align: 'right' }, { key: 'src', header: 'Authority', render: () => <code className="text-[12px]">workspace_settings.global_limits</code> }]} />
      <Note>Limits can only be <strong>tightened</strong> from here. Raising a limit needs an approval request that a <strong>second owner</strong> must approve and that only takes effect after the stored delay. Bucket policies may never exceed these.</Note>
      <div className="grid gap-3 sm:grid-cols-3">{LIMITS.map((l) => <TextInput key={l.key} label={`New ${l.label.toLowerCase()} (${l.unit})`} inputMode="numeric" value={vals[l.key] ?? ''} onChange={(e) => setVals({ ...vals, [l.key]: e.target.value })} placeholder={String(limits[l.key] ?? '')} />)}</div>
      <TextInput label="Reason (audit log)" value={why} onChange={(e) => setWhy(e.target.value)} />
      {bad && <p role="alert" className="text-[12px] text-bad">Limits must be whole numbers.</p>}
      {looser.length > 0 && <Note tone="warn">{looser.map(([k]) => k).join(', ')} would be <strong>loosened</strong>. That cannot be applied directly: use the request button, which creates a pending approval.</Note>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={!canOwn || bad || !reasonOk || tighter.length === 0 || looser.length > 0} title={canOwn ? undefined : 'Owner only'} busy={tighten.busy} onClick={() => tighten.run({ workspace, limits: Object.fromEntries(tighter) as any, reason: why.trim() }, { ok: 'Limits tightened', onDone: () => setVals({}) })}>Apply tighter limits</Button>
        <Button disabled={!canOwn || bad || !reasonOk || looser.length === 0} busy={incr.busy} onClick={() => incr.run({ workspace, limits: Object.fromEntries(looser) as any, reason: why.trim() }, { ok: 'Increase requested: a second owner must approve it', onDone: () => setVals({}) })}>Request an increase</Button>
      </div>
      <h3 className="text-[14px] font-semibold">Pending and past limit-increase requests</h3>
      {pend.length === 0 ? <EmptyState title="No limit-increase requests" /> : (
        <Table caption="Limit increase requests" rows={pend} cols={[
          { key: 'status', header: 'Status', render: (a) => <Badge tone={a.status === 'executed' ? 'good' : a.status === 'rejected' ? 'bad' : 'warn'}>{a.status}</Badge> },
          { key: 'limits', header: 'Requested limits', render: (a) => <span className="font-mono text-[12px]">{JSON.stringify(a.subject?.limits)}</span> }, { key: 'reason', header: 'Reason', render: (a) => a.subject?.reason ?? '' },
          { key: 'not_before', header: 'Not before', render: (a) => when(a.not_before) },
          { key: 'act', header: 'Action', render: (a) => {
            const left = new Date(a.not_before).getTime() - Date.now();
            if (a.status === 'pending') return <span className="flex gap-2"><Button variant="primary" disabled={!canOwn || a.requested_by === me} title={a.requested_by === me ? 'Four-eyes: a different owner must approve' : undefined} busy={decide.busy} onClick={() => decide.run({ approval: a.id, approve: true }, { ok: 'Approved' })}>Approve</Button><Button variant="danger" disabled={!canOwn || a.requested_by === me} busy={decide.busy} onClick={() => decide.run({ approval: a.id, approve: false }, { ok: 'Rejected' })}>Reject</Button></span>;
            if (a.status === 'approved') return <Button variant="primary" disabled={!canOwn || left > 0} title={left > 0 ? 'Delay has not elapsed' : undefined} busy={apply.busy} onClick={() => apply.run({ approval: a.id }, { ok: 'Limits raised' })}>Apply</Button>;
            return <span className="text-muted">-</span>; } }]} />)}
    </div>
  );
}

export default function SettingsPage() {
  const { current, canOwn } = useWorkspace();
  const ov = useWs<any>('settings/overview'), mem = useWs<any>('settings/members'), integ = useWs<any>('settings/integrations'), alloc = useWs<any>('allocations');
  if (!current) return <NeedWorkspace>{null}</NeedWorkspace>;
  const me = (mem.data?.items ?? []).find((m: any) => m.is_you)?.user_id;
  return (
    <NeedWorkspace>
      <PageHeader title="Settings" description="Workspace, members, limits and integrations. Nothing here is shown as connected unless it truly is." />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        <Card title="Workspace"><Async q={ov}>{(d: any) => (
          <dl className="grid gap-4 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-muted">Name</dt><dd className="font-semibold">{d.workspace.name}</dd></div><div><dt className="text-muted">Base currency</dt><dd className="font-semibold">{d.workspace.base_currency}</dd></div>
            <div><dt className="text-muted">Created</dt><dd className="font-semibold">{when(d.workspace.created_at)}</dd></div><div><dt className="text-muted">Your role</dt><dd className="font-semibold">{d.yourRole}</dd></div>
            <div className="sm:col-span-2 lg:col-span-4"><dt className="text-muted">Authentication</dt><dd className="font-semibold">{d.authMode === 'dev' ? <><Badge tone="warn">LOCAL DEV AUTH</Badge> Not production authentication. MFA is not enforced.</> : 'JWT verification (Supabase-compatible)'}</dd></div>
          </dl>)}</Async></Card>

        <Card title="Members">
          <Async q={mem}>{(d: any) => (<>
            <Table caption="Workspace members" rows={d.items.map((m: any) => ({ ...m, id: m.user_id }))} cols={[{ key: 'email', header: 'Email', render: (m) => m.email ?? <span className="text-muted">hidden (owner/admin only)</span> },
              { key: 'role', header: 'Role', filter: true, render: (m) => <Badge tone={m.role === 'owner' ? 'accent' : 'neutral'}>{m.role}</Badge> }, { key: 'user_id', header: 'User id', render: (m) => <span className="font-mono text-[11px]">{String(m.user_id).slice(0, 8)}{m.is_you ? ' (you)' : ''}</span> }, { key: 'joined_at', header: 'Joined', render: (m) => when(m.joined_at) }]} />
            <div className="mt-4 flex flex-wrap items-center gap-3"><Button disabled aria-describedby="invite-note">Invite member</Button><p id="invite-note" className="text-[12px] text-muted">{d.inviteNote}</p></div></>)}</Async>
        </Card>

        <Card title="Role matrix (what each role can do)">
          <div className="overflow-x-auto rounded-xl border border-line" tabIndex={0} role="region" aria-label="Role matrix (scrollable)"><table className="w-full min-w-[560px] text-left text-[13px]" data-testid="role-matrix"><caption className="sr-only">Role permission matrix</caption>
            <thead className="bg-[#f6f8fb] text-[11px] uppercase tracking-wider text-muted"><tr><th scope="col" className="px-4 py-3">Capability</th>{['Owner', 'Admin', 'Trader', 'Viewer'].map((r) => <th key={r} scope="col" className="px-4 py-3">{r}</th>)}</tr></thead>
            <tbody>{MATRIX.map((r) => <tr key={r[0]} className="border-t border-line"><th scope="row" className="px-4 py-2 font-medium">{r[0]}</th>{r.slice(1).map((c, i) => <td key={i} className="px-4 py-2">{c === 'yes' ? 'Yes' : 'No'}</td>)}</tr>)}</tbody></table></div>
          <p className="mt-2 text-[12px] text-muted">The UI greys out actions your role cannot perform, but the database re-checks the role on every command; this table only explains it.</p>
        </Card>

        <Card title="Safe-mode defaults"><Async q={ov}>{(d: any) => (
          <ul className="space-y-2 text-[13px]">
            <li><Badge tone="good">Default</Badge> New workspaces start in the <strong>paper</strong> environment with live trading <strong>disabled</strong>.</li>
            <li><Badge tone={d.settings.live_allowed ? 'bad' : 'good'}>Now</Badge> Live execution is <strong>{d.settings.live_allowed ? 'ENABLED' : 'LOCKED'}</strong>. It needs every gate PASS with evidence, the owner opt-in ({String(d.settings.live_opt_in)}), the operator flag ({String(d.settings.live_feature_flag)}) and an active global state ({d.settings.global_state}).</li>
            <li><Badge>Default</Badge> The paper engine is {d.settings.paper_running ? 'flagged to run' : 'stopped'}; emergency stop forces it off.</li>
            <li><Badge>Default</Badge> Live portfolios and live ledger mutations are refused by the database unless live is allowed / done by the reconciliation service.</li></ul>)}</Async></Card>

        <Card title="Global limits"><Async q={ov}>{(d: any) => <Limits workspace={current.id} limits={d.settings.global_limits} approvals={alloc.data?.approvals ?? []} canOwn={canOwn} me={me} />}</Async></Card>

        <Card title="Feature flags (read-only)"><Async q={ov}>{(d: any) => <Table searchable={false as any} caption="Feature flags" rows={d.flags.map((f: any) => ({ ...f, id: f.key }))} cols={[{ key: 'key', header: 'Flag' }, { key: 'value', header: 'Value', render: (f) => <Badge tone={f.value ? 'warn' : 'neutral'}>{String(f.value)}</Badge> }, { key: 'source', header: 'Source', render: (f) => <code className="text-[12px]">{f.source}</code> }, { key: 'note', header: 'Note' }]} />}</Async></Card>

        <Card title="Integrations">
          <Note>Status is derived from configuration presence only. No integration is probed live, so nothing is ever shown as healthy.</Note>
          <div className="mt-4"><Async q={integ}>{(d: any) => (<div className="grid gap-4 lg:grid-cols-2">
            {d.items.map((i: any) => (
              <section key={i.key} aria-label={i.name} className="rounded-xl border border-line p-4" data-testid={`integration-${i.key}`}>
                <div className="flex items-center justify-between gap-2"><h3 className="text-[14px] font-semibold">{i.name}</h3><Badge tone={i.status === 'BLOCKED' ? 'bad' : i.status.startsWith('CONFIGURED') ? 'warn' : 'neutral'}>{i.status}</Badge></div>
                <p className="mt-1 text-[13px] text-muted">{i.detail}</p>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-[13px]">{i.setup.map((s: string) => <li key={s}>{s}</li>)}</ol>
              </section>))}</div>)}</Async></div>
        </Card>

        <Card title="Data retention and export"><Async q={integ}>{(d: any) => <p className="text-[13px]">{d.retention}</p>}</Async></Card>
      </div>
    </NeedWorkspace>
  );
}
