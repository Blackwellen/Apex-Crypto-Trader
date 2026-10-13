import { createHash } from 'node:crypto';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}
export function sha256d(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  return '1'.repeat(zeros) + out;
}

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error(`invalid base58 character '${ch}'`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes]);
}

export function base58CheckEncode(payload: Uint8Array): string {
  const sum = sha256d(payload).slice(0, 4);
  const full = new Uint8Array(payload.length + 4);
  full.set(payload);
  full.set(sum, payload.length);
  return base58Encode(full);
}

/** Returns the payload (checksum stripped) or throws on bad checksum. */
export function base58CheckDecode(s: string): Uint8Array {
  const full = base58Decode(s);
  if (full.length < 5) throw new Error('base58check: too short');
  const payload = full.slice(0, -4);
  const sum = full.slice(-4);
  const expect = sha256d(payload).slice(0, 4);
  for (let i = 0; i < 4; i++) if (sum[i] !== expect[i]) throw new Error('base58check: bad checksum');
  return payload;
}

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(h: string): Uint8Array {
  if (!/^([0-9a-fA-F]{2})*$/.test(h)) throw new Error('invalid hex');
  return Uint8Array.from(h.match(/../g)?.map((x) => parseInt(x, 16)) ?? []);
}
