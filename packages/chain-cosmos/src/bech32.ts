// BIP-173 bech32 (Cosmos uses classic bech32, not bech32m). No 90-char limit here: Cosmos SDK allows longer strings.
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

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

export function bech32Encode(hrp: string, data5: number[]): string {
  const mod = polymod([...hrpExpand(hrp), ...data5, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return hrp + '1' + [...data5, ...checksum].map((d) => CHARSET[d]).join('');
}

export function bech32Decode(s: string): { hrp: string; data: number[] } {
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) throw new Error('mixed case');
  s = s.toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1) throw new Error('missing or empty hrp separator');
  if (pos + 7 > s.length) throw new Error('data part too short');
  const hrp = s.slice(0, pos);
  for (const c of hrp) { const code = c.charCodeAt(0); if (code < 33 || code > 126) throw new Error('invalid hrp char'); }
  const data: number[] = [];
  for (const c of s.slice(pos + 1)) { const i = CHARSET.indexOf(c); if (i < 0) throw new Error(`invalid data char '${c}'`); data.push(i); }
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) throw new Error('bad checksum');
  return { hrp, data: data.slice(0, -6) };
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
