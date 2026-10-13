'use client';
import { useState } from 'react';
import { ExternalLink, Plus } from 'lucide-react';
import { Async, Badge, Button, Card, DataTable, Dialog, EmptyState, Kpi, PageHeader, Select, TabPanel, Tabs, TextInput, useToast } from '@/components/ui';
import { NeedWorkspace } from '@/components/onboarding';
import { useWs } from '@/components/hooks';
import { useCommand } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { when } from '@/lib/format';
import { ResearcherStatusBar } from '@/components/research/common';

type News = { id: string; headline: string; kind: string; source_name: string; source_url: string | null; published_at: string; observed_at: string; verified: boolean; verified_at: string | null; verification_note: string | null; catalysts: { lifecycle: string; symbol: string; chain: string; contract: string }[] };
const CHECKS: [string, string][] = [['source_identified', 'The publisher/account is who it claims to be (checked on its own domain or verified profile, not a lookalike).'], ['timestamp_confirmed', 'The original publication time is confirmed and is before any price move being attributed to it.'], ['primary_source_corroborated', 'A primary source (official site, on-chain transaction, exchange notice) confirms the claim.'], ['not_promotional_or_paid', 'It is not a paid promotion, shill, copy-paste or bot-amplified post.']];
const KINDS = [{ value: 'news', label: 'News article' }, { value: 'social_post', label: 'Social post' }, { value: 'official_announcement', label: 'Official announcement' }, { value: 'onchain_event', label: 'On-chain event' }];

