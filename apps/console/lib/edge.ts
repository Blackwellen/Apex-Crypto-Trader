import { parseUnits } from './format';

/**
 * Executable net edge calculator (arbitrage). Pure BigInt math in quote base units. USER-ENTERED inputs only -- never fed from or presented as live data.
 * Rounding is conservative: costs round UP, proceeds round DOWN, so the displayed edge can only understate.
 */
export interface EdgeInput {
  baseDecimals: number; quoteDecimals: number;
  qty: string;               // whole base units, decimal string ("1.5")
  buyPrice: string;          // quote per 1 base at the venue you buy on (ask), decimal string
  sellPrice: string;         // quote per 1 base at the venue you sell on (bid)
  buyFeeBps: number; sellFeeBps: number;
  buySlippageBps: number; sellSlippageBps: number;
  latencyRiskBps: number;    // allowance for adverse price move during transfer / settlement latency
  fixedCosts: string;        // gas, withdrawal, bridge fees in QUOTE units (decimal string, "0" if none)
}
export interface EdgeResult {
  ok: true; buyCost: bigint; sellProceeds: bigint; naiveSpread: bigint; naiveSpreadBps: bigint;
  buyFee: bigint; sellFee: bigint; slippage: bigint; latencyRisk: bigint; fixed: bigint; totalCosts: bigint;
  netEdge: bigint; netEdgeBps: bigint; breakevenGrossBps: bigint; verdict: 'positive' | 'zero' | 'negative';
}
export type EdgeError = { ok: false; errors: Record<string, string> };

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;          // a,b >= 0
const bpsOf = (x: bigint, bps: number) => ceilDiv(x * BigInt(bps), 10000n);
const intBps = (n: number, name: string, errors: Record<string, string>, max = 100_000) => { if (!Number.isInteger(n) || n < 0 || n > max) errors[name] = `Whole basis points between 0 and ${max}`; };
const dec = (name: string, v: string, d: number, errors: Record<string, string>, allowZero = false): bigint => {
  try { const x = parseUnits(v, d); if (!allowZero && BigInt(x) === 0n) { errors[name] = 'Must be greater than zero'; return 0n; } return BigInt(x); }
  catch (e) { errors[name] = (e as Error).message; return 0n; }
};

export function netEdge(i: EdgeInput): EdgeResult | EdgeError {
  const errors: Record<string, string> = {};
  const qty = dec('qty', i.qty, i.baseDecimals, errors); const bp = dec('buyPrice', i.buyPrice, i.quoteDecimals, errors); const sp = dec('sellPrice', i.sellPrice, i.quoteDecimals, errors);
  const fixed = dec('fixedCosts', i.fixedCosts, i.quoteDecimals, errors, true);
  intBps(i.buyFeeBps, 'buyFeeBps', errors); intBps(i.sellFeeBps, 'sellFeeBps', errors); intBps(i.buySlippageBps, 'buySlippageBps', errors); intBps(i.sellSlippageBps, 'sellSlippageBps', errors); intBps(i.latencyRiskBps, 'latencyRiskBps', errors);
  if (Object.keys(errors).length) return { ok: false, errors };
  const unit = 10n ** BigInt(i.baseDecimals);
  const buyCost = ceilDiv(qty * bp, unit);                 // you pay: round up
  const sellProceeds = (qty * sp) / unit;                  // you receive: round down
  const naiveSpread = sellProceeds - buyCost;
  const buyFee = bpsOf(buyCost, i.buyFeeBps), sellFee = bpsOf(sellProceeds, i.sellFeeBps);
  const slippage = bpsOf(buyCost, i.buySlippageBps) + bpsOf(sellProceeds, i.sellSlippageBps);
  const latencyRisk = bpsOf(buyCost, i.latencyRiskBps);
  const totalCosts = buyFee + sellFee + slippage + latencyRisk + fixed;
  const net = naiveSpread - totalCosts;
  const bps = (x: bigint) => (buyCost === 0n ? 0n : (x * 10000n) / buyCost);   // truncates toward zero for negatives too
  const breakevenGrossBps = bps(totalCosts) + (totalCosts > 0n && (totalCosts * 10000n) % buyCost !== 0n ? 1n : 0n);
  return { ok: true, buyCost, sellProceeds, naiveSpread, naiveSpreadBps: bps(naiveSpread), buyFee, sellFee, slippage, latencyRisk, fixed, totalCosts, netEdge: net, netEdgeBps: bps(net), breakevenGrossBps, verdict: net > 0n ? 'positive' : net === 0n ? 'zero' : 'negative' };
}
