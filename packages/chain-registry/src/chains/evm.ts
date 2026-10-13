// EVM family. Chain ids / native symbols / decimals / explorers verified against the ethereum-lists registry (chainid.network) and,
// where noted, the chain's official documentation page (fetched; id string present). Live eth_chainId is recorded separately in
// live-evidence.generated.ts (docs/evidence/chains-a-live-reads.md). finalityModel text is descriptive; numeric depth policy lives in @apex/chain-evm.
import type { VerifiedChainRecord } from '@apex/contracts';
import { l2FeeSpec, getFinalityPolicy } from '@apex/chain-evm';
import { CHAINLIST, record } from './shared.ts';

interface EvmSeed {
  chainId: number; name: string; native: string; explorer: string; rpc: string[]; testnet?: boolean;
  stack: 'l1' | 'op-stack' | 'arbitrum-nitro' | 'zk-rollup' | 'sidechain' | 'other-l2';
  finality: string;
  /** official docs page that was fetched and contained the chain id (null => NOT confirmed against official docs) */
  docs: string | null;
  /** finalityModel text not confirmed from an official source */
  finalityUnverified: boolean;
}

const SEEDS: EvmSeed[] = [
  { chainId: 1, name: 'Ethereum', native: 'ETH', explorer: 'https://etherscan.io', rpc: ['https://ethereum-rpc.publicnode.com'], stack: 'l1',
    finality: 'Gasper finality: `finalized` block tag (2 epochs, ~13 min); `safe` earlier; probabilistic before', docs: 'https://ethereum.org/en/developers/docs/networks/', finalityUnverified: false },
  { chainId: 8453, name: 'Base', native: 'ETH', explorer: 'https://basescan.org', rpc: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'], stack: 'op-stack',
    finality: 'OP-stack L2: sequencer soft confirmation; unsafe->safe->finalized follows L1 batch posting and L1 finality', docs: 'https://docs.base.org/base-chain/quickstart/connecting-to-base', finalityUnverified: true },
  { chainId: 42161, name: 'Arbitrum One', native: 'ETH', explorer: 'https://arbiscan.io', rpc: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'], stack: 'arbitrum-nitro',
    finality: 'Arbitrum Nitro L2: sequencer soft confirmation; hard finality after L1 batch posting/finality', docs: 'https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info', finalityUnverified: true },
  { chainId: 10, name: 'OP Mainnet', native: 'ETH', explorer: 'https://optimistic.etherscan.io', rpc: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com'], stack: 'op-stack',
    finality: 'OP-stack L2: sequencer soft confirmation; unsafe->safe->finalized follows L1', docs: 'https://docs.optimism.io/superchain/networks', finalityUnverified: true },
  { chainId: 137, name: 'Polygon PoS', native: 'POL', explorer: 'https://polygonscan.com', rpc: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org', 'https://polygon-rpc.com'], stack: 'sidechain',
    finality: 'PoS sidechain (Bor/Heimdall) with checkpoints to Ethereum and milestone-based fast finality; not a rollup', docs: 'https://docs.polygon.technology/pos/reference/rpc-endpoints/', finalityUnverified: true },
  { chainId: 56, name: 'BNB Smart Chain', native: 'BNB', explorer: 'https://bscscan.com', rpc: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'], stack: 'l1',
    finality: 'Parlia PoSA with fast finality votes (BEP-126); probabilistic until finalized vote', docs: 'https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/', finalityUnverified: true },
  { chainId: 43114, name: 'Avalanche C-Chain', native: 'AVAX', explorer: 'https://snowtrace.io', rpc: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-c-chain-rpc.publicnode.com'], stack: 'l1',
    finality: 'Snowman consensus: sub-second probabilistic-to-irreversible finality on acceptance', docs: 'https://build.avax.network/docs/rpcs/c-chain', finalityUnverified: true },
  { chainId: 59144, name: 'Linea', native: 'ETH', explorer: 'https://lineascan.build', rpc: ['https://rpc.linea.build', 'https://linea-rpc.publicnode.com'], stack: 'zk-rollup',
    finality: 'zk-rollup: sequencer soft confirmation; proven/finalized on L1 after batch proof', docs: null, finalityUnverified: true },
  { chainId: 534352, name: 'Scroll', native: 'ETH', explorer: 'https://scrollscan.com', rpc: ['https://rpc.scroll.io', 'https://scroll-rpc.publicnode.com'], stack: 'zk-rollup',
    finality: 'zk-rollup: sequencer soft confirmation; finalized on L1 after batch proof', docs: null, finalityUnverified: true },
  { chainId: 324, name: 'zkSync Era', native: 'ETH', explorer: 'https://explorer.zksync.io', rpc: ['https://mainnet.era.zksync.io'], stack: 'zk-rollup',
    finality: 'zk-rollup: L2 block soft confirmation; batch committed/proven/executed on L1', docs: 'https://docs.zksync.io/zksync-network/', finalityUnverified: true },
  { chainId: 5000, name: 'Mantle', native: 'MNT', explorer: 'https://mantlescan.xyz', rpc: ['https://rpc.mantle.xyz', 'https://mantle-rpc.publicnode.com'], stack: 'other-l2',
    finality: 'OP-stack-derived L2 with EigenDA data availability: sequencer soft confirmation; L1 finality later', docs: 'https://docs.mantle.xyz/network/for-developers/quick-access', finalityUnverified: true },
  { chainId: 81457, name: 'Blast', native: 'ETH', explorer: 'https://blastscan.io', rpc: ['https://rpc.blast.io', 'https://blast-rpc.publicnode.com'], stack: 'op-stack',
    finality: 'OP-stack-derived L2: sequencer soft confirmation; L1 finality later', docs: 'https://docs.blast.io/building/network-information', finalityUnverified: true },
  // ---- testnets (monitoring / paper only) ----
  { chainId: 11155111, name: 'Ethereum Sepolia', native: 'ETH', explorer: 'https://sepolia.etherscan.io', rpc: ['https://ethereum-sepolia-rpc.publicnode.com'], testnet: true, stack: 'l1',
    finality: 'Gasper finality (testnet)', docs: null, finalityUnverified: true },
  { chainId: 84532, name: 'Base Sepolia', native: 'ETH', explorer: 'https://sepolia.basescan.org', rpc: ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'], testnet: true, stack: 'op-stack',
    finality: 'OP-stack L2 (testnet)', docs: null, finalityUnverified: true },
];

