// EIP-1559 fee quoting (pure) + legacy fallback. Amounts are wei as bigint. No floats on money.
import type { FeeQuote } from '@apex/contracts';
import type { EvmRpcClient, RpcFeeHistory } from './rpc.ts';
import { RpcError } from './rpc.ts';

export class FeeCapExceededError extends Error {
  constructor(public readonly required: bigint, public readonly cap: bigint) {
    super(`required maxFeePerGas ${required} exceeds hard cap ${cap}; refusing to quote (fail closed)`);
    this.name = 'FeeCapExceededError';
  }
}

/** EIP-1559 base-fee update rule. Parameters are per-chain (OP-stack uses different elasticity/denominator): pass them. */
export function nextBaseFee(parentBaseFee: bigint, parentGasUsed: bigint, parentGasLimit: bigint, elasticity = 2n, denominator = 8n): bigint {
  const target = parentGasLimit / elasticity;
  if (target === 0n) throw new Error('gas target is zero');
  if (parentGasUsed === target) return parentBaseFee;
  if (parentGasUsed > target) {
    const delta = (parentBaseFee * (parentGasUsed - target)) / target / denominator;
    return parentBaseFee + (delta > 0n ? delta : 1n);
  }
  const delta = (parentBaseFee * (target - parentGasUsed)) / target / denominator;
  return parentBaseFee > delta ? parentBaseFee - delta : 0n;
}

export interface FeePolicy {
  /** maxFee = nextBaseFee * baseFeeMultiplierBps/10000 + priority. 20000 = tolerate 2x base fee growth (≈ 6 full blocks). */
  baseFeeMultiplierBps: bigint;
  minPriorityFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** HARD bound on maxFeePerGas. A quote that would need more throws FeeCapExceededError. */
  maxFeePerGasCap: bigint;
  /** index into the fee-history reward percentile columns used as the tip signal */
  rewardPercentileIndex: number;
}

export interface Eip1559Quote {
  type: 'eip1559';
  baseFeePerGas: bigint; priorityFeePerGas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint;
  /** headroom the maxFee gives above (base+priority) */
  headroom: bigint;
}
export interface LegacyQuote { type: 'legacy'; gasPrice: bigint }
export type EvmGasQuote = Eip1559Quote | LegacyQuote;

function median(xs: bigint[]): bigint {
  if (xs.length === 0) throw new Error('median of empty set');
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2n;
}
const clamp = (x: bigint, lo: bigint, hi: bigint) => (x < lo ? lo : x > hi ? hi : x);

export function priorityFromFeeHistory(h: Pick<RpcFeeHistory, 'reward'>, percentileIndex: number): bigint | undefined {
  const col = (h.reward ?? []).map((row) => row[percentileIndex]).filter((x): x is bigint => x !== undefined);
  return col.length ? median(col) : undefined;
}

export function quoteEip1559(input: { nextBaseFee: bigint; priorityObserved: bigint | undefined; policy: FeePolicy }): Eip1559Quote {
  const { policy } = input;
  if (policy.minPriorityFeePerGas > policy.maxPriorityFeePerGas) throw new Error('policy: min priority > max priority');
  const priority = clamp(input.priorityObserved ?? policy.minPriorityFeePerGas, policy.minPriorityFeePerGas, policy.maxPriorityFeePerGas);
  // ceil so the multiplier never rounds the buffer down
  const scaledBase = (input.nextBaseFee * policy.baseFeeMultiplierBps + 9_999n) / 10_000n;
  const maxFee = scaledBase + priority;
  if (maxFee > policy.maxFeePerGasCap) throw new FeeCapExceededError(maxFee, policy.maxFeePerGasCap);
  return {
    type: 'eip1559', baseFeePerGas: input.nextBaseFee, priorityFeePerGas: priority,
    maxFeePerGas: maxFee, maxPriorityFeePerGas: priority, headroom: maxFee - input.nextBaseFee - priority,
  };
}

