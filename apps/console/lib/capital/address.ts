/**
 * Client-side STRUCTURAL address validation per chain family. This is a first line of defence and a UX aid only:
 * - it checks length/alphabet/decoded size (and the bech32 checksum, which is cheap and unambiguous);
 * - it does NOT verify EIP-55 / Base58Check / TON CRC checksums: that lives in the chain packages and the API/DB re-validates structurally.
 * It also refuses anything that looks like secret material (seed phrase, private key, WIF, Solana keypair) in an address field.
 */
export type Family = 'evm' | 'svm' | 'sui' | 'aptos' | 'tron' | 'cosmos' | 'bitcoin' | 'ton' | 'near' | 'cex';
export type AddressResult = { ok: true; normalized: string; warnings: string[] } | { ok: false; reason: string; secret?: boolean };

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Decode base58 to bytes using BigInt; returns null on invalid alphabet. Leading '1's are leading zero bytes. */
export function base58Decode(s: string): Uint8Array | null {
  if (!s) return null;
  let n = 0n;
  for (const ch of s) { const i = B58.indexOf(ch); if (i < 0) return null; n = n * 58n + BigInt(i); }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  let zeros = 0; for (const ch of s) { if (ch === '1') zeros++; else break; }
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes]);
}

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let chk = 1;
  for (const v of values) { const b = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= G[i]; }
  return chk >>> 0;
}
/** Full bech32/bech32m checksum verification. Returns {hrp, dataLen} or null. */
export function bech32Check(s: string): { hrp: string; variant: 'bech32' | 'bech32m'; dataLen: number } | null {
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return null;           // mixed case is invalid
  const str = s.toLowerCase(); const pos = str.lastIndexOf('1');
  if (pos < 1 || pos + 7 > str.length || str.length > 120) return null;
  const hrp = str.slice(0, pos); if (!/^[\x21-\x7e]+$/.test(hrp)) return null;
  const data: number[] = []; for (const ch of str.slice(pos + 1)) { const i = BECH32_CHARSET.indexOf(ch); if (i < 0) return null; data.push(i); }
  const hrpExp = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  const pm = polymod([...hrpExp, ...data]);
  const variant = pm === 1 ? 'bech32' : pm === 0x2bc830a3 ? 'bech32m' : null;
  return variant ? { hrp, variant, dataLen: data.length - 6 } : null;
}

const hasSpace = /\s/;
const BIP39ISH = /^(\w+\s+){11,23}\w+$/;
/** Heuristics for "this is probably a secret, not an address". Returns a reason or null. Applied to EVERY family. */
export function secretHint(input: string): string | null {
  const t = input.trim();
  if (BIP39ISH.test(t) || (t.split(/\s+/).length >= 12 && /^[a-z ]+$/.test(t))) return 'This looks like a seed phrase. APEX never accepts seed phrases. Clear the field and enter a public address only.';
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(t)) return 'A 64-character hex string can be a private key. If this is a public identifier for this chain family it is accepted below; otherwise APEX will not store it.';
  if (/^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(t)) return 'This looks like a Bitcoin WIF private key. APEX never accepts private keys.';
  if (/^(xprv|yprv|zprv|tprv)[1-9A-HJ-NP-Za-km-z]{100,}$/.test(t)) return 'This looks like an extended private key (xprv). APEX never accepts private keys.';
  if (/(seed|mnemonic|private|secret|passphrase)/i.test(t)) return 'This contains secret-related words. APEX never accepts keys or seed phrases.';
  return null;
}

