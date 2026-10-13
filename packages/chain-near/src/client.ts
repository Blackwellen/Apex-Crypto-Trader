export interface HttpRequest { method: 'POST'; url: string; body: unknown }
export interface HttpResponse { status: number; json: unknown }
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;
export const fetchTransport: Transport = async (req) => {
  const r = await fetch(req.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req.body), signal: AbortSignal.timeout(20_000) });
  const t = await r.text(); let json: unknown = null; try { json = JSON.parse(t); } catch { /* null */ }
  return { status: r.status, json };
};
export class NearRpcError extends Error { constructor(m: string, public status?: number) { super(m); } }

/** READ-ONLY NEAR JSON-RPC client. */
export class NearRpcClient {
  private id = 0;
  constructor(private readonly url: string, private readonly transport: Transport = fetchTransport) {}
  private async rpc<T>(method: string, params: unknown): Promise<T> {
    const r = await this.transport({ method: 'POST', url: this.url, body: { jsonrpc: '2.0', id: String(++this.id), method, params } });
    const j = r.json as any;
    if (r.status < 200 || r.status >= 300) throw new NearRpcError(`HTTP ${r.status} ${method}`, r.status);
    if (j?.error) throw new NearRpcError(`${method}: ${j.error.name ?? ''} ${j.error.cause?.name ?? ''} ${j.error.data ?? j.error.message ?? ''}`.trim());
    return j.result as T;
  }
  async status(): Promise<{ chainId: string; latestHeight: bigint; latestHash: string; syncing: boolean; protocolVersion: number }> {
    const r = await this.rpc<any>('status', []);
    return { chainId: r.chain_id, latestHeight: BigInt(r.sync_info.latest_block_height), latestHash: r.sync_info.latest_block_hash, syncing: !!r.sync_info.syncing, protocolVersion: r.protocol_version };
  }
  async gasPriceYocto(blockId: string | null = null): Promise<bigint> { return BigInt((await this.rpc<any>('gas_price', [blockId])).gas_price); }
  async viewAccount(accountId: string, finality: 'optimistic' | 'near-final' | 'final' = 'final'): Promise<{ amount: bigint; locked: bigint; storageUsage: bigint; blockHeight: bigint } | null> {
    try {
      const r = await this.rpc<any>('query', { request_type: 'view_account', finality, account_id: accountId });
      return { amount: BigInt(r.amount), locked: BigInt(r.locked), storageUsage: BigInt(r.storage_usage), blockHeight: BigInt(r.block_height) };
    } catch (e) { if (e instanceof NearRpcError && /UNKNOWN_ACCOUNT|does not exist/i.test(e.message)) return null; throw e; }
  }
  async viewAccessKeyNonce(accountId: string, publicKey: string): Promise<bigint> {
    const r = await this.rpc<any>('query', { request_type: 'view_access_key', finality: 'optimistic', account_id: accountId, public_key: publicKey });
    return BigInt(r.nonce);
  }
  /** Protocol limits (transaction_validity_period, max_total_prepaid_gas, storage_amount_per_byte) come from here, never constants. */
  async protocolConfig(): Promise<{ transactionValidityPeriod: bigint; storageAmountPerByte: bigint; maxTotalPrepaidGas: bigint }> {
    const r = await this.rpc<any>('EXPERIMENTAL_protocol_config', { finality: 'final' });
    return { transactionValidityPeriod: BigInt(r.transaction_validity_period), storageAmountPerByte: BigInt(r.runtime_config.storage_amount_per_byte), maxTotalPrepaidGas: BigInt(r.runtime_config.wasm_config.limit_config.max_total_prepaid_gas) };
  }
}
