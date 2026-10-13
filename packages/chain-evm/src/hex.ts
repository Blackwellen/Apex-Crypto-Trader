// Hex / quantity helpers. All money is bigint; JSON-RPC quantities are parsed strictly.
export function strip0x(h: string): string { return h.startsWith('0x') || h.startsWith('0X') ? h.slice(2) : h; }

export function bytesToHex(b: Uint8Array): string {
  let s = '0x';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}
export function hexToBytes(h: string): Uint8Array {
  const s = strip0x(h);
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error(`invalid hex: ${h.slice(0, 20)}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
/** JSON-RPC QUANTITY -> bigint. Rejects non-hex, empty "0x" and leading zeros (per the JSON-RPC spec). */
export function parseQuantity(q: unknown): bigint {
  if (typeof q !== 'string' || !/^0x(0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(q)) throw new Error(`invalid JSON-RPC quantity: ${JSON.stringify(q)}`);
  return BigInt(q);
}
export function toQuantity(n: bigint): string {
  if (n < 0n) throw new Error('negative quantity');
  return '0x' + n.toString(16);
}
