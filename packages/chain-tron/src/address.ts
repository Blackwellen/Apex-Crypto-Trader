import { base58CheckDecode, base58CheckEncode, fromHex, toHex } from './base58.ts';

export const TRON_ADDRESS_PREFIX = 0x41;

export interface TronAddressResult { valid: boolean; reason?: string; normalized?: string; hex?: string }

/** Validates a TRON address: base58check (25 bytes, 0x41 prefix, sha256d checksum) or 41-prefixed 42-char hex. */
export function validateTronAddress(address: string): TronAddressResult {
  if (typeof address !== 'string' || address.length === 0) return { valid: false, reason: 'empty' };
  if (/^41[0-9a-fA-F]{40}$/.test(address)) {
    const b58 = base58CheckEncode(fromHex(address));
    return { valid: true, normalized: b58, hex: address.toLowerCase() };
  }
  if (address.startsWith('0x')) return { valid: false, reason: 'EVM 0x form is not a TRON address; convert explicitly (0x41 + 20 bytes)' };
  if (address.length !== 34 || address[0] !== 'T') return { valid: false, reason: 'base58 TRON addresses are 34 chars starting with T' };
  let payload: Uint8Array;
  try { payload = base58CheckDecode(address); } catch (e) { return { valid: false, reason: (e as Error).message }; }
  if (payload.length !== 21) return { valid: false, reason: `payload length ${payload.length} != 21` };
  if (payload[0] !== TRON_ADDRESS_PREFIX) return { valid: false, reason: 'prefix byte is not 0x41' };
  return { valid: true, normalized: address, hex: toHex(payload) };
}

export function tronHexToBase58(hex: string): string {
  const r = validateTronAddress(hex);
  if (!r.valid || !r.normalized) throw new Error(r.reason ?? 'invalid');
  return r.normalized;
}
export function tronBase58ToHex(addr: string): string {
  const r = validateTronAddress(addr);
  if (!r.valid || !r.hex) throw new Error(r.reason ?? 'invalid');
  return r.hex;
}
