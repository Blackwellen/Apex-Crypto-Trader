export interface HttpRequest { method: 'GET'; url: string; headers?: Record<string, string> }
export interface HttpResponse { status: number; headers: Record<string, string>; json: unknown }
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;
export const fetchTransport: Transport = async (req) => {
  const r = await fetch(req.url, { method: req.method, headers: req.headers, signal: AbortSignal.timeout(20_000) });
  const t = await r.text(); let json: unknown = null; try { json = JSON.parse(t); } catch { json = { raw: t.slice(0, 200) }; }
  const headers: Record<string, string> = {}; r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  return { status: r.status, headers, json };
};
export class VenueHttpError extends Error { constructor(m: string, public status: number, public retryAfterSec?: number) { super(m); } }
