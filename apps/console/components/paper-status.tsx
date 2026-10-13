'use client';
import { Badge } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';

export interface PaperStatus {
  data_provenance: string; provenance_note: string; paper_running: boolean; global_state: string; verdict: 'running' | 'engine_not_running' | 'partial_feed_not_running' | 'stopped' | 'halted'; headline: string;
  execution_engine_running: boolean; feed_running: boolean; intents_total: number; fills_total: number; settled_total: number; conservation_ok: boolean; last_fill_at: string | null;
  intents_by_state: Record<string, number>; engines: { component: string; instance_id: string; age_seconds: number; running: boolean; stopped: boolean; counters: Record<string, number> }[];
  feed: { cursor: number; seed: number; last_run_age_seconds: number | null } | null;
}

/** Paper-engine truth: process heartbeats (not just the persisted flag), pipeline counts, and the SYNTHETIC provenance note. Read-only. */
export function usePaperStatus() {
  const { current } = useWorkspace();
  return useApi<PaperStatus>(current ? `v1/paper/status?workspace=${current.id}` : null, { refetchInterval: 4_000 });
}

export function PaperEngineStrip() {
  const { current } = useWorkspace(); const q = usePaperStatus(); const s = q.data;
  if (!current) return null;
  const tone = !s ? 'neutral' : s.verdict === 'running' ? 'good' : s.verdict === 'stopped' ? 'neutral' : s.verdict === 'halted' ? 'bad' : 'warn';
  return (
    <section aria-label="Paper engine status" data-testid="paper-engine-strip" className="mb-5 rounded-2xl border border-line bg-card p-4 text-[13px] shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone}>{s ? s.headline : q.isError ? 'Engine status unavailable' : 'Checking engine…'}</Badge>
        <Badge tone="warn" title={s?.provenance_note}>SYNTHETIC market data</Badge>
        {s && <span className="text-muted" data-testid="paper-counts">intents {s.intents_total} · fills {s.fills_total} · settled {s.settled_total} · ledger conserved: {s.conservation_ok ? 'yes' : 'NO'}</span>}
      </div>
      {s && <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-muted">
        {['execution', 'paper_feed'].map((c) => { const e = s.engines.find((x) => x.component === c && !x.stopped) ?? s.engines.find((x) => x.component === c);
          return <li key={c}>{c === 'execution' ? 'Execution engine' : 'Signal feed'}: {e ? (e.running ? `alive (heartbeat ${e.age_seconds}s ago)` : e.stopped ? 'stopped cleanly' : `NOT RUNNING (last heartbeat ${Math.round(e.age_seconds)}s ago)`) : 'never started'}</li>; })}
        {s.feed && <li>Feed bar {s.feed.cursor}</li>}
      </ul>}
      <p className="mt-2 text-[12px] text-muted">{s?.provenance_note ?? 'All paper market data is SYNTHETIC (seeded random generator). Paper PnL is meaningless as evidence of any edge.'}</p>
    </section>
  );
}
