const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));

export function base58Decode(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array(0);
  let n = 0n;
  for (const ch of s) {
    const v = MAP.get(ch);
    if (v === undefined) throw new Error(`invalid base58 character '${ch}'`);
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.push(Number(n & 0xffn)); n >>= 8n; }
  let zeros = 0; for (const ch of s) { if (ch === '1') zeros++; else break; }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes.reverse()]);
}
export function base58Encode(b: Uint8Array): string {
  let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x);
  let s = ''; while (n > 0n) { s = ALPHABET[Number(n % 58n)]! + s; n /= 58n; }
  let zeros = 0; for (const x of b) { if (x === 0) zeros++; else break; }
  return '1'.repeat(zeros) + s;
}

export interface SolanaAddressCheck { valid: boolean; reason?: string; normalized?: string }
/** A Solana public key is exactly 32 bytes of base58 (case-sensitive; there is no checksum). On-curve-ness is NOT checked (PDAs are off-curve). */
export function validateSolanaAddress(address: string): SolanaAddressCheck {
  if (typeof address !== 'string' || address.length < 32 || address.length > 44) return { valid: false, reason: 'base58 pubkey must be 32..44 characters' };
  let bytes: Uint8Array;
  try { bytes = base58Decode(address); } catch (e) { return { valid: false, reason: (e as Error).message }; }
  if (bytes.length !== 32) return { valid: false, reason: `decodes to ${bytes.length} bytes, expected 32` };
  if (base58Encode(bytes) !== address) return { valid: false, reason: 'non-canonical base58 encoding' };
  return { valid: true, normalized: address };
}
