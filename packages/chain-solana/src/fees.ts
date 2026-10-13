// Solana fee model (lamports, bigint). Priority fee is charged on the REQUESTED compute-unit limit (legacy/v0), not CUs consumed.
export const LAMPORTS_PER_SIGNATURE = 5_000n;       // base fee per signature (Solana fee docs)
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000n;   // per-transaction CU ceiling (Solana compute budget docs)
export const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;
export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
export const MIN_JITO_TIP_LAMPORTS = 1_000n;        // Jito bundle minimum tip (Jito docs)

export type TxVersion = 'legacy' | 'v0' | 'v1';

export function priorityFeeLamports(cuLimit: bigint, microLamportsPerCu: bigint): bigint {
  if (cuLimit <= 0n || cuLimit > MAX_COMPUTE_UNIT_LIMIT) throw new Error(`cuLimit must be in 1..${MAX_COMPUTE_UNIT_LIMIT}`);
  if (microLamportsPerCu < 0n) throw new Error('negative CU price');
  return (cuLimit * microLamportsPerCu + MICRO_LAMPORTS_PER_LAMPORT - 1n) / MICRO_LAMPORTS_PER_LAMPORT; // ceil
}

export class JitoTipRefused extends Error { constructor(m: string) { super(m); this.name = 'JitoTipRefused'; } }
/**
 * Bounded Jito tip. `maxTipLamports` is a REQUIRED hard cap; optionally also capped at a fraction of the trade value.
 * Returns the clamped tip, or throws if even the minimum tip would exceed the cap (so we never overpay to land).
 */
export function boundedJitoTip(o: { suggestedLamports: bigint; maxTipLamports: bigint; tradeValueLamports?: bigint; maxTipFractionOfTradeBps?: bigint; minTipLamports?: bigint }): bigint {
  const min = o.minTipLamports ?? MIN_JITO_TIP_LAMPORTS;
  let cap = o.maxTipLamports;
  if (cap < 0n) throw new Error('negative cap');
  if (o.tradeValueLamports !== undefined && o.maxTipFractionOfTradeBps !== undefined) {
    const frac = (o.tradeValueLamports * o.maxTipFractionOfTradeBps) / 10_000n;
    if (frac < cap) cap = frac;
  }
  if (cap < min) throw new JitoTipRefused(`cap ${cap} below Jito minimum tip ${min}; bundle path not economic`);
  const t = o.suggestedLamports < min ? min : o.suggestedLamports;
  return t > cap ? cap : t;
}

export interface SolanaFeeInput {
  version: TxVersion; numSignatures: number; cuLimit: bigint; microLamportsPerCu: bigint;
  jitoTipLamports?: bigint; newAccountRentLamports?: bigint;
}
export interface SolanaFeeQuote {
  baseFee: bigint; priorityFee: bigint; jitoTip: bigint; rentForNewAccounts: bigint;
  /** burned/paid fees (base+priority+tip); rent is refundable-ish deposit, reported separately */
  feeTotal: bigint; totalOutlay: bigint;
  complete: boolean; unknownComponents: string[];
}
export function quoteSolanaFee(i: SolanaFeeInput): SolanaFeeQuote {
  if (!Number.isInteger(i.numSignatures) || i.numSignatures < 1) throw new Error('numSignatures >= 1');
  const base = LAMPORTS_PER_SIGNATURE * BigInt(i.numSignatures);
  const unknown: string[] = [];
  let priority = 0n;
  if (i.version === 'v1') unknown.push('priorityFee(v1 transaction fee semantics differ; not modelled)');
  else priority = priorityFeeLamports(i.cuLimit, i.microLamportsPerCu);
  const tip = i.jitoTipLamports ?? 0n; const rent = i.newAccountRentLamports ?? 0n;
  const feeTotal = base + priority + tip;
  return { baseFee: base, priorityFee: priority, jitoTip: tip, rentForNewAccounts: rent, feeTotal, totalOutlay: feeTotal + rent, complete: unknown.length === 0, unknownComponents: unknown };
}

const u32le = (n: bigint) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, Number(n), true); return b; };
const u64le = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
/** Instruction data for ComputeBudget SetComputeUnitLimit (disc 2, u32) and SetComputeUnitPrice (disc 3, u64 micro-lamports). */
export function setComputeUnitLimitData(units: bigint): Uint8Array { if (units <= 0n || units > MAX_COMPUTE_UNIT_LIMIT) throw new Error('bad CU limit'); return Uint8Array.from([2, ...u32le(units)]); }
export function setComputeUnitPriceData(microLamports: bigint): Uint8Array { if (microLamports < 0n) throw new Error('bad price'); return Uint8Array.from([3, ...u64le(microLamports)]); }
