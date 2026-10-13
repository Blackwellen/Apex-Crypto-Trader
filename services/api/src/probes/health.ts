/** Pure chain-health derivation from recorded RPC probe samples. No I/O. A chain with no fresh sample is NOT_MEASURED, never healthy. */
export type HealthStatus = 'NOT_MEASURED' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';
export interface Sample {
  endpoint: string; observed_at: Date | string; ok: boolean; latency_ms: number | null;
  chain_id_match: boolean | null; block_height?: string | null; block_time?: Date | string | null; error?: string | null; reported_chain_id?: string | null;
}
export interface EndpointHealth { endpoint: string; status: HealthStatus; reason: string; latencyMs: number | null; blockAgeMs: number | null; blockHeight: string | null; observedAt: string; chainIdMatch: boolean | null }
export interface ChainHealth { status: HealthStatus; reason: string; rpcLatencyMs: number | null; blockAgeMs: number | null; measuredAt: string | null; endpoints: EndpointHealth[]; note: string }

export interface HealthOpts { now?: Date; freshMs?: number; maxBlockAgeMs?: number }
export const DEFAULT_FRESH_MS = 10 * 60_000;
/** per-family tolerance for block age at observation time (conservative; unknown family => 5 min) */
export const MAX_BLOCK_AGE_MS: Record<string, number> = { evm: 3 * 60_000, svm: 60_000 };

const ms = (d: Date | string) => (d instanceof Date ? d : new Date(d)).getTime();

export function endpointHealth(s: Sample, maxBlockAgeMs: number): EndpointHealth {
  const observed = ms(s.observed_at);
  const blockAgeMs = s.block_time ? Math.max(0, observed - ms(s.block_time)) : null;
  const base = { endpoint: s.endpoint, latencyMs: s.latency_ms, blockAgeMs, blockHeight: s.block_height ?? null, observedAt: new Date(observed).toISOString(), chainIdMatch: s.chain_id_match };
  if (s.chain_id_match === false) return { ...base, status: 'UNHEALTHY', reason: `chain id mismatch (reported ${s.reported_chain_id ?? 'unknown'}); endpoint must not be used` };
  if (!s.ok) return { ...base, status: 'UNHEALTHY', reason: s.error ? `probe failed: ${s.error}` : 'probe failed' };
  if (s.chain_id_match === null) return { ...base, status: 'DEGRADED', reason: 'reachable, but chain identity could not be verified' };
  if (blockAgeMs === null) return { ...base, status: 'DEGRADED', reason: 'reachable and identity verified, but block freshness is unknown' };
  if (blockAgeMs > maxBlockAgeMs) return { ...base, status: 'DEGRADED', reason: `latest block is ${Math.round(blockAgeMs / 1000)}s old (limit ${Math.round(maxBlockAgeMs / 1000)}s)` };
  return { ...base, status: 'HEALTHY', reason: 'chain id verified, fresh block' };
}

/** `samples` = the LATEST sample per endpoint. */
export function deriveHealth(samples: Sample[], opts: HealthOpts = {}): ChainHealth {
  const now = (opts.now ?? new Date()).getTime(); const fresh = opts.freshMs ?? DEFAULT_FRESH_MS; const maxAge = opts.maxBlockAgeMs ?? 5 * 60_000;
  const note = 'Derived only from recorded RPC probe samples; absence of samples is NOT_MEASURED, never healthy.';
  const usable = samples.filter((s) => now - ms(s.observed_at) <= fresh);
  if (samples.length === 0) return { status: 'NOT_MEASURED', reason: 'no probe samples recorded (probing is off, or this chain has never been probed)', rpcLatencyMs: null, blockAgeMs: null, measuredAt: null, endpoints: [], note };
  if (usable.length === 0) {
    const last = new Date(Math.max(...samples.map((s) => ms(s.observed_at)))).toISOString();
    return { status: 'NOT_MEASURED', reason: `latest probe sample is stale (${last}); the probe may have stopped`, rpcLatencyMs: null, blockAgeMs: null, measuredAt: last, endpoints: [], note };
  }
  const eps = usable.map((s) => endpointHealth(s, maxAge));
  const healthy = eps.filter((e) => e.status === 'HEALTHY');
  const mismatched = eps.filter((e) => e.chainIdMatch === false);
  const measuredAt = new Date(Math.max(...usable.map((s) => ms(s.observed_at)))).toISOString();
  const lat = healthy.map((e) => e.latencyMs).filter((x): x is number => x !== null);
  const ages = healthy.map((e) => e.blockAgeMs).filter((x): x is number => x !== null);
  const rpcLatencyMs = lat.length ? Math.min(...lat) : null; const blockAgeMs = ages.length ? Math.min(...ages) : null;
  let status: HealthStatus; let reason: string;
  if (healthy.length === 0) {
    const degraded = eps.some((e) => e.status === 'DEGRADED');
    status = degraded && mismatched.length === 0 ? 'DEGRADED' : 'UNHEALTHY';
    reason = mismatched.length ? `chain id mismatch on ${mismatched.length} endpoint(s); no verified healthy endpoint` : degraded ? 'no fully verified endpoint (see endpoints)' : 'no healthy endpoint';
  } else if (healthy.length < eps.length) {
    status = 'DEGRADED';
    reason = `${healthy.length} of ${eps.length} endpoint(s) healthy${mismatched.length ? `; ${mismatched.length} with chain id mismatch` : ''}`;
  } else { status = 'HEALTHY'; reason = `${healthy.length} of ${eps.length} endpoint(s) healthy, chain id verified`; }
  return { status, reason, rpcLatencyMs, blockAgeMs, measuredAt, endpoints: eps, note };
}

/** Extract RPC candidates from a registry `details` blob. Returns raw URLs (server-side use only) — never send these to clients. */
export function rpcCandidates(details: unknown): string[] {
  const d = (details ?? {}) as Record<string, unknown>;
  const raw = d.rpcCandidates ?? d.rpc_candidates ?? d.rpc ?? d.rpcUrls ?? [];
  const arr = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const x of arr) {
    const u = typeof x === 'string' ? x : (x as { url?: unknown })?.url;
    if (typeof u === 'string' && /^https?:\/\//i.test(u) && !out.includes(u)) out.push(u);
  }
  return out;
}
/** Origin only (scheme://host[:port]). RPC URLs frequently embed API keys in path/query/userinfo, so those are dropped. */
export function sanitizeEndpoint(url: string): string | null {
  try { const u = new URL(url); if (u.protocol !== 'http:' && u.protocol !== 'https:') return null; return `${u.protocol}//${u.host}`; } catch { return null; }
}
