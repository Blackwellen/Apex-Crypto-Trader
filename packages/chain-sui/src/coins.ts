// Pure coin selection (no I/O). Contention-safety comes from the DB lease (leases.ts); this is the selection policy mirror.
import type { SuiCoin } from './rpc.ts';

export class InsufficientCoins extends Error { constructor(m: string) { super(m); this.name = 'InsufficientCoins'; } }

/** smallest single coin >= need, else largest-first accumulation up to maxObjects. Excluded ids (leased elsewhere) are skipped. */
export function selectCoins(coins: SuiCoin[], need: bigint, o: { maxObjects?: number; exclude?: ReadonlySet<string> } = {}): SuiCoin[] {
  if (need < 0n) throw new Error('negative need');
  const pool = coins.filter((c) => !o.exclude?.has(c.objectId));
  const single = pool.filter((c) => c.balance >= need).sort((a, b) => (a.balance < b.balance ? -1 : a.balance > b.balance ? 1 : 0))[0];
  if (single) return [single];
  const sorted = [...pool].sort((a, b) => (a.balance > b.balance ? -1 : a.balance < b.balance ? 1 : 0));
  const out: SuiCoin[] = []; let acc = 0n;
  for (const c of sorted) { if (acc >= need || out.length >= (o.maxObjects ?? 50)) break; out.push(c); acc += c.balance; }
  if (acc < need) throw new InsufficientCoins(`need ${need}, selectable ${acc}`);
  return out;
}
