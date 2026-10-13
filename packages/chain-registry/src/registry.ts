// Registry assembly + merge point.
//
// MERGE (lead wires the other families in later, nothing here blocks on them):
//   import { chains as tronChains } from '@apex/chain-tron';      // each family package exports ChainRecord[]
//   import { registerChains, buildRegistry } from '@apex/chain-registry';
//   registerChains(tronChains); registerChains(cosmosChains); ...   // idempotent per id; conflicting duplicates throw
//   const reg = buildRegistry();                                   // base (EVM/SVM/Sui/Aptos) + everything registered
// Then regenerate the seed migration:  pnpm --filter @apex/chain-registry gen:sql
import { CAPABILITIES } from '@apex/contracts';
import type { CapabilityMap, ChainFamily, ChainRecord, VerifiedChainRecord } from '@apex/contracts';
import { EVM_CHAINS, EXTRA_EVM_CHAINS } from './chains/evm.ts';
import { SOLANA_CHAINS } from './chains/solana.ts';
import { MOVE_CHAINS } from './chains/move.ts';
import { LIVE_EVIDENCE } from './live-evidence.generated.ts';

/** Families implemented by other agents; their records arrive through registerChains(). Listed so a health view can show NOT BUILT here. */
export const EXTERNAL_FAMILIES: readonly ChainFamily[] = ['tron', 'cosmos', 'bitcoin', 'ton', 'near'];
export const EXTERNAL_VENUE_KIND = 'cex'; // CEXes are venues, not chains: separate venue registry

export const LIVE_EVIDENCE_DOC = 'docs/evidence/chains-a-live-reads.md';

function cloneCaps(m: CapabilityMap): CapabilityMap { return JSON.parse(JSON.stringify(m)) as CapabilityMap; }

/** Apply recorded live-read evidence: capabilities that a REAL read succeeded for become READ_ONLY (never CERTIFIED). */
export function applyLiveEvidence(rec: VerifiedChainRecord, evidence = LIVE_EVIDENCE): VerifiedChainRecord {
  const ev = evidence[rec.id];
  const caps = cloneCaps(rec.capabilities);
  if (ev && ev.status === 'PASS') {
    for (const c of ev.capabilities) {
      const cap = c as keyof CapabilityMap;
      if (!(CAPABILITIES as readonly string[]).includes(c)) throw new Error(`live evidence names unknown capability ${c}`);
      if (caps[cap].status === 'UNSUPPORTED') continue;
      caps[cap] = { status: 'READ_ONLY', evidenceRef: `${LIVE_EVIDENCE_DOC}#${rec.id}`, note: `live read via ${ev.rpc} at ${ev.at}` };
    }
  }
  return { ...rec, capabilities: caps };
}

export function validateRecord(r: ChainRecord): void {
  if (r.id !== `${r.namespace}:${r.chainRef}`) throw new Error(`record id ${r.id} must be namespace:chainRef`);
  if (r.nativeDecimals < 0 || r.nativeDecimals > 36) throw new Error(`${r.id}: nativeDecimals out of range`);
  if (r.enabled) throw new Error(`${r.id}: registry records must be shipped enabled=false (opt-in)`);
  for (const cap of CAPABILITIES) {
    const c = r.capabilities[cap];
    if (!c) throw new Error(`${r.id}: missing capability ${cap}`);
    if (c.status === 'CERTIFIED' && !c.evidenceRef) throw new Error(`${r.id}: ${cap} CERTIFIED without evidenceRef`);
  }
}

const registered = new Map<string, ChainRecord>();
/** Register additional records (other families). Same id + identical JSON is a no-op; same id + different content throws. */
export function registerChains(records: readonly ChainRecord[]): void {
  for (const r of records) {
    validateRecord(r);
    const prev = registered.get(r.id);
    if (prev && JSON.stringify(prev) !== JSON.stringify(r)) throw new Error(`registerChains: conflicting duplicate for ${r.id}`);
    registered.set(r.id, r);
  }
}
export function clearRegisteredChains(): void { registered.clear(); } // tests

export class Registry {
  readonly records: readonly ChainRecord[];
  private byId: Map<string, ChainRecord>;
  constructor(records: ChainRecord[]) {
    this.byId = new Map();
    for (const r of records) { if (this.byId.has(r.id)) throw new Error(`duplicate chain id ${r.id}`); validateRecord(r); this.byId.set(r.id, r); }
    this.records = records;
  }
  get(id: string): ChainRecord | undefined { return this.byId.get(id); }
  require(id: string): ChainRecord { const r = this.byId.get(id); if (!r) throw new Error(`unknown chain ${id}`); return r; }
  byFamily(f: ChainFamily): ChainRecord[] { return this.records.filter((r) => r.family === f); }
  capabilities(id: string): CapabilityMap { return this.require(id).capabilities; }
  families(): ChainFamily[] { return [...new Set(this.records.map((r) => r.family))]; }
}

/** Base chains owned by this package (EVM incl. disabled extras, Solana, Sui, Aptos) with recorded live evidence applied. */
export function baseChains(): VerifiedChainRecord[] {
  return [...EVM_CHAINS, ...EXTRA_EVM_CHAINS, ...SOLANA_CHAINS, ...MOVE_CHAINS].map((r) => applyLiveEvidence(r));
}
export function buildRegistry(): Registry { return new Registry([...baseChains(), ...registered.values()]); }
