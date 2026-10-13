/** Pure helpers for reading researcher reports. The report is DATA from the researcher; nothing here invents numbers. */
export type Provenance = 'SYNTHETIC' | 'REAL_USER_SUPPLIED' | 'REAL_PUBLIC_API' | 'PENDING';
export interface MetricCI { point: number; ci_low: number; ci_high: number }
export const isSynthetic = (p?: string | null) => p === 'SYNTHETIC';
export const provenanceTone = (p?: string | null): 'warn' | 'accent' | 'neutral' => (p === 'SYNTHETIC' ? 'warn' : p === 'PENDING' || !p ? 'neutral' : 'accent');
export function provenanceLabel(p?: string | null): string {
  if (p === 'SYNTHETIC') return 'SYNTHETIC data';
  if (p === 'REAL_USER_SUPPLIED') return 'REAL data (user supplied)';
  if (p === 'REAL_PUBLIC_API') return 'REAL data (public API)';
  return 'Provenance pending';
}
export const fnum = (x: unknown, nd = 3): string => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(nd) : 'n/a');
export const fpct = (x: unknown, nd = 1): string => (typeof x === 'number' && Number.isFinite(x) ? `${(x * 100).toFixed(nd)}%` : 'n/a');
/** An interval is only shown when both ends are finite numbers and ordered; otherwise the UI says there is no interval. */
export function interval(m: Partial<MetricCI> | undefined | null): [number, number] | null {
  if (!m || typeof m.ci_low !== 'number' || typeof m.ci_high !== 'number' || !Number.isFinite(m.ci_low) || !Number.isFinite(m.ci_high) || m.ci_low > m.ci_high) return null;
  return [m.ci_low, m.ci_high];
}
/** Does the interval include zero? (A point estimate whose interval straddles zero is not distinguishable from no effect at this sample.) */
export const straddlesZero = (iv: [number, number] | null) => (iv ? iv[0] <= 0 && iv[1] >= 0 : null);

export type Row = { metric: string; point: string; ciLow: string; ciHigh: string; level: string };
const CI_KEYS: [string, string][] = [['sharpe', 'Sharpe (annualised)'], ['cagr', 'CAGR'], ['max_drawdown', 'Max drawdown'], ['total_return', 'Total return']];
/** Flatten a stored run into export rows (metrics with uncertainty). */
export function metricRows(report: any): Row[] {
  const u = report?.metric_uncertainty; const lvl = typeof u?.method?.level === 'number' ? `${Math.round(u.method.level * 100)}%` : 'n/a';
  const rows: Row[] = [];
  for (const [k, name] of CI_KEYS) { const m = u?.[k]; const iv = interval(m); rows.push({ metric: name, point: fnum(m?.point ?? report?.point_metrics?.[k], 6), ciLow: iv ? iv[0].toFixed(6) : 'n/a', ciHigh: iv ? iv[1].toFixed(6) : 'n/a', level: iv ? lvl : 'n/a' }); }
  for (const k of ['ann_vol', 'sortino', 'calmar', 'n_closed_trades', 'win_rate_closed_trades', 'turnover_x_equity']) rows.push({ metric: k, point: fnum(report?.point_metrics?.[k], 6), ciLow: 'n/a', ciHigh: 'n/a', level: 'no interval' });
  return rows;
}
export function exportRows(runs: { id: string; label?: string | null; status: string; data_provenance: string; metrics?: any }[]): string[][] {
  const out: string[][] = [];
  for (const r of runs) for (const m of metricRows(r.metrics?.report)) out.push([r.id, r.label ?? '', r.status, r.data_provenance, m.metric, m.point, m.ciLow, m.ciHigh, m.level]);
  return out;
}
export const EXPORT_HEADER = ['run_id', 'label', 'status', 'data_provenance', 'metric', 'point', 'ci_low', 'ci_high', 'ci_level'];
/** Equity series if (and only if) the researcher supplied one: [{x,y}] or number[]; anything else -> null (APEX never reconstructs a curve). */
export function equitySeries(report: any): { x: string; y: number }[] | null {
  const s = report?.equity_curve ?? report?.equity_series; if (!Array.isArray(s) || s.length < 2) return null;
  if (s.every((v: unknown) => typeof v === 'number' && Number.isFinite(v))) return s.map((y: number, i: number) => ({ x: `bar ${i}`, y }));
  if (s.every((p: any) => p && typeof p.y === 'number' && Number.isFinite(p.y))) return s.map((p: any, i: number) => ({ x: String(p.x ?? `bar ${i}`), y: p.y }));
  return null;
}
