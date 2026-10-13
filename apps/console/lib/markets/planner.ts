/**
 * Protected trade planner: net round-trip economics for a PLANNED spot trade, in BigInt base units. No floats touch money.
 * Costs round UP (against the trader), value after the hypothesised gross move rounds DOWN. Nothing here predicts price:
 * `grossMoveBps` is the user's hypothesis and the break-even is the move needed just to pay for costs.
 * Planning only: this module cannot place an order.
 */
export interface PlannerInput {
  notional: bigint;            // quote base units spent at entry
  entryFeeBps: bigint; exitFeeBps: bigint;
  entrySlippageBps: bigint; exitSlippageBps: bigint;
  buyTaxBps: bigint; sellTaxBps: bigint;      // token transfer taxes (from the safety findings)
  gasEntry: bigint; gasExit: bigint;           // quote base units each (0 on CEX)
  failedTxProbBps: bigint;                     // 0..9999: expected extra gas from retried failed txs = gas / (1-p)
  grossMoveBps: bigint;                        // hypothesised price move between entry and exit (may be negative)
  exitDepth?: bigint;                          // optional: effective exit depth in quote base units
}
export interface PlannerResult {
  entryCosts: { fee: bigint; slippage: bigint; tax: bigint; gas: bigint };
  exitCosts: { fee: bigint; slippage: bigint; tax: bigint; gas: bigint };
  totalCosts: bigint; effectiveEntryValue: bigint; valueBeforeExit: bigint; proceeds: bigint;
  netPnl: bigint; netBpsOfNotional: bigint; breakEvenGrossBps: bigint | null;
  positionPctOfExitDepthBps: bigint | null; depthWarning: string | null;
}
const BPS = 10_000n;
export const ceilDiv = (a: bigint, b: bigint): bigint => { if (b <= 0n) throw new Error('divisor must be positive'); return a >= 0n ? (a + b - 1n) / b : -((-a) / b); };
export const floorDiv = (a: bigint, b: bigint): bigint => { if (b <= 0n) throw new Error('divisor must be positive'); const q = a / b; return a % b !== 0n && a < 0n ? q - 1n : q; };
const cost = (amount: bigint, bps: bigint) => ceilDiv(amount * bps, BPS);

function validate(i: PlannerInput) {
  if (i.notional <= 0n) throw new Error('Notional must be greater than zero');
  for (const [k, v] of Object.entries({ entryFeeBps: i.entryFeeBps, exitFeeBps: i.exitFeeBps, entrySlippageBps: i.entrySlippageBps, exitSlippageBps: i.exitSlippageBps, buyTaxBps: i.buyTaxBps, sellTaxBps: i.sellTaxBps }))
    if (v < 0n || v > BPS) throw new Error(`${k} must be between 0 and 10000`);
  if (i.entryFeeBps + i.entrySlippageBps + i.buyTaxBps >= BPS) throw new Error('Entry costs consume the whole notional');
  if (i.failedTxProbBps < 0n || i.failedTxProbBps >= BPS) throw new Error('Failed-transaction probability must be below 100%');
  if (i.gasEntry < 0n || i.gasExit < 0n) throw new Error('Gas cannot be negative');
}

export function planRoundTrip(i: PlannerInput): PlannerResult {
  validate(i);
  const expGas = (g: bigint) => ceilDiv(g * BPS, BPS - i.failedTxProbBps);
  const entry = { fee: cost(i.notional, i.entryFeeBps), slippage: cost(i.notional, i.entrySlippageBps), tax: cost(i.notional, i.buyTaxBps), gas: expGas(i.gasEntry) };
  const effective = i.notional - entry.fee - entry.slippage - entry.tax;
  const evalAt = (g: bigint) => {
    const value = floorDiv(effective * (BPS + g), BPS);
    const v = value < 0n ? 0n : value;
    const exit = { fee: cost(v, i.exitFeeBps), slippage: cost(v, i.exitSlippageBps), tax: cost(v, i.sellTaxBps), gas: expGas(i.gasExit) };
    const proceeds = v - exit.fee - exit.slippage - exit.tax;
    const net = proceeds - i.notional - entry.gas - exit.gas;
    return { value: v, exit, proceeds, net };
  };
  const at = evalAt(i.grossMoveBps);
  // break-even: smallest integer gross move (bps) with net >= 0; net is non-decreasing in the move, so binary search
  let breakEven: bigint | null = null;
  if (evalAt(1_000_000n).net >= 0n) { let lo = -9_999n, hi = 1_000_000n; while (lo < hi) { const mid = floorDiv(lo + hi, 2n); if (evalAt(mid).net >= 0n) hi = mid; else lo = mid + 1n; } breakEven = lo; }
  const depthBps = i.exitDepth && i.exitDepth > 0n ? ceilDiv(i.notional * BPS, i.exitDepth) : null;
  return {
    entryCosts: entry, exitCosts: at.exit, totalCosts: entry.fee + entry.slippage + entry.tax + entry.gas + at.exit.fee + at.exit.slippage + at.exit.tax + at.exit.gas,
    effectiveEntryValue: effective, valueBeforeExit: at.value, proceeds: at.proceeds, netPnl: at.net, netBpsOfNotional: floorDiv(at.net * BPS, i.notional),
    breakEvenGrossBps: breakEven, positionPctOfExitDepthBps: depthBps,
    depthWarning: depthBps === null ? 'No exit-depth figure entered: the position cannot be checked against exit capacity.' : depthBps > 200n ? 'Position exceeds 2% of the entered exit depth: the strategy admission limit would reject this size.' : null,
  };
}
export const formatBps = (b: bigint) => { const neg = b < 0n; const a = neg ? -b : b; return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}%`; };
