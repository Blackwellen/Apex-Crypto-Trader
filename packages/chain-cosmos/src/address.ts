import { bech32Decode, bech32Encode, convertBits } from './bech32.ts';

export interface CosmosAddressResult { valid: boolean; reason?: string; normalized?: string; hrp?: string; byteLength?: number }

/** Account addresses are 20 bytes; contract/module/ICA addresses can be 32 bytes. Both accepted; anything else rejected. */
export function validateCosmosAddress(address: string, expectedPrefix: string): CosmosAddressResult {
  if (typeof address !== 'string' || !address) return { valid: false, reason: 'empty' };
  let d: { hrp: string; data: number[] };
  try { d = bech32Decode(address); } catch (e) { return { valid: false, reason: (e as Error).message }; }
  if (d.hrp !== expectedPrefix) return { valid: false, reason: `prefix '${d.hrp}' != expected '${expectedPrefix}'`, hrp: d.hrp };
  let bytes: number[];
  try { bytes = convertBits(d.data, 5, 8, false); } catch (e) { return { valid: false, reason: (e as Error).message }; }
  if (bytes.length !== 20 && bytes.length !== 32) return { valid: false, reason: `byte length ${bytes.length} not 20 or 32`, hrp: d.hrp };
  return { valid: true, normalized: address.toLowerCase(), hrp: d.hrp, byteLength: bytes.length };
}

/** Re-encode the same bytes under another chain prefix (e.g. cosmos1... -> osmo1...). Same key, different chain: NOT an ownership statement. */
export function convertPrefix(address: string, from: string, to: string): string {
  const r = validateCosmosAddress(address, from);
  if (!r.valid) throw new Error(r.reason);
  const d = bech32Decode(address);
  return bech32Encode(to, d.data);
}
