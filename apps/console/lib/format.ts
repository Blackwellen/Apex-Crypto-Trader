/** Money formatting from integer base-unit STRINGS using BigInt only. Never converts ledger amounts through JS floats. */
export function formatUnits(amount: string | bigint, decimals: number, maxFrac = 6): string {
  const neg = String(amount).startsWith('-');
  const a = BigInt(String(amount).replace('-', ''));
  const base = 10n ** BigInt(decimals);
  const whole = a / base, frac = (a % base).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${w}${frac ? '.' + frac : ''}`;
}
/** Parse a user-typed decimal ("12.5") into base units string for a given decimals; throws on excess precision/invalid input. */
export function parseUnits(input: string, decimals: number): string {
  const m = /^(\d{1,40})(?:\.(\d{1,40}))?$/.exec(input.trim());
  if (!m) throw new Error('Enter a positive number');
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new Error(`At most ${decimals} decimal places`);
  return (BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')).toString();
}
export const shortAddr = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
export const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
export const bps = (n: number) => `${(n / 100).toFixed(2)}%`;
