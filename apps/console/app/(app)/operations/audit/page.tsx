'use client';
import { useState } from 'react';
import { Download } from 'lucide-react';
import { Async, Badge, Button, Card, Dialog, EmptyState, PageHeader, Select, TextInput } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { OpsTabs } from '@/components/ops/OpsTabs';
import { useWs } from '@/components/hooks';
import { Note, Table, useAction } from '@/components/ops/common';
import { get } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { when } from '@/lib/format';
import { downloadCsv } from '@/lib/csv';

const PAGE = 25;
const sev = (s: string) => (s === 'critical' ? 'bad' : s === 'warn' ? 'warn' : 'neutral') as 'bad' | 'warn' | 'neutral';

function RecordIncident({ open, onClose, workspace }: { open: boolean; onClose: () => void; workspace: string }) {
  const act = useAction<any>('recordIncident'); const [cls, setCls] = useState('manual'); const [severity, setSeverity] = useState('warn'); const [msg, setMsg] = useState('');
  return (
    <Dialog open={open} onClose={onClose} title="Record an incident" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={msg.trim().length < 3 || cls.trim().length < 2} busy={act.busy} onClick={() => act.run({ workspace, class: cls.trim(), severity: severity as any, message: msg.trim() }, { ok: 'Incident recorded', onDone: () => { setMsg(''); onClose(); } })}>Record</Button></>}>
      <div className="space-y-4"><Note>Operator-reported incidents sit beside system alerts. They are written to the audit log and do not stop anything by themselves; use Risk Command for stop controls.</Note>
        <TextInput label="Class" value={cls} onChange={(e) => setCls(e.target.value)} maxLength={60} />
        <Select label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value)} options={['info', 'warn', 'critical'].map((s) => ({ value: s, label: s }))} />
        <TextInput label="What happened" value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={1000} />
      </div>
    </Dialog>
  );
}

