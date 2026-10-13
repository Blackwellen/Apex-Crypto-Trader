// Aptos gas + expiration. Cost bound = gas_unit_price * max_gas_amount (octas, 1 APT = 1e8 octas).
import type { NativeReserve } from '@apex/contracts';
import type { GasEstimate } from './rest.ts';

export type GasUrgency = 'deprioritized' | 'normal' | 'prioritized';
export interface AptosGasQuote { gasUnitPrice: bigint; maxGasAmount: bigint; /** worst-case octas: gas_unit_price * max_gas_amount */ maxCost: bigint }

export class GasCapExceeded extends Error { constructor(m: string) { super(m); this.name = 'GasCapExceeded'; } }

export function quoteAptosGas(est: GasEstimate, o: { urgency?: GasUrgency; maxGasAmount: bigint; maxUnitPrice: bigint; maxCostOctas?: bigint }): AptosGasQuote {
  const price = est[o.urgency ?? 'normal'];
  if (price > o.maxUnitPrice) throw new GasCapExceeded(`gas_unit_price ${price} exceeds cap ${o.maxUnitPrice}`);
  if (o.maxGasAmount <= 0n) throw new Error('maxGasAmount must be > 0');
  const cost = price * o.maxGasAmount;
  if (o.maxCostOctas !== undefined && cost > o.maxCostOctas) throw new GasCapExceeded(`max cost ${cost} exceeds cap ${o.maxCostOctas}`);
  return { gasUnitPrice: price, maxGasAmount: o.maxGasAmount, maxCost: cost };
}
/** max_gas_amount from a simulation's gas_used: ceil(gas_used * (1+buffer)), bounded by `cap`; throws if the need exceeds the cap. */
export function maxGasFromSimulation(gasUsed: bigint, o: { bufferBps?: bigint; cap: bigint }): bigint {
  const need = (gasUsed * (10_000n + (o.bufferBps ?? 3_000n)) + 9_999n) / 10_000n;
  if (need > o.cap) throw new GasCapExceeded(`simulated need ${need} exceeds max_gas_amount cap ${o.cap}`);
  return need;
}

// ---- expiration (chain time, not the local clock) ----
export const DEFAULT_TTL_SECS = 60n; export const MAX_TTL_SECS = 600n;
/** expiration_timestamp_secs derived from the NODE's ledger timestamp (usec) so local clock skew cannot create an already-expired or too-long-lived tx. */
export function expirationFromLedger(ledgerTimestampUsec: bigint, ttlSecs: bigint = DEFAULT_TTL_SECS): bigint {
  if (ttlSecs < 10n || ttlSecs > MAX_TTL_SECS) throw new Error(`ttl must be within 10..${MAX_TTL_SECS}s`);
  return ledgerTimestampUsec / 1_000_000n + ttlSecs;
}
/** A tx is expired once chain time >= expiration_timestamp_secs. */
export function isExpiredAt(ledgerTimestampUsec: bigint, expirationSecs: bigint): boolean { return ledgerTimestampUsec >= expirationSecs * 1_000_000n; }

export interface AptosReserveConfig { floor: bigint; perTxMaxCost: bigint; emergencyExitMaxCost: bigint; emergencyMultiplierBps?: bigint }
export function computeAptosReserve(chainId: string, c: AptosReserveConfig, o: { plannedTxCount: number }): NativeReserve {
  if (!Number.isInteger(o.plannedTxCount) || o.plannedTxCount < 0) throw new Error('plannedTxCount must be a non-negative integer');
  const next = c.perTxMaxCost * BigInt(o.plannedTxCount);
  const exit = (c.emergencyExitMaxCost * (c.emergencyMultiplierBps ?? 15_000n) + 9_999n) / 10_000n;
  return { chainId, floor: c.floor, nextNTxEstimate: next, emergencyExit: exit, total: c.floor + next + exit };
}
