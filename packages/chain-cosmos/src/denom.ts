import { createHash } from 'node:crypto';

/** ICS-20 / ibc-go: denom = "ibc/" + UPPERCASE_HEX(sha256(utf8("<path>/<base_denom>"))). With empty path the denom is the base denom itself. */
export function ibcDenomHash(path: string, baseDenom: string): string {
  const full = path ? `${path}/${baseDenom}` : baseDenom;
  return createHash('sha256').update(full, 'utf8').digest('hex').toUpperCase();
}
export const ibcDenom = (path: string, baseDenom: string): string => (path ? `ibc/${ibcDenomHash(path, baseDenom)}` : baseDenom);

export interface DenomTrace { path: string; base_denom: string }
export interface Hop { port: string; channel: string }

export function parseTracePath(path: string): Hop[] {
  if (!path) return [];
  const parts = path.split('/');
  if (parts.length % 2 !== 0) throw new Error(`malformed trace path '${path}'`);
  const hops: Hop[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const port = parts[i]!, channel = parts[i + 1]!;
    if (!/^[a-z][a-z0-9._+\-#\[\]<>]{1,127}$/.test(port) || !/^channel-\d+$/.test(channel)) throw new Error(`malformed hop '${port}/${channel}'`);
    hops.push({ port, channel });
  }
  return hops;
}

export type ResolvedDenom =
  | { kind: 'native'; denom: string }
  | { kind: 'factory'; denom: string; creator: string }
  | { kind: 'ibc'; denom: string; hash: string; path: string; baseDenom: string; hops: Hop[]; hashVerified: true }
  | { kind: 'unresolved'; denom: string; reason: string };

export type TraceLookup = (hash: string) => Promise<DenomTrace | null>;

/**
 * Resolve a denom. For ibc/<hash> the trace comes from an UNTRUSTED node (LCD) so we recompute the hash locally
 * and refuse to accept a trace that does not hash to the denom (prevents spoofed/impersonated assets).
 */
export async function resolveDenom(denom: string, lookup: TraceLookup): Promise<ResolvedDenom> {
  if (denom.startsWith('ibc/')) {
    const hash = denom.slice(4);
    if (!/^[0-9A-F]{64}$/.test(hash)) return { kind: 'unresolved', denom, reason: 'ibc hash must be 64 uppercase hex chars' };
    const t = await lookup(hash);
    if (!t) return { kind: 'unresolved', denom, reason: 'trace not found' };
    if (ibcDenomHash(t.path, t.base_denom) !== hash) return { kind: 'unresolved', denom, reason: 'trace does not hash to denom (untrusted node response rejected)' };
    try { return { kind: 'ibc', denom, hash, path: t.path, baseDenom: t.base_denom, hops: parseTracePath(t.path), hashVerified: true }; }
    catch (e) { return { kind: 'unresolved', denom, reason: (e as Error).message }; }
  }
  const f = /^factory\/([a-z0-9]+)\/(.+)$/.exec(denom);
  if (f) return { kind: 'factory', denom, creator: f[1]! };
  if (/^[a-zA-Z][a-zA-Z0-9/:._-]{2,127}$/.test(denom)) return { kind: 'native', denom };
  return { kind: 'unresolved', denom, reason: 'invalid denom syntax' };
}

/** Canonical asset id for the ledger: identity is (origin chain/base denom + path), never the symbol or display name. */
export const canonicalAssetId = (chainId: string, r: ResolvedDenom): string =>
  r.kind === 'ibc' ? `cosmos:${chainId}/ibc:${r.hash}` : `cosmos:${chainId}/${r.kind}:${r.denom}`;
