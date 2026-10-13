// ADDITIVE contract extension (chains-A agent): provenance for registry records. Does not alter ChainRecord.
import type { ChainRecord } from './chain.ts';

/** A registry record that carries where each hard fact came from. Unverified facts must be listed, never silently trusted. */
export interface VerifiedChainRecord extends ChainRecord {
  /** URLs / evidence strings the chain id, native symbol, decimals and explorer were checked against */
  verifiedFrom: string[];
  /** true if ANY field could not be verified against an official/primary source */
  unverified: boolean;
  /** names of the ChainRecord fields (or meta keys) that remain unverified */
  unverifiedFields: string[];
  /** free-form chain metadata persisted to chain_registry.details (rollup stack, identifiers, policy notes) */
  meta: Record<string, unknown>;
}
