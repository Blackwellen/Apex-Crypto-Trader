import { describe, expect, it } from 'vitest';
import vectors from './waterfall.sql-vectors.json';
import { bpsToPct, pctToBps, portionsValid, previewWaterfall, progressBps, simulate, targetBase } from './waterfall';

// lib/waterfall.sql-vectors.json was produced by running the SAME expressions as apply_waterfall (migration 0004) in the real Postgres
// (see scripts in the evidence log); services/api/tests/console_ops.test.ts additionally calls the real apply_waterfall function.
describe('waterfall preview == SQL', () => {
  it('has a meaningful vector set', () => expect(vectors.length).toBeGreaterThanOrEqual(60));
  it.each(vectors.map((v, i) => [i, v] as const))('vector %i matches SQL', (_i, v) => {
    const r = previewWaterfall(BigInt(v.input.gross), BigInt(v.input.deficit), { taxBps: v.input.tax, reinvestBps: v.input.rv, vaultBps: v.input.vt, crossBps: v.input.cx, reserveBps: v.input.rs, minTicket: BigInt(v.input.minTicket) });
    expect({ deficitRecovered: r.deficitRecovered.toString(), eligible: r.eligible.toString(), tax: r.tax.toString(), vault: r.vault.toString(), cross: r.cross.toString(), reserve: r.reserve.toString(), reinvest: r.reinvest.toString() }).toEqual(v.expected);
    // conservation: every eligible base unit is allocated exactly once
    expect(r.tax + r.vault + r.cross + r.reserve + r.reinvest).toBe(r.eligible);
  });
});
describe('waterfall rules', () => {
  const p = { taxBps: 1000, reinvestBps: 4000, vaultBps: 3500, crossBps: 0, reserveBps: 2500, minTicket: 0n };
  it('rounding remainder goes to reinvest', () => { const r = previewWaterfall(7n, 0n, { ...p, taxBps: 0, reinvestBps: 3333, vaultBps: 3333, crossBps: 3334, reserveBps: 0 }); expect(r.vault).toBe(2n); expect(r.cross).toBe(2n); expect(r.reinvest).toBe(3n); });
  it('no profit => nothing', () => { expect(previewWaterfall(-5n, 0n, p).noProfit).toBe(true); expect(previewWaterfall(0n, 0n, p).eligible).toBe(0n); });
  it('deficit is recovered before distribution', () => { const r = previewWaterfall(1000n, 400n, p); expect(r.deficitRecovered).toBe(400n); expect(r.eligible).toBe(600n); });
  it('below min ticket records nothing to distribute', () => { const r = previewWaterfall(1000n, 0n, { ...p, minTicket: 2000n }); expect(r.belowMinTicket).toBe(true); expect(r.reinvest).toBe(0n); });
  it('portions must total exactly 10000 bps', () => { expect(portionsValid(p)).toBe(true); expect(portionsValid({ ...p, reserveBps: 2400 })).toBe(false); expect(portionsValid({ ...p, reserveBps: 2501 })).toBe(false); });
  it('huge values stay exact (no float)', () => { const g = 10n ** 40n + 3n; const r = previewWaterfall(g, 0n, { ...p, taxBps: 0, reinvestBps: 10000, vaultBps: 0, reserveBps: 0 }); expect(r.reinvest).toBe(g); });
});
describe('helpers', () => {
  it('pctToBps', () => { expect(pctToBps('40')).toBe(4000); expect(pctToBps('33.33')).toBe(3333); expect(pctToBps('0.5')).toBe(50); expect(pctToBps('1.234')).toBeNull(); expect(pctToBps('abc')).toBeNull(); expect(pctToBps('-1')).toBeNull(); });
  it('bpsToPct', () => { expect(bpsToPct(3333)).toBe('33.33'); expect(bpsToPct(5)).toBe('0.05'); });
  it('target progress is computed with BigInt from realised', () => {
    expect(targetBase({ target_amount: '1000', target_pct_bps: null, start_equity: '0' })).toBe(1000n);
    expect(targetBase({ target_amount: null, target_pct_bps: 500, start_equity: '20000' })).toBe(1000n);
    expect(progressBps(250n, 1000n)).toBe(2500); expect(progressBps(-5n, 1000n)).toBe(0); expect(progressBps(1n, 0n)).toBeNull();
  });
  it('simulator is deterministic arithmetic', () => { const rows = simulate(1000n, 100, 3, { taxBps: 0, reinvestBps: 5000, vaultBps: 5000, crossBps: 0, reserveBps: 0, minTicket: 0n }); expect(rows[0].profit).toBe(10n); expect(rows[0].tradeable).toBe(1005n); expect(rows).toHaveLength(3); });
});
