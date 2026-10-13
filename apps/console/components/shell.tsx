'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Menu, OctagonX, ShieldCheck } from 'lucide-react';
import { NAV } from './nav';
import { Badge, Button, ConfirmDialog, Dialog, Select, TextInput, ToastProvider, cx, useToast } from './ui';
import { useWorkspace, WorkspaceProvider } from '@/lib/workspace';
import { useCommand } from '@/lib/api';

function EnvBanner() {
  const { current } = useWorkspace();
  if (!current) return null;
  return (
    <div role="region" aria-label="Environment" className="border-b border-[#f0dfb7] bg-warn-soft px-5 py-2 text-[12px] text-warn">
      <strong>PAPER / RESEARCH ENVIRONMENT.</strong> Balances and fills are ledger-accounted simulations; no real orders, signing or live balances. Live execution is{' '}
      <strong>{current.live_allowed ? 'ENABLED' : 'LOCKED'}</strong>{current.live_allowed ? '' : ' until every deployment gate passes with evidence and the owner opts in.'}
    </div>
  );
}

function StateBadge() {
  const { current } = useWorkspace(); if (!current) return null;
  const s = current.global_state;
  if (s !== 'active') return <Badge tone="bad">{s.replace(/_/g, ' ')}</Badge>;
  return current.paper_running ? <Badge tone="good">Paper engine running</Badge> : <Badge>Paper engine stopped</Badge>;
}

function KillSwitch() {
  const { current, canWrite } = useWorkspace(); const toast = useToast();
  const [open, setOpen] = useState(false); const stop = useCommand('emergencyStop');
  if (!current || !canWrite) return null;
  return (<>
    <Button variant="danger" onClick={() => setOpen(true)} aria-label="Emergency stop"><OctagonX className="size-4" aria-hidden />Emergency stop</Button>
    <ConfirmDialog open={open} onClose={() => setOpen(false)} danger phrase="STOP" confirmLabel="Stop new entries" busy={stop.isPending}
      title="Emergency stop" body={<><p>This immediately halts all <strong>new entries</strong> for this workspace and stops the paper engine.</p>
        <p className="text-muted">Settlement watchers, reconciliation and risk-reducing exits keep running. It does not kill processes or abandon open positions.</p></>}
      onConfirm={() => stop.mutate({ body: { workspace: current.id, reason: 'Emergency stop from console' } }, { onSuccess: () => { toast.push('Emergency stop active: new entries halted'); setOpen(false); }, onError: (e) => toast.push(e.message, 'bad') })} />
  </>);
}

function Header({ onMenu }: { onMenu: () => void }) {
  const { workspaces, current, setCurrent } = useWorkspace(); const router = useRouter(); const [q, setQ] = useState('');
  return (
    <header className="sticky top-0 z-30 flex flex-wrap items-center gap-3 border-b border-line bg-white/95 px-4 py-3 backdrop-blur md:px-8">
      <button className="rounded-lg p-2 hover:bg-[#f0f3f8] md:hidden" onClick={onMenu} aria-label="Open navigation"><Menu className="size-5" /></button>
      <form role="search" className="min-w-[140px] flex-1 md:max-w-sm" onSubmit={(e) => { e.preventDefault(); if (q.trim()) router.push(`/markets?q=${encodeURIComponent(q.trim())}`); }}>
        <input aria-label="Global search: symbol, chain, contract" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search symbol, chain or contract" className="min-h-10 w-full rounded-xl border border-line bg-[#f6f8fb] px-3 text-[13px]" />
      </form>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {workspaces.length > 0 && (
          <select aria-label="Workspace" value={current?.id ?? ''} onChange={(e) => setCurrent(e.target.value)} className="min-h-10 rounded-xl border border-line bg-white px-3 text-[13px]">
            {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>)}
        <Badge tone="accent">Paper mode</Badge><StateBadge />
        <Link href="/chains" className="hidden rounded-full bg-[#eef1f6] px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-[#44546a] md:inline" title="Chain health is not measured until a probe worker runs">Chains: unmeasured</Link>
        <KillSwitch />
        <Button variant="ghost" onClick={async () => { await fetch('/api/auth/logout', { method: 'POST' }); location.href = '/login'; }}>Sign out</Button>
      </div>
    </header>
  );
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const path = usePathname(); const groups = [...new Set(NAV.map((n) => n.group))];
  return (<>
    {open && <div className="fixed inset-0 z-40 bg-[#0f1b33]/40 md:hidden" onClick={onClose} aria-hidden />}
    <aside className={cx('fixed inset-y-0 left-0 z-50 w-64 overflow-y-auto border-r border-line bg-white p-4 transition-transform md:sticky md:top-0 md:h-dvh md:translate-x-0', open ? 'translate-x-0' : '-translate-x-full')} aria-label="Primary">
      <div className="mb-6 flex items-center gap-3 px-2"><span className="grid size-9 place-items-center rounded-xl bg-accent text-white"><ShieldCheck className="size-5" aria-hidden /></span><span className="text-xl font-bold tracking-tight">APEX</span></div>
      <nav>{groups.map((g) => (
        <div key={g} className="mb-4"><div className="px-3 pb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-muted">{g}</div>
          {NAV.filter((n) => n.group === g).map((n) => { const active = path === n.href || (n.href !== '/dashboard' && path.startsWith(n.href + '/')); const Icon = n.icon;
            return <Link key={n.href} href={n.href} onClick={onClose} aria-current={active ? 'page' : undefined} className={cx('flex min-h-10 items-center gap-3 rounded-xl px-3 text-[14px] font-medium', active ? 'bg-accent-soft text-accent' : 'text-[#44546a] hover:bg-[#f3f6fb]')}><Icon className="size-[18px]" aria-hidden />{n.label}</Link>; })}</div>))}</nav>
    </aside>
  </>);
}

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <ToastProvider><WorkspaceProvider>
      <a href="#main" className="skip-link">Skip to content</a>
      <div className="md:flex">
        <Sidebar open={open} onClose={() => setOpen(false)} />
        <div className="min-w-0 flex-1"><EnvBanner /><Header onMenu={() => setOpen(true)} />
          <main id="main" className="mx-auto max-w-[1360px] px-4 py-6 md:px-8">{children}</main></div>
      </div>
    </WorkspaceProvider></ToastProvider>
  );
}
export { Dialog, Select, TextInput };
