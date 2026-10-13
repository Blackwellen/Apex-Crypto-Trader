/**
 * Waterfall preview: BigInt integer arithmetic that EXACTLY mirrors `apply_waterfall` in
 * packages/db/migrations/0004_compounding_ops.sql (div() = floor division on non-negative integers; the rounding
 * remainder always goes to reinvest). Cross-checked against the real SQL function in
 * services/api/tests/console_ops.test.ts and against recorded SQL vectors in lib/waterfall.test.ts.
 *
 * SQL (for reference):
 *   gross := greatest(realized_net_quote, 0);  (gross = 0 -> rejected: nothing to distribute)
 *   def   := least(deficit, gross);  elig := gross - def;
 *   if elig < min_ticket or elig = 0 -> execution recorded with all portions 0 (profit event still marked processed)
 *   tax := div(elig * tax_bps, 10000)
 *   vt  := div((elig - tax) * vault_bps, 10000);  cx := div((elig - tax) * cross_bps, 10000);  rs := div((elig - tax) * reserve_bps, 10000)
 *   rv  := elig - tax - vt - cx - rs
 */
export interface WaterfallPolicy { taxBps: number; reinvestBps: number; vaultBps: number; crossBps: number; reserveBps: number; minTicket: bigint }
export interface WaterfallResult { gross: bigint; deficitRecovered: bigint; eligible: bigint; tax: bigint; reinvest: bigint; vault: bigint; cross: bigint; reserve: bigint; belowMinTicket: boolean; noProfit: boolean }

/** SQL div(): truncating integer division. Inputs here are always >= 0, so it equals floor division. */
export const div = (a: bigint, b: bigint): bigint => a / b;

export const portionsTotalBps = (p: Pick<WaterfallPolicy, 'reinvestBps' | 'vaultBps' | 'crossBps' | 'reserveBps'>) => p.reinvestBps + p.vaultBps + p.crossBps + p.reserveBps;
export const portionsValid = (p: Pick<WaterfallPolicy, 'reinvestBps' | 'vaultBps' | 'crossBps' | 'reserveBps'>) =>
  [p.reinvestBps, p.vaultBps, p.crossBps, p.reserveBps].every((x) => Number.isInteger(x) && x >= 0 && x <= 10000) && portionsTotalBps(p) === 10000;

export function previewWaterfall(realisedNet: bigint, deficit: bigint, p: WaterfallPolicy): WaterfallResult {
  const zero = { tax: 0n, reinvest: 0n, vault: 0n, cross: 0n, reserve: 0n };
  const gross = realisedNet > 0n ? realisedNet : 0n;
  if (gross === 0n) return { gross, deficitRecovered: 0n, eligible: 0n, ...zero, belowMinTicket: false, noProfit: true };
  const def = deficit < gross ? (deficit > 0n ? deficit : 0n) : gross;
  const elig = gross - def;
  if (elig < p.minTicket || elig === 0n) return { gross, deficitRecovered: def, eligible: 0n, ...zero, belowMinTicket: elig > 0n, noProfit: false };
  const tax = div(elig * BigInt(p.taxBps), 10000n);
  const net = elig - tax;
  const vault = div(net * BigInt(p.vaultBps), 10000n);
  const cross = div(net * BigInt(p.crossBps), 10000n);
  const reserve = div(net * BigInt(p.reserveBps), 10000n);
  const reinvest = elig - tax - vault - cross - reserve;
  return { gross, deficitRecovered: def, eligible: elig, tax, reinvest, vault, cross, reserve, belowMinTicket: false, noProfit: false };
}

/**
 * Scenario simulator: ILLUSTRATIVE ARITHMETIC, NOT A FORECAST. Applies a fixed return (bps of the tradeable balance) per cycle,
 * runs the waterfall on each cycle's profit and reinvests only the reinvest portion. It uses no market data and no probabilities.
 */
export interface SimRow { cycle: number; tradeable: bigint; profit: bigint; reinvest: bigint; vault: bigint; cross: bigint; reserve: bigint; tax: bigint; vaultTotal: bigint }
export function simulate(start: bigint, returnBps: number, cycles: number, p: WaterfallPolicy): SimRow[] {
  const rows: SimRow[] = []; let bal = start, vaultTotal = 0n;
  for (let i = 1; i <= Math.min(cycles, 120); i++) {
    const profit = div(bal * BigInt(returnBps), 10000n);
    const r = previewWaterfall(profit, 0n, p);
    bal = bal + r.reinvest; vaultTotal += r.vault;
    rows.push({ cycle: i, tradeable: bal, profit, reinvest: r.reinvest, vault: r.vault, cross: r.cross, reserve: r.reserve, tax: r.tax, vaultTotal });
  }
  return rows;
}

/** "12.5" (percent) -> 1250 bps. Integer parsing only; at most 2 decimals; null when invalid. */
export function pctToBps(input: string): number | null {
  const m = /^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
}
export const bpsToPct = (b: number) => `${Math.floor(b / 100)}.${String(b % 100).padStart(2, '0')}`;

/** Target amount in base units: absolute amount if set, else start_equity * pct / 10000 (integer floor). */
export function targetBase(t: { target_amount: string | null; target_pct_bps: number | null; start_equity: string }): bigint | null {
  if (t.target_amount !== null && t.target_amount !== undefined) return BigInt(t.target_amount);
  if (t.target_pct_bps !== null && t.target_pct_bps !== undefined) return (BigInt(t.start_equity) * BigInt(t.target_pct_bps)) / 10000n;
  return null;
}
/** Progress in basis points (realised / target), clamped below at 0; null when the target is zero/unknown. */
export function progressBps(realised: bigint, target: bigint | null): number | null {
  if (target === null || target <= 0n) return null;
  if (realised <= 0n) return 0;
  return Number((realised * 10000n) / target);
}
