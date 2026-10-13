import { describe, expect, it } from 'vitest';
import { EXPORT_HEADER, equitySeries, exportRows, fnum, fpct, interval, metricRows, provenanceLabel, provenanceTone, straddlesZero } from './results';
import { toCsv } from '../csv';

const report = { point_metrics: { sharpe: 0.5, ann_vol: 0.2, n_closed_trades: 10 }, metric_uncertainty: { method: { level: 0.9 }, sharpe: { point: 0.5, ci_low: -4, ci_high: 5 }, cagr: { point: 0.1, ci_low: 0.05, ci_high: 0.2 }, max_drawdown: { point: -0.1, ci_low: -0.2, ci_high: -0.05 }, total_return: { point: 0.01, ci_low: 0.001, ci_high: 0.02 } } };
describe('results helpers', () => {
  it('formats safely', () => { expect(fnum(1.23456, 2)).toBe('1.23'); expect(fnum(NaN)).toBe('n/a'); expect(fnum(undefined)).toBe('n/a'); expect(fpct(0.1234)).toBe('12.3%'); });
  it('interval rejects missing/unordered/non-finite', () => {
    expect(interval({ ci_low: 1, ci_high: 2 })).toEqual([1, 2]); expect(interval({ ci_low: 3, ci_high: 2 })).toBeNull(); expect(interval({ ci_low: NaN, ci_high: 2 })).toBeNull(); expect(interval(undefined)).toBeNull();
  });
  it('straddlesZero', () => { expect(straddlesZero([-1, 1])).toBe(true); expect(straddlesZero([0.1, 1])).toBe(false); expect(straddlesZero(null)).toBeNull(); });
  it('provenance wording never flatters unknowns', () => {
    expect(provenanceLabel('SYNTHETIC')).toMatch(/SYNTHETIC/); expect(provenanceLabel('REAL_PUBLIC_API')).toMatch(/REAL/); expect(provenanceLabel(undefined)).toMatch(/pending/i);
    expect(provenanceTone('SYNTHETIC')).toBe('warn'); expect(provenanceTone(null)).toBe('neutral');
  });
  it('metric rows carry intervals only where the researcher gave them', () => {
    const rows = metricRows(report); expect(rows[0]).toMatchObject({ metric: 'Sharpe (annualised)', ciLow: '-4.000000', ciHigh: '5.000000', level: '90%' });
    expect(rows.find((r) => r.metric === 'ann_vol')).toMatchObject({ ciLow: 'n/a', level: 'no interval' });
    expect(metricRows(undefined).every((r) => r.point === 'n/a')).toBe(true);
  });
  it('export rows + CSV include provenance on every line and neutralise formula injection', () => {
    const rows = exportRows([{ id: 'r1', label: '=HYPERLINK("x")', status: 'done', data_provenance: 'SYNTHETIC', metrics: { report } }]);
    expect(rows.every((r) => r[3] === 'SYNTHETIC')).toBe(true);
    const csv = toCsv(EXPORT_HEADER, rows); expect(csv.split('\r\n')[0]).toContain('data_provenance'); expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
  it('equity series is used only when supplied and well-formed', () => {
    expect(equitySeries(report)).toBeNull(); expect(equitySeries({ equity_curve: [1, 2, 3] })!.length).toBe(3);
    expect(equitySeries({ equity_curve: [{ x: 'a', y: 1 }, { x: 'b', y: 2 }] })![1]).toEqual({ x: 'b', y: 2 }); expect(equitySeries({ equity_curve: [1, 'x'] })).toBeNull();
  });
});