export function quoteLegacy(gasPrice: bigint, policy: Pick<FeePolicy, 'baseFeeMultiplierBps' | 'maxFeePerGasCap'>, bufferBps = 11_000n): LegacyQuote {
  const p = (gasPrice * bufferBps + 9_999n) / 10_000n;
  if (p > policy.maxFeePerGasCap) throw new FeeCapExceededError(p, policy.maxFeePerGasCap);
  return { type: 'legacy', gasPrice: p };
}

export interface EvmFeeQuote {
  chainId: string; gas: EvmGasQuote; gasLimit: bigint;
  /** worst-case L2-execution cost: gasLimit * maxFeePerGas (or gasPrice) */
  worstCaseExecutionCost: bigint;
  /** L2 data-availability / L1 components, kept SEPARATE from execution cost. Each is a known amount or explicitly unknown. */
  l2Components: { name: string; amount?: bigint; known: boolean; note?: string }[];
  observedAt: number; source: string;
}

export function worstCaseCost(gas: EvmGasQuote, gasLimit: bigint): bigint {
  return gasLimit * (gas.type === 'eip1559' ? gas.maxFeePerGas : gas.gasPrice);
}

/** Adapt to the shared FeeQuote. An incomplete quote (unknown L2 component) is marked stale => consumers fail closed. */
export function toFeeQuote(q: EvmFeeQuote, nowMs: number, maxAgeMs = 15_000): FeeQuote {
  const components: Record<string, bigint> = { execution: q.worstCaseExecutionCost };
  let total = q.worstCaseExecutionCost;
  let incomplete = false;
  for (const c of q.l2Components) {
    if (c.known && c.amount !== undefined) { components[c.name] = c.amount; total += c.amount; } else incomplete = true;
  }
  const unknown = q.l2Components.filter((c) => !c.known).map((c) => c.name);
  return {
    chainId: q.chainId, nativeUnits: total, components, observedAt: q.observedAt,
    source: q.source + (incomplete ? `;INCOMPLETE:unknown=${unknown.join(',')}` : ''),
    stale: incomplete || nowMs - q.observedAt > maxAgeMs,
  };
}

export const DEFAULT_POLICY_PERCENTILES = [25, 50, 75] as const;

/** Fetch inputs from the node and build a quote. Falls back to eth_maxPriorityFeePerGas, then to legacy gasPrice. */
export async function fetchGasQuote(client: EvmRpcClient, policy: FeePolicy): Promise<{ gas: EvmGasQuote; source: string }> {
  const latest = await client.getBlock('latest');
  if (!latest) throw new Error('node returned no latest block');
  if (latest.baseFeePerGas === undefined) {
    return { gas: quoteLegacy(await client.gasPrice(), policy), source: 'eth_gasPrice(legacy: block has no baseFeePerGas)' };
  }
  let priority: bigint | undefined; let base = latest.baseFeePerGas; let source = 'eth_feeHistory';
  try {
    const h = await client.feeHistory(5, 'latest', [...DEFAULT_POLICY_PERCENTILES]);
    priority = priorityFromFeeHistory(h, policy.rewardPercentileIndex);
    const last = h.baseFeePerGas[h.baseFeePerGas.length - 1];
    if (last !== undefined) base = last; // node-reported base fee of the NEXT block
  } catch (e) {
    if (!(e instanceof RpcError)) throw e;
    source = 'eth_maxPriorityFeePerGas(feeHistory unavailable)';
    base = nextBaseFee(latest.baseFeePerGas, latest.gasUsed, latest.gasLimit);
    try { priority = await client.maxPriorityFeePerGas(); } catch (e2) { if (!(e2 instanceof RpcError)) throw e2; priority = undefined; source += ';tip=policy-min'; }
  }
  return { gas: quoteEip1559({ nextBaseFee: base, priorityObserved: priority, policy }), source };
}
