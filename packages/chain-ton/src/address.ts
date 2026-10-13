export interface TonAddressResult {
  valid: boolean; reason?: string; format?: 'raw' | 'friendly';
  workchain?: number; hashHex?: string; bounceable?: boolean; testnetOnly?: boolean; raw?: string;
}
/** CRC16-CCITT (XMODEM): poly 0x1021, init 0, no reflection, as used by TON user-friendly addresses. */
export function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * Raw: "<workchain>:<64 hex>". Friendly: 48 chars base64 or base64url -> 36 bytes
 * [flags(1)][workchain int8(1)][hash(32)][crc16(2)]. flags: 0x11 bounceable, 0x51 non-bounceable, +0x80 testnet-only.
 */
export function validateTonAddress(address: string): TonAddressResult {
  if (typeof address !== 'string' || !address) return { valid: false, reason: 'empty' };
  const rawm = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(address);
  if (rawm) {
    const wc = Number(rawm[1]);
    if (!Number.isInteger(wc) || wc < -128 || wc > 127) return { valid: false, reason: 'workchain out of int8 range' };
    if (wc !== 0 && wc !== -1) return { valid: false, reason: `workchain ${wc} not 0 (basechain) or -1 (masterchain)` };
    return { valid: true, format: 'raw', workchain: wc, hashHex: rawm[2]!.toLowerCase(), raw: `${wc}:${rawm[2]!.toLowerCase()}` };
  }
  if (address.length !== 48 || !/^[A-Za-z0-9_\-+/]+$/.test(address)) return { valid: false, reason: 'friendly address must be 48 base64/base64url chars' };
  if (/[+/]/.test(address) && /[-_]/.test(address)) return { valid: false, reason: 'mixed base64 and base64url alphabets' };
  const bytes = new Uint8Array(Buffer.from(address.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  if (bytes.length !== 36) return { valid: false, reason: `decoded length ${bytes.length} != 36` };
  const body = bytes.slice(0, 34);
  const crc = (bytes[34]! << 8) | bytes[35]!;
  if (crc16(body) !== crc) return { valid: false, reason: 'bad CRC16' };
  const flags = bytes[0]!;
  const testnetOnly = (flags & 0x80) !== 0;
  const tag = flags & 0x7f;
  if (tag !== 0x11 && tag !== 0x51) return { valid: false, reason: `unknown tag 0x${flags.toString(16)}` };
  const wc = (bytes[1]! << 24) >> 24; // int8
  if (wc !== 0 && wc !== -1) return { valid: false, reason: `workchain ${wc} not 0 or -1` };
  const hashHex = toHex(bytes.slice(2, 34));
  return { valid: true, format: 'friendly', workchain: wc, hashHex, bounceable: tag === 0x11, testnetOnly, raw: `${wc}:${hashHex}` };
}
export function toFriendly(raw: string, opts: { bounceable: boolean; testnetOnly?: boolean }): string {
  const r = validateTonAddress(raw);
  if (!r.valid || r.format !== 'raw') throw new Error('expected a valid raw address');
  const body = new Uint8Array(34);
  body[0] = (opts.bounceable ? 0x11 : 0x51) | (opts.testnetOnly ? 0x80 : 0);
  body[1] = r.workchain! & 0xff;
  body.set(Buffer.from(r.hashHex!, 'hex'), 2);
  const c = crc16(body);
  return Buffer.from([...body, c >> 8, c & 0xff]).toString('base64url');
}
/** Same account regardless of encoding: compare on raw form only (never compare friendly strings: flags differ). */
export const sameTonAccount = (a: string, b: string): boolean => {
  const x = validateTonAddress(a), y = validateTonAddress(b);
  return x.valid && y.valid && x.raw === y.raw;
};
