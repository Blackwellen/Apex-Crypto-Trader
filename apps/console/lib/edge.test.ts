import { describe, expect, it } from 'vitest';
import { netEdge, type EdgeInput, type EdgeResult } from './edge';

const base: EdgeInput = { baseDecimals: 8, quoteDecimals: 6, qty: '1', buyPrice: '100', sellPrice: '101', buyFeeBps: 10, sellFeeBps: 10, buySlippageBps: 5, sellSlippageBps: 5, latencyRiskBps: 20, fixedCosts: '0' };
const ok = (i: Partial<EdgeInput>) => { const r = netEdge({ ...base, ...i }); if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r as EdgeResult; };

describe('executable net edge', () => {
  it('computes naive spread vs net exactly in BigInt quote units', () => {
    const r = ok({});
    expect(r.buyCost).toBe(100_000_000n); expect(r.sellProceeds).toBe(101_000_000n); expect(r.naiveSpread).toBe(1_000_000n); expect(r.naiveSpreadBps).toBe(100n);
    expect(r.buyFee).toBe(100_000n); expect(r.sellFee).toBe(101_000n);
    expect(r.slippage).toBe(50_000n + 50_500n); expect(r.latencyRisk).toBe(200_000n);
    expect(r.totalCosts).toBe(100_000n + 101_000n + 100_500n + 200_000n);
    expect(r.netEdge).toBe(1_000_000n - 501_500n); expect(r.verdict).toBe('positive');
  });
  it('a positive naive spread can be a NEGATIVE executable edge', () => {
    const r = ok({ sellPrice: '100.2', buyFeeBps: 20, sellFeeBps: 20 }); expect(r.naiveSpread > 0n).toBe(true); expect(r.netEdge < 0n).toBe(true); expect(r.verdict).toBe('negative'); expect(r.netEdgeBps < 0n).toBe(true);
  });
  it('fixed costs (gas / withdrawal) reduce the edge', () => {
    expect(ok({ fixedCosts: '0.25' }).netEdge).toBe(ok({}).netEdge - 250_000n);
  });
  it('rounds in the conservative direction (costs up, proceeds down)', () => {
    const r = ok({ baseDecimals: 0, quoteDecimals: 0, qty: '1', buyPrice: '3', sellPrice: '3', buyFeeBps: 1, sellFeeBps: 1, buySlippageBps: 0, sellSlippageBps: 0, latencyRiskBps: 0 });
    expect(r.buyFee).toBe(1n); expect(r.sellFee).toBe(1n);       // ceil(3 * 1 / 10000) = 1, never 0
  });
  it('is exact beyond 2^53 (no float math)', () => {
    const r = ok({ baseDecimals: 18, quoteDecimals: 18, qty: '123456789.123456789', buyPrice: '98765.432109876543', sellPrice: '98765.432109876544', buyFeeBps: 0, sellFeeBps: 0, buySlippageBps: 0, sellSlippageBps: 0, latencyRiskBps: 0 });
    expect(r.buyCost > 2n ** 80n).toBe(true); expect(r.naiveSpread).toBe(r.sellProceeds - r.buyCost); expect(r.netEdge).toBe(r.naiveSpread);
  });
  it('zero edge is reported as zero, not positive', () => {
    expect(ok({ sellPrice: '100', buyFeeBps: 0, sellFeeBps: 0, buySlippageBps: 0, sellSlippageBps: 0, latencyRiskBps: 0 }).verdict).toBe('zero');
  });
  it('breakeven gross spread covers all costs', () => {
    const r = ok({}); expect(r.breakevenGrossBps).toBe(51n);   // 501500 / 100e6 = 50.15 bps -> rounded up
  });
  it('rejects invalid input with per-field messages', () => {
    for (const bad of [{ qty: '0' }, { qty: '-1' }, { buyPrice: 'abc' }, { buyPrice: '0' }, { sellPrice: '1.1234567' }, { buyFeeBps: -1 }, { buyFeeBps: 1.5 }, { latencyRiskBps: 1e9 }, { fixedCosts: '-3' }]) {
      const r = netEdge({ ...base, ...bad } as EdgeInput); expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });
});
