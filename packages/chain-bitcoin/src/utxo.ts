import type { BtcScriptType } from './address.ts';
import { DUST_LIMIT, feeForVsize, txVsize, type InputType } from './fees.ts';

export interface Utxo {
  txid: string; vout: number; valueSat: bigint; inputType: InputType;
  /** confirmation count (0 = mempool) */
  confirmations: number;
  /** true only if this output is change from a tx WE created/signed (trusted unconfirmed) */
  isOwnChange?: boolean;
  /** frozen by policy (e.g. dust/ordinal/inscription holdings) */
  frozen?: boolean;
}
export interface TxOutput { script: BtcScriptType; valueSat: bigint; address?: string }
export interface SelectParams {
  utxos: Utxo[]; outputs: TxOutput[]; feeRateSatKvb: bigint; changeScript: BtcScriptType;
  /** absolute fee cap in sat; selection fails rather than exceed it */
  maxFeeSat: bigint;
  /** fee-rate cap in sat/kvB applied to the FINAL fee/vsize (guards against dust-to-fee absorption) */
  maxFeeRateSatKvb: bigint;
  minConfirmations?: number;                 // default 1 for external funds
  allowUnconfirmedChange?: boolean;          // own change with 0 conf, default false
  allowUnconfirmedExternal?: boolean;        // NEVER default; external 0-conf can be replaced/double spent
  bnbMaxTries?: number;
}
export interface Selection { inputs: Utxo[]; outputs: TxOutput[]; change?: TxOutput; feeSat: bigint; vsize: bigint; algorithm: 'bnb' | 'largest-first' }
export class SelectionError extends Error { constructor(public code: 'INSUFFICIENT_FUNDS' | 'FEE_CAP_EXCEEDED' | 'DUST_OUTPUT' | 'BAD_PARAMS', m: string) { super(m); } }

const inputVsizeFee = (t: InputType, rate: bigint): bigint => feeForVsize(rate, txVsize([t], []) - txVsize([], []) ); // marginal vsize of an input

export function eligible(u: Utxo, p: SelectParams): boolean {
  if (u.frozen || u.valueSat <= 0n) return false;
  const minConf = p.minConfirmations ?? 1;
  if (u.confirmations >= minConf) return true;
  if (u.isOwnChange && p.allowUnconfirmedChange) return true;
  if (!u.isOwnChange && p.allowUnconfirmedExternal) return true;
  return false;
}

function finalize(p: SelectParams, picked: Utxo[], withChange: boolean, algorithm: Selection['algorithm']): Selection {
  const outSum = p.outputs.reduce((a, o) => a + o.valueSat, 0n);
  const inSum = picked.reduce((a, u) => a + u.valueSat, 0n);
  const types = picked.map((u) => u.inputType);
  const scripts = p.outputs.map((o) => o.script);
  if (withChange) {
    const vsize = txVsize(types, [...scripts, p.changeScript]);
    const fee = feeForVsize(p.feeRateSatKvb, vsize);
    const change = inSum - outSum - fee;
    if (change >= DUST_LIMIT[p.changeScript]) return check(p, { inputs: picked, outputs: p.outputs, change: { script: p.changeScript, valueSat: change }, feeSat: fee, vsize, algorithm });
  }
  // no change: the remainder (if any) is absorbed by fee - capped below
  const vsize = txVsize(types, scripts);
  const fee = inSum - outSum;
  return check(p, { inputs: picked, outputs: p.outputs, feeSat: fee, vsize, algorithm });
}
function check(p: SelectParams, s: Selection): Selection {
  if (s.feeSat > p.maxFeeSat) throw new SelectionError('FEE_CAP_EXCEEDED', `fee ${s.feeSat} > cap ${p.maxFeeSat}`);
  if (s.feeSat * 1000n > p.maxFeeRateSatKvb * s.vsize) throw new SelectionError('FEE_CAP_EXCEEDED', `effective feerate exceeds cap`);
  const minFee = feeForVsize(p.feeRateSatKvb, s.vsize);
  if (s.feeSat < minFee) throw new SelectionError('INSUFFICIENT_FUNDS', `fee ${s.feeSat} below required ${minFee}`);
  return s;
}

