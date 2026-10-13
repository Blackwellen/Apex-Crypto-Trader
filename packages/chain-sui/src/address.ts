export interface SuiAddressCheck { valid: boolean; reason?: string; normalized?: string }
const FULL = /^0x[0-9a-fA-F]{64}$/;
/** Strict Sui address / object id check: "0x" + exactly 64 hex chars. Short forms (e.g. 0x2) are NOT accepted as addresses; use normalizeSuiShortForm explicitly. */
export function validateSuiAddress(address: string): SuiAddressCheck {
  if (typeof address !== 'string') return { valid: false, reason: 'address must be a string' };
  if (!address.startsWith('0x')) return { valid: false, reason: 'missing 0x prefix' };
  if (address.length !== 66) return { valid: false, reason: `expected 64 hex chars after 0x, got ${address.length - 2}` };
  if (!FULL.test(address)) return { valid: false, reason: 'non-hex character' };
  return { valid: true, normalized: address.toLowerCase() };
}
/** Pads a short-form 0x.. (<=64 hex) to 32 bytes. For well-known framework ids only; user input must go through validateSuiAddress. */
export function normalizeSuiShortForm(id: string): string {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(id)) throw new Error(`not a Sui short-form id: ${id}`);
  return '0x' + id.slice(2).toLowerCase().padStart(64, '0');
}
export const SUI_COIN_TYPE = '0x2::sui::SUI';
/** Canonical-ish coin type: <hex address>::<module>::<Name> (generic arguments allowed). Short address form is fine for types. */
export function validateCoinType(t: string): { valid: boolean; reason?: string } {
  if (!/^0x[0-9a-fA-F]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*(<.+>)?$/.test(t)) return { valid: false, reason: 'expected 0x<addr>::<module>::<Name>' };
  return { valid: true };
}
