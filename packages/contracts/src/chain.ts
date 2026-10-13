// Shared chain/venue contracts. Every adapter package implements ChainAdapter. Amounts are bigint base units.
export type ChainFamily = 'evm' | 'svm' | 'sui' | 'aptos' | 'tron' | 'cosmos' | 'bitcoin' | 'ton' | 'near';
export type CertStatus = 'CERTIFIED' | 'READ_ONLY' | 'PENDING' | 'UNSUPPORTED';

export const CAPABILITIES = [
  'discoverAssets', 'subscribeBlocks', 'subscribeTransactions', 'subscribePools', 'getBalances', 'getAllowances', 'getTokenMetadata',
  'getFeeQuote', 'getPriorityFeeQuote', 'simulate', 'buildTransaction', 'signThroughPolicyService', 'submit', 'getTransactionStatus',
  'finalityStatus', 'getLiquidity', 'buildSwapQuote', 'swap', 'transfer', 'bridgeQuote', 'bridgeSubmit', 'nativeReserveRequired',
  'supportsAtomicBundle', 'supportsPrivateRoute', 'supportsSponsoredGas', 'supportsNativeOrderBook',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface CapabilityRecord { status: CertStatus; evidenceRef?: string; note?: string }
/** Honest capability map. A capability may only be CERTIFIED with a recorded evidenceRef (test/log reference). */
export type CapabilityMap = Record<Capability, CapabilityRecord>;

export interface ChainRecord {
  id: string;            // CAIP-2 style: eip155:8453, solana:mainnet, sui:mainnet, ...
  namespace: string; chainRef: string; family: ChainFamily; name: string; isTestnet: boolean;
  nativeSymbol: string; nativeDecimals: number; finalityModel: string; addressFormat: string; explorerUrl?: string;
  /** public RPC candidates are documentation hints only; never trusted without health + chain-id verification */
  rpcCandidates: string[];
  enabled: boolean;      // default false: monitoring/trading are opt-in
  capabilities: CapabilityMap;
}

export interface FeeQuote { chainId: string; nativeUnits: bigint; components: Record<string, bigint>; observedAt: number; source: string; stale: boolean }
export interface NativeReserve { chainId: string; floor: bigint; nextNTxEstimate: bigint; emergencyExit: bigint; total: bigint }
export interface TxStatus { state: 'unknown' | 'pending' | 'included' | 'final' | 'failed' | 'reorged' | 'expired'; confirmations?: number; detail?: string }
export interface Balance { assetId: string; amount: bigint; decimals: number }

export class CapabilityNotCertified extends Error {
  constructor(public chainId: string, public capability: string, public status: CertStatus) {
    super(`capability ${capability} on ${chainId} is ${status}; refusing to proceed (fail closed)`);
  }
}

/** Adapters must throw CapabilityNotCertified for anything not CERTIFIED (reads may proceed at READ_ONLY). */
export interface ChainAdapter {
  readonly family: ChainFamily;
  capabilities(chainId: string): CapabilityMap;
  validateAddress(address: string, chainId?: string): { valid: boolean; reason?: string; normalized?: string };
  validateAssetId?(assetId: string, chainId?: string): { valid: boolean; reason?: string };
  getBalances?(chainId: string, address: string): Promise<Balance[]>;
  getFeeQuote?(chainId: string): Promise<FeeQuote>;
  nativeReserveRequired(chainId: string, opts: { plannedTxCount: number }): NativeReserve;
  getTransactionStatus?(chainId: string, txId: string): Promise<TxStatus>;
  /** execution paths: MUST call assertCertified(...) first */
  submit?(chainId: string, signedTx: Uint8Array): Promise<{ txId: string }>;
}

export function assertCertified(map: CapabilityMap, chainId: string, cap: Capability): void {
  const rec = map[cap];
  if (!rec || rec.status !== 'CERTIFIED') throw new CapabilityNotCertified(chainId, cap, rec?.status ?? 'UNSUPPORTED');
}
export function emptyCapabilities(status: CertStatus = 'PENDING'): CapabilityMap {
  return Object.fromEntries(CAPABILITIES.map((c) => [c, { status }])) as CapabilityMap;
}

// ---- Venue contract (CEX/aggregator). Venue != chain. ----
export interface VenueMarket { symbol: string; base: string; quote: string; tickSize: string; lotSize: string; minNotional: string; status: 'online' | 'offline' }
export interface BookLevel { price: string; qty: string }
export interface OrderBookSnapshot { symbol: string; seq: number; ts: number; bids: BookLevel[]; asks: BookLevel[] }
export interface VenueAdapter {
  readonly id: string;
  /** UK retail availability must be VERIFIED by a human against venue/FCA documentation; default UNVERIFIED */
  readonly ukAvailability: 'UNVERIFIED' | 'AVAILABLE' | 'RESTRICTED';
  readonly spotOnly: true;
  listMarkets(): Promise<VenueMarket[]>;
  getOrderBook(symbol: string): Promise<OrderBookSnapshot>;
  /** trading is disabled unless a credential scope with withdrawals disabled has been verified */
  placeOrder?(): never;
}
