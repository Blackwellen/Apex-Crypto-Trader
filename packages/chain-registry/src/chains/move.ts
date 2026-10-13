import type { VerifiedChainRecord } from '@apex/contracts';
import { SUI_CHAIN_IDENTIFIERS } from '@apex/chain-sui';
import { APTOS_CHAIN_IDS } from '@apex/chain-aptos';
import { record } from './shared.ts';

const SUI_NET = 'https://docs.sui.io/concepts/sui-architecture/networks';
const APTOS_NET = 'https://aptos.dev/network/nodes/networks';

function sui(ref: 'mainnet' | 'testnet', digest: string, rpc: string[], explorer: string): VerifiedChainRecord {
  return record('sui', {
    id: `sui:${ref}`, namespace: 'sui', chainRef: ref, name: ref === 'mainnet' ? 'Sui Mainnet' : 'Sui Testnet', isTestnet: ref !== 'mainnet', nativeSymbol: 'SUI', nativeDecimals: 9,
    finalityModel: 'checkpoint finality: a transaction included in a certified checkpoint is final (no reorgs); owned-object txs finalize via consensus-free fast path',
    addressFormat: 'sui-0x-hex32', explorerUrl: explorer, rpcCandidates: rpc,
    verifiedFrom: [`${SUI_NET} (fetched; network names present)`, `sui_getChainIdentifier=${SUI_CHAIN_IDENTIFIERS[`sui:${ref}`]} and GraphQL chainIdentifier=${digest} observed live (docs/evidence/chains-a-live-reads.md)`],
    unverifiedFields: ['rpcCandidates', 'finalityModel', 'explorerUrl'],
    meta: { chainIdentifier: SUI_CHAIN_IDENTIFIERS[`sui:${ref}`], genesisCheckpointDigest: digest, mistPerSui: '1000000000', jsonRpcStatus: 'DEPRECATED on official public fullnodes (returns -32601 migrate to gRPC/GraphQL); third-party providers still serve it',
      objectModel: 'owned/shared objects; coin objects with versions; gas coin selection; no account nonce', graphqlEndpoint: `https://graphql.${ref}.sui.io/graphql` },
  }, {});
}
function aptos(ref: 'mainnet' | 'testnet', explorerNet: string): VerifiedChainRecord {
  const id = APTOS_CHAIN_IDS[`aptos:${ref}`];
  return record('aptos', {
    id: `aptos:${ref}`, namespace: 'aptos', chainRef: ref, name: ref === 'mainnet' ? 'Aptos Mainnet' : 'Aptos Testnet', isTestnet: ref !== 'mainnet', nativeSymbol: 'APT', nativeDecimals: 8,
    finalityModel: 'deterministic BFT finality: a committed transaction (found by hash, non-pending) is final; sequence-number or orderless (replay-protection nonce) transactions',
    addressFormat: 'aptos-0x-hex1..64-normalised-to-64', explorerUrl: `https://explorer.aptoslabs.com/?network=${explorerNet}`,
    rpcCandidates: [ref === 'mainnet' ? 'https://fullnode.mainnet.aptoslabs.com/v1' : 'https://fullnode.testnet.aptoslabs.com/v1'],
    verifiedFrom: [`${APTOS_NET} (fetched; Mainnet / Chain ID present)`, `GET /v1 chain_id=${id} observed live (docs/evidence/chains-a-live-reads.md)`],
    unverifiedFields: ['rpcCandidates', 'explorerUrl'],
    meta: { aptosChainId: id, octasPerApt: '100000000', nativeCoinType: '0x1::aptos_coin::AptosCoin', sequenceModel: 'per-account sequence_number; orderless transactions exist (u64::MAX sequence + replay_protection_nonce) and are NOT modelled by the allocator' },
  }, {});
}
export const MOVE_CHAINS: VerifiedChainRecord[] = [
  sui('mainnet', '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S', ['https://fullnode.mainnet.sui.io:443', 'https://sui-rpc.publicnode.com'], 'https://suiscan.xyz/mainnet'),
  sui('testnet', '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD', ['https://fullnode.testnet.sui.io:443', 'https://sui-testnet-rpc.publicnode.com'], 'https://suiscan.xyz/testnet'),
  aptos('mainnet', 'mainnet'),
  aptos('testnet', 'testnet'),
];
