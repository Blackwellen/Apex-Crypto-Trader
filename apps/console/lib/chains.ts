/** Pure chain readiness logic. Readiness is derived ONLY from capability statuses stored in the DB; nothing is CERTIFIED by default. */
export type CertStatus = 'CERTIFIED' | 'READ_ONLY' | 'PENDING' | 'UNSUPPORTED';
export interface CapRecord { status: CertStatus; evidence?: string | null; updated_at?: string }
export type CapMap = Record<string, CapRecord | undefined>;

/** Mirrors packages/contracts CAPABILITIES (the ChainAdapter contract). */
export const ALL_CAPABILITIES = [
  'discoverAssets', 'subscribeBlocks', 'subscribeTransactions', 'subscribePools', 'getBalances', 'getAllowances', 'getTokenMetadata',
  'getFeeQuote', 'getPriorityFeeQuote', 'simulate', 'buildTransaction', 'signThroughPolicyService', 'submit', 'getTransactionStatus',
  'finalityStatus', 'getLiquidity', 'buildSwapQuote', 'swap', 'transfer', 'bridgeQuote', 'bridgeSubmit', 'nativeReserveRequired',
  'supportsAtomicBundle', 'supportsPrivateRoute', 'supportsSponsoredGas', 'supportsNativeOrderBook',
] as const;

/** reads that support research/monitoring (CERTIFIED or READ_ONLY is enough) */
export const READ_CAPS = ['discoverAssets', 'subscribeBlocks', 'getBalances', 'getTokenMetadata', 'getFeeQuote', 'getTransactionStatus', 'finalityStatus', 'getLiquidity'] as const;
/** EVERY one must be CERTIFIED before trading is shown as ready; swap and submit are mandatory members */
export const TRADE_CAPS = ['swap', 'submit', 'simulate', 'getFeeQuote', 'getTransactionStatus', 'finalityStatus', 'signThroughPolicyService'] as const;

export type ResearchReadiness = 'read_only_available' | 'none';
export type TradingReadiness = 'certified' | 'partial' | 'not_ready';
export interface Readiness { research: ResearchReadiness; trading: TradingReadiness; missingForTrading: string[]; counts: Record<CertStatus | 'UNRECORDED', number>; certifiedWithoutEvidence: string[] }

/** A CERTIFIED record without an evidence reference is not trusted (the DB forbids it; this is defence in depth). */
export function effectiveStatus(rec: CapRecord | undefined): CertStatus | 'UNRECORDED' {
  if (!rec) return 'UNRECORDED';
  if (rec.status === 'CERTIFIED' && !(rec.evidence && rec.evidence.trim())) return 'PENDING';
  return rec.status;
}

export function readiness(caps: CapMap | null | undefined): Readiness {
  const m = caps ?? {};
  const counts: Readiness['counts'] = { CERTIFIED: 0, READ_ONLY: 0, PENDING: 0, UNSUPPORTED: 0, UNRECORDED: 0 };
  const certifiedWithoutEvidence: string[] = [];
  for (const c of ALL_CAPABILITIES) {
    counts[effectiveStatus(m[c])]++;
    if (m[c]?.status === 'CERTIFIED' && effectiveStatus(m[c]) !== 'CERTIFIED') certifiedWithoutEvidence.push(c);
  }
  const research: ResearchReadiness = READ_CAPS.some((c) => { const s = effectiveStatus(m[c]); return s === 'CERTIFIED' || s === 'READ_ONLY'; }) ? 'read_only_available' : 'none';
  const missingForTrading = TRADE_CAPS.filter((c) => effectiveStatus(m[c]) !== 'CERTIFIED');
  const trading: TradingReadiness = missingForTrading.length === 0 ? 'certified' : missingForTrading.length < TRADE_CAPS.length ? 'partial' : 'not_ready';
  return { research, trading, missingForTrading, counts, certifiedWithoutEvidence };
}

export const researchLabel = (r: ResearchReadiness) => (r === 'read_only_available' ? 'Research: read-only data available' : 'Research: no certified or read-only capability');
export const tradingLabel = (t: TradingReadiness) => (t === 'certified' ? 'Trading: capabilities certified (gates still apply)' : t === 'partial' ? 'Trading: partially certified, not ready' : 'Trading: not ready');

export interface ChainLite { id: string; family: string; capabilities?: CapMap }
/** Coverage of a strategy's allowed families: how many registry chains exist in those families and how many are trading-certified. */
export function chainCoverage(families: string[], chains: ChainLite[]) {
  const inFam = chains.filter((c) => families.includes(c.family));
  const hasCex = families.includes('cex');
  return { chains: inFam.length, tradingCertified: inFam.filter((c) => readiness(c.capabilities).trading === 'certified').length, researchReadable: inFam.filter((c) => readiness(c.capabilities).research === 'read_only_available').length, venues: hasCex };
}

export const ADAPTER_PACKAGE: Record<string, string> = { evm: 'packages/chain-evm', svm: 'packages/chain-solana', sui: 'packages/chain-sui', aptos: 'packages/chain-aptos', tron: 'packages/chain-tron', cosmos: 'packages/chain-cosmos', bitcoin: 'packages/chain-bitcoin', ton: 'packages/chain-ton', near: 'packages/chain-near' };

export type HealthStatus = 'NOT_MEASURED' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';
export const healthLabel = (s: HealthStatus) => ({ NOT_MEASURED: 'Not measured', HEALTHY: 'Healthy', DEGRADED: 'Degraded', UNHEALTHY: 'Unhealthy' }[s]);
export const healthTone = (s: HealthStatus) => ({ NOT_MEASURED: 'neutral', HEALTHY: 'good', DEGRADED: 'warn', UNHEALTHY: 'bad' } as const)[s];