export default function AuditPage() {
  const { current, canWrite } = useWorkspace();
  const [action, setAction] = useState(''); const [entity, setEntity] = useState(''); const [actor, setActor] = useState(''); const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState<any>(null); const [rec, setRec] = useState(false); const [ackNote, setAckNote] = useState<Record<string, string>>({});
  const qs = `&limit=${PAGE}&offset=${offset}` + (action ? `&action=${encodeURIComponent(action)}` : '') + (entity ? `&entity=${encodeURIComponent(entity)}` : '') + (actor ? `&actor=${actor}` : '')
    + (from ? `&from=${encodeURIComponent(new Date(from + 'T00:00:00').toISOString())}` : '') + (to ? `&to=${encodeURIComponent(new Date(to + 'T23:59:59').toISOString())}` : '');
  const audit = useWs<any>('audit/search', qs), inc = useWs<any>('risk/incidents');
  const ack = useAction<any>('acknowledgeAlert');
  if (!current) return <NeedWorkspace>{null}</NeedWorkspace>;
  const exportAll = async () => {
    const r = await get<any>(`v1/audit/search?workspace=${current.id}&limit=500&offset=0${qs.replace(/&limit=\d+&offset=\d+/, '')}`);
    downloadCsv('audit-events.csv', ['id', 'time', 'actor', 'action', 'entity', 'entity_id', 'environment', 'detail'], r.items.map((x: any) => [String(x.id), x.created_at, x.actor ?? '', x.action, x.entity, x.entity_id ?? '', x.environment ?? '', JSON.stringify(x.detail)]));
  };
  const reset = (fn: () => void) => { fn(); setOffset(0); };
  return (
    <NeedWorkspace>
      <PageHeader title="Audit and Incidents" description="Immutable event timeline (a database trigger rejects edits and deletes), plus open incidents with acknowledgement." actions={<>
        <Button onClick={() => setRec(true)} disabled={!canWrite}>Record incident</Button><Button onClick={exportAll}><Download className="size-4" aria-hidden />Export CSV (up to 500)</Button></>} />
      <OpsTabs />
      <div className="grid gap-5">
        <Card title="Open incidents and alerts">
          <Async q={inc}>{(d: any) => (<>
            <Note>{d.note}</Note>
            <div className="mt-3"><Table caption="Incidents" rows={d.alerts} empty={<EmptyState title="No incidents or alerts" hint="Nothing has been raised. That is not proof of health: no probes are running." />} cols={[
              { key: 'created_at', header: 'When', render: (a) => when(a.created_at), sort: (a) => a.created_at }, { key: 'severity', header: 'Severity', filter: true, render: (a) => <Badge tone={sev(a.severity)}>{a.severity}</Badge> },
              { key: 'class', header: 'Class', filter: true }, { key: 'message', header: 'Detail' }, { key: 'source', header: 'Source' },
              { key: 'state', header: 'State', filter: true, text: (a) => (a.acknowledged ? 'acknowledged' : 'open'), render: (a) => (a.acknowledged ? <span className="text-[12px]"><Badge tone="good">acknowledged</Badge> {a.ack_note}</span> : (
                <span className="flex flex-wrap items-center gap-2"><input aria-label={`Note for incident ${a.id}`} placeholder="Root cause / note" value={ackNote[a.id] ?? ''} onChange={(e) => setAckNote({ ...ackNote, [a.id]: e.target.value })} className="min-h-10 w-40 rounded-xl border border-line px-3 text-[13px]" />
                  <Button disabled={!canWrite} busy={ack.busy} onClick={() => ack.run({ alert: Number(a.id), ...(ackNote[a.id]?.trim() ? { note: ackNote[a.id].trim() } : {}) }, { ok: 'Acknowledged' })}>Acknowledge</Button></span>)) }]} /></div></>)}</Async>
        </Card>

        <Card title="Event timeline">
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Select label="Action" value={action} onChange={(e) => reset(() => setAction(e.target.value))} options={[{ value: '', label: 'All actions' }, ...((audit.data?.facets.actions ?? []) as string[]).map((a) => ({ value: a, label: a }))]} />
            <Select label="Entity" value={entity} onChange={(e) => reset(() => setEntity(e.target.value))} options={[{ value: '', label: 'All entities' }, ...((audit.data?.facets.entities ?? []) as string[]).map((a) => ({ value: a, label: a }))]} />
            <Select label="Actor" value={actor} onChange={(e) => reset(() => setActor(e.target.value))} options={[{ value: '', label: 'All actors' }, ...((audit.data?.facets.actors ?? []) as string[]).map((a) => ({ value: a, label: a.slice(0, 8) }))]} />
            <TextInput label="From date" type="date" value={from} onChange={(e) => reset(() => setFrom(e.target.value))} /><TextInput label="To date" type="date" value={to} onChange={(e) => reset(() => setTo(e.target.value))} />
          </div>
          <Async q={audit}>{(d: any) => (<>
            <Table caption="Audit events" rows={d.items.map((x: any) => ({ ...x, id: String(x.id) }))} onRow={setDetail} empty={<EmptyState title="No events match" hint="Clear the filters or perform an action to create events." />} cols={[
              { key: 'id', header: '#', sort: (x) => Number(x.id) }, { key: 'created_at', header: 'When', render: (x) => when(x.created_at), sort: (x) => x.created_at },
              { key: 'action', header: 'Action' }, { key: 'entity', header: 'Entity' }, { key: 'entity_id', header: 'Entity id', render: (x) => (x.entity_id ? String(x.entity_id).slice(0, 12) : '-') },
              { key: 'actor', header: 'Actor', render: (x) => (x.actor ? String(x.actor).slice(0, 8) : 'system') }, { key: 'environment', header: 'Env', render: (x) => x.environment ?? '-' },
              { key: 'view', header: '', render: (x) => <Button variant="ghost" onClick={(e) => { e.stopPropagation(); setDetail(x); }} aria-label={`Details of event ${x.id}`}>Details</Button> }]} />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[13px]"><span data-testid="audit-total">{d.total} event(s) match · showing {d.items.length ? offset + 1 : 0}-{offset + d.items.length}</span>
              <span className="flex gap-2"><Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button><Button disabled={offset + PAGE >= d.total} onClick={() => setOffset(offset + PAGE)}>Next</Button></span></div>
            <p className="mt-2 text-[12px] text-muted">{d.immutable}</p></>)}</Async>
        </Card>
      </div>
      <Dialog open={!!detail} onClose={() => setDetail(null)} side title={detail ? `Event ${detail.id}: ${detail.action}` : 'Event'}>
        {detail && <dl className="space-y-3 text-[13px]">
          {([['Time', when(detail.created_at)], ['Action', detail.action], ['Entity', `${detail.entity} ${detail.entity_id ?? ''}`], ['Actor', detail.actor ?? 'system'], ['Environment', detail.environment ?? 'n/a']] as [string, string][]).map(([k, v]) => <div key={k}><dt className="text-muted">{k}</dt><dd className="break-all font-semibold">{v}</dd></div>)}
          <div><dt className="text-muted">Detail</dt><dd><pre className="overflow-x-auto rounded-xl bg-[#f6f8fb] p-3 text-[12px]">{JSON.stringify(detail.detail, null, 2)}</pre></dd></div></dl>}
      </Dialog>
      <RecordIncident open={rec} onClose={() => setRec(false)} workspace={current.id} />
    </NeedWorkspace>
  );
}
