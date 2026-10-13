/** Pure strategy-lifecycle and wizard logic (S-01..S-06). Mirrors the database rules; the database remains the enforcer. */
export type Stage = 'research' | 'paper' | 'live_candidate';
export const STAGES: Stage[] = ['research', 'paper', 'live_candidate'];
export const stageLabel = (s: string) => ({ research: 'Research', paper: 'Paper', live_candidate: 'Live candidate', retired: 'Retired' } as Record<string, string>)[s] ?? s;
/** the only forward move from each stage; promotion always needs an approval, and live_candidate needs recorded evidence */
export const nextStage = (s: Stage): Stage | null => (s === 'research' ? 'paper' : s === 'paper' ? 'live_candidate' : null);
export function promotionBlocker(stage: Stage, hasEvidence: boolean): string | null {
  const n = nextStage(stage);
  if (!n) return 'Live is locked: live_candidate cannot go further here. Live execution needs every deployment gate to PASS with evidence, the live feature flag and your explicit opt-in (see Risk).';
  if (n === 'live_candidate' && !hasEvidence) return 'No validation evidence is recorded for this strategy, so it cannot become a live candidate.';
  return null;
}
export const canEnableOnBucket = (stage: string) => stage === 'paper' || stage === 'live_candidate';

export interface BoundRow { name: string; min: string; max: string; def: string }
export interface WizardState {
  name: string; slug: string; category: string; summary: string; families: string[]; clonedFrom: string | null;
  dataSources: string[]; regimes: string[]; bounds: BoundRow[];
  maxOrderBps: string; maxDailyLossBps: string; paperDays: string; minTrades: string; notes: string; requestPaper: boolean;
}
export const emptyWizard = (): WizardState => ({ name: '', slug: '', category: 'custom', summary: '', families: [], clonedFrom: null, dataSources: [], regimes: [], bounds: [],
  maxOrderBps: '1000', maxDailyLossBps: '100', paperDays: '14', minTrades: '30', notes: '', requestPaper: false });
export const slugify = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[^a-z]+/, '').slice(0, 40);

const num = (s: string) => (s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : NaN);
const intIn = (s: string, lo: number, hi: number) => { const n = num(s); return Number.isInteger(n) && n >= lo && n <= hi; };
/** Per-step validation; returns field -> message. Step indexes are 0-based: type, data, bounds, risk, validation, approval. */
export function validateStep(step: number, w: WizardState): Record<string, string> {
  const e: Record<string, string> = {};
  if (step === 0) {
    if (w.name.trim().length < 3) e.name = 'At least 3 characters';
    if (!/^[a-z][a-z0-9_]{2,39}$/.test(w.slug)) e.slug = 'Lowercase letters, digits and underscore, 3-40 chars, starting with a letter';
    if (w.families.length === 0) e.families = 'Choose at least one chain family or venue kind';
  }
  if (step === 2) {
    const seen = new Set<string>();
    w.bounds.forEach((b, i) => {
      if (!/^[a-z][a-z0-9_]{1,40}$/.test(b.name)) e[`b${i}.name`] = 'Lowercase name, 2-41 chars';
      else if (seen.has(b.name)) e[`b${i}.name`] = 'Duplicate name'; else seen.add(b.name);
      const mn = num(b.min), mx = num(b.max), d = num(b.def);
      if ([mn, mx, d].some(Number.isNaN)) e[`b${i}.def`] = 'Min, max and default must be numbers';
      else if (!(mn <= d && d <= mx)) e[`b${i}.def`] = 'Require min <= default <= max';
    });
  }
  if (step === 3) {
    if (!intIn(w.maxOrderBps, 0, 10000)) e.maxOrderBps = 'Whole basis points 0-10000';
    if (!intIn(w.maxDailyLossBps, 0, 10000)) e.maxDailyLossBps = 'Whole basis points 0-10000';
  }
  if (step === 4) {
    if (!intIn(w.paperDays, 1, 365)) e.paperDays = 'Whole days 1-365';
    if (!intIn(w.minTrades, 1, 100000)) e.minTrades = 'Whole number 1-100000';
  }
  return e;
}
export const WIZARD_STEPS = ['Type', 'Data sources', 'Parameter bounds', 'Risk budget', 'Validation', 'Approval'];
export const firstInvalidStep = (w: WizardState): number => { for (let s = 0; s <= 4; s++) if (Object.keys(validateStep(s, w)).length) return s; return -1; };

export function toCommand(w: WizardState, workspace: string) {
  return {
    workspace, slug: w.slug, name: w.name.trim(), category: w.category, summary: w.summary.trim(), families: w.families, dataSources: w.dataSources, regimes: w.regimes,
    paramBounds: Object.fromEntries(w.bounds.map((b) => [b.name, { min: Number(b.min), max: Number(b.max), default: Number(b.def) }])),
    riskBudget: { maxOrderBpsOfBudget: Number(w.maxOrderBps), maxDailyLossBps: Number(w.maxDailyLossBps) },
    validationPlan: { paperDays: Number(w.paperDays), minTrades: Number(w.minTrades), notes: w.notes },
    ...(w.clonedFrom ? { clonedFrom: w.clonedFrom } : {}),
  };
}
export interface DefLite { key: string; name: string; category: string; summary: string; allowed_families: string[]; data_sources: string[]; regimes: string[]; param_bounds: Record<string, { min: number; max: number; default: number }>; risk_budget: { max_order_bps_of_budget?: number; max_daily_loss_bps?: number } }
export function cloneToWizard(d: DefLite): WizardState {
  const w = emptyWizard();
  return { ...w, name: `${d.name} (copy)`, slug: slugify(`${d.key.split('.').pop()}_copy`), category: d.category, summary: d.summary, families: [...d.allowed_families], clonedFrom: d.key, dataSources: [...d.data_sources], regimes: [...d.regimes],
    bounds: Object.entries(d.param_bounds ?? {}).map(([name, b]) => ({ name, min: String(b.min), max: String(b.max), def: String(b.default) })),
    maxOrderBps: String(d.risk_budget?.max_order_bps_of_budget ?? 1000), maxDailyLossBps: String(d.risk_budget?.max_daily_loss_bps ?? 100) };
}
