/** Cosmos gas/fee model. Gas price is a per-chain/per-node value that must be SUPPLIED (queried), never hardcoded here. */
const SCALE = 18n;
const ONE = 10n ** SCALE;

/** Parse a decimal string like "0.0025" into an 18-dp fixed-point bigint (sdk.Dec). */
export function parseDec(s: string): bigint {
  if (!/^\d+(\.\d{1,18})?$/.test(s)) throw new Error(`invalid decimal '${s}'`);
  const [i, f = ''] = s.split('.');
  return BigInt(i!) * ONE + BigInt(f.padEnd(18, '0'));
}
export interface GasPrice { denom: string; amount: string }
export interface FeeModelInput {
  gasUsedSimulated: bigint;
  /** safety multiplier in bps, e.g. 13000 = x1.3 (applied to simulated gas to form gas limit) */
  gasAdjustmentBps: bigint;
  gasPrice: GasPrice;
  /** denoms the chain accepts for fees */
  allowedFeeDenoms: string[];
  /** policy cap in fee-denom base units */
  maxFee: bigint;
}
export interface FeeResult { gasLimit: bigint; feeDenom: string; feeAmount: bigint }
export function computeFee(i: FeeModelInput): FeeResult {
  if (!i.allowedFeeDenoms.includes(i.gasPrice.denom)) throw new Error(`fee denom ${i.gasPrice.denom} not accepted`);
  if (i.gasUsedSimulated <= 0n) throw new Error('simulate first: gas used must be positive');
  if (i.gasAdjustmentBps < 10_000n) throw new Error('gas adjustment below 1.0x');
  const gasLimit = (i.gasUsedSimulated * i.gasAdjustmentBps + 9_999n) / 10_000n;
  const price = parseDec(i.gasPrice.amount);
  const feeAmount = (gasLimit * price + ONE - 1n) / ONE; // ceil, as SDK does
  if (feeAmount > i.maxFee) throw new Error(`fee ${feeAmount}${i.gasPrice.denom} exceeds cap ${i.maxFee}`);
  return { gasLimit, feeDenom: i.gasPrice.denom, feeAmount };
}
/** A node enforces minimum-gas-prices (node-local, from /cosmos/base/node/v1beta1/config). Check before broadcast. */
export function meetsMinGasPrice(price: GasPrice, minimum: GasPrice[]): boolean {
  const m = minimum.find((x) => x.denom === price.denom);
  return m ? parseDec(price.amount) >= parseDec(m.amount) : false;
}
