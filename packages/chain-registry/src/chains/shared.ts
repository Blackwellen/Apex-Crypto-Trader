import { emptyCapabilities } from '@apex/contracts';
import type { CapabilityMap, VerifiedChainRecord } from '@apex/contracts';

export const CHAINLIST = 'https://chainid.network/chains.json';

/** Baseline capabilities: everything PENDING except capabilities that are structurally impossible on the family. Never CERTIFIED here. */
export function baseCapabilities(unsupported: Partial<Record<keyof CapabilityMap, string>> = {}): CapabilityMap {
  const m = emptyCapabilities('PENDING');
  for (const [k, note] of Object.entries(unsupported)) m[k as keyof CapabilityMap] = { status: 'UNSUPPORTED', note };
  return m;
}

export interface BaseSeed {
  id: string; namespace: string; chainRef: string; name: string; isTestnet: boolean; nativeSymbol: string; nativeDecimals: number;
  finalityModel: string; addressFormat: string; explorerUrl: string; rpcCandidates: string[];
  verifiedFrom: string[]; unverifiedFields: string[]; meta: Record<string, unknown>;
}

export function record(family: VerifiedChainRecord['family'], s: BaseSeed, unsupported: Parameters<typeof baseCapabilities>[0]): VerifiedChainRecord {
  return {
    id: s.id, namespace: s.namespace, chainRef: s.chainRef, family, name: s.name, isTestnet: s.isTestnet, nativeSymbol: s.nativeSymbol, nativeDecimals: s.nativeDecimals,
    finalityModel: s.finalityModel, addressFormat: s.addressFormat, explorerUrl: s.explorerUrl, rpcCandidates: s.rpcCandidates, enabled: false,
    capabilities: baseCapabilities(unsupported), verifiedFrom: s.verifiedFrom, unverified: s.unverifiedFields.length > 0, unverifiedFields: s.unverifiedFields, meta: s.meta,
  };
}