export default function Intelligence() {
  const { current, canWrite } = useWorkspace(); const toast = useToast(); const [tab, setTab] = useState('overview');
  const ov = useWs<any>('intelligence/overview'), news = useWs<{ items: News[] }>('intelligence/news'), lcs = useWs<{ items: any[] }>('market/lifecycles');
  const add = useCommand('addNewsItem'), verify = useCommand('verifyNewsItem'), link = useCommand('linkCatalyst'), decide = useCommand('decideApproval');
  const err = (e: Error) => toast.push(e.message, 'bad');
  const [addOpen, setAddOpen] = useState(false); const [f, setF] = useState({ headline: '', kind: 'news', source: '', url: '', at: '' });
  const [vItem, setVItem] = useState<News | null>(null); const [checks, setChecks] = useState<Record<string, boolean>>({}); const [vNote, setVNote] = useState('');
  const [lItem, setLItem] = useState<News | null>(null); const [lTarget, setLTarget] = useState('');
  const urlOk = !f.url.trim() || /^https?:\/\/\S+$/.test(f.url.trim()); const atOk = f.at && !Number.isNaN(Date.parse(f.at)) && Date.parse(f.at) <= Date.now() + 300_000;
  const addReady = canWrite && f.headline.trim().length >= 3 && f.source.trim().length >= 2 && urlOk && atOk;
  return (
    <NeedWorkspace>
      <PageHeader title="News & Intelligence" description="Manually entered, source-verified items; model provider status; model job queue; human approvals. Unverified posts are recorded but are not signals and cannot be linked as catalysts." />
      <ResearcherStatusBar />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'overview', label: 'Model & fallback' }, { id: 'news', label: 'News & verification' }, { id: 'queue', label: 'Model job queue' }, { id: 'approvals', label: 'Human approvals' }]} />

      <TabPanel id="overview" value={tab}>
        <Async q={ov}>{(d) => (<div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Kpi label="Model provider" value={d.model.provider ?? 'unknown'} sub={d.model.state === 'DISABLED' ? 'Disabled (default)' : d.model.state === 'CONFIGURED' ? 'Configured' : 'Researcher not reachable'} tone={d.model.state === 'CONFIGURED' ? 'good' : 'warn'} />
            <Kpi label="Model state" value={d.model.state === 'DISABLED' ? 'Disabled' : d.model.state === 'CONFIGURED' ? 'Configured' : 'Unknown'} sub={d.model.state === 'CONFIGURED' ? 'Outputs are untrusted drafts until a human approves' : 'No model output can reach a decision'} />
            <Kpi label="News items" value={d.news.total} sub={`${d.news.verified} verified, ${d.news.total - d.news.verified} unverified`} />
            <Kpi label="Pending approvals" value={d.approvals.length} sub="Human decision required" tone={d.approvals.length ? 'warn' : undefined} />
          </div>
          <Card title="Model provider status">
            <dl className="grid gap-4 text-[13px] sm:grid-cols-2">
              <div><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Configured?</dt><dd>{d.model.state === 'CONFIGURED' ? <Badge tone="good">Configured</Badge> : d.model.state === 'DISABLED' ? <Badge>Not configured: Disabled</Badge> : <Badge tone="warn">Unknown: researcher not reachable</Badge>}</dd></div>
              <div><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Budgets (calls / tokens / cost)</dt><dd>{d.model.budget ? JSON.stringify(d.model.budget) : <span className="text-muted">Not reported</span>}</dd></div>
            </dl>
            <p className="mt-3 text-[13px] text-muted">{d.model.budgetNote}</p>
            <p className="mt-2 text-[13px] text-muted">To enable a provider, set its credentials in the researcher service environment (never in this console). Model output is always untrusted data: it cannot place orders, change risk limits or mark a news item verified.</p>
          </Card>
          <Card title="AI-disabled fallback"><p className="text-[13px]">{d.model.fallback}</p>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-[13px] text-muted"><li>News and announcements: manual entry with source URL and timestamps, verified with the checklist.</li><li>Token safety: deterministic rule-based gate on findings you enter.</li><li>Summaries, clusters, image/meme classification: unavailable until a provider is enabled.</li></ul></Card>
        </div>)}</Async>
      </TabPanel>

      <TabPanel id="news" value={tab}>
        <Card title="News feed (manual entry)" action={<Button variant="primary" onClick={() => setAddOpen(true)} disabled={!canWrite}><Plus className="size-4" aria-hidden />Add item</Button>}>
          <p className="mb-4 rounded-xl bg-warn-soft p-3 text-[13px] text-warn"><strong>Unverified social posts are not signals.</strong> Every item starts unverified. Only items that pass the four-point authenticity checklist can be linked to a token as a catalyst; the database refuses the link otherwise. No headline here was fetched by APEX: each one was typed in by a person with its source and timestamp.</p>
          <Async q={news} empty={(d) => d.items.length === 0}>{(d) => <DataTable caption="News items" rows={d.items} cols={[
            { key: 'headline', header: 'Headline', render: (r) => <span className="font-medium">{r.headline}</span> },
            { key: 'kind', header: 'Kind', filter: true, render: (r) => r.kind.replace(/_/g, ' ') },
            { key: 'source_name', header: 'Source', render: (r) => (r.source_url ? <a className="inline-flex items-center gap-1 text-accent underline" href={r.source_url} target="_blank" rel="noreferrer noopener">{r.source_name}<ExternalLink className="size-3" aria-hidden /><span className="sr-only"> (opens source)</span></a> : <span>{r.source_name} <Badge tone="warn">no URL</Badge></span>), text: (r) => r.source_name },
            { key: 'published_at', header: 'Source time', render: (r) => when(r.published_at), sort: (r) => r.published_at }, { key: 'observed_at', header: 'Entered', render: (r) => when(r.observed_at), sort: (r) => r.observed_at },
            { key: 'verified', header: 'Authenticity', filter: true, text: (r) => (r.verified ? 'verified' : 'unverified'), render: (r) => (r.verified ? <Badge tone="good" title={r.verification_note ?? ''}>Verified</Badge> : <Badge tone="warn">Unverified: not a signal</Badge>) },
            { key: 'catalysts', header: 'Catalyst for', text: (r) => r.catalysts.map((c) => c.symbol).join(', ') || 'none' },
            { key: 'act', header: 'Actions', text: () => '', render: (r) => <div className="flex flex-wrap gap-2">
              {!r.verified && <Button onClick={() => { setVItem(r); setChecks({}); setVNote(''); }} disabled={!canWrite || !r.source_url} title={r.source_url ? '' : 'An item without a source URL cannot be verified'}>Verify</Button>}
              <Button onClick={() => { setLItem(r); setLTarget(''); }} disabled={!canWrite || !r.verified} title={r.verified ? '' : 'Unverified items cannot be linked as catalysts'}>Link as catalyst</Button></div> }]} />}</Async>
          {news.data?.items.length === 0 && <EmptyState title="No news items entered" hint="APEX has no news feed connected. Add an item by hand with its source and original timestamp." action={<Button variant="primary" onClick={() => setAddOpen(true)} disabled={!canWrite}>Add item</Button>} />}
        </Card>
        <Card title="Source-verification checklist" className="mt-5"><ol className="list-decimal space-y-1 pl-5 text-[13px]">{CHECKS.map(([k, t]) => <li key={k}>{t}</li>)}</ol><p className="mt-2 text-[12px] text-muted">All four, plus a written note and a source URL, are required. The checklist and note are stored with the item and audited.</p></Card>
      </TabPanel>

      <TabPanel id="queue" value={tab}>
        <Card title="Model job queue"><Async q={ov}>{(d) => d.jobs.length === 0
          ? <EmptyState title="No model jobs" hint={d.model.state === 'DISABLED' ? 'The model provider is disabled, so no model jobs are created.' : 'Nothing has been queued in the model/intelligence queues for this workspace.'} />
          : <DataTable caption="Model jobs" rows={d.jobs} cols={[{ key: 'queue', header: 'Queue', filter: true }, { key: 'status', header: 'Status', filter: true, render: (r: any) => <Badge tone={r.status === 'failed' || r.status === 'dead' ? 'bad' : r.status === 'done' ? 'good' : 'warn'}>{r.status}</Badge> }, { key: 'attempts', header: 'Attempts', align: 'right' }, { key: 'last_error', header: 'Last error' }, { key: 'created_at', header: 'Created', render: (r: any) => when(r.created_at), sort: (r: any) => r.created_at }]} />}</Async></Card>
      </TabPanel>

      <TabPanel id="approvals" value={tab}>
        <Card title="Human approval queue"><p className="mb-3 text-[13px] text-muted">Anything a model or automation proposes that changes permissions, capital or gates waits here for a person. A requester cannot approve their own request (except deployment-gate sign-off).</p>
          <Async q={ov}>{(d) => d.approvals.length === 0 ? <EmptyState title="Nothing awaiting approval" hint="No model output reaches this queue while the provider is disabled." />
            : <DataTable caption="Pending approvals" rows={d.approvals} cols={[{ key: 'kind', header: 'Kind', render: (r: any) => r.kind.replace(/_/g, ' ') }, { key: 'subject', header: 'Subject', text: (r: any) => JSON.stringify(r.subject).slice(0, 120) }, { key: 'created_at', header: 'Requested', render: (r: any) => when(r.created_at) },
              { key: 'act', header: 'Decision', text: () => '', render: (r: any) => <div className="flex gap-2"><Button onClick={() => decide.mutate({ body: { approval: r.id, approve: true } }, { onSuccess: () => toast.push('Approved'), onError: err })} disabled={!canWrite}>Approve</Button><Button variant="danger" onClick={() => decide.mutate({ body: { approval: r.id, approve: false } }, { onSuccess: () => toast.push('Rejected'), onError: err })} disabled={!canWrite}>Reject</Button></div> }]} />}</Async></Card>
      </TabPanel>

      <Dialog open={addOpen} onClose={() => setAddOpen(false)} title="Add news item" footer={<><Button onClick={() => setAddOpen(false)}>Cancel</Button>
        <Button variant="primary" disabled={!addReady} busy={add.isPending} onClick={() => add.mutate({ body: { workspace: current!.id, headline: f.headline.trim(), kind: f.kind, sourceName: f.source.trim(), ...(f.url.trim() ? { sourceUrl: f.url.trim() } : {}), publishedAt: new Date(f.at).toISOString() } },
          { onSuccess: () => { toast.push('Item added as unverified'); setAddOpen(false); setF({ headline: '', kind: 'news', source: '', url: '', at: '' }); }, onError: err })}>Add as unverified</Button></>}>
        <div className="space-y-3"><p className="text-[13px] text-muted">Type exactly what the source says. The item is stored as <strong>unverified</strong>.</p>
          <TextInput label="Headline / claim" value={f.headline} onChange={(e) => setF({ ...f, headline: e.target.value })} maxLength={300} />
          <Select label="Kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} options={KINDS} />
          <TextInput label="Source name" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} maxLength={120} />
          <TextInput label="Source URL" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} maxLength={500} error={urlOk ? undefined : 'Must start with http:// or https://'} hint="Required to verify later." />
          <TextInput label="Original publication time (source's timestamp)" type="datetime-local" value={f.at} onChange={(e) => setF({ ...f, at: e.target.value })} error={f.at && !atOk ? 'Cannot be in the future' : undefined} /></div>
      </Dialog>
      <Dialog open={!!vItem} onClose={() => setVItem(null)} title="Verify source authenticity" footer={<><Button onClick={() => setVItem(null)}>Cancel</Button>
        <Button variant="primary" disabled={CHECKS.some(([k]) => !checks[k]) || vNote.trim().length < 5} busy={verify.isPending} onClick={() => verify.mutate({ body: { item: vItem!.id, checklist: Object.fromEntries(CHECKS.map(([k]) => [k, !!checks[k]])), note: vNote.trim() } }, { onSuccess: () => { toast.push('Item verified'); setVItem(null); }, onError: err })}>Mark verified</Button></>}>
        {vItem && <div className="space-y-3"><p className="text-[14px] font-semibold">{vItem.headline}</p><p className="text-[12px] text-muted">{vItem.source_name} · {vItem.source_url}</p>
          <fieldset><legend className="sr-only">Authenticity checklist</legend>{CHECKS.map(([k, t]) => <label key={k} className="mb-2 flex items-start gap-3 text-[13px]"><input type="checkbox" className="mt-0.5 size-5 accent-[#2758da]" checked={!!checks[k]} onChange={(e) => setChecks({ ...checks, [k]: e.target.checked })} /><span>{t}</span></label>)}</fieldset>
          <TextInput label="How did you verify it? (required)" value={vNote} onChange={(e) => setVNote(e.target.value)} maxLength={500} /></div>}
      </Dialog>
      <Dialog open={!!lItem} onClose={() => setLItem(null)} title="Link verified item as a catalyst" footer={<><Button onClick={() => setLItem(null)}>Cancel</Button>
        <Button variant="primary" disabled={!lTarget} busy={link.isPending} onClick={() => link.mutate({ body: { item: lItem!.id, lifecycle: lTarget } }, { onSuccess: () => { toast.push('Catalyst linked'); setLItem(null); }, onError: err })}>Link</Button></>}>
        {lItem && <div className="space-y-3"><p className="text-[14px] font-semibold">{lItem.headline}</p>
          <Select label="Tracked token" value={lTarget} onChange={(e) => setLTarget(e.target.value)} options={[{ value: '', label: lcs.data?.items.length ? 'Choose a token…' : 'No tracked tokens: log one on the Meme Radar' }, ...(lcs.data?.items ?? []).map((l: any) => ({ value: l.id, label: `${l.symbol} · ${l.chain_name}` }))]} />
          <p className="text-[12px] text-muted">A catalyst is context for a human decision. It never triggers a trade.</p></div>}
      </Dialog>
    </NeedWorkspace>
  );
}
