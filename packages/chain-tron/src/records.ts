import { capabilityMapWith, type VerifiedChainRecord } from '@apex/contracts';

const EV = 'docs/evidence/chains-b-live-reads.md#tron';
const caps = () => capabilityMapWith({
  getBalances: { status: 'READ_ONLY', evidenceRef: EV, note: 'wallet/getaccount live read PASS; TRC20 balances not yet exercised' },
  getFeeQuote: { status: 'READ_ONLY', evidenceRef: EV, note: 'derived from live getchainparameters; burn estimate is a model, not a simulation' },
  getTransactionStatus: { status: 'READ_ONLY', evidenceRef: EV },
  finalityStatus: { status: 'READ_ONLY', evidenceRef: EV, note: 'solidified block via /walletsolidity' },
  nativeReserveRequired: { status: 'PENDING', note: 'pure model implemented and unit-tested; not exercised against chain' },
  submit: { status: 'PENDING', note: 'no signing/broadcast code in this package; execution requires policy-service signing + testnet (Nile) run' },
  transfer: { status: 'PENDING' },
});
const VERIFIED_AT = '2026-10-13';

export const chainRecords: VerifiedChainRecord[] = [
  {
    id: 'tron:0x2b6653dc', namespace: 'tron', chainRef: '0x2b6653dc', family: 'tron', name: 'TRON Mainnet', isTestnet: false,
    nativeSymbol: 'TRX', nativeDecimals: 6, finalityModel: 'DPoS 27 SR; solidified when >=18 SR confirm (~19 blocks / ~57s); use /walletsolidity',
    addressFormat: 'base58check, 0x41 prefix, 34 chars (T...)', explorerUrl: 'https://tronscan.org',
    rpcCandidates: ['https://api.trongrid.io'], enabled: false, capabilities: caps(),
    verifiedFrom: [
      'https://api.trongrid.io/wallet/getblockbynum {"num":0} => blockID 00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc (CAIP-2 ref = last 4 bytes of genesis hash)',
      'https://developers.tron.network/docs/resource-model',
    ],
    unverified: false, unverifiedFields: ['finalityModel.numeric-details(SR threshold wording)'],
    meta: { verifiedAt: VERIFIED_AT, genesisBlockId: '00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc', chainParametersSource: 'POST /wallet/getchainparameters (queried at runtime, never hardcoded)' },
  },
  {
    id: 'tron:0xcd8690dc', namespace: 'tron', chainRef: '0xcd8690dc', family: 'tron', name: 'TRON Nile Testnet', isTestnet: true,
    nativeSymbol: 'TRX', nativeDecimals: 6, finalityModel: 'same as mainnet (solidified block)',
    addressFormat: 'base58check, 0x41 prefix, 34 chars (T...)', explorerUrl: 'https://nile.tronscan.org',
    rpcCandidates: ['https://nile.trongrid.io'], enabled: false, capabilities: caps(),
    verifiedFrom: [
      'https://nile.trongrid.io/wallet/getblockbynum {"num":0} => blockID 0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc',
    ],
    unverified: false, unverifiedFields: ['explorerUrl'],
    meta: { verifiedAt: VERIFIED_AT, genesisBlockId: '0000000000000000d698d4192c56cb6be724a558448e2684802de4d6cd8690dc', faucet: 'unverified' },
  },
];
