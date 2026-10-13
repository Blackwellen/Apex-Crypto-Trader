import { describe, expect, it } from 'vitest';
import { ceilDiv, floorDiv, formatBps, planRoundTrip, type PlannerInput } from './planner';
import { parseUnits } from '../format';

const base: PlannerInput = { notional: 1_000_000_000n, entryFeeBps: 30n, exitFeeBps: 30n, entrySlippageBps: 50n, exitSlippageBps: 50n, buyTaxBps: 0n, sellTaxBps: 0n, gasEntry: 0n, gasExit: 0n, failedTxProbBps: 0n, grossMoveBps: 0n };

describe('division helpers', () => {
  it('ceil/floor handle negatives', () => { expect(ceilDiv(7n, 2n)).toBe(4n); expect(ceilDiv(-7n, 2n)).toBe(-3n); expect(floorDiv(-7n, 2n)).toBe(-4n); expect(floorDiv(7n, 2n)).toBe(3n); expect(floorDiv(-8n, 2n)).toBe(-4n); });
  it('rejects non-positive divisors', () => { expect(() => ceilDiv(1n, 0n)).toThrow(); });
});
describe('planRoundTrip', () => {
  it('zero move: loses exactly the costs (hand-computed, 1000 USDC with 6 decimals)', () => {
    const r = planRoundTrip(base);
    expect(r.entryCosts).toEqual({ fee: 3_000_000n, slippage: 5_000_000n, tax: 0n, gas: 0n });
    expect(r.effectiveEntryValue).toBe(992_000_000n);
    expect(r.exitCosts.fee).toBe(2_976_000n); expect(r.exitCosts.slippage).toBe(4_960_000n);
    expect(r.proceeds).toBe(992_000_000n - 2_976_000n - 4_960_000n);
    expect(r.netPnl).toBe(r.proceeds - 1_000_000_000n);
    expect(r.netPnl).toBeLessThan(0n);
    expect(r.totalCosts).toBe(-r.netPnl);                    // with zero move, net loss == total cost (accounting identity)
  });
  it('break-even move is the minimal integer bps with net >= 0', () => {
    const r = planRoundTrip(base); const be = r.breakEvenGrossBps!;
    expect(planRoundTrip({ ...base, grossMoveBps: be }).netPnl).toBeGreaterThanOrEqual(0n);
    expect(planRoundTrip({ ...base, grossMoveBps: be - 1n }).netPnl).toBeLessThan(0n);
    expect(be).toBeGreaterThan(150n);                         // ~ (30+50)*2 bps plus compounding of costs
  });
  it('taxes and gas raise break-even; failed-tx probability inflates expected gas', () => {
    const plain = planRoundTrip(base).breakEvenGrossBps!;
    const taxed = planRoundTrip({ ...base, buyTaxBps: 200n, sellTaxBps: 500n }).breakEvenGrossBps!;
    expect(taxed).toBeGreaterThan(plain + 650n);
    const g = planRoundTrip({ ...base, gasEntry: 2_000_000n, gasExit: 2_000_000n });
    expect(g.entryCosts.gas).toBe(2_000_000n);
    const gf = planRoundTrip({ ...base, gasEntry: 2_000_000n, gasExit: 2_000_000n, failedTxProbBps: 5000n });
    expect(gf.entryCosts.gas).toBe(4_000_000n); expect(gf.exitCosts.gas).toBe(4_000_000n);
    expect(gf.netPnl).toBeLessThan(g.netPnl);
  });
  it('a 100% sell tax can never break even (honeypot-like) -> null', () => {
    expect(planRoundTrip({ ...base, sellTaxBps: 10_000n }).breakEvenGrossBps).toBeNull();
  });
  it('is exact for very large amounts (no float rounding) and rounds costs up', () => {
    const n = parseUnits('123456789012345.123456', 6) ;
    const r = planRoundTrip({ ...base, notional: BigInt(n) + 1n, entryFeeBps: 1n });
    expect(r.entryCosts.fee).toBe(ceilDiv((BigInt(n) + 1n) * 1n, 10_000n));
    expect(typeof r.netPnl).toBe('bigint');
  });
  it('negative move gives a larger loss; depth check flags >2% of exit depth', () => {
    const up = planRoundTrip({ ...base, grossMoveBps: 500n }), down = planRoundTrip({ ...base, grossMoveBps: -500n });
    expect(down.netPnl).toBeLessThan(up.netPnl);
    expect(planRoundTrip({ ...base, exitDepth: 100_000_000_000n }).depthWarning).toBeNull();                    // 1% of depth
    expect(planRoundTrip({ ...base, exitDepth: 10_000_000_000n }).depthWarning).toMatch(/2%/);                  // 10% of depth
    expect(planRoundTrip(base).depthWarning).toMatch(/No exit-depth/);
  });
  it('validates inputs', () => {
    expect(() => planRoundTrip({ ...base, notional: 0n })).toThrow(/greater than zero/);
    expect(() => planRoundTrip({ ...base, failedTxProbBps: 10_000n })).toThrow(/below 100%/);
    expect(() => planRoundTrip({ ...base, entryFeeBps: 6000n, entrySlippageBps: 4000n })).toThrow(/whole notional/);
    expect(() => planRoundTrip({ ...base, sellTaxBps: 10_001n })).toThrow();
  });
  it('formats bps', () => { expect(formatBps(1234n)).toBe('12.34%'); expect(formatBps(-5n)).toBe('-0.05%'); expect(formatBps(0n)).toBe('0.00%'); });
});
