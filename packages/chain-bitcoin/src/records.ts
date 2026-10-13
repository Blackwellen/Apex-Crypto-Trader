import { capabilityMapWith, type VerifiedChainRecord } from '@apex/contracts';

const EV = 'docs/evidence/chains-b-live-reads.md#bitcoin';
const NOT_AMM = 'Bitcoin has no AMM/pools/ERC-20: capability is structurally unsupported (BTC spot trades are VenueAdapter business)';
const caps = () => capabilityMapWith({
  getBalances: { status: 'READ_ONLY', evidenceRef: EV, note: 'Esplora address stats' },
  getFeeQuote: { status: 'READ_ONLY', evidenceRef: EV, note: 'mempool.space recommended fees (third-party)' },
  getTransactionStatus: { status: 'READ_ONLY', evidenceRef: EV },
  finalityStatus: { status: 'READ_ONLY', evidenceRef: EV, note: 'confirmation-depth policy; reorg detection by block hash compare' },
  subscribeBlocks: { status: 'PENDING', note: 'polling tip only; no websocket exercised' },
  buildTransaction: { status: 'PENDING', note: 'selection/fee maths implemented + property tested; no PSBT/signing builder' },
  submit: { status: 'PENDING', note: 'no broadcast path; requires signer service + testnet run' },
  transfer: { status: 'PENDING' },
  getAllowances: { status: 'UNSUPPORTED', note: 'no allowances on UTXO chain' },
  getLiquidity: { status: 'UNSUPPORTED', note: NOT_AMM }, buildSwapQuote: { status: 'UNSUPPORTED', note: NOT_AMM }, swap: { status: 'UNSUPPORTED', note: NOT_AMM },
  subscribePools: { status: 'UNSUPPORTED', note: NOT_AMM }, discoverAssets: { status: 'UNSUPPORTED', note: 'native BTC only' },
  supportsSponsoredGas: { status: 'UNSUPPORTED' }, simulate: { status: 'UNSUPPORTED', note: 'use testmempoolaccept on own node (not implemented)' },
});

export const chainRecords: VerifiedChainRecord[] = [
  {
    id: 'bip122:000000000019d6689c085ae165831e93', namespace: 'bip122', chainRef: '000000000019d6689c085ae165831e93', family: 'bitcoin', name: 'Bitcoin Mainnet', isTestnet: false,
    nativeSymbol: 'BTC', nativeDecimals: 8, finalityModel: 'probabilistic PoW; confirmation-depth policy (default 3/6/12 by amount), reorg detection by block hash',
    addressFormat: 'P2PKH(1...), P2SH(3...), bech32 P2WPKH/P2WSH (bc1q...), bech32m P2TR (bc1p...)', explorerUrl: 'https://mempool.space',
    rpcCandidates: ['https://mempool.space'], enabled: false, capabilities: caps(),
    verifiedFrom: ['https://mempool.space/api/block-height/0 => 000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f (CAIP-2 bip122 ref = first 16 bytes of genesis hash)', 'https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki', 'https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki'],
    unverified: false, unverifiedFields: [], meta: { verifiedAt: '2026-10-13', api: 'Esplora/mempool.space', genesisHash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f' },
  },
  {
    id: 'bip122:000000000933ea01ad0ee984209779ba', namespace: 'bip122', chainRef: '000000000933ea01ad0ee984209779ba', family: 'bitcoin', name: 'Bitcoin Testnet3', isTestnet: true,
    nativeSymbol: 'tBTC', nativeDecimals: 8, finalityModel: 'probabilistic PoW (testnet: reorgs/min-difficulty blocks common)',
    addressFormat: 'P2PKH(m/n...), P2SH(2...), bech32 (tb1q...), bech32m (tb1p...)', explorerUrl: 'https://mempool.space/testnet',
    rpcCandidates: ['https://mempool.space/testnet'], enabled: false, capabilities: caps(),
    verifiedFrom: ['https://mempool.space/testnet/api/block-height/0 => 000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943'],
    unverified: false, unverifiedFields: ['testnet3 deprecation status (testnet4 exists: bip122:00000000da84f2bafbbc53dee25a72ae)'],
    meta: { verifiedAt: '2026-10-13', alsoKnown: { testnet4: { chainRef: '00000000da84f2bafbbc53dee25a72ae', genesisHash: '00000000da84f2bafbbc53dee25a72ae507ff4914b867c565be350b0da8bf043', api: 'https://mempool.space/testnet4' } } },
  },
];
