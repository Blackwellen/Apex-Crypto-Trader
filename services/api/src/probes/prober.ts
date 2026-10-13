import type pg from 'pg';
import { rpcCandidates, sanitizeEndpoint } from './health.ts';

/**
 * Read-only chain prober. Uses plain JSON-RPC reads only (eth_chainId, eth_getBlockByNumber / getHealth, getSlot, getBlockTime, getGenesisHash).
 * No signing, no state-changing methods, no keys. Results go to rpc_health_samples through record_rpc_health_sample (service role only).
 * Off unless APEX_PROBES=1. If the network is unreachable the samples are failures (UNHEALTHY) or absent (NOT_MEASURED) -- never green.
 */
export interface ProbeResult { ok: boolean; latencyMs: number | null; reportedChainId: string | null; chainIdMatch: boolean | null; blockHeight: bigint | null; blockTime: Date | null; error: string | null }
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
export interface ProbeOpts { fetchImpl?: FetchLike; timeoutMs?: number }

const MAX_BODY = 256 * 1024;
export async function rpc(url: string, method: string, params: unknown[], o: ProbeOpts = {}): Promise<unknown> {
  const f: FetchLike = o.fetchImpl ?? ((u, i) => fetch(u, i));
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), o.timeoutMs ?? 5000);
  try {
    const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const txt = await r.text(); if (txt.length > MAX_BODY) throw new Error('response too large');
    const j = JSON.parse(txt) as { result?: unknown; error?: { message?: string } };
    if (j.error) throw new Error(`rpc error: ${String(j.error.message ?? 'unknown').slice(0, 120)}`);
    if (!('result' in j)) throw new Error('malformed JSON-RPC response');
    return j.result;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`timeout after ${o.timeoutMs ?? 5000}ms`);
    throw e;
  } finally { clearTimeout(t); }
}
const fail = (error: string, latencyMs: number | null = null, extra: Partial<ProbeResult> = {}): ProbeResult => ({ ok: false, latencyMs, reportedChainId: null, chainIdMatch: null, blockHeight: null, blockTime: null, error: error.slice(0, 300), ...extra });
const hexToBig = (h: unknown): bigint => { if (typeof h !== 'string' || !/^0x[0-9a-fA-F]+$/.test(h)) throw new Error('bad hex quantity'); return BigInt(h); };

/** expectedChainRef = decimal chain id from the registry (eip155 reference). Mismatch => ok=false, chainIdMatch=false. */
export async function probeEvm(url: string, expectedChainRef: string, o: ProbeOpts = {}): Promise<ProbeResult> {
  const t0 = Date.now(); let latency: number | null = null;
  try {
    const cid = hexToBig(await rpc(url, 'eth_chainId', [], o)); latency = Date.now() - t0;
    const match = /^\d+$/.test(expectedChainRef) && cid === BigInt(expectedChainRef);
    if (!match) return fail(`chain id mismatch: expected ${expectedChainRef}, endpoint reports ${cid}`, latency, { reportedChainId: cid.toString(), chainIdMatch: false });
    const blk = (await rpc(url, 'eth_getBlockByNumber', ['latest', false], o)) as { number?: unknown; timestamp?: unknown } | null;
    if (!blk) return fail('endpoint returned no latest block', latency, { reportedChainId: cid.toString(), chainIdMatch: true });
    return { ok: true, latencyMs: latency, reportedChainId: cid.toString(), chainIdMatch: true, blockHeight: hexToBig(blk.number), blockTime: new Date(Number(hexToBig(blk.timestamp)) * 1000), error: null };
  } catch (e) { return fail((e as Error).message, latency); }
}

/** Solana: getHealth + getSlot (+ getBlockTime). Identity is verified only when the registry supplies details.genesisHash; otherwise chainIdMatch=null (never "healthy"). */
export async function probeSvm(url: string, expectedGenesis: string | null, o: ProbeOpts = {}): Promise<ProbeResult> {
  const t0 = Date.now(); let latency: number | null = null;
  try {
    const h = await rpc(url, 'getHealth', [], o); latency = Date.now() - t0;
    if (h !== 'ok') return fail(`getHealth returned ${JSON.stringify(h).slice(0, 60)}`, latency);
    let match: boolean | null = null; let reported: string | null = null;
    if (expectedGenesis) { reported = String(await rpc(url, 'getGenesisHash', [], o)); match = reported === expectedGenesis; if (!match) return fail(`genesis hash mismatch: expected ${expectedGenesis}, endpoint reports ${reported}`, latency, { reportedChainId: reported, chainIdMatch: false }); }
    const slot = BigInt(String(await rpc(url, 'getSlot', [{ commitment: 'confirmed' }], o)));
    let bt: Date | null = null;
    try { const secs = await rpc(url, 'getBlockTime', [Number(slot)], o); if (typeof secs === 'number') bt = new Date(secs * 1000); } catch { /* freshness unknown */ }
    return { ok: true, latencyMs: latency, reportedChainId: reported, chainIdMatch: match, blockHeight: slot, blockTime: bt, error: null };
  } catch (e) { return fail((e as Error).message, latency); }
}