/** Configurable extra EVM chains shipped disabled; ids/natives/explorers from chainid.network; official docs NOT checked => unverified. */
const EXTRA_SEEDS: EvmSeed[] = [
  { chainId: 130, name: 'Unichain', native: 'ETH', explorer: 'https://uniscan.xyz', rpc: ['https://mainnet.unichain.org', 'https://unichain-rpc.publicnode.com'], stack: 'op-stack', finality: 'OP-stack L2', docs: null, finalityUnverified: true },
  { chainId: 146, name: 'Sonic', native: 'S', explorer: 'https://sonicscan.org', rpc: ['https://rpc.soniclabs.com', 'https://sonic-rpc.publicnode.com'], stack: 'l1', finality: 'Sonic L1 (fast finality)', docs: null, finalityUnverified: true },
  { chainId: 480, name: 'World Chain', native: 'ETH', explorer: 'https://worldscan.org', rpc: ['https://worldchain-mainnet.g.alchemy.com/public'], stack: 'op-stack', finality: 'OP-stack L2', docs: null, finalityUnverified: true },
  { chainId: 80094, name: 'Berachain', native: 'BERA', explorer: 'https://berascan.com', rpc: ['https://rpc.berachain.com', 'https://berachain-rpc.publicnode.com'], stack: 'l1', finality: 'CometBFT-based single-slot finality', docs: null, finalityUnverified: true },
  { chainId: 57073, name: 'Ink', native: 'ETH', explorer: 'https://explorer.inkonchain.com', rpc: ['https://rpc-gel.inkonchain.com'], stack: 'op-stack', finality: 'OP-stack L2', docs: null, finalityUnverified: true },
  { chainId: 100, name: 'Gnosis', native: 'XDAI', explorer: 'https://gnosisscan.io', rpc: ['https://rpc.gnosischain.com'], stack: 'sidechain', finality: 'Beacon-chain based finality', docs: null, finalityUnverified: true },
];

