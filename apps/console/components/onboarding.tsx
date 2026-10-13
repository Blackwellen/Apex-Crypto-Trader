'use client';
import { useState, type ReactNode } from 'react';
import { Button, Card, EmptyState, ErrorState, LoadingBlock, TextInput, useToast } from './ui';
import { useWorkspace } from '@/lib/workspace';
import { useCommand } from '@/lib/api';

/** Gate for pages needing a workspace: loading / error / first-run creation. */
export function NeedWorkspace({ children }: { children: ReactNode }) {
  const { current, loading, error } = useWorkspace(); const toast = useToast();
  const [name, setName] = useState('My treasury'); const create = useCommand('createWorkspace');
  if (loading) return <LoadingBlock rows={4} />;
  if (error) return <ErrorState error={error} />;
  if (!current) return (
    <Card title="Create your workspace">
      <p className="mb-4 max-w-xl text-[14px] text-muted">A workspace is your private treasury. Everything starts in the <strong>paper</strong> environment with live trading locked.</p>
      <form className="flex max-w-md flex-col gap-3" onSubmit={(e) => { e.preventDefault(); create.mutate({ body: { name } }, { onSuccess: () => toast.push('Workspace created'), onError: (er) => toast.push(er.message, 'bad') }); }}>
        <TextInput label="Workspace name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        <Button variant="primary" type="submit" busy={create.isPending}>Create workspace</Button>
      </form>
    </Card>);
  return <>{children}</>;
}
export function NotConnected({ title, what, setup }: { title: string; what: string; setup: string[] }) {
  return <Card><EmptyState title={title} hint={what} action={<ul className="mt-2 list-disc text-left text-[13px] text-muted">{setup.map((s) => <li key={s}>{s}</li>)}</ul>} /></Card>;
}
