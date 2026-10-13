// Native gas reserve model: floor + next N transactions + emergency exit. Never lets spendable go negative.
import type { NativeReserve } from '@apex/contracts';

export interface ReserveConfig {
  /** minimum native balance kept at all times (dust / account-viability floor) */
  floor: bigint;
  /** worst-case native cost of ONE planned transaction (gasLimit*maxFee + any L2 data component) */
  perTxCost: bigint;
  /** worst-case native cost of a single emergency exit transaction (approve revoke / sell / withdraw) */
  emergencyExitCost: bigint;
  /** exit-cost multiplier in bps to absorb fee spikes (default 15000 = 1.5x) */
  emergencyMultiplierBps?: bigint;
}
export function computeNativeReserve(chainId: string, cfg: ReserveConfig, opts: { plannedTxCount: number }): NativeReserve {
  if (!Number.isInteger(opts.plannedTxCount) || opts.plannedTxCount < 0) throw new Error('plannedTxCount must be a non-negative integer');
  for (const [k, v] of Object.entries({ floor: cfg.floor, perTxCost: cfg.perTxCost, emergencyExitCost: cfg.emergencyExitCost })) if (v < 0n) throw new Error(`${k} negative`);
  const mult = cfg.emergencyMultiplierBps ?? 15_000n;
  const nextN = cfg.perTxCost * BigInt(opts.plannedTxCount);
  const exit = (cfg.emergencyExitCost * mult + 9_999n) / 10_000n;
  return { chainId, floor: cfg.floor, nextNTxEstimate: nextN, emergencyExit: exit, total: cfg.floor + nextN + exit };
}
/** Native amount a strategy may spend as VALUE (not gas) without breaching the reserve. */
export function spendableNative(balance: bigint, reserve: NativeReserve): bigint {
  const s = balance - reserve.total;
  return s > 0n ? s : 0n;
}
/** True when the wallet can still pay for an emergency exit after spending `amount` of native value. */
export function canSpendNative(balance: bigint, amount: bigint, reserve: NativeReserve): boolean {
  return amount >= 0n && balance - amount >= reserve.floor + reserve.emergencyExit;
}
