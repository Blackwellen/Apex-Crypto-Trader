/**
 * Guarded HTTP client for the Python researcher service.
 * SSRF posture: the base URL comes ONLY from the operator's environment (APEX_RESEARCHER_URL), is validated once at startup, and the
 * request path is chosen from a closed list. No user-supplied value ever reaches the URL, headers or redirect handling.
 * No credentials are forwarded (no Authorization/Cookie); redirects are refused; responses are size-capped.
 */
export const RESEARCHER_PATHS = ['/health', '/openapi.json', '/backtests', '/token-safety/evaluate'] as const;
export type ResearcherPath = (typeof RESEARCHER_PATHS)[number];

export class ResearcherError extends Error {
  constructor(public kind: 'unreachable' | 'timeout' | 'upstream_4xx' | 'upstream_5xx' | 'bad_response', message: string, public status?: number) { super(message); }
}

export function resolveResearcherBase(raw: string | undefined): URL {
  const u = new URL(raw && raw.trim() ? raw.trim() : 'http://127.0.0.1:8100');
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('APEX_RESEARCHER_URL must be http(s)');
  if (u.username || u.password) throw new Error('APEX_RESEARCHER_URL must not embed credentials');
  if (u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw new Error('APEX_RESEARCHER_URL must be a bare origin');
  return u;
}

const MAX_BYTES = 8 * 1024 * 1024;

export interface ResearcherClient {
  origin: string;
  call: (path: ResearcherPath, opts?: { method?: 'GET' | 'POST'; body?: unknown; query?: Record<string, string | number>; timeoutMs?: number }) => Promise<any>;
}

export function makeResearcherClient(base: URL): ResearcherClient {
  const origin = base.origin;
  return {
    origin,
    async call(path, opts = {}) {
      if (!(RESEARCHER_PATHS as readonly string[]).includes(path)) throw new Error('path not allowed');
      const url = new URL(path, origin);
      for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 5000);
      let res: Response;
      try {
        res = await fetch(url, { method: opts.method ?? 'GET', redirect: 'error', signal: ctl.signal,
          headers: opts.body !== undefined ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
      } catch (e) {
        clearTimeout(t);
        if ((e as Error).name === 'AbortError') throw new ResearcherError('timeout', 'researcher did not answer in time');
        throw new ResearcherError('unreachable', 'researcher service is not reachable');
      }
      try {
        const buf = await readCapped(res);
        let json: any; try { json = JSON.parse(buf); } catch { throw new ResearcherError('bad_response', 'researcher returned non-JSON', res.status); }
        if (res.status >= 500) throw new ResearcherError('upstream_5xx', `researcher error (HTTP ${res.status})`, res.status);
        if (res.status >= 400) throw new ResearcherError('upstream_4xx', summariseDetail(json) ?? `researcher rejected the request (HTTP ${res.status})`, res.status);
        return json;
      } catch (e) {
        if (e instanceof ResearcherError) throw e;
        if ((e as Error).name === 'AbortError') throw new ResearcherError('timeout', 'researcher did not answer in time');
        throw new ResearcherError('bad_response', 'researcher response could not be read');
      } finally { clearTimeout(t); }
    },
  };
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader(); if (!reader) return '';
  const chunks: Uint8Array[] = []; let n = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; if (n > MAX_BYTES) { await reader.cancel(); throw new ResearcherError('bad_response', 'researcher response too large'); } chunks.push(value); }
  return Buffer.concat(chunks).toString('utf8');
}
function summariseDetail(j: any): string | null {
  const d = j?.detail; if (d === undefined) return null;
  const s = typeof d === 'string' ? d : Array.isArray(d) ? d.map((x: any) => `${(x.loc ?? []).slice(1).join('.')}: ${x.msg}`).join('; ') : JSON.stringify(d);
  return s.replace(/\s+/g, ' ').slice(0, 300);
}
