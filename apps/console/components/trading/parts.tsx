'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge, Card, EmptyState } from '@/components/ui';
import { healthLabel, healthTone, readiness, researchLabel, tradingLabel, type CapMap, type CertStatus, type HealthStatus } from '@/lib/chains';
import { formatUnits } from '@/lib/format';

export interface Health { status: HealthStatus; reason: string; rpcLatencyMs: number | null; blockAgeMs: number | null; measuredAt: string | null; endpoints: { endpoint: string; status: HealthStatus; reason: string; latencyMs: number | null; blockAgeMs: number | null; blockHeight: string | null; observedAt: string; chainIdMatch: boolean | null }[]; note: string }

export function HealthBadge({ health }: { health: Pick<Health, 'status' | 'reason'> }) {
  return <Badge tone={healthTone(health.status)} title={health.reason}>{healthLabel(health.status)}</Badge>;
}
const capTone = { CERTIFIED: 'good', READ_ONLY: 'accent', PENDING: 'warn', UNSUPPORTED: 'neutral' } as const;
export function CapBadge({ status }: { status: CertStatus | 'UNRECORDED' }) {
  if (status === 'UNRECORDED') return <Badge title="No record exists for this capability in the database">Unrecorded</Badge>;
  return <Badge tone={capTone[status]}>{status.replace('_', ' ')}</Badge>;
}
export function ReadinessBadges({ caps }: { caps: CapMap | null | undefined }) {
  const r = readiness(caps);
  return (
    <div className="flex flex-wrap gap-1.5">
      <Badge tone={r.research === 'read_only_available' ? 'accent' : 'neutral'} title={researchLabel(r.research)}>Research: {r.research === 'read_only_available' ? 'read-only' : 'none'}</Badge>
      <Badge tone={r.trading === 'certified' ? 'good' : r.trading === 'partial' ? 'warn' : 'neutral'} title={tradingLabel(r.trading) + (r.missingForTrading.length ? ` Missing CERTIFIED: ${r.missingForTrading.join(', ')}.` : '')}>
        Trading: {r.trading === 'certified' ? 'certified' : r.trading === 'partial' ? 'partial' : 'not ready'}</Badge>
    </div>
  );
}
export function EnvBadge({ env }: { env: string }) {
  return env === 'live' ? <Badge tone="bad" title="Live environment">Live</Badge> : <Badge tone="accent" title="Paper (simulated) environment">Paper</Badge>;
}
export const stageTone = (s: string) => (s === 'live_candidate' ? 'warn' : s === 'paper' ? 'accent' : 'neutral') as 'warn' | 'accent' | 'neutral';
export const ms = (v: number | null | undefined) => (v == null ? '—' : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`);
export const fmtDur = (v: number | null | undefined) => (v == null ? '—' : v < 1000 ? `${Math.round(v)} ms` : v < 60_000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v / 60_000)} min`);
export const amt = (v: string | null | undefined, decimals: number, sym?: string) => (v == null ? '—' : `${formatUnits(v, decimals)}${sym ? ' ' + sym : ''}`);

export function NotConnectedCard({ title, what, setup, id }: { title: string; what: string; setup: string[]; id?: string }) {
  return (
    <div id={id} className="rounded-xl border border-dashed border-line p-5">
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-[13px] text-muted">{what}</p>
      <p className="mt-3 text-[12px] font-semibold uppercase tracking-wider text-muted">Setup</p>
      <ol className="mt-1 list-decimal pl-5 text-[13px] text-muted">{setup.map((s) => <li key={s}>{s}</li>)}</ol>
    </div>
  );
}
export function Note({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'warn' }) {
  return <p className={tone === 'warn' ? 'rounded-lg bg-warn-soft p-3 text-[13px] text-warn' : 'rounded-lg bg-[#f3f6fb] p-3 text-[13px] text-[#44546a]'}>{children}</p>;
}
export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) { return <Card title={title} action={action} className="mb-5">{children}</Card>; }
export { Link, EmptyState };
