import { validateTronAddress } from './address.ts';
import { parseChainParameters, type GetChainParametersResponse, type TronChainParams } from './fees.ts';

export interface HttpRequest { method: 'GET' | 'POST'; url: string; headers?: Record<string, string>; body?: unknown }
export interface HttpResponse { status: number; json: unknown }
/** Injectable transport; production code can wrap fetch, tests inject fixtures. */
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

export const fetchTransport: Transport = async (req) => {
  const r = await fetch(req.url, {
    method: req.method,
    headers: { 'content-type': 'application/json', ...(req.headers ?? {}) },
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: r.status, json };
};

export class TronApiError extends Error {}

export interface NowBlock { blockID: string; number: bigint; timestampMs: bigint }
export interface TronAccount { address: string; balanceSun: bigint; exists: boolean }
export interface TronAccountResources { freeNetLimit: bigint; freeNetUsed: bigint; netLimit: bigint; netUsed: bigint; energyLimit: bigint; energyUsed: bigint }

export class TronClient {
  constructor(private readonly baseUrl: string, private readonly transport: Transport = fetchTransport) {}
  private async call(path: string, body?: unknown): Promise<any> {
    const r = await this.transport({ method: body === undefined ? 'GET' : 'POST', url: `${this.baseUrl.replace(/\/$/, '')}${path}`, body });
    if (r.status < 200 || r.status >= 300) throw new TronApiError(`HTTP ${r.status} from ${path}`);
    const j = r.json as any;
    if (j && typeof j === 'object' && 'Error' in j) throw new TronApiError(`API error from ${path}: ${String(j.Error)}`);
    return j;
  }
  async getNowBlock(): Promise<NowBlock> {
    const j = await this.call('/wallet/getnowblock');
    const raw = j?.block_header?.raw_data;
    if (!j?.blockID || raw?.number === undefined) throw new TronApiError('malformed getnowblock');
    return { blockID: j.blockID, number: BigInt(raw.number), timestampMs: BigInt(raw.timestamp ?? 0) };
  }
  async getChainParameters(): Promise<TronChainParams> {
    return parseChainParameters((await this.call('/wallet/getchainparameters')) as GetChainParametersResponse);
  }
  async getAccount(address: string): Promise<TronAccount> {
    const v = validateTronAddress(address);
    if (!v.valid || !v.normalized) throw new TronApiError(`invalid address: ${v.reason}`);
    const j = await this.call('/wallet/getaccount', { address: v.normalized, visible: true });
    // an inactive account returns {} - NOT an error; it simply does not exist on chain yet
    if (!j || Object.keys(j).length === 0) return { address: v.normalized, balanceSun: 0n, exists: false };
    return { address: v.normalized, balanceSun: BigInt(j.balance ?? 0), exists: true };
  }
  async getAccountResources(address: string): Promise<TronAccountResources> {
    const v = validateTronAddress(address);
    if (!v.valid || !v.normalized) throw new TronApiError(`invalid address: ${v.reason}`);
    const j = await this.call('/wallet/getaccountresource', { address: v.normalized, visible: true });
    const g = (k: string): bigint => BigInt(j?.[k] ?? 0);
    return { freeNetLimit: g('freeNetLimit'), freeNetUsed: g('freeNetUsed'), netLimit: g('NetLimit'), netUsed: g('NetUsed'), energyLimit: g('EnergyLimit'), energyUsed: g('EnergyUsed') };
  }
  /** Returns null when the tx is unknown to this node (could be pending/unknown - never infer failure). */
  async getTransactionInfo(txId: string): Promise<{ blockNumber: bigint; result: string; energyUsage: bigint; netUsage: bigint; feeSun: bigint } | null> {
    if (!/^[0-9a-fA-F]{64}$/.test(txId)) throw new TronApiError('txId must be 64 hex chars');
    const j = await this.call('/wallet/gettransactioninfobyid', { value: txId });
    if (!j || Object.keys(j).length === 0) return null;
    return {
      blockNumber: BigInt(j.blockNumber ?? 0), result: String(j.result ?? 'SUCCESS'),
      energyUsage: BigInt(j.receipt?.energy_usage_total ?? 0), netUsage: BigInt(j.receipt?.net_usage ?? 0), feeSun: BigInt(j.fee ?? 0),
    };
  }
  /** Solidity node (on the same host, /walletsolidity) reports the latest solidified (final) block. */
  async getSolidifiedBlockNumber(): Promise<bigint> {
    const j = await this.call('/walletsolidity/getnowblock');
    if (j?.block_header?.raw_data?.number === undefined) throw new TronApiError('malformed solidity getnowblock');
    return BigInt(j.block_header.raw_data.number);
  }
}
