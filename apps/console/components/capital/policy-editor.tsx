'use client';
import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Badge, Button, Card, Field, Select, TextInput, inputCls, useToast } from '@/components/ui';
import { ApiError, useCommand } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { LIMITS, buildPolicy, diffPolicy, policyToFields, type DiffLine } from '@/lib/capital/policy';
import { when } from '@/lib/format';
import type { BucketRow } from './shared';

export function DiffView({ lines, label }: { lines: DiffLine[]; label: string }) {
  const changed = lines.filter((l) => l.kind !== 'same');
  if (changed.length === 0) return <p className="text-[13px] text-muted">No differences.</p>;
  return <table className="w-full text-left text-[12px]"><caption className="sr-only">{label}</caption><thead className="text-[11px] uppercase tracking-wider text-muted"><tr><th scope="col" className="py-1 pr-3">Field</th><th scope="col" className="py-1 pr-3">Before</th><th scope="col" className="py-1">After</th></tr></thead>
    <tbody>{changed.map((l) => <tr key={l.key} className="border-t border-line"><th scope="row" className="py-1 pr-3 font-mono font-medium">{l.key}</th><td className="py-1 pr-3 font-mono text-bad">{l.kind === 'added' ? '(unset)' : l.before}</td><td className="py-1 font-mono text-good">{l.kind === 'removed' ? '(removed)' : l.after}</td></tr>)}</tbody></table>;
}

/** Bucket limits editor: optimistic version token, diff-before-save, stale-version (409) recovery. */
export function PolicyEditor({ bucket, versions, refetch }: { bucket: BucketRow; versions: { version: number; policy: Record<string, unknown>; created_at: string }[]; refetch: () => Promise<unknown> | unknown }) {
  const { canAdmin } = useWorkspace(); const toast = useToast(); const cmd = useCommand('updateBucketPolicy');
  const init = useMemo(() => policyToFields(bucket.policy), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [fields, setFields] = useState(init.fields); const [extra, setExtra] = useState(init.extra); const [base, setBase] = useState(bucket.policy_version); const [dirty, setDirty] = useState(false);
  const [stale, setStale] = useState(false); const [review, setReview] = useState(false); const [cmp, setCmp] = useState('');
  const built = buildPolicy(fields, extra);
  const behind = bucket.policy_version !== base;
  // Pristine editor follows server changes; an edited one never silently overwrites a draft.
  useEffect(() => { if (!dirty && bucket.policy_version !== base) { const n = policyToFields(bucket.policy); setFields(n.fields); setExtra(n.extra); setBase(bucket.policy_version); } }, [bucket.policy_version]); // eslint-disable-line react-hooks/exhaustive-deps
  const diff = diffPolicy(bucket.policy, built.policy);
  const hasChanges = diff.some((d) => d.kind !== 'same');
  const save = () => cmd.mutate({ body: { bucket: bucket.id, expectedVersion: base, policy: built.policy } }, {
    onSuccess: (r) => { toast.push(`Policy saved as version ${(r.result as any).version}`); setBase((r.result as any).version); setDirty(false); setReview(false); setStale(false); refetch(); },
    onError: async (e: ApiError) => { if (e.status === 409) { setStale(true); setReview(false); await refetch(); } else toast.push(e.message, 'bad'); } });
  const loadLatest = () => { const n = policyToFields(bucket.policy); setFields(n.fields); setExtra(n.extra); setBase(bucket.policy_version); setDirty(false); setStale(false); setReview(false); };
  const rebase = () => { setBase(bucket.policy_version); setStale(false); };
  const other = versions.find((v) => String(v.version) === cmp);
  return (
    <div className="space-y-5">
      {(stale || behind) && dirty && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-[#f0dfb7] bg-warn-soft p-4 text-[13px] text-warn">
          <p className="min-w-0 flex-1"><strong>{stale ? 'Save refused: this policy was changed by someone else.' : 'This policy changed since you opened the editor.'}</strong> You edited version {base}; the current version is {bucket.policy_version}. Nothing was overwritten.</p>
          <Button onClick={loadLatest}><RefreshCw className="size-4" aria-hidden />Discard my edits, load v{bucket.policy_version}</Button>
          <Button variant="primary" onClick={rebase}>Keep my edits, compare with v{bucket.policy_version}</Button></div>)}
      <Card title={<span>Capital policy <Badge tone="accent">current version {bucket.policy_version}</Badge></span>}>
        <p className="mb-4 text-[13px] text-muted">Bucket limits can never be looser than the workspace hard limits (the database enforces this). Saving creates an immutable new version; you must be on the latest version to save.</p>
        <div className="grid gap-3 sm:grid-cols-2">{LIMITS.map((l) => <TextInput key={l.key} label={`${l.label} (${l.unit})`} hint={l.hint} inputMode="numeric" disabled={!canAdmin} value={fields[l.key] ?? ''} onChange={(e) => { setFields({ ...fields, [l.key]: e.target.value }); setDirty(true); }} />)}</div>
        <div className="mt-3"><Field label="Other policy keys (JSON object)"><textarea className={`${inputCls} min-h-24 font-mono text-[12px]`} disabled={!canAdmin} value={extra} onChange={(e) => { setExtra(e.target.value); setDirty(true); }} spellCheck={false} /></Field></div>
        {built.errors.length > 0 && <ul role="alert" className="mt-2 list-disc pl-5 text-[12px] text-bad">{built.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button variant="primary" disabled={!canAdmin || built.errors.length > 0 || !hasChanges} title={!canAdmin ? 'Owner or admin role required' : !hasChanges ? 'No changes to save' : undefined} onClick={() => setReview(true)}>Review changes</Button>
          <Button disabled={!dirty} onClick={loadLatest}>Reset</Button></div>
      </Card>
      {review && (
        <Card title={`Review: version ${bucket.policy_version} to version ${bucket.policy_version + 1}`}>
          <DiffView lines={diff} label="Policy changes before save" />
          <div className="mt-4 flex gap-2"><Button variant="primary" busy={cmd.isPending} onClick={save}>Confirm and save (expects v{base})</Button><Button onClick={() => setReview(false)}>Back</Button></div></Card>)}
      <Card title="Version history">
        {versions.length === 0 ? <p className="text-[13px] text-muted">No versions recorded.</p> : (<div className="space-y-3">
          <Select label="Compare current policy with" value={cmp} onChange={(e) => setCmp(e.target.value)} options={[{ value: '', label: 'Choose a version…' }, ...versions.map((v) => ({ value: String(v.version), label: `v${v.version} · ${when(v.created_at)}` }))]} />
          {other && <DiffView lines={diffPolicy(other.policy, bucket.policy)} label={`Changes from v${other.version} to current`} />}</div>)}
      </Card>
    </div>
  );
}
