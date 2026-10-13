// Sui gas model helpers. Sui gas = computation (units * gas price) + storage cost - storage rebate. Budget must cover GROSS (computation+storage).
import type { GasSummary } from './rpc.ts';
import type { NativeReserve } from '@apex/contracts';

export function netGas(g: GasSummary): bigint { return g.computationCost + g.storageCost - g.storageRebate; }
export function grossGas(g: GasSummary): bigint { return g.computationCost + g.storageCost; }
/** Gas budget from a dry run: gross cost * (1+buffer), bounded by maxBudget (hard cap; throws if the need exceeds it). */
export function gasBudgetFromDryRun(g: GasSummary, o: { bufferBps?: bigint; maxBudget: bigint; minBudget?: bigint }): bigint {
  const need = (grossGas(g) * (10_000n + (o.bufferBps ?? 2_000n)) + 9_999n) / 10_000n;
  const b = o.minBudget !== undefined && need < o.minBudget ? o.minBudget : need;
  if (b > o.maxBudget) throw new Error(`gas budget ${b} exceeds cap ${o.maxBudget}; refusing (fail closed)`);
  return b;
}
export interface SuiReserveConfig { floor: bigint; perTxBudget: bigint; emergencyExitBudget: bigint; emergencyMultiplierBps?: bigint }
export function computeSuiReserve(chainId: string, c: SuiReserveConfig, o: { plannedTxCount: number }): NativeReserve {
  if (!Number.isInteger(o.plannedTxCount) || o.plannedTxCount < 0) throw new Error('plannedTxCount must be a non-negative integer');
  const next = c.perTxBudget * BigInt(o.plannedTxCount);
  const exit = (c.emergencyExitBudget * (c.emergencyMultiplierBps ?? 15_000n) + 9_999n) / 10_000n;
  return { chainId, floor: c.floor, nextNTxEstimate: next, emergencyExit: exit, total: c.floor + next + exit };
}
