/** Bucket policy helpers: known limit keys, JSON validation, and a line diff between two policy objects. */
export interface LimitDef { key: string; label: string; hint: string; unit: 'bps' | 'count' | 'seconds' }
export const LIMITS: LimitDef[] = [
  { key: 'max_slippage_bps', label: 'Max slippage', hint: 'Basis points. Cannot exceed the workspace hard limit (enforced by the database).', unit: 'bps' },
  { key: 'max_order_notional_bps_of_bucket', label: 'Max order size (share of bucket)', hint: 'Basis points of bucket value per order. Cannot exceed the workspace hard limit.', unit: 'bps' },
  { key: 'max_drawdown_bps', label: 'Max drawdown', hint: 'Basis points. Enforced by the risk engine when it consumes the policy.', unit: 'bps' },
  { key: 'max_open_orders', label: 'Max open orders', hint: 'Whole number.', unit: 'count' },
  { key: 'max_active_trades', label: 'Max active trades', hint: 'Whole number.', unit: 'count' },
  { key: 'fee_reserve_bps', label: 'Fee / gas reserve', hint: 'Basis points of bucket kept back from trading.', unit: 'bps' },
  { key: 'per_asset_limit_bps', label: 'Per-asset concentration', hint: 'Basis points of bucket in any one asset.', unit: 'bps' },
];
export function buildPolicy(fields: Record<string, string>, extraJson: string): { policy: Record<string, unknown>; errors: string[] } {
  const errors: string[] = []; const policy: Record<string, unknown> = {};
  if (extraJson.trim()) {
    try { const j = JSON.parse(extraJson); if (!j || typeof j !== 'object' || Array.isArray(j)) errors.push('Advanced JSON must be an object'); else Object.assign(policy, j); }
    catch { errors.push('Advanced JSON is not valid JSON'); }
  }
  for (const d of LIMITS) {
    const v = (fields[d.key] ?? '').trim(); if (!v) { delete policy[d.key]; continue; }
    if (!/^\d{1,9}$/.test(v)) { errors.push(`${d.label}: whole number required`); continue; }
    const n = Number(v); if (d.unit === 'bps' && n > 10000) { errors.push(`${d.label}: at most 10000 bps`); continue; }
    policy[d.key] = n;
  }
  return { policy, errors };
}
export function policyToFields(policy: Record<string, unknown>): { fields: Record<string, string>; extra: string } {
  const fields: Record<string, string> = {}; const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(policy ?? {})) { if (LIMITS.some((l) => l.key === k) && typeof v === 'number') fields[k] = String(v); else rest[k] = v; }
  return { fields, extra: Object.keys(rest).length ? JSON.stringify(rest, null, 2) : '' };
}
export type DiffLine = { key: string; kind: 'added' | 'removed' | 'changed' | 'same'; before?: string; after?: string };
export function diffPolicy(before: Record<string, unknown>, after: Record<string, unknown>): DiffLine[] {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
  return keys.map((key) => {
    const b = key in (before ?? {}) ? JSON.stringify(before[key]) : undefined, a = key in (after ?? {}) ? JSON.stringify(after[key]) : undefined;
    return b === undefined ? { key, kind: 'added', after: a } : a === undefined ? { key, kind: 'removed', before: b } : b === a ? { key, kind: 'same', before: b, after: a } : { key, kind: 'changed', before: b, after: a };
  });
}