const hex = (n: string) => new RegExp(`^0x[0-9a-fA-F]{${n}}$`);
export function validateAddress(family: Family, raw: string): AddressResult {
  const a = raw.trim();
  if (!a) return { ok: false, reason: 'Enter a public address' };
  // Hard secret refusals first (these never become "just invalid", they are flagged as secrets).
  if (hasSpace.test(a)) { const h = secretHint(a); return { ok: false, secret: !!h, reason: h ?? 'Addresses never contain spaces' }; }
  const is64hex = /^(0x)?[0-9a-fA-F]{64}$/.test(a);
  // A 64-hex string is a legitimate public id only for Sui/Aptos (0x-prefixed) and NEAR implicit accounts; anywhere else it is likely a private key.
  const legit64 = ((family === 'sui' || family === 'aptos') && a.startsWith('0x')) || (family === 'near' && /^[0-9a-f]{64}$/.test(a));
  if (is64hex && !legit64) return { ok: false, secret: true, reason: `A 64-hex string is not a valid ${family.toUpperCase()} address and may be a private key. APEX refuses it.` };
  const sh = is64hex ? null : secretHint(a);
  if (sh) return { ok: false, secret: true, reason: sh };
  const bad = (reason: string): AddressResult => ({ ok: false, reason });
  const warnings: string[] = [];
  switch (family) {
    case 'evm': {
      if (!hex('40').test(a)) return bad('EVM addresses are 0x followed by exactly 40 hex characters');
      const body = a.slice(2);
      if (body !== body.toLowerCase() && body !== body.toUpperCase()) warnings.push('Mixed-case address: the EIP-55 checksum is not verified in the browser. Double-check it against your wallet; the chain packages verify checksums.');
      return { ok: true, normalized: a.toLowerCase(), warnings };
    }
    case 'svm': {
      const b = base58Decode(a); if (!b) return bad('Solana addresses use the base58 alphabet (no 0, O, I, l)');
      if (b.length !== 32) return bad(b.length === 64 ? 'This decodes to 64 bytes, which is a Solana secret keypair, not a public address. APEX refuses it.' : `Solana public keys decode to exactly 32 bytes (this decodes to ${b.length})`);
      return { ok: true, normalized: a, warnings: b.length === 32 ? [] : warnings };
    }
    case 'sui': return hex('64').test(a) ? { ok: true, normalized: a.toLowerCase(), warnings } : bad('Sui addresses are 0x followed by exactly 64 hex characters');
    case 'aptos': return /^0x[0-9a-fA-F]{1,64}$/.test(a) ? { ok: true, normalized: a.toLowerCase(), warnings: a.length < 66 ? ['Short-form Aptos address; it will be stored as entered.'] : [] } : bad('Aptos addresses are 0x followed by 1 to 64 hex characters');
    case 'tron': {
      const b = /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a) ? base58Decode(a) : null;
      if (!b || b.length !== 25 || b[0] !== 0x41) return bad('TRON addresses start with T and are 34 base58 characters');
      return { ok: true, normalized: a, warnings: ['Base58Check checksum is verified by the chain package, not in the browser.'] };
    }
    case 'bitcoin': {
      if (/^(bc1|tb1|bcrt1)/i.test(a)) { const r = bech32Check(a); if (!r || r.dataLen < 2) return bad('Invalid Bitcoin bech32 address (checksum or format)'); return { ok: true, normalized: a.toLowerCase(), warnings }; }
      const b = /^[13mn2][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a) ? base58Decode(a) : null;
      if (!b || b.length !== 25 || ![0x00, 0x05, 0x6f, 0xc4].includes(b[0])) return bad('Bitcoin addresses are bech32 (bc1…/tb1…) or legacy base58 (1…/3…)');
      return { ok: true, normalized: a, warnings: ['Legacy address: Base58Check checksum is verified by the chain package, not in the browser.'] };
    }
    case 'cosmos': {
      const r = bech32Check(a); if (!r || !/^[a-z]{2,20}$/.test(r.hrp) || r.variant !== 'bech32' || r.dataLen < 32) return bad('Cosmos addresses are bech32 with a chain prefix (e.g. cosmos1…) and a valid checksum');
      return { ok: true, normalized: a.toLowerCase(), warnings: [`Prefix "${r.hrp}" must match the selected chain; the chain package confirms this.`] };
    }
    case 'ton': {
      if (/^-?[0-9]:[0-9a-fA-F]{64}$/.test(a)) return { ok: true, normalized: a, warnings: ['Raw TON address format.'] };
      if (/^[EU][Qf][A-Za-z0-9_-]{46}$/.test(a)) return { ok: true, normalized: a, warnings: ['TON CRC16 checksum is verified by the chain package, not in the browser.'] };
      return bad('TON addresses are 48-character user-friendly (EQ…/UQ…) or raw workchain:hex64');
    }
    case 'near': {
      if (/^[0-9a-f]{64}$/.test(a)) return { ok: true, normalized: a, warnings };
      if (a.length < 20) return bad('The API currently requires at least 20 characters; use the 64-hex implicit account id for short NEAR names');
      if (a.length > 64 || !/^([a-z0-9]+[-_])*[a-z0-9]+(\.([a-z0-9]+[-_])*[a-z0-9]+)*$/.test(a)) return bad('NEAR accounts are lowercase letters, digits, - _ and dot-separated labels (2 to 64 characters), or 64 hex');
      return { ok: true, normalized: a, warnings };
    }
    case 'cex': {
      if (!/^[A-Za-z0-9._:/@+-]{20,120}$/.test(a)) return bad('Enter a 20 to 120 character exchange sub-account reference (letters, digits and . _ : / @ + -)');
      return { ok: true, normalized: a, warnings: ['This is an opaque reference label for the exchange account. Never paste an API key or secret.'] };
    }
  }
}

export const FAMILIES: { id: Family; label: string; connector: string; example: string; kind: 'onchain' | 'cex' }[] = [
  { id: 'evm', label: 'EVM (browser / hardware wallet)', connector: 'Ethereum, Base, Arbitrum, Optimism, BNB Chain, Polygon and other EVM networks', example: '0x9a4fc2bc7897dd21305b92c0e5cb86dffc984362', kind: 'onchain' },
  { id: 'svm', label: 'Solana wallet adapter', connector: 'Solana (account = ed25519 public key, base58)', example: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', kind: 'onchain' },
  { id: 'sui', label: 'Sui wallet', connector: 'Sui (0x + 64 hex)', example: '0x' + 'ab12'.repeat(16), kind: 'onchain' },
  { id: 'aptos', label: 'Aptos wallet', connector: 'Aptos (0x + up to 64 hex)', example: '0x' + 'cd34'.repeat(16), kind: 'onchain' },
  { id: 'tron', label: 'TRON wallet', connector: 'TRON (T… base58, 34 chars)', example: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', kind: 'onchain' },
  { id: 'cosmos', label: 'Cosmos wallet', connector: 'Cosmos SDK chains (bech32, chain prefix)', example: 'cosmos1hsk6jryyqjfhp5dhc55tc9jtckygx0eph6dd02', kind: 'onchain' },
  { id: 'bitcoin', label: 'Bitcoin watch-only / hardware', connector: 'Bitcoin (bech32 bc1… or legacy)', example: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', kind: 'onchain' },
  { id: 'ton', label: 'TON', connector: 'TON user-friendly or raw address', example: '0:' + 'ab'.repeat(32), kind: 'onchain' },
  { id: 'near', label: 'NEAR', connector: 'NEAR named or implicit account', example: 'a'.repeat(64), kind: 'onchain' },
  { id: 'cex', label: 'Centralised exchange (CEX)', connector: 'Exchange sub-account reference (view-only or trade-only)', example: 'exchange-main-subaccount-01', kind: 'cex' },
];
