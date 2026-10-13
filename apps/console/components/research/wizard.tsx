'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, Stepper, TextInput, Select, useToast } from '@/components/ui';
import { useCommand, ApiError } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { useResearcher } from './common';

const STEPS = ['Strategy', 'Data window', 'Cost model', 'Validation', 'Review & run'];
interface Sleeve { name: string; on: boolean; pct: string; stage: 'research' | 'paper' }
const num = (s: string) => (s.trim() === '' ? NaN : Number(s));

export function BacktestWizard() {
  const { current, canWrite } = useWorkspace(); const toast = useToast(); const router = useRouter();
  const health = useResearcher(); const h = health.data; const reachable = !!h?.reachable;
  const supports = (f: string) => !!h?.backtestFields?.includes(f);
  const run = useCommand<any>('startBacktest');
  const [step, setStep] = useState(0);
  const [label, setLabel] = useState('');
  const [sleeves, setSleeves] = useState<Sleeve[] | null>(null);
  const [f, setF] = useState({ nBars: '2000', seed: '7', includeDelisted: true, cash: '100000', venue: 'cex', taker: '', spread: '', gasUnits: '', failProb: '', nBoot: '200', nPaths: '200', train: '', folds: '' });
  const key = useRef(crypto.randomUUID());
  const rows: Sleeve[] = sleeves ?? (h?.strategies ?? []).map((n) => ({ name: n, on: n === 'trend_momentum' || n === 'risk_off', pct: n === 'trend_momentum' ? '50' : '0', stage: 'research' as const }));
  const set = (k: keyof typeof f) => (v: string | boolean) => setF({ ...f, [k]: v });
  const chosen = rows.filter((r) => r.on);
  const total = chosen.reduce((a, r) => a + (Number.isFinite(num(r.pct)) ? num(r.pct) : 0), 0);

  const errors: string[][] = [
    [chosen.length === 0 ? 'Choose at least one strategy sleeve.' : '', chosen.some((r) => !(num(r.pct) >= 0 && num(r.pct) <= 100)) ? 'Allocations must be between 0 and 100%.' : '', total > 100 ? `Allocations add up to ${total}% (max 100%).` : ''],
    [!(num(f.nBars) >= 300 && num(f.nBars) <= 20000 && Number.isInteger(num(f.nBars))) ? 'Bars must be a whole number from 300 to 20000.' : '', !(Number.isInteger(num(f.seed)) && num(f.seed) >= 0) ? 'Seed must be a non-negative whole number.' : '', !(Number.isInteger(num(f.cash)) && num(f.cash) >= 100) ? 'Starting cash must be a whole number of at least 100.' : ''],
    [f.taker !== '' && !(num(f.taker) >= 0 && num(f.taker) <= 500) ? 'Taker fee must be 0 to 500 bps.' : '', f.spread !== '' && !(num(f.spread) >= 0 && num(f.spread) <= 500) ? 'Half-spread must be 0 to 500 bps.' : '', f.failProb !== '' && !(num(f.failProb) >= 0 && num(f.failProb) <= 90) ? 'Failed-tx probability must be 0 to 90%.' : ''],
    [!(num(f.nBoot) >= 50 && num(f.nBoot) <= 1000) ? 'Bootstrap resamples: 50 to 1000.' : '', !(num(f.nPaths) >= 50 && num(f.nPaths) <= 1000) ? 'Monte Carlo paths: 50 to 1000.' : '', f.train !== '' && !(num(f.train) >= 50 && num(f.train) <= 90) ? 'Train share must be 50 to 90%.' : ''],
    [],
  ].map((a) => a.filter(Boolean));
  const stepErr = errors[step] ?? [];
  const allErr = errors.flat();

  function submit() {
    if (!current) return;
    const extras: Record<string, number> = {};
    if (f.train !== '') extras.trainFraction = num(f.train) / 100; if (f.folds !== '') extras.walkForwardFolds = num(f.folds);
    if (f.taker !== '') extras.takerFeeBps = num(f.taker); if (f.spread !== '') extras.halfSpreadBps = num(f.spread);
    if (f.gasUnits !== '') extras.gasUnits = num(f.gasUnits); if (f.failProb !== '') extras.failProb = num(f.failProb) / 100;
    const body = { workspace: current.id, ...(label.trim() ? { label: label.trim() } : {}), seed: num(f.seed), nBars: num(f.nBars), includeDelisted: f.includeDelisted, venue: f.venue, initialCashQuote: num(f.cash),
      sleeves: chosen.map((r) => ({ name: r.name, allocation: num(r.pct) / 100, stage: r.stage })), nBoot: num(f.nBoot), nPaths: num(f.nPaths), ...(Object.keys(extras).length ? { extras } : {}) };
    run.mutate({ body, key: key.current }, {
      onSuccess: (r: any) => { toast.push('Backtest finished'); key.current = crypto.randomUUID(); router.push(`/research/${r.result.id}`); },
      onError: (e: ApiError) => { toast.push(e.message, 'bad'); if (e.code && e.status !== 0) key.current = crypto.randomUUID(); },
    });
  }
  const blocked = !reachable ? 'Researcher NOT REACHABLE: Run is disabled.' : !canWrite ? 'Your role cannot start backtests (trader or above).' : allErr.length ? 'Fix the highlighted fields first.' : '';

  return (
    <Card title="New backtest">
      {!reachable && !health.isLoading && <p role="alert" className="mb-4 rounded-xl border border-[#f3c9c5] bg-bad-soft p-3 text-[13px] font-semibold text-bad">Researcher NOT REACHABLE: Run is disabled. You can still review the wizard, but nothing can be executed until the service answers.</p>}
      <Stepper steps={STEPS} current={step} />
      {step === 0 && (
        <div className="space-y-4">
          <TextInput label="Run label (optional)" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} hint="Shown in run history and exports." />
          <fieldset><legend className="mb-2 text-[12px] font-semibold text-[#44546a]">Strategy sleeves (capital share of the simulated account)</legend>
            {!h?.strategies?.length && <p className="text-[13px] text-muted">{reachable ? 'The researcher reported no strategies.' : 'Strategy list unavailable while the researcher is not reachable.'}</p>}
            <div className="space-y-2">{rows.map((r, i) => (
              <div key={r.name} className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 rounded-xl border border-line p-3 sm:grid-cols-[auto_1fr_110px_130px]">
                <input type="checkbox" aria-label={`Include ${r.name}`} checked={r.on} onChange={(e) => setSleeves(rows.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} className="size-5 accent-[#2758da]" />
                <span className="font-mono text-[13px]">{r.name}</span>
                <label className="text-[12px] text-muted">Allocation %<input aria-label={`${r.name} allocation percent`} type="number" min={0} max={100} step={1} disabled={!r.on} value={r.pct} onChange={(e) => setSleeves(rows.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)))} className="mt-1 min-h-10 w-full rounded-xl border border-line px-3 text-[14px] text-ink disabled:bg-[#f3f5f9]" /></label>
                <label className="text-[12px] text-muted">Stage<select aria-label={`${r.name} stage`} disabled={!r.on} value={r.stage} onChange={(e) => setSleeves(rows.map((x, j) => (j === i ? { ...x, stage: e.target.value as 'research' | 'paper' } : x)))} className="mt-1 min-h-10 w-full rounded-xl border border-line bg-white px-3 text-[14px] text-ink disabled:bg-[#f3f5f9]"><option>research</option><option>paper</option></select></label>
              </div>))}</div>
            <p className="mt-2 text-[12px] text-muted" aria-live="polite">Total allocated: <strong>{total}%</strong> (the remainder stays in cash).</p>
          </fieldset>
        </div>)}
      {step === 1 && (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput label="Window length (hourly bars)" type="number" min={300} max={20000} step={1} value={f.nBars} onChange={(e) => set('nBars')(e.target.value)} hint="300 to 20,000 bars of the researcher's seeded generator." />
          <TextInput label="Random seed" type="number" min={0} step={1} value={f.seed} onChange={(e) => set('seed')(e.target.value)} hint="Same seed + same parameters = same data. Reproducible." />
          <TextInput label="Starting cash (whole quote units)" type="number" min={100} step={1} value={f.cash} onChange={(e) => set('cash')(e.target.value)} />
          <label className="flex items-start gap-3 rounded-xl border border-line p-3 text-[13px]"><input type="checkbox" checked={f.includeDelisted} onChange={(e) => set('includeDelisted')(e.target.checked)} className="mt-0.5 size-5 accent-[#2758da]" />
            <span><strong>Include delisted / rugged assets</strong><br /><span className="text-muted">Leaving this off makes the dataset survivorship-biased (optimistic). The report states which you chose.</span></span></label>
          <div className="sm:col-span-2 rounded-xl border border-dashed border-line p-3 text-[13px] text-muted"><strong className="text-ink">Data source: synthetic only.</strong> The researcher&apos;s <code>/backtests</code> endpoint accepts no dataset today, so every run uses its seeded generator and is labelled SYNTHETIC. Real historical data (CSV/parquet or Coinbase public candles) cannot be selected here until a loader is wired to that endpoint.</div>
        </div>)}
      {step === 2 && (
        <div className="space-y-4">
          <Select label="Venue cost preset" value={f.venue} onChange={(e) => set('venue')(e.target.value)} options={[{ value: 'cex', label: 'CEX spot (maker/taker fees, spread, book-depth slippage)' }, { value: 'dex', label: 'DEX (pool fee, slippage, gas, failed-transaction probability)' }]} hint="The exact fee, spread, depth, gas and failed-tx values used are recorded in the result's cost model." />
          <div className="grid gap-4 sm:grid-cols-2">
            <OverrideInput label="Taker fee override (bps)" field="takerFeeBps" f="taker_fee_bps" v={f.taker} on={set('taker')} ok={supports('taker_fee_bps')} />
            <OverrideInput label="Half-spread override (bps)" field="halfSpreadBps" f="half_spread_bps" v={f.spread} on={set('spread')} ok={supports('half_spread_bps')} />
            <OverrideInput label="Gas units per swap (DEX)" field="gasUnits" f="gas_units" v={f.gasUnits} on={set('gasUnits')} ok={supports('gas_units')} />
            <OverrideInput label="Failed-transaction probability (%)" field="failProb" f="fail_prob" v={f.failProb} on={set('failProb')} ok={supports('fail_prob')} />
          </div>
          <p className="text-[12px] text-muted">Slippage is modelled from simulated book depth and order size, not set by a single number. Overrides are only enabled when the connected researcher advertises them.</p>
        </div>)}
      {step === 3 && (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextInput label="Bootstrap resamples (metric intervals)" type="number" min={50} max={1000} step={50} value={f.nBoot} onChange={(e) => set('nBoot')(e.target.value)} hint="Stationary block bootstrap. More resamples = smoother interval ends." />
            <TextInput label="Monte Carlo paths (with stress scenarios)" type="number" min={50} max={1000} step={50} value={f.nPaths} onChange={(e) => set('nPaths')(e.target.value)} hint="Resampling of the realised path. Stress scenarios are reported separately. It is not a forecast." />
            <OverrideInput label="Train share of window (%)" field="trainFraction" f="train_fraction" v={f.train} on={set('train')} ok={supports('train_fraction')} />
            <OverrideInput label="Walk-forward folds" field="walkForwardFolds" f="walk_forward_folds" v={f.folds} on={set('folds')} ok={supports('walk_forward_folds')} />
          </div>
          <p className="text-[12px] text-muted">No-lookahead: the researcher decides at the close of bar t and fills at the open of bar t+1, and checks features for future leakage. Train/test segmentation and walk-forward are available only when the researcher&apos;s <code>/backtests</code> endpoint advertises them; until then the single in-sample path is reported with intervals and is never presented as out-of-sample.</p>
        </div>)}
      {step === 4 && (
        <div className="space-y-3 text-[13px]">
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            <Item k="Strategies">{chosen.map((r) => `${r.name} ${r.pct}% (${r.stage})`).join(', ') || 'none'}</Item>
            <Item k="Window">{f.nBars} hourly bars, seed {f.seed}</Item>
            <Item k="Starting cash">{f.cash} quote units</Item>
            <Item k="Delisted assets">{f.includeDelisted ? 'included' : 'EXCLUDED (survivorship-biased)'}</Item>
            <Item k="Venue preset">{f.venue.toUpperCase()}</Item>
            <Item k="Intervals">{f.nBoot} bootstrap resamples · {f.nPaths} Monte Carlo paths</Item>
          </dl>
          <div className="rounded-xl bg-warn-soft p-3 text-warn"><Badge tone="warn">SYNTHETIC</Badge> This run will use seeded synthetic data. Results will say so on every screen and export, and are not evidence of edge.</div>
          {blocked && <p role="alert" className="font-semibold text-bad">{blocked}</p>}
          {run.isPending && <p role="status" className="text-muted">Running on the researcher. This can take several seconds…</p>}
        </div>)}
      {stepErr.length > 0 && <ul role="alert" className="mt-4 list-disc pl-5 text-[13px] text-bad">{stepErr.map((e) => <li key={e}>{e}</li>)}</ul>}
      <div className="mt-6 flex flex-wrap justify-between gap-2">
        <Button onClick={() => setStep(step - 1)} disabled={step === 0 || run.isPending}>Back</Button>
        {step < STEPS.length - 1
          ? <div className="flex gap-2">{!reachable && <Button variant="primary" disabled>Run backtest</Button>}<Button variant="primary" onClick={() => setStep(step + 1)} disabled={stepErr.length > 0}>Next</Button></div>
          : <Button variant="primary" onClick={submit} busy={run.isPending} disabled={!!blocked}>Run backtest</Button>}
      </div>
    </Card>
  );
}
const Item = ({ k, children }: { k: string; children: React.ReactNode }) => <div><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">{k}</dt><dd>{children}</dd></div>;
function OverrideInput({ label, v, on, ok, f }: { label: string; field: string; f: string; v: string; on: (v: string) => void; ok: boolean }) {
  return <TextInput label={label} type="number" step="any" disabled={!ok} value={ok ? v : ''} onChange={(e) => on(e.target.value)} placeholder={ok ? 'preset' : 'not supported'} hint={ok ? 'Leave empty to use the preset.' : `Disabled: the connected researcher does not advertise "${f}" on /backtests.`} />;
}
