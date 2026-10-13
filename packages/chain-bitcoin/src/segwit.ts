// BIP-173 (bech32) and BIP-350 (bech32m). Witness v0 MUST use bech32; v1+ MUST use bech32m.
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
export const BECH32_CONST = 1;
export const BECH32M_CONST = 0x2bc830a3;
export type Bech32Variant = 'bech32' | 'bech32m';

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i]!;
  }
  return chk >>> 0;
}
const hrpExpand = (hrp: string): number[] => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];

export function bech32Encode(hrp: string, data5: number[], variant: Bech32Variant): string {
  const mod = polymod([...hrpExpand(hrp), ...data5, 0, 0, 0, 0, 0, 0]) ^ (variant === 'bech32' ? BECH32_CONST : BECH32M_CONST);
  const cs = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return hrp + '1' + [...data5, ...cs].map((d) => CHARSET[d]).join('');
}
export function bech32Decode(s: string, limit = 90): { hrp: string; data: number[]; variant: Bech32Variant } {
  if (s.length < 8 || s.length > limit) throw new Error('bad length');
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) throw new Error('mixed case');
  s = s.toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1 || pos + 7 > s.length) throw new Error('bad separator position');
  const hrp = s.slice(0, pos);
  for (const c of hrp) { const code = c.charCodeAt(0); if (code < 33 || code > 126) throw new Error('invalid hrp char'); }
  const data: number[] = [];
  for (const c of s.slice(pos + 1)) { const i = CHARSET.indexOf(c); if (i < 0) throw new Error('invalid data char'); data.push(i); }
  const pm = polymod([...hrpExpand(hrp), ...data]);
  const variant: Bech32Variant | null = pm === BECH32_CONST ? 'bech32' : pm === BECH32M_CONST ? 'bech32m' : null;
  if (!variant) throw new Error('bad checksum');
  return { hrp, data: data.slice(0, -6), variant };
}
export function convertBits(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0, bits = 0; const out: number[] = []; const maxv = (1 << to) - 1;
  for (const v of data) {
    if (v < 0 || v >> from) throw new Error('invalid value');
    acc = (acc << from) | v; bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
    acc &= (1 << bits) - 1;
  }
  if (pad) { if (bits) out.push((acc << (to - bits)) & maxv); }
  else if (bits >= from || ((acc << (to - bits)) & maxv)) throw new Error('invalid padding');
  return out;
}
export function segwitDecode(hrp: string, addr: string): { version: number; program: number[] } {
  const d = bech32Decode(addr);
  if (d.hrp !== hrp) throw new Error(`hrp '${d.hrp}' != '${hrp}'`);
  if (d.data.length < 1) throw new Error('empty data');
  const version = d.data[0]!;
  if (version > 16) throw new Error('witness version > 16');
  const program = convertBits(d.data.slice(1), 5, 8, false);
  if (program.length < 2 || program.length > 40) throw new Error('program length out of range');
  if (version === 0 && program.length !== 20 && program.length !== 32) throw new Error('v0 program must be 20 or 32 bytes');
  if ((version === 0) !== (d.variant === 'bech32')) throw new Error(`witness v${version} must use ${version === 0 ? 'bech32' : 'bech32m'}`);
  return { version, program };
}
export function segwitEncode(hrp: string, version: number, program: number[]): string {
  return bech32Encode(hrp, [version, ...convertBits(program, 8, 5, true)], version === 0 ? 'bech32' : 'bech32m');
}
