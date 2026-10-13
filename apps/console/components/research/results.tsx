'use client';
import { Badge, Card, DataTable, EmptyState, LineChart } from '@/components/ui';
import { equitySeries, fnum, fpct, interval, straddlesZero } from '@/lib/research/results';
import { ProvenanceBadge, SyntheticNotice } from './common';

const CI_ROWS: [string, string, (x: unknown) => string][] = [['sharpe', 'Sharpe ratio (annualised)', (x) => fnum(x, 2)], ['cagr', 'CAGR', (x) => fpct(x)], ['max_drawdown', 'Max drawdown', (x) => fpct(x)], ['total_return', 'Total return', (x) => fpct(x)]];

export function IntervalBar({ lo, hi, point, scale }: { lo: number; hi: number; point: number; scale: [number, number] }) {
  const [a, b] = scale; const span = b - a || 1; const p = (v: number) => Math.min(100, Math.max(0, ((v - a) / span) * 100));
  return <div aria-hidden className="relative h-2 w-full min-w-[80px] rounded-full bg-[#eef1f6]"><div className="absolute h-2 rounded-full bg-accent-soft" style={{ left: `${p(lo)}%`, width: `${Math.max(1, p(hi) - p(lo))}%`, background: '#c9d7fb' }} /><div className="absolute top-[-2px] h-3 w-1 rounded bg-accent" style={{ left: `${p(point)}%` }} /></div>;
}

/** Survivorship + no-lookahead statements: rendered on every result, sourced from the researcher's own report. */
export function MethodStatements({ report }: { report: any }) {
  const s = report?.survivorship, n = report?.no_lookahead;
  const biased = s?.includes_delisted === false;
  return (
    <div className="grid gap-4 md:grid-cols-2" data-testid="method-statements">
      <section aria-label="Survivorship bias" className={`rounded-2xl border p-4 text-[13px] ${biased ? 'border-[#f3c9c5] bg-bad-soft text-bad' : 'border-line bg-card'}`}>
        <h3 className="mb-1 text-[13px] font-bold uppercase tracking-wider">Survivorship bias</h3>
        {s ? <><p>{s.interpretation}</p><p className="mt-1 text-muted">Delisted/rugged assets declared included: <strong>{String(s.includes_delisted)}</strong> · present in this sample: <strong>{s.delisted_assets_in_dataset}</strong> · flag: <code>{s.bias_flag}</code></p><p className="mt-1 text-muted">{s.note}</p></>
          : <p>The researcher did not return a survivorship section for this run, so treat it as <strong>unvetted</strong>.</p>}
      </section>
      <section aria-label="No lookahead" className="rounded-2xl border border-line bg-card p-4 text-[13px]">
        <h3 className="mb-1 text-[13px] font-bold uppercase tracking-wider">No lookahead</h3>
        {n ? <><p>Execution rule: <strong>{n.execution}</strong>.</p><p className="mt-1 text-muted">Check: {n.method}. Feature sets checked: {(n.validated_feature_sets ?? []).join(', ') || 'none reported'}.</p></>
          : <p>The researcher did not return a lookahead section for this run, so treat it as <strong>unvetted</strong>.</p>}
      </section>
    </div>
  );
}