export async function probeChain(chain: { family: string; chain_ref: string; details: unknown }, url: string, o: ProbeOpts = {}): Promise<ProbeResult | null> {
  if (chain.family === 'evm') return probeEvm(url, chain.chain_ref, o);
  if (chain.family === 'svm') { const g = (chain.details as { genesisHash?: unknown } | null)?.genesisHash; return probeSvm(url, typeof g === 'string' ? g : null, o); }
  return null;   // no prober for this family yet: stays NOT_MEASURED (documented limitation)
}

export interface CycleResult { probed: number; failed: number; skipped: { chain: string; reason: string }[] }
/** One pass over monitored chains (registry.enabled OR enabled by any workspace policy). `svc` must connect with rights to `set role service_role`. */
export async function runProbeCycle(svc: pg.Pool, o: ProbeOpts & { maxEndpointsPerChain?: number } = {}): Promise<CycleResult> {
  const { rows } = await svc.query(`select r.id, r.family, r.chain_ref, r.details from chain_registry r
      where r.enabled or exists (select 1 from workspace_chain_policy p where p.chain_id = r.id and p.enabled)`);
  const res: CycleResult = { probed: 0, failed: 0, skipped: [] };
  await Promise.all(rows.map(async (c: { id: string; family: string; chain_ref: string; details: unknown }) => {
    const urls = rpcCandidates(c.details).slice(0, o.maxEndpointsPerChain ?? 4);
    if (urls.length === 0) { res.skipped.push({ chain: c.id, reason: 'no RPC candidates in registry' }); return; }
    for (const url of urls) {
      const endpoint = sanitizeEndpoint(url); if (!endpoint) continue;
      const r = await probeChain(c, url, o);
      if (!r) { res.skipped.push({ chain: c.id, reason: `no prober for family ${c.family}` }); return; }
      const cl = await svc.connect();
      try {
        await cl.query('begin'); await cl.query('set local role service_role');
        await cl.query(`select record_rpc_health_sample($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [c.id, endpoint, r.ok, r.latencyMs, r.reportedChainId, r.chainIdMatch, r.blockHeight?.toString() ?? null, r.blockTime, r.error]);
        await cl.query('commit');
      } catch (e) { await cl.query('rollback').catch(() => undefined); throw e; } finally { cl.release(); }
      res.probed++; if (!r.ok) res.failed++;
    }
  }));
  return res;
}

/** Starts the interval loop when APEX_PROBES=1 and a service connection URL is configured. Returns a stop function (or null when off). */
export function startProbes(env: NodeJS.ProcessEnv, mkPool: (url: string) => pg.Pool, log: (m: string) => void = console.log): (() => Promise<void>) | null {
  if (env.APEX_PROBES !== '1') return null;
  const url = env.APEX_PROBES_DATABASE_URL;
  if (!url) { log('APEX_PROBES=1 but APEX_PROBES_DATABASE_URL is not set: probes NOT started (chain health stays NOT_MEASURED)'); return null; }
  const interval = Math.max(15_000, Number(env.APEX_PROBE_INTERVAL_MS ?? 120_000)); const svc = mkPool(url);
  let stopped = false; let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try { const r = await runProbeCycle(svc); log(`apex probes: ${r.probed} endpoint(s) probed, ${r.failed} failed, ${r.skipped.length} skipped`); } catch (e) { log(`apex probes: cycle error ${(e as Error).message}`); }
    if (!stopped) timer = setTimeout(tick, interval);
  };
  timer = setTimeout(tick, 1000);
  return async () => { stopped = true; if (timer) clearTimeout(timer); await svc.end().catch(() => undefined); };
}