export function selectCoins(p: SelectParams): Selection {
  if (p.outputs.length === 0) throw new SelectionError('BAD_PARAMS', 'no outputs');
  if (p.feeRateSatKvb <= 0n) throw new SelectionError('BAD_PARAMS', 'fee rate must be positive');
  for (const o of p.outputs) {
    if (o.valueSat < DUST_LIMIT[o.script]) throw new SelectionError('DUST_OUTPUT', `output ${o.valueSat} below dust ${DUST_LIMIT[o.script]} for ${o.script}`);
  }
  const outSum = p.outputs.reduce((a, o) => a + o.valueSat, 0n);
  const scripts = p.outputs.map((o) => o.script);
  const pool = p.utxos.filter((u) => eligible(u, p));
  const baseFee = feeForVsize(p.feeRateSatKvb, txVsize([], scripts));
  // effective value = value - marginal input fee; skip negative-effective-value inputs (cost more than they bring)
  const eff = pool.map((u) => ({ u, ev: u.valueSat - inputVsizeFee(u.inputType, p.feeRateSatKvb) })).filter((x) => x.ev > 0n);
  const totalEff = eff.reduce((a, x) => a + x.ev, 0n);
  if (totalEff < outSum + baseFee) throw new SelectionError('INSUFFICIENT_FUNDS', `eligible effective value ${totalEff} < needed ${outSum + baseFee}`);

  // ---- Branch and bound: exact match window [target, target + costOfChange] => no change output needed ----
  const target = outSum + baseFee;
  const changeOutFee = feeForVsize(p.feeRateSatKvb, txVsize([], [p.changeScript]) - txVsize([], []));
  const costOfChange = changeOutFee + feeForVsize(p.feeRateSatKvb, txVsize(['p2wpkh'], []) - txVsize([], [])); // creating + later spending change
  const sorted = [...eff].sort((a, b) => (a.ev < b.ev ? 1 : a.ev > b.ev ? -1 : 0));
  const suffix: bigint[] = new Array(sorted.length + 1).fill(0n);
  for (let i = sorted.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1]! + sorted[i]!.ev;
  let tries = 0; const maxTries = p.bnbMaxTries ?? 100_000;
  let best: number[] | null = null; let bestWaste: bigint | null = null;
  const cur: number[] = [];
  const dfs = (i: number, sum: bigint): void => {
    if (tries++ > maxTries) return;
    if (sum > target + costOfChange) return;
    if (sum >= target) {
      const waste = sum - target;
      if (bestWaste === null || waste < bestWaste) { best = [...cur]; bestWaste = waste; }
      return;
    }
    if (i >= sorted.length || sum + suffix[i]! < target) return;
    cur.push(i); dfs(i + 1, sum + sorted[i]!.ev); cur.pop();
    dfs(i + 1, sum);
  };
  dfs(0, 0n);
  if (best) {
    try { return finalize(p, (best as number[]).map((i) => sorted[i]!.u), false, 'bnb'); } catch (e) { if (!(e instanceof SelectionError)) throw e; /* fall through to largest-first */ }
  }

  // ---- Largest-first with change ----
  const picked: Utxo[] = []; let acc = 0n;
  let lastErr: SelectionError | null = null;
  for (const x of sorted) {
    picked.push(x.u); acc += x.ev;
    if (acc >= target) {
      try { return finalize(p, picked, true, 'largest-first'); } catch (e) { if (e instanceof SelectionError) lastErr = e; else throw e; }
      // change fell under dust and no-change absorbed too much (cap) => try adding another input
    }
  }
  throw lastErr ?? new SelectionError('INSUFFICIENT_FUNDS', 'could not fund outputs plus fee');
}
