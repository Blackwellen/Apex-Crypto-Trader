export interface AptosAddressCheck { valid: boolean; reason?: string; normalized?: string; special?: boolean; short?: boolean }
/**
 * Aptos account address: 0x + 1..64 hex. Output is normalised to the long form (0x + 64 lowercase hex, left-padded).
 * `strict` (recommended for user-supplied destinations) additionally rejects short forms of NON-special addresses
 * (AIP-40: only 0x0..0xf may be shortened), because a truncated paste with lost leading zeros would silently be a different account.
 */
export function validateAptosAddress(address: string, opts: { strict?: boolean } = {}): AptosAddressCheck {
  if (typeof address !== 'string') return { valid: false, reason: 'address must be a string' };
  if (!address.startsWith('0x')) return { valid: false, reason: 'missing 0x prefix' };
  const body = address.slice(2);
  if (body.length === 0 || body.length > 64) return { valid: false, reason: `expected 1..64 hex chars after 0x, got ${body.length}` };
  if (!/^[0-9a-fA-F]+$/.test(body)) return { valid: false, reason: 'non-hex character' };
  const long = '0x' + body.toLowerCase().padStart(64, '0');
  const special = /^0x0{63}[0-9a-f]$/.test(long);
  const short = body.length < 64;
  if (opts.strict && short && !special) return { valid: false, reason: 'short form is only allowed for special addresses 0x0..0xf (strict mode)' };
  return { valid: true, normalized: long, special, short };
}
export const APT_COIN_TYPE = '0x1::aptos_coin::AptosCoin';
/** Move type tag for a coin/asset: 0x<addr>::module::Name (generics allowed). */
export function validateMoveType(t: string): { valid: boolean; reason?: string } {
  return /^0x[0-9a-fA-F]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*(<.+>)?$/.test(t) ? { valid: true } : { valid: false, reason: 'expected 0x<addr>::<module>::<Name>' };
}
