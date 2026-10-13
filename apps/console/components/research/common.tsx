'use client';
import { AlertTriangle, FlaskConical, ShieldAlert } from 'lucide-react';
import { Badge, LoadingBlock } from '@/components/ui';
import { useApi } from '@/lib/api';
import { provenanceLabel, provenanceTone } from '@/lib/research/results';

export interface ResearcherHealth { reachable: boolean; origin: string; checkedAt: string; error?: string; version?: string; mode?: string; llm?: { provider: string; enabled: boolean }; strategies?: string[]; backtestFields?: string[] }
export const useResearcher = () => useApi<ResearcherHealth>('v1/research/health', { refetchInterval: 10_000 });

export function ProvenanceBadge({ value }: { value?: string | null }) {
  return <Badge tone={provenanceTone(value)} title="Data provenance of every number in this run">{provenanceLabel(value)}</Badge>;
}

/** Honest researcher status: reachable or NOT REACHABLE (never assumed). */
export function ResearcherStatusBar() {
  const q = useResearcher();
  if (q.isLoading) return <LoadingBlock rows={1} />;
  const h = q.data;
  if (q.error || !h) return <div role="alert" className="mb-5 rounded-xl border border-[#f3c9c5] bg-bad-soft p-3 text-[13px] text-bad"><strong>Researcher status unknown:</strong> the APEX API could not be asked.</div>;
  return h.reachable
    ? <div className="mb-5 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-card px-4 py-3 text-[13px]"><Badge tone="good">Researcher reachable</Badge><span className="text-muted">v{h.version} · {h.origin} · mode {h.mode} · no execution endpoints</span></div>
    : <div role="alert" className="mb-5 rounded-xl border border-[#f3c9c5] bg-bad-soft p-4 text-[13px] text-bad"><div className="flex items-center gap-2 font-semibold"><AlertTriangle className="size-4" aria-hidden />Researcher NOT REACHABLE</div>
        <p className="mt-1">{h.error}. Backtests cannot run and are disabled. Start the Python researcher service (<code>services/researcher</code>, FastAPI) and make sure <code>APEX_RESEARCHER_URL</code> ({h.origin}) points at it. Existing run history below is stored in the database and stays readable.</p></div>;
}

export function SyntheticNotice({ provenance, banner }: { provenance?: string | null; banner?: string }) {
  const synth = provenance === 'SYNTHETIC';
  return (
    <div role="note" className={`mb-5 flex items-start gap-3 rounded-xl border p-4 text-[13px] ${synth ? 'border-[#f0dfb7] bg-warn-soft text-warn' : 'border-line bg-card text-ink'}`}>
      {synth ? <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden /> : <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}
      <div><div className="mb-1"><ProvenanceBadge value={provenance} /></div>{banner ?? 'Data provenance is attached to every run. Synthetic results test the plumbing and the statistics; they are not evidence that any strategy has an edge.'}</div>
    </div>
  );
}

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
