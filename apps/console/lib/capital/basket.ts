/** Basket weight and rebalancing-preview math. BigInt only for ledger amounts; weights are integer basis points. No price feed is used or assumed. */
export const TOTAL_BPS = 10000;

/** Parse a percent string ("33.33") into integer bps (max 2 decimals). Returns null if invalid. */
export function parsePct(input: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return bps > TOTAL_BPS ? null : bps;
}
export const fmtPct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

export interface WeightRow { asset: string; bps: number | null }
export function weightSummary(rows: WeightRow[]) {
  const assets = rows.map((r) => r.asset).filter(Boolean);
  const dupes = assets.filter((a, i) => assets.indexOf(a) !== i);
  const invalid = rows.filter((r) => r.bps === null).length;
  const total = rows.reduce((a, r) => a + (r.bps ?? 0), 0);
  const remaining = TOTAL_BPS - total;
  const problems: string[] = [];
  if (rows.length === 0) problems.push('Add at least one asset');
  if (rows.some((r) => !r.asset)) problems.push('Choose an asset for every row');
  if (dupes.length) problems.push('Each asset may appear once');
  if (invalid) problems.push('Enter every weight as a percentage with at most 2 decimals');
  if (remaining !== 0) problems.push(remaining > 0 ? `${fmtPct(remaining)} still unallocated` : `${fmtPct(-remaining)} over 100%`);
  return { total, remaining, problems, canSave: problems.length === 0 };
}

export interface Holding { asset: string; symbol: string; decimals: number; amount: string }
export interface Member { asset: string; symbol: string; decimals: number; weight_bps: number }
export interface PreviewRow { asset: string; symbol: string; decimals: number; currentUnits: bigint; currentBps: number; targetBps: number; driftBps: number; deltaUnits: bigint; action: 'buy' | 'sell' | 'hold' }

/**
 * Units-based rebalance preview. Each holding is normalised to a common scale (10^maxDecimals) so differing decimals compare as whole units.
 * WITHOUT prices this treats 1 unit of every asset as equal value, which is only meaningful for like-denominated baskets (e.g. stablecoins);
 * the UI must say so. deltaUnits is in the asset's own base units, truncated toward zero.
 */
export function rebalancePreview(members: Member[], holdings: Holding[]): { rows: PreviewRow[]; totalNormalised: bigint; outside: Holding[] } {
  const maxDec = Math.max(0, ...members.map((m) => m.decimals));
  const scale = (dec: number) => 10n ** BigInt(maxDec - dec);
  const held = new Map(holdings.map((h) => [h.asset, BigInt(h.amount)]));
  const norm = members.map((m) => (held.get(m.asset) ?? 0n) * scale(m.decimals));
  const total = norm.reduce((a, b) => a + b, 0n);
  const rows = members.map((m, i): PreviewRow => {
    const currentBps = total === 0n ? 0 : Number((norm[i] * 10000n) / total);
    const targetNorm = (total * BigInt(m.weight_bps)) / 10000n;
    const deltaNorm = targetNorm - norm[i];
    const deltaUnits = deltaNorm / scale(m.decimals);
    return { asset: m.asset, symbol: m.symbol, decimals: m.decimals, currentUnits: held.get(m.asset) ?? 0n, currentBps, targetBps: m.weight_bps, driftBps: currentBps - m.weight_bps, deltaUnits, action: deltaUnits > 0n ? 'buy' : deltaUnits < 0n ? 'sell' : 'hold' };
  });
  const inSet = new Set(members.map((m) => m.asset));
  return { rows, totalNormalised: total, outside: holdings.filter((h) => !inSet.has(h.asset) && BigInt(h.amount) > 0n) };
}

/** Assets that appear in more than one basket (aggregate exposure can hide a double bet), and per-chain weight shares for a basket. */
export function basketOverlaps(baskets: { id: string; name: string; members: { asset: string; symbol: string }[] }[]) {
  const by = new Map<string, { symbol: string; baskets: string[] }>();
  for (const b of baskets) for (const m of b.members) { const e = by.get(m.asset) ?? { symbol: m.symbol, baskets: [] }; if (!e.baskets.includes(b.name)) e.baskets.push(b.name); by.set(m.asset, e); }
  return [...by.entries()].filter(([, v]) => v.baskets.length > 1).map(([asset, v]) => ({ asset, symbol: v.symbol, baskets: v.baskets }));
}
export function chainConcentration(members: { chain_id: string; weight_bps: number }[]) {
  const m = new Map<string, number>(); for (const x of members) m.set(x.chain_id, (m.get(x.chain_id) ?? 0) + x.weight_bps);
  return [...m.entries()].map(([chain, bps]) => ({ chain, bps })).sort((a, b) => b.bps - a.bps);
}
