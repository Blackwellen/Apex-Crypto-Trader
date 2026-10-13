import { capabilityMapWith, type VerifiedChainRecord } from '@apex/contracts';
const EV = 'docs/evidence/chains-b-live-reads.md#ton';
const BLOCKER = 'EXECUTION UNSUPPORTED (documented blocker): wallet-contract (v4r2/v5) message construction + signing is not implemented or testnet-exercised in this repo. Official libs exist (@ton/core 0.63.1, @ton/ton 16.3.0 per npm 2026-10-13) but are not integrated with the policy signer and no funded testnet run was possible. Not faking execution.';
export const TON_EXECUTION_BLOCKER = BLOCKER;
export const chainRecords: VerifiedChainRecord[] = [{
  id: 'ton:-239', namespace: 'ton', chainRef: '-239', family: 'ton', name: 'TON Mainnet', isTestnet: false, nativeSymbol: 'TON', nativeDecimals: 9,
  finalityModel: 'BFT masterchain blocks; async actor model: wallet tx is first hop only; confirm resulting message tree (seqno advance + tx lookup)',
  addressFormat: 'raw "0:<64hex>" or friendly base64url 48 chars with CRC16 (EQ.. bounceable / UQ.. non-bounceable)', explorerUrl: 'https://tonviewer.com',
  rpcCandidates: ['https://toncenter.com'], enabled: false,
  capabilities: capabilityMapWith({
    getBalances: { status: 'READ_ONLY', evidenceRef: EV, note: 'native TON only; jettons not implemented' },
    getTransactionStatus: { status: 'PENDING', note: 'seqno-based resolver implemented (unit-tested); tx lookup by message hash not exercised' },
    subscribeBlocks: { status: 'READ_ONLY', evidenceRef: EV, note: 'masterchain seqno poll via getMasterchainInfo' },
    buildTransaction: { status: 'UNSUPPORTED', note: BLOCKER }, signThroughPolicyService: { status: 'UNSUPPORTED', note: BLOCKER },
    submit: { status: 'UNSUPPORTED', note: BLOCKER }, transfer: { status: 'UNSUPPORTED', note: BLOCKER }, swap: { status: 'UNSUPPORTED', note: BLOCKER },
  }),
  verifiedFrom: ['https://toncenter.com/api/v2/getMasterchainInfo init.root_hash F6OpKZKqvqeFp6CQmFomXNMfMj2EnaUSOXN+Mh+wVWk= == https://ton.org/global-config.json validator.zero_state.root_hash', 'https://toncenter.com/api/v2/detectAddress (address format)'],
  unverified: true, unverifiedFields: ['chainRef -239 (global_id not present in fetched global-config.json; documented in TON docs only)', 'explorerUrl'],
  meta: { verifiedAt: '2026-10-13', executionBlocker: BLOCKER, feeNote: 'see TON_FEE_NOTE' },
}];
