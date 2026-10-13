import type { RecommendedFees } from './fees.ts';

export interface HttpRequest { method: 'GET'; url: string }
export interface HttpResponse { status: number; json: unknown; text?: string }
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;
export const fetchTransport: Transport = async (req) => {
  const r = await fetch(req.url, { signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  let json: unknown = null; try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, json, text };
};
export class BitcoinApiError extends Error { constructor(m: string, public status?: number) { super(m); } }

/** mempool.space / Esplora-compatible REST. Third-party data: untrusted, cross-check before value-bearing decisions. */
export class EsploraClient {
  constructor(private readonly base: string, private readonly transport: Transport = fetchTransport) {}
  private async get(path: string): Promise<HttpResponse> {
    const r = await this.transport({ method: 'GET', url: `${this.base.replace(/\/$/, '')}${path}` });
    if (r.status < 200 || r.status >= 300) throw new BitcoinApiError(`HTTP ${r.status} ${path}`, r.status);
    return r;
  }
  async getTipHeight(): Promise<number> {
    const r = await this.get('/api/blocks/tip/height');
    const n = Number((r.text ?? String(r.json)).trim());
    if (!Number.isInteger(n) || n < 0) throw new BitcoinApiError('malformed tip height');
    return n;
  }
  async getBlockHashAtHeight(h: number): Promise<string> {
    const r = await this.get(`/api/block-height/${h}`);
    const t = (r.text ?? '').trim();
    if (!/^[0-9a-f]{64}$/.test(t)) throw new BitcoinApiError('malformed block hash');
    return t;
  }
  async getRecommendedFees(): Promise<RecommendedFees> {
    const j = (await this.get('/api/v1/fees/recommended')).json as any;
    for (const k of ['fastestFee', 'halfHourFee', 'hourFee', 'economyFee', 'minimumFee']) if (typeof j?.[k] !== 'number') throw new BitcoinApiError(`fee response missing ${k}`);
    return j as RecommendedFees;
  }
  async getAddressBalance(addr: string): Promise<{ confirmedSat: bigint; unconfirmedDeltaSat: bigint }> {
    const j = (await this.get(`/api/address/${encodeURIComponent(addr)}`)).json as any;
    if (!j?.chain_stats) throw new BitcoinApiError('malformed address stats');
    const net = (s: any): bigint => BigInt(s.funded_txo_sum) - BigInt(s.spent_txo_sum);
    return { confirmedSat: net(j.chain_stats), unconfirmedDeltaSat: net(j.mempool_stats ?? { funded_txo_sum: 0, spent_txo_sum: 0 }) };
  }
  async getAddressUtxos(addr: string): Promise<{ txid: string; vout: number; valueSat: bigint; confirmed: boolean; blockHeight?: number }[]> {
    const j = (await this.get(`/api/address/${encodeURIComponent(addr)}/utxo`)).json as any[];
    if (!Array.isArray(j)) throw new BitcoinApiError('malformed utxo list');
    return j.map((u) => ({ txid: u.txid, vout: u.vout, valueSat: BigInt(u.value), confirmed: !!u.status?.confirmed, blockHeight: u.status?.block_height }));
  }
  /** null => node does not know the tx (NOT proof it failed) */
  async getTxStatus(txid: string): Promise<{ confirmed: boolean; blockHeight?: number; blockHash?: string } | null> {
    if (!/^[0-9a-f]{64}$/.test(txid)) throw new BitcoinApiError('bad txid');
    try {
      const j = (await this.get(`/api/tx/${txid}/status`)).json as any;
      return { confirmed: !!j.confirmed, blockHeight: j.block_height, blockHash: j.block_hash };
    } catch (e) { if (e instanceof BitcoinApiError && e.status === 404) return null; throw e; }
  }
}
