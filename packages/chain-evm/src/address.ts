import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from './hex.ts';

const utf8 = new TextEncoder();
export function keccakHex(data: Uint8Array | string): string {
  return bytesToHex(keccak_256(typeof data === 'string' ? utf8.encode(data) : data));
}

/** EIP-55 mixed-case checksum encoding of a 20-byte hex address (input case ignored). */
export function toChecksumAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(lower)) throw new Error('not a 20-byte hex address');
  const hash = keccakHex(lower).slice(2); // keccak over the ASCII lowercase hex
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  return out;
}

export interface EvmAddressCheck {
  valid: boolean; reason?: string;
  /** EIP-55 checksummed form (only when valid) */
  normalized?: string;
  /** true when the input carried a (valid) mixed-case checksum */
  checksummed?: boolean;
  isZero?: boolean;
}

export interface EvmAddressOptions {
  /** reject all-lowercase / all-uppercase (non-checksummed) input. Default false: accepted but flagged checksummed=false. */
  requireChecksum?: boolean;
  /** reject 0x000...000 */
  rejectZero?: boolean;
}

export function validateEvmAddress(address: string, opts: EvmAddressOptions = {}): EvmAddressCheck {
  if (typeof address !== 'string') return { valid: false, reason: 'address must be a string' };
  if (!/^0x/.test(address)) return { valid: false, reason: 'missing 0x prefix' };
  const body = address.slice(2);
  if (body.length !== 40) return { valid: false, reason: `expected 40 hex chars, got ${body.length}` };
  if (!/^[0-9a-fA-F]{40}$/.test(body)) return { valid: false, reason: 'non-hex character' };
  const checksum = toChecksumAddress(address);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && checksum !== address) return { valid: false, reason: 'EIP-55 checksum mismatch' };
  const checksummed = mixed && checksum === address;
  if (opts.requireChecksum && !checksummed) return { valid: false, reason: 'checksum required but address is not mixed-case checksummed' };
  const isZero = /^0+$/.test(body);
  if (opts.rejectZero && isZero) return { valid: false, reason: 'zero address rejected' };
  return { valid: true, normalized: checksum, checksummed, isZero };
}

/** canonical lowercase key used for DB keys / allowlists. Throws on invalid. */
export function addressKey(address: string): string {
  const r = validateEvmAddress(address);
  if (!r.valid) throw new Error(`invalid EVM address: ${r.reason}`);
  return r.normalized!.toLowerCase();
}
