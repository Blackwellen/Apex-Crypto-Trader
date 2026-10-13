import type { VerifiedChainRecord } from '@apex/contracts';
import { SOLANA_GENESIS_HASHES } from '@apex/chain-solana';
import { record } from './shared.ts';

const DOCS = 'https://solana.com/docs/core/clusters';
const UNSUP = { supportsNativeOrderBook: 'no protocol-level order book (programs such as Phoenix/OpenBook are venues, not chain capabilities)' } as const;

function sol(ref: 'mainnet' | 'devnet' | 'testnet', name: string, explorerUrl: string, rpc: string[], testnet: boolean): VerifiedChainRecord {
  return record('svm', {
    id: `solana:${ref}`, namespace: 'solana', chainRef: ref, name, isTestnet: testnet, nativeSymbol: 'SOL', nativeDecimals: 9,
    finalityModel: 'commitment levels: processed < confirmed (optimistic, supermajority vote) < finalized (rooted, ~32 slots); blockhash valid ~150 blocks (lastValidBlockHeight)',
    addressFormat: 'base58-32byte-pubkey', explorerUrl, rpcCandidates: rpc,
    verifiedFrom: [`${DOCS} (fetched; cluster names present)`, `genesis hash ${SOLANA_GENESIS_HASHES[`solana:${ref}`]} observed live via getGenesisHash (docs/evidence/chains-a-live-reads.md)`],
    unverifiedFields: ['rpcCandidates'],
    meta: { genesisHash: SOLANA_GENESIS_HASHES[`solana:${ref}`], lamportsPerSol: '1000000000', baseFeeLamportsPerSignature: '5000', rentLamportsPerByteYear: '3480', tokenPrograms: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'], clusterVerification: 'genesis hash' },
  }, UNSUP);
}
export const SOLANA_CHAINS: VerifiedChainRecord[] = [
  sol('mainnet', 'Solana Mainnet Beta', 'https://explorer.solana.com', ['https://api.mainnet-beta.solana.com'], false),
  sol('devnet', 'Solana Devnet', 'https://explorer.solana.com/?cluster=devnet', ['https://api.devnet.solana.com'], true),
  sol('testnet', 'Solana Testnet', 'https://explorer.solana.com/?cluster=testnet', ['https://api.testnet.solana.com'], true),
];