function build(s: EvmSeed, extra: boolean): VerifiedChainRecord {
  const idStr = String(s.chainId);
  const unverifiedFields: string[] = [];
  if (s.docs === null) unverifiedFields.push('officialDocsChainId');
  if (s.finalityUnverified) unverifiedFields.push('finalityModel');
  if (extra) unverifiedFields.push('rpcCandidates');
  const spec = l2FeeSpec(s.chainId);
  let finalityPolicy: unknown = 'none configured (fail closed)';
  try { const p = getFinalityPolicy(`eip155:${idStr}`); finalityPolicy = { requiredDepth: p.requiredDepth.toString(), requireFinalizedTag: p.requireFinalizedTag, finalizedTag: p.finalizedTag, basis: p.basis }; } catch { /* extra chains: none */ }
  return record('evm', {
    id: `eip155:${idStr}`, namespace: 'eip155', chainRef: idStr, name: s.name, isTestnet: s.testnet === true, nativeSymbol: s.native, nativeDecimals: 18,
    finalityModel: s.finality, addressFormat: 'eip55-hex20', explorerUrl: s.explorer, rpcCandidates: s.rpc,
    verifiedFrom: [`${CHAINLIST} (ethereum-lists/chains, chainId=${idStr}: name, nativeCurrency, explorers)`, ...(s.docs ? [`${s.docs} (fetched; chain id string present)`] : [])],
    unverifiedFields,
    meta: { stack: s.stack, extraChain: extra, l2DataFee: { modelled: spec.modelled, component: spec.componentName, note: spec.note }, finalityPolicy, eip1559: 'detected at runtime from baseFeePerGas; legacy fallback otherwise' },
  }, { supportsNativeOrderBook: 'EVM chains have no native order book' });
}

export const EVM_CHAINS: VerifiedChainRecord[] = SEEDS.map((s) => build(s, false));
export const EXTRA_EVM_CHAINS: VerifiedChainRecord[] = EXTRA_SEEDS.map((s) => build(s, true));

export interface ExtraEvmSpec { chainId: number; name: string; nativeSymbol: string; nativeDecimals?: number; explorerUrl: string; rpcCandidates: string[]; finalityModel: string; verifiedFrom: string[]; isTestnet?: boolean }
/**
 * Configure an additional EVM chain. `verifiedFrom` is REQUIRED and must name where the chain id was checked (official RPC docs / chain registry).
 * The record is created disabled with all capabilities PENDING and `unverified: true` for rpcCandidates until a live chain-id check passes.
 */
export function makeExtraEvmChain(spec: ExtraEvmSpec): VerifiedChainRecord {
  if (!Number.isSafeInteger(spec.chainId) || spec.chainId <= 0) throw new Error('chainId must be a positive integer');
  if (!spec.verifiedFrom.length || spec.verifiedFrom.some((v) => !v.trim())) throw new Error('verifiedFrom is required: cite where the chain id was verified');
  if ((spec.nativeDecimals ?? 18) < 0 || (spec.nativeDecimals ?? 18) > 36) throw new Error('bad nativeDecimals');
  const r = build({ chainId: spec.chainId, name: spec.name, native: spec.nativeSymbol, explorer: spec.explorerUrl, rpc: spec.rpcCandidates, testnet: spec.isTestnet ?? false, stack: 'other-l2', finality: spec.finalityModel, docs: null, finalityUnverified: true }, true);
  r.nativeDecimals = spec.nativeDecimals ?? 18;
  r.verifiedFrom = [...spec.verifiedFrom];
  r.unverifiedFields = r.unverifiedFields.filter((f) => f !== 'officialDocsChainId');
  r.unverified = r.unverifiedFields.length > 0;
  return r;
}
