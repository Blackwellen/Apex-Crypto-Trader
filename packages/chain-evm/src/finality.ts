// Per-chain finality / confirmation-depth POLICY. These are risk-policy defaults (not protocol guarantees) and are tunable.
// A chain with no entry throws: the caller cannot treat an unconfigured chain as final (fail closed).
export interface FinalityPolicy {
  /** blocks (inclusive of the including block) before a tx is treated as final for money movement */
  requiredDepth: bigint;
  /** whether the node's `finalized` block tag is meaningful on this chain */
  finalizedTag: 'supported' | 'unsupported' | 'unknown';
  /** when true, depth alone is NOT enough: the finalized tag must also cover the block */
  requireFinalizedTag: boolean;
  basis: string;
}
const P = (requiredDepth: bigint, finalizedTag: FinalityPolicy['finalizedTag'], requireFinalizedTag: boolean, basis: string): FinalityPolicy =>
  ({ requiredDepth, finalizedTag, requireFinalizedTag, basis });

export const FINALITY_POLICIES: Record<string, FinalityPolicy> = {
  'eip155:1': P(64n, 'supported', true, 'Ethereum: 2 epochs (64 slots) + finalized tag required'),
  'eip155:11155111': P(64n, 'supported', false, 'Sepolia testnet: policy depth'),
  'eip155:8453': P(30n, 'supported', false, 'OP-stack L2 (Base): soft depth; L1-finalized tag is slower (~minutes) and optional by policy'),
  'eip155:10': P(30n, 'supported', false, 'OP-stack L2 (OP Mainnet): soft depth policy'),
  'eip155:81457': P(30n, 'supported', false, 'OP-stack L2 (Blast): soft depth policy'),
  'eip155:84532': P(30n, 'supported', false, 'Base Sepolia: soft depth policy'),
  'eip155:42161': P(30n, 'supported', false, 'Arbitrum One: soft depth policy (sequencer confirmation); L1 settlement later'),
  'eip155:137': P(256n, 'unknown', false, 'Polygon PoS: conservative depth policy (milestone finality not queried here)'),
  'eip155:56': P(15n, 'unknown', false, 'BSC: depth policy above fast-finality window'),
  'eip155:43114': P(5n, 'unknown', false, 'Avalanche C-Chain: Snowman fast finality; small policy depth'),
  'eip155:59144': P(30n, 'unknown', false, 'Linea: soft depth policy'),
  'eip155:534352': P(30n, 'unknown', false, 'Scroll: soft depth policy'),
  'eip155:324': P(30n, 'unknown', false, 'zkSync Era: soft depth policy (L1 batch execution later)'),
  'eip155:5000': P(30n, 'unknown', false, 'Mantle: soft depth policy'),
};

export class NoFinalityPolicyError extends Error {
  constructor(public readonly chainId: string) { super(`no finality policy configured for ${chainId}; refusing to treat anything as final`); this.name = 'NoFinalityPolicyError'; }
}
export function getFinalityPolicy(chainId: string, overrides: Record<string, FinalityPolicy> = {}): FinalityPolicy {
  const p = overrides[chainId] ?? FINALITY_POLICIES[chainId];
  if (!p) throw new NoFinalityPolicyError(chainId);
  return p;
}
