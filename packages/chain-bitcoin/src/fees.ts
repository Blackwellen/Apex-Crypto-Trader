/**
 * Bitcoin sizing and fee maths. All money in satoshi (bigint). Fee rates are sat/kvB (bigint) to avoid floats.
 * Weights are in weight units (WU); vsize = ceil(WU/4).
 * NOTE: Bitcoin transfers are UTXO spends. They are NOT AMM swaps; there is no pool, no slippage, no router, no ERC-20.
 */
import type { BtcScriptType } from './address.ts';

export const BITCOIN_NOT_AMM = 'Bitcoin-native transfers are UTXO spends to an address. They are not AMM swaps and never go through a router/pool; BTC trading happens on exchange venues (VenueAdapter), separately from native custody visibility.';

export type InputType = 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh' | 'p2tr-keypath';
/** Typical input weights (BIP141 accounting, worst-case signature sizes): doc'd in Bitcoin Core policy/feerate comments. */
export const INPUT_WEIGHT: Record<InputType, number> = { 'p2pkh': 592, 'p2sh-p2wpkh': 364, 'p2wpkh': 272, 'p2tr-keypath': 230 };
export const OUTPUT_WEIGHT: Record<BtcScriptType, number> = { p2pkh: 136, p2sh: 128, p2wpkh: 124, p2wsh: 172, p2tr: 172 };
const SEGWIT_INPUTS: InputType[] = ['p2sh-p2wpkh', 'p2wpkh', 'p2tr-keypath'];
const BASE_TX_WEIGHT = 40; // version(4)+locktime(4) = 8 bytes *4 = 32, plus 1-byte in/out counts *4 *2 = 8 (valid for <253 in/out)
const SEGWIT_MARKER_WEIGHT = 2;

export function txWeight(inputs: InputType[], outputs: BtcScriptType[]): number {
  if (inputs.length >= 253 || outputs.length >= 253) throw new Error('varint-size counts not modelled');
  let w = BASE_TX_WEIGHT;
  for (const i of inputs) w += INPUT_WEIGHT[i];
  for (const o of outputs) w += OUTPUT_WEIGHT[o];
  if (inputs.some((i) => SEGWIT_INPUTS.includes(i))) w += SEGWIT_MARKER_WEIGHT;
  return w;
}
export const vsizeOf = (weight: number): bigint => BigInt(Math.ceil(weight / 4));
export const txVsize = (inputs: InputType[], outputs: BtcScriptType[]): bigint => vsizeOf(txWeight(inputs, outputs));

/** fee = ceil(rate[sat/kvB] * vsize / 1000) */
export const feeForVsize = (rateSatPerKvb: bigint, vsize: bigint): bigint => (rateSatPerKvb * vsize + 999n) / 1000n;

/** Dust (Bitcoin Core policy, dustRelayFee = 3000 sat/kvB): (output size + cost to spend it) * 3. */
export const DUST_RELAY_FEE_SAT_KVB = 3000n;
export const DUST_LIMIT: Record<BtcScriptType, bigint> = { p2pkh: 546n, p2sh: 540n, p2wpkh: 294n, p2wsh: 330n, p2tr: 330n };

/** "1.5" sat/vB -> 1500n sat/kvB. Rejects negatives/exponents. */
export function satPerVbToKvb(s: string | number): bigint {
  const str = typeof s === 'number' ? String(s) : s;
  if (!/^\d+(\.\d{1,3})?$/.test(str)) throw new Error(`bad fee rate '${str}'`);
  const [i, f = ''] = str.split('.');
  return BigInt(i!) * 1000n + BigInt(f.padEnd(3, '0'));
}
/** Bitcoin Core estimatesmartfee returns BTC/kvB as a decimal; 0.00001 BTC/kvB = 1000 sat/kvB. */
export function btcPerKvbToSatKvb(s: string | number): bigint {
  const str = typeof s === 'number' ? s.toFixed(8) : s;
  if (!/^\d+(\.\d{1,8})?$/.test(str)) throw new Error(`bad BTC/kvB '${str}'`);
  const [i, f = ''] = str.split('.');
  return BigInt(i!) * 100_000_000n + BigInt(f.padEnd(8, '0'));
}

export interface RecommendedFees { fastestFee: number; halfHourFee: number; hourFee: number; economyFee: number; minimumFee: number }
export type FeeTarget = 'fastest' | 'halfHour' | 'hour' | 'economy';
export interface FeeRateChoice { satPerKvb: bigint; source: string; clampedBy?: 'min' | 'cap' }
/** Pick a rate from mempool.space /api/v1/fees/recommended. Clamp to [relay floor, policy cap]; reject nonsense (non-monotone, zero). */
export function chooseFeeRate(rec: RecommendedFees, target: FeeTarget, opts: { minRelayFeeSatKvb: bigint; maxFeeRateSatKvb: bigint }): FeeRateChoice {
  const vals = [rec.fastestFee, rec.halfHourFee, rec.hourFee, rec.economyFee, rec.minimumFee];
  if (vals.some((v) => !Number.isFinite(v) || v <= 0)) throw new Error('fee estimate response contains non-positive rates');
  if (!(rec.fastestFee >= rec.halfHourFee && rec.halfHourFee >= rec.hourFee && rec.hourFee >= rec.economyFee && rec.economyFee >= rec.minimumFee)) throw new Error('fee estimate not monotone: refusing');
  const v = { fastest: rec.fastestFee, halfHour: rec.halfHourFee, hour: rec.hourFee, economy: rec.economyFee }[target];
  let r = satPerVbToKvb(v);
  let clampedBy: FeeRateChoice['clampedBy'];
  if (r < opts.minRelayFeeSatKvb) { r = opts.minRelayFeeSatKvb; clampedBy = 'min'; }
  if (r > opts.maxFeeRateSatKvb) { r = opts.maxFeeRateSatKvb; clampedBy = 'cap'; }
  return { satPerKvb: r, source: `mempool.space:${target}`, clampedBy };
}