export function MetricsTable({ report }: { report: any }) {
  const u = report?.metric_uncertainty; const ok = u?.status === 'OK'; const level = typeof u?.method?.level === 'number' ? Math.round(u.method.level * 100) : null;
  return (
    <Card title="Metrics with uncertainty">
      {!ok && <p className="mb-3 rounded-lg bg-warn-soft p-3 text-[13px] text-warn">Not enough observations for intervals ({u?.n_obs ?? 'unknown'} obs). Point estimates below must not be read as findings.</p>}
      <div className="overflow-x-auto rounded-xl border border-line"><table className="w-full min-w-[560px] text-left text-[13px]"><caption className="sr-only">Point estimates with {level ?? 'n/a'} percent bootstrap confidence intervals</caption>
        <thead className="bg-[#f6f8fb] text-[11px] uppercase tracking-wider text-muted"><tr><th scope="col" className="px-4 py-3">Metric</th><th scope="col" className="px-4 py-3 text-right">Point</th><th scope="col" className="px-4 py-3 text-right">{level ?? 'n/a'}% interval</th><th scope="col" className="px-4 py-3">Range</th><th scope="col" className="px-4 py-3">Reading</th></tr></thead>
        <tbody>{CI_ROWS.map(([k, name, fmt]) => { const m = u?.[k]; const iv = ok ? interval(m) : null; const z = straddlesZero(iv);
          return <tr key={k} className="border-t border-line"><th scope="row" className="px-4 py-3 font-medium">{name}</th>
            <td className="tabular px-4 py-3 text-right">{fmt(m?.point ?? report?.point_metrics?.[k])}</td>
            <td className="tabular px-4 py-3 text-right">{iv ? `[${fmt(iv[0])}, ${fmt(iv[1])}]` : 'no interval'}</td>
            <td className="px-4 py-3">{iv && m ? <IntervalBar lo={iv[0]} hi={iv[1]} point={m.point} scale={[iv[0] - Math.abs(iv[1] - iv[0]) * 0.1, iv[1] + Math.abs(iv[1] - iv[0]) * 0.1]} /> : null}</td>
            <td className="px-4 py-3 text-[12px] text-muted">{k === 'max_drawdown' || k === 'total_return' || k === 'cagr' || k === 'sharpe' ? (z === null ? 'unknown' : z && k !== 'max_drawdown' ? 'interval includes zero: not distinguishable from no effect' : k === 'max_drawdown' ? 'drawdown range' : 'interval excludes zero (in-sample, one path)') : ''}</td></tr>; })}</tbody></table></div>
      <dl className="mt-4 grid gap-3 text-[13px] sm:grid-cols-3">
        <div><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">P(Sharpe ≤ 0), bootstrap</dt><dd className="tabular">{fnum(u?.prob_sharpe_leq_0_bootstrap, 2)}</dd></div>
        <div><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Probabilistic Sharpe P(SR&gt;0)</dt><dd className="tabular">{fnum(u?.psr_sharpe_gt_0, 2)}</dd></div>
        <div><dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">Deflated Sharpe (trials: {report?.n_trials_assumed ?? 'n/a'})</dt><dd className="tabular">{fnum(report?.deflated_sharpe_prob, 2)}</dd></div>
      </dl>
      <p className="mt-3 text-[12px] text-muted">{ok ? `Stationary block bootstrap, ${u.method.n_boot} resamples, mean block ${u.method.mean_block_bars} bars, ${level}% level.` : ''} Intervals describe sampling noise of ONE path of ONE dataset, not future performance.</p>
      <details className="mt-3 text-[13px]"><summary className="cursor-pointer font-semibold">Other point estimates (no interval computed)</summary>
        <dl className="mt-2 grid gap-2 sm:grid-cols-3">{(['ann_vol', 'sortino', 'calmar', 'n_closed_trades', 'win_rate_closed_trades', 'turnover_x_equity'] as const).map((k) => <div key={k}><dt className="font-mono text-[11px] text-muted">{k}</dt><dd className="tabular">{fnum(report?.point_metrics?.[k], 3)}</dd></div>)}</dl></details>
    </Card>
  );
}

export function MonteCarlo({ report }: { report: any }) {
  const mc = report?.monte_carlo_stress;
  if (!mc || mc.status !== 'OK') return <Card title="Monte Carlo with stress"><EmptyState title="No Monte Carlo result" hint={mc?.status ? `Researcher status: ${mc.status}` : 'The researcher did not return one.'} /></Card>;
  const rows = Object.entries<any>(mc.scenarios).map(([name, s]) => ({ id: name, name, ...s }));
  const pair = (a: number[], f: (x: number) => string) => (Array.isArray(a) ? `${f(a[0])} to ${f(a[1])}` : 'n/a');
  return (
    <Card title="Monte Carlo with stress scenarios">
      <DataTable searchable={false} caption="Monte Carlo scenarios" rows={rows} cols={[
        { key: 'name', header: 'Scenario' },
        { key: 'terminal_multiple_median', header: 'Terminal multiple (median)', align: 'right', render: (r) => <span>{fnum(r.terminal_multiple_median, 3)}<br /><span className="text-[11px] text-muted">{mc.level * 100}%: {pair(r.terminal_multiple_ci, (x) => fnum(x, 2))}</span></span>, sort: (r) => r.terminal_multiple_median },
        { key: 'max_drawdown_median', header: 'Max drawdown (median)', align: 'right', render: (r) => <span>{fpct(r.max_drawdown_median)}<br /><span className="text-[11px] text-muted">{pair(r.max_drawdown_ci, (x) => fpct(x, 0))}</span></span>, sort: (r) => r.max_drawdown_median },
        { key: 'prob_loss', header: 'P(loss)', align: 'right', render: (r) => fpct(r.prob_loss, 0) }, { key: 'prob_drawdown_gt_30pct', header: 'P(DD > 30%)', align: 'right', render: (r) => fpct(r.prob_drawdown_gt_30pct, 1) },
        { key: 'prob_drawdown_gt_50pct', header: 'P(DD > 50%)', align: 'right', render: (r) => fpct(r.prob_drawdown_gt_50pct, 1) }]} />
      <p className="mt-3 text-[12px] text-muted">{mc.disclaimer} {mc.n_paths} paths over {mc.horizon_bars} bars.</p>
    </Card>
  );
}

