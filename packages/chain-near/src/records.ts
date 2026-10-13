import { capabilityMapWith, type VerifiedChainRecord } from '@apex/contracts';
const EV = 'docs/evidence/chains-b-live-reads.md#near';
export const NEAR_EXECUTION_BLOCKER = 'EXECUTION UNSUPPORTED (documented blocker): transaction building/signing (borsh, ed25519 access-key signing, action serialisation) is not implemented or testnet-exercised here. Official JS lib near-api-js 7.3.1 exists (npm 2026-10-13) but is not integrated with the policy signer, and no funded testnet account run was possible. Not faking execution.';
export const chainRecords: VerifiedChainRecord[] = [{
  id: 'near:mainnet', namespace: 'near', chainRef: 'mainnet', family: 'near', name: 'NEAR Protocol Mainnet', isTestnet: false, nativeSymbol: 'NEAR', nativeDecimals: 24,
  finalityModel: 'Nightshade/Doomslug: optimistic < near-final < final (use final for settlement); gas prepaid, receipts execute asynchronously across shards',
  addressFormat: 'named account ids (a-z0-9 . - _, 2-64), 64-hex implicit, 0x+40hex ETH-implicit', explorerUrl: 'https://nearblocks.io',
  rpcCandidates: ['https://rpc.mainnet.near.org'], enabled: false,
  capabilities: capabilityMapWith({
    getBalances: { status: 'READ_ONLY', evidenceRef: EV, note: 'native NEAR (view_account); NEP-141 not implemented' },
    getFeeQuote: { status: 'READ_ONLY', evidenceRef: EV, note: 'gas_price RPC' },
    subscribeBlocks: { status: 'READ_ONLY', evidenceRef: EV, note: 'status poll' },
    finalityStatus: { status: 'PENDING', note: 'classifier unit-tested; tx status RPC not exercised' },
    getTransactionStatus: { status: 'PENDING' },
    buildTransaction: { status: 'UNSUPPORTED', note: NEAR_EXECUTION_BLOCKER }, signThroughPolicyService: { status: 'UNSUPPORTED', note: NEAR_EXECUTION_BLOCKER },
    submit: { status: 'UNSUPPORTED', note: NEAR_EXECUTION_BLOCKER }, transfer: { status: 'UNSUPPORTED', note: NEAR_EXECUTION_BLOCKER }, swap: { status: 'UNSUPPORTED', note: NEAR_EXECUTION_BLOCKER },
  }),
  verifiedFrom: ['https://rpc.mainnet.near.org status => chain_id "mainnet", genesis_hash EPnLgE7iEq9s7yTkos96M3cWymH5avBAPm3qx3NXqR8H', 'https://docs.near.org/protocol/account-id'],
  unverified: true, unverifiedFields: ['explorerUrl', 'public RPC endpoint longevity (near.lava.build discontinued, observed HTTP 410)'],
  meta: { verifiedAt: '2026-10-13', genesisHash: 'EPnLgE7iEq9s7yTkos96M3cWymH5avBAPm3qx3NXqR8H', executionBlocker: NEAR_EXECUTION_BLOCKER },
}];