// ---- BIP125 RBF ----
export interface RbfCheckInput {
  originalSignalsRbf: boolean;           // any input nSequence < 0xfffffffe (or ancestor signals)
  fullRbfPolicy: boolean;                // node runs mempoolfullrbf (default true in Bitcoin Core >= 28) - verify per node, do not assume
  evictedFeesSat: bigint;                // sum of fees of originals + all descendants that would be evicted
  evictedTxCount: number;                // originals + descendants
  replacementFeeSat: bigint;
  replacementVsize: bigint;
  incrementalRelayFeeSatKvb: bigint;     // node setting (default 1000 sat/kvB)
  replacementAddsUnconfirmedInputs: boolean;
}
export interface RbfResult { ok: boolean; minReplacementFeeSat: bigint; failures: string[] }
export function checkRbfReplacement(i: RbfCheckInput): RbfResult {
  const failures: string[] = [];
  const bump = feeForVsize(i.incrementalRelayFeeSatKvb, i.replacementVsize);
  const minFee = i.evictedFeesSat + bump;
  if (!i.originalSignalsRbf && !i.fullRbfPolicy) failures.push('rule1: original does not signal RBF and node is not full-RBF');
  if (i.replacementAddsUnconfirmedInputs) failures.push('rule2: replacement adds new unconfirmed inputs');
  if (i.replacementFeeSat < i.evictedFeesSat) failures.push('rule3: replacement fee below sum of replaced fees');
  if (i.replacementFeeSat < minFee) failures.push(`rule4: replacement fee ${i.replacementFeeSat} < required ${minFee} (evicted fees + incremental relay on own size)`);
  if (i.evictedTxCount > 100) failures.push('rule5: more than 100 transactions would be evicted');
  return { ok: failures.length === 0, minReplacementFeeSat: minFee, failures };
}

// ---- CPFP ----
/** Fee the child must pay so that (parent+child) package reaches targetRate. Returns 0 if parent already pays enough. */
export function cpfpChildFee(p: { parentFeeSat: bigint; parentVsize: bigint; childVsize: bigint; targetRateSatKvb: bigint }): bigint {
  const need = feeForVsize(p.targetRateSatKvb, p.parentVsize + p.childVsize) - p.parentFeeSat;
  if (need <= 0n) return 0n;
  const own = feeForVsize(p.targetRateSatKvb, p.childVsize); // child must at least pay its own way
  return need > own ? need : own;
}

// ---- finality ----
export type BtcFinality = 'unknown' | 'mempool' | 'included' | 'confirmed' | 'final' | 'reorged';
export interface DepthPolicy { includedMin: number; confirmedMin: number; finalByAmount: { upToSat: bigint; depth: number }[] }
/** Policy parameters (NOT consensus). Default: 1 included, 3 confirmed, final 6 for large; smaller for small amounts. Tune per risk policy. */
export const DEFAULT_DEPTH_POLICY: DepthPolicy = { includedMin: 1, confirmedMin: 3, finalByAmount: [{ upToSat: 1_000_000n, depth: 3 }, { upToSat: 100_000_000n, depth: 6 }, { upToSat: (1n << 62n), depth: 12 }] };
export function requiredDepth(amountSat: bigint, p: DepthPolicy = DEFAULT_DEPTH_POLICY): number {
  for (const t of p.finalByAmount) if (amountSat <= t.upToSat) return t.depth;
  return p.finalByAmount[p.finalByAmount.length - 1]!.depth;
}
/** confirmations = tip - blockHeight + 1; the recorded block hash must still be on the best chain else reorged. */
export function classifyFinality(i: { inMempool: boolean; blockHeight?: number; blockHash?: string; canonicalHashAtHeight?: string; tipHeight: number; amountSat: bigint; policy?: DepthPolicy }): { state: BtcFinality; confirmations: number; required: number } {
  const policy = i.policy ?? DEFAULT_DEPTH_POLICY;
  const required = requiredDepth(i.amountSat, policy);
  if (i.blockHeight === undefined) return { state: i.inMempool ? 'mempool' : 'unknown', confirmations: 0, required };
  if (i.blockHash && i.canonicalHashAtHeight && i.blockHash !== i.canonicalHashAtHeight) return { state: 'reorged', confirmations: 0, required };
  const confirmations = Math.max(0, i.tipHeight - i.blockHeight + 1);
  const state: BtcFinality = confirmations >= required ? 'final' : confirmations >= policy.confirmedMin ? 'confirmed' : confirmations >= policy.includedMin ? 'included' : 'mempool';
  return { state, confirmations, required };
}
