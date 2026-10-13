'use client';
import { useState } from 'react';
import { Async, Badge, Button, Card, ConfirmDialog, EmptyState, Kpi, PageHeader } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { OpsTabs } from '@/components/ops/OpsTabs';
import { useWs } from '@/components/hooks';
import { Note, Table, useAction } from '@/components/ops/common';
import { useWorkspace } from '@/lib/workspace';
import { when } from '@/lib/format';

export default function JobsPage() {
  const { current, canWrite, canAdmin } = useWorkspace();
  const sum = useWs<any>('jobs/summary');
  const [pauseOpen, setPauseOpen] = useState(false);
  const pause = useAction<any>('pauseNonEssentialJobs'), resume = useAction<any>('resumeNonEssentialJobs'), retry = useAction<any>('retryJob');
  if (!current) return <NeedWorkspace>{null}</NeedWorkspace>;
  return (
    <NeedWorkspace>
      <PageHeader title="Operations" description="Job queue state straight from the jobs table. Pausing non-essential work never touches essential safety and settlement jobs." />
      <OpsTabs />
      <Async q={sum}>{(d: any) => {
        const n = (st: string[]) => d.groups.filter((g: any) => st.includes(g.status)).reduce((a: number, g: any) => a + g.n, 0);
        const total = d.groups.reduce((a: number, g: any) => a + g.n, 0);
        return (<div className="grid grid-cols-[minmax(0,1fr)] gap-5">
          <Note tone="warn"><strong>Worker status:</strong> {d.note} Evidence in the table: {d.workerEvidence.jobsHoldingALock} job(s) hold a worker lock, {d.workerEvidence.jobsRunning} marked running{d.workerEvidence.newestJobAt ? `, newest job ${when(d.workerEvidence.newestJobAt)}` : ', no jobs have ever been enqueued'}.</Note>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <Kpi label="Total jobs" value={total} /><Kpi label="Queued" value={n(['queued'])} /><Kpi label="Running" value={n(['running'])} /><Kpi label="Done" value={n(['done'])} tone="good" />
            <Kpi label="Failed / dead-letter" value={n(['failed', 'dead'])} tone={n(['failed', 'dead']) ? 'bad' : undefined} />
          </div>
          <Card title="Non-essential job pause" action={d.paused ? <Badge tone="warn">Non-essential paused</Badge> : <Badge tone="good">Running normally</Badge>}>
            <p className="mb-3 text-[13px] text-muted">Pauses research, scan and LLM style jobs. Jobs flagged <strong>essential</strong> (safety, exit supervision, settlement, reconciliation) are excluded by the database itself: a constraint makes it impossible to mark an essential job paused. Jobs enqueued while paused start paused unless essential.</p>
            {d.paused
              ? <Button variant="primary" disabled={!canAdmin} title={canAdmin ? undefined : 'Owner/admin only'} busy={resume.busy} onClick={() => resume.run({ workspace: current.id }, { ok: 'Non-essential jobs resumed' })}>Resume non-essential jobs</Button>
              : <Button variant="danger" disabled={!canWrite} onClick={() => setPauseOpen(true)}>Pause non-essential research jobs</Button>}
          </Card>
          <Card title="Queues by status and class">
            {d.groups.length === 0 ? <EmptyState title="No jobs yet" hint="Nothing has been enqueued in this workspace. Services enqueue jobs; the console does not." /> : (
              <Table caption="Jobs by queue, status and class" rows={d.groups.map((g: any, i: number) => ({ ...g, id: String(i) }))} cols={[
                { key: 'queue', header: 'Queue', filter: true }, { key: 'class', header: 'Class', filter: true, render: (g) => (g.essential ? <Badge tone="accent">essential</Badge> : <Badge>non-essential</Badge>), text: (g) => (g.essential ? 'essential' : 'non-essential') },
                { key: 'status', header: 'Status', filter: true }, { key: 'paused', header: 'Paused', render: (g) => (g.paused ? <Badge tone="warn">paused</Badge> : '-'), text: (g) => (g.paused ? 'paused' : 'no') },
                { key: 'n', header: 'Jobs', align: 'right' }, { key: 'oldest', header: 'Oldest', render: (g) => when(g.oldest) }]} />)}
          </Card>
          <Card title="Dead-letter and failed jobs">
            {d.dead.length === 0 ? <EmptyState title="No failed or dead-lettered jobs" /> : (
              <Table caption="Failed and dead-letter jobs" rows={d.dead} cols={[
                { key: 'queue', header: 'Queue', filter: true }, { key: 'status', header: 'Status', render: (j) => <Badge tone="bad">{j.status}</Badge> }, { key: 'essential', header: 'Class', render: (j) => (j.essential ? 'essential' : 'non-essential'), text: (j) => (j.essential ? 'essential' : 'non-essential') },
                { key: 'attempts', header: 'Attempts', align: 'right' }, { key: 'last_error', header: 'Last error', render: (j) => j.last_error ?? '-' }, { key: 'created_at', header: 'Created', render: (j) => when(j.created_at) },
                { key: 'act', header: 'Action', render: (j) => <Button disabled={!canAdmin} title={canAdmin ? 'Idempotent: repeating the same click cannot queue it twice' : 'Owner/admin only'} busy={retry.busy} onClick={() => retry.run({ job: j.id }, { ok: 'Job re-queued' })}>Retry</Button> }]} />)}
          </Card>
          <Card title="Cost, token usage, provider latency and throughput"><EmptyState title="Not measured" hint="No worker reports cost, token usage, provider latency or throughput, so none is shown. These appear once workers write telemetry." /></Card>
        </div>);
      }}</Async>
      <ConfirmDialog open={pauseOpen} onClose={() => setPauseOpen(false)} danger phrase="PAUSE" confirmLabel="Pause non-essential" busy={pause.busy} title="Pause non-essential jobs"
        body={<div className="space-y-2"><p>All queued and running <strong>non-essential</strong> jobs in this workspace will be marked paused, and new non-essential jobs will start paused.</p><p><strong>Essential safety jobs are not affected.</strong></p></div>}
        onConfirm={() => pause.run({ workspace: current.id, reason: 'Paused from Operations' }, { ok: 'Non-essential jobs paused', onDone: () => setPauseOpen(false) })} />
    </NeedWorkspace>
  );
}
