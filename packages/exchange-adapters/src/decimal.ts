/** Fixed-point decimal strings (18dp) - exact comparisons without floats. Used for prices/quantities/notional. */
const DP = 18;
export function parseDecimal(s: string): bigint {
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`invalid decimal '${s}'`);
  const neg = s.startsWith('-'); const t = neg ? s.slice(1) : s;
  const [i, f = ''] = t.split('.');
  if (f.length > DP) { if (/[1-9]/.test(f.slice(DP))) throw new Error(`decimal '${s}' exceeds ${DP} dp`); }
  const v = BigInt(i!) * 10n ** BigInt(DP) + BigInt(f.slice(0, DP).padEnd(DP, '0'));
  return neg ? -v : v;
}
export function formatDecimal(v: bigint): string {
  const neg = v < 0n; const a = neg ? -v : v;
  const s = a.toString().padStart(DP + 1, '0');
  const i = s.slice(0, -DP), f = s.slice(-DP).replace(/0+$/, '');
  return `${neg ? '-' : ''}${i}${f ? '.' + f : ''}`;
}
export const normDecimal = (s: string): string => formatDecimal(parseDecimal(s));
export const cmpDecimal = (a: string, b: string): number => { const x = parseDecimal(a), y = parseDecimal(b); return x < y ? -1 : x > y ? 1 : 0; };
export const isZeroDecimal = (s: string): boolean => parseDecimal(s) === 0n;
/** a*b at 18dp, truncating (round toward zero) */
export const mulDecimal = (a: bigint, b: bigint): bigint => (a * b) / 10n ** BigInt(DP);
