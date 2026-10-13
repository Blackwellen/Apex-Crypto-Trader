export interface HttpRequest { method: 'GET'; url: string }
export interface HttpResponse { status: number; json: unknown }
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;
export const fetchTransport: Transport = async (req) => {
  const r = await fetch(req.url, { signal: AbortSignal.timeout(20_000) });
  const t = await r.text(); let json: unknown = null; try { json = JSON.parse(t); } catch { /* keep null */ }
  return { status: r.status, json };
};
export class TonApiError extends Error { constructor(m: string, public status?: number) { super(m); } }

/** READ-ONLY toncenter v2 client (third-party indexer API; rate-limited without API key). */
export class ToncenterClient {
  constructor(private readonly base: string, private readonly transport: Transport = fetchTransport) {}
  private async call<T>(method: string, qs: Record<string, string> = {}): Promise<T> {
    const q = new URLSearchParams(qs).toString();
    const r = await this.transport({ method: 'GET', url: `${this.base.replace(/\/$/, '')}/api/v2/${method}${q ? `?${q}` : ''}` });
    const j = r.json as any;
    if (r.status < 200 || r.status >= 300 || !j?.ok) throw new TonApiError(`toncenter ${method} failed: HTTP ${r.status} ${j?.error ?? ''}`, r.status);
    return j.result as T;
  }
  async getMasterchainInfo(): Promise<{ seqno: number; zeroStateRootHash: string }> {
    const r = await this.call<any>('getMasterchainInfo');
    return { seqno: Number(r.last.seqno), zeroStateRootHash: r.init.root_hash };
  }
  async getBalance(addr: string): Promise<bigint> { return BigInt(await this.call<string>('getAddressBalance', { address: addr })); }
  /** seqno is null for non-wallet / uninitialised accounts: an unknown seqno must BLOCK sending, not default to 0. */
  async getWalletInfo(addr: string): Promise<{ balance: bigint; seqno: number | null; state: string; isWallet: boolean }> {
    const r = await this.call<any>('getWalletInformation', { address: addr });
    return { balance: BigInt(r.balance), seqno: typeof r.seqno === 'number' ? r.seqno : null, state: String(r.account_state), isWallet: !!r.wallet };
  }
  async getConfigParam(id: number): Promise<string> { return (await this.call<any>('getConfigParam', { config_id: String(id) })).config.bytes; }
}
