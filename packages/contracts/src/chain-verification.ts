// Additive helper (families B): build a CapabilityMap with explicit overrides. Never produces CERTIFIED.
import type { CapabilityMap, Capability } from './chain.ts';
import { emptyCapabilities } from './chain.ts';

export type FamilyBCapOverride = { status: 'READ_ONLY' | 'UNSUPPORTED' | 'PENDING'; evidenceRef?: string; note?: string };
export function capabilityMapWith(overrides: Partial<Record<Capability, FamilyBCapOverride>>): CapabilityMap {
  const m = emptyCapabilities('PENDING');
  for (const [k, v] of Object.entries(overrides)) if (v) m[k as Capability] = { ...v };
  return m;
}