export function CostsCard({ report }: { report: any }) {
  const c = report?.costs, m = report?.cost_model;
  return (
    <Card title="Cost model and costs paid">
      {m ? <dl className="grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-3">{Object.entries(m).map(([k, v]) => <div key={k}><dt className="font-mono text-[11px] text-muted">{k}</dt><dd className="tabular">{String(v)}</dd></div>)}</dl> : <p className="text-[13px] text-muted">No cost model returned.</p>}
      {c && <><h3 className="mb-1 mt-4 text-[12px] font-bold uppercase tracking-wider text-muted">Paid in simulation (integer quote micro-units)</h3>
        <dl className="grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-3">{Object.entries(c).map(([k, v]) => <div key={k}><dt className="font-mono text-[11px] text-muted">{k}</dt><dd className="tabular">{String(v)}</dd></div>)}</dl></>}
    </Card>
  );
}

export function SplitSections({ report }: { report: any }) {
  const wf = report?.walk_forward, ho = report?.holdout;
  return (
    <Card title="Train / test, walk-forward and out-of-sample">
      {!wf && !ho
        ? <EmptyState title="No out-of-sample evidence in this run" hint="This run reports one in-sample path only. Nothing here has been validated out of sample, so do not treat the metrics above as predictive." />
        : <div className="space-y-4 text-[13px]">
          {ho && <div><h3 className="font-semibold">Holdout</h3><pre className="overflow-x-auto rounded-lg bg-[#f6f8fb] p-3 text-[12px]">{JSON.stringify(ho, null, 2)}</pre></div>}
          {wf && <div><h3 className="font-semibold">Walk-forward</h3><p className="text-muted">In-sample mean {fnum(wf.mean_in_sample)} vs out-of-sample mean {fnum(wf.mean_out_of_sample)} across {wf.folds?.length ?? 0} folds.</p>
            <DataTable searchable={false} caption="Walk-forward folds" rows={(wf.folds ?? []).map((f: any, i: number) => ({ id: String(i), ...f, train: JSON.stringify(f.train), test: JSON.stringify(f.test) }))} cols={[{ key: 'status', header: 'Status' }, { key: 'train', header: 'Train' }, { key: 'test', header: 'Test' }, { key: 'in_sample', header: 'IS', render: (r: any) => fnum(r.in_sample) }, { key: 'out_of_sample', header: 'OOS', render: (r: any) => fnum(r.out_of_sample) }]} /></div>}
        </div>}
    </Card>
  );
}

export function EquityCard({ report, provenance }: { report: any; provenance: string }) {
  const pts = equitySeries(report);
  return (
    <Card title="Equity curve">
      {pts
        ? <LineChart points={pts} label="Simulated equity" unit="quote micro-units (researcher-supplied)" provenance={`${provenance === 'SYNTHETIC' ? 'SYNTHETIC data' : 'REAL data (' + provenance + ')'} — in-sample, not a forecast`} summary={`${pts.length} points from ${pts[0].y} to ${pts[pts.length - 1].y}`} />
        : <EmptyState title="No equity series was returned" hint="The researcher's /backtests response contains summary statistics but no per-bar equity series, and APEX will not reconstruct a curve it was not given. Total return, drawdown and the Monte Carlo scenarios above are the researcher's own numbers." />}
      <p className="mt-2 text-[12px] text-muted">Provenance: <ProvenanceBadge value={provenance} /></p>
    </Card>
  );
}

export function WarningsCard({ report }: { report: any }) {
  const w: string[] = report?.warnings ?? [], l: string[] = report?.limitations ?? [];
  return (
    <Card title="Warnings and limitations">
      {w.length > 0 && <ul className="mb-3 list-disc space-y-1 pl-5 text-[13px] text-warn">{w.map((x) => <li key={x}>{x}</li>)}</ul>}
      <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted">{l.map((x) => <li key={x}>{x}</li>)}</ul>
      {report?.edge_claim && <p className="mt-3 text-[13px]"><Badge tone={report.data_provenance === 'SYNTHETIC' ? 'warn' : 'neutral'}>Edge claim</Badge> {report.edge_claim}</p>}
    </Card>
  );
}

export function RunBanner({ run }: { run: { data_provenance: string; metrics?: any } }) {
  return <SyntheticNotice provenance={run.data_provenance} banner={run.metrics?.report?.provenance_banner} />;
}
