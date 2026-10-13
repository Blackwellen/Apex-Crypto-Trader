import { capabilityMapWith, type VerifiedChainRecord } from '@apex/contracts';
import { COSMOS_CHAINS, type CosmosChainConfig } from './config.ts';

const EV = 'docs/evidence/chains-b-live-reads.md#cosmos';
const caps = () => capabilityMapWith({
  getBalances: { status: 'READ_ONLY', evidenceRef: EV },
  getTokenMetadata: { status: 'READ_ONLY', evidenceRef: EV, note: 'IBC denom trace resolved + hash-verified; no symbol/decimals registry' },
  getTransactionStatus: { status: 'READ_ONLY', evidenceRef: EV },
  getFeeQuote: { status: 'READ_ONLY', evidenceRef: EV, note: 'node minimum_gas_price only; no simulation endpoint exercised' },
  finalityStatus: { status: 'READ_ONLY', evidenceRef: EV, note: 'CometBFT instant finality per committed block; IBC settlement requires ack/timeout (state machine, unit tested only)' },
  submit: { status: 'PENDING', note: 'no protobuf signing/broadcast implemented; blocker: signer service + testnet run' },
  bridgeSubmit: { status: 'PENDING', note: 'IBC transfer tx build not implemented' },
});
const verified: Record<string, { from: string[]; unverifiedFields: string[] }> = {
  'cosmoshub-4': { from: ['https://cosmos-rest.publicnode.com/cosmos/base/tendermint/v1beta1/node_info => network cosmoshub-4, gaiad', 'https://cosmos-rest.publicnode.com/cosmos/staking/v1beta1/params => bond_denom uatom'], unverifiedFields: ['explorerUrl'] },
  'osmosis-1': { from: ['https://osmosis-rest.publicnode.com/cosmos/base/tendermint/v1beta1/node_info => network osmosis-1, osmosisd'], unverifiedFields: ['explorerUrl', 'nativeDenom(uosmo) not queried from staking params'] },
};
export const toRecord = (c: CosmosChainConfig): VerifiedChainRecord => {
  const v = verified[c.chainId];
  return {
    id: `cosmos:${c.chainId}`, namespace: 'cosmos', chainRef: c.chainId, family: 'cosmos', name: c.name, isTestnet: c.isTestnet,
    nativeSymbol: c.nativeSymbol, nativeDecimals: c.decimals, finalityModel: 'CometBFT instant finality per block; IBC transfers final only on acknowledgement or timeout refund',
    addressFormat: `bech32 (${c.bech32Prefix}1...), 20 or 32 bytes`, explorerUrl: c.explorer, rpcCandidates: c.lcd, enabled: false, capabilities: caps(),
    verifiedFrom: v?.from ?? [], unverified: !v || v.unverifiedFields.length > 0, unverifiedFields: v?.unverifiedFields ?? ['all'],
    meta: { bech32Prefix: c.bech32Prefix, nativeDenom: c.nativeDenom, feeDenoms: c.feeDenoms, gasPrice: 'queried per node (config endpoint), never hardcoded', verifiedAt: '2026-10-13', rpcKind: 'LCD (REST)' },
  };
};
export const chainRecords: VerifiedChainRecord[] = COSMOS_CHAINS.map(toRecord);
