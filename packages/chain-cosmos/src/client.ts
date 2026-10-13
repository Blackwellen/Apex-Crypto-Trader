import type { ChannelInfo } from './ibc.ts';
import type { DenomTrace } from './denom.ts';
import type { GasPrice } from './fees.ts';

export interface HttpRequest { method: 'GET' | 'POST'; url: string; body?: unknown }
export interface HttpResponse { status: number; json: unknown }
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;
export const fetchTransport: Transport = async (req) => {
  const r = await fetch(req.url, { method: req.method, headers: { 'content-type': 'application/json' }, body: req.body === undefined ? undefined : JSON.stringify(req.body), signal: AbortSignal.timeout(20_000) });
  const t = await r.text();
  let json: unknown; try { json = JSON.parse(t); } catch { json = { raw: t.slice(0, 200) }; }
  return { status: r.status, json };
};
export class CosmosApiError extends Error { constructor(m: string, public status?: number) { super(m); } }

export interface NodeInfo { network: string; appName: string; appVersion: string }
export interface CoinBalance { denom: string; amount: bigint }

/** Cosmos SDK LCD (gRPC-gateway REST) client. All responses are untrusted node data. */
export class CosmosLcdClient {
  constructor(private readonly baseUrl: string, private readonly transport: Transport = fetchTransport) {}
  private async get(path: string): Promise<any> {
    const r = await this.transport({ method: 'GET', url: `${this.baseUrl.replace(/\/$/, '')}${path}` });
    if (r.status === 404) return null; // SDK returns 404/NotFound codes for missing accounts/traces
    if (r.status < 200 || r.status >= 300) throw new CosmosApiError(`HTTP ${r.status} ${path}`, r.status);
    return r.json;
  }
  async getNodeInfo(): Promise<NodeInfo> {
    const j = await this.get('/cosmos/base/tendermint/v1beta1/node_info');
    if (!j?.default_node_info?.network) throw new CosmosApiError('malformed node_info');
    return { network: j.default_node_info.network, appName: j.application_version?.app_name ?? '', appVersion: j.application_version?.version ?? '' };
  }
  async getLatestBlock(): Promise<{ height: bigint; time: string; chainId: string }> {
    const j = await this.get('/cosmos/base/tendermint/v1beta1/blocks/latest');
    const h = j?.block?.header; if (!h) throw new CosmosApiError('malformed latest block');
    return { height: BigInt(h.height), time: h.time, chainId: h.chain_id };
  }
  async getBalances(address: string): Promise<CoinBalance[]> {
    const j = await this.get(`/cosmos/bank/v1beta1/balances/${encodeURIComponent(address)}?pagination.limit=1000`);
    return (j?.balances ?? []).map((b: any) => ({ denom: String(b.denom), amount: BigInt(b.amount) }));
  }
  /** Returns null for an address with no on-chain account yet (valid for receive-only addresses). */
  async getAccountSequence(address: string): Promise<{ accountNumber: bigint; sequence: bigint } | null> {
    const j = await this.get(`/cosmos/auth/v1beta1/accounts/${encodeURIComponent(address)}`);
    if (!j?.account) return null;
    const a = j.account.base_account ?? j.account; // vesting/module wrap base_account
    if (a.sequence === undefined) throw new CosmosApiError('account type without sequence');
    return { accountNumber: BigInt(a.account_number ?? 0), sequence: BigInt(a.sequence) };
  }
  async getDenomTrace(hashHex: string): Promise<DenomTrace | null> {
    if (!/^[0-9A-F]{64}$/.test(hashHex)) throw new CosmosApiError('hash must be 64 uppercase hex');
    const j = await this.get(`/ibc/apps/transfer/v1/denom_traces/${hashHex}`);
    return j?.denom_trace ? { path: j.denom_trace.path, base_denom: j.denom_trace.base_denom } : null;
  }
  async getChannel(channelId: string, portId = 'transfer'): Promise<ChannelInfo | null> {
    if (!/^channel-\d+$/.test(channelId)) throw new CosmosApiError('bad channel id');
    const j = await this.get(`/ibc/core/channel/v1/channels/${channelId}/ports/${portId}`);
    return j?.channel ? { ...j.channel, port_id: portId, channel_id: channelId } : null;
  }
  /** True if the packet receipt exists on THIS (destination) chain, i.e. the packet was received. */
  async packetReceived(channelId: string, port: string, sequence: bigint): Promise<boolean | null> {
    const j = await this.get(`/ibc/core/channel/v1/channels/${channelId}/ports/${port}/packet_receipts/${sequence}`);
    return j ? Boolean(j.received) : null;
  }
  /** Is the commitment still present on the SOURCE chain? Absent => acknowledged or timed out (look at tx events to know which). */
  async packetCommitmentExists(channelId: string, port: string, sequence: bigint): Promise<boolean> {
    const j = await this.get(`/ibc/core/channel/v1/channels/${channelId}/ports/${port}/packet_commitments/${sequence}`);
    return !!j?.commitment;
  }
  async getTx(hash: string): Promise<{ height: bigint; code: number; rawLog: string } | null> {
    if (!/^[0-9A-Fa-f]{64}$/.test(hash)) throw new CosmosApiError('bad tx hash');
    const j = await this.get(`/cosmos/tx/v1beta1/txs/${hash}`);
    return j?.tx_response ? { height: BigInt(j.tx_response.height), code: Number(j.tx_response.code ?? 0), rawLog: String(j.tx_response.raw_log ?? '') } : null;
  }
  /** Node-local minimum gas prices, e.g. "0.0025uatom". Informational: the node you broadcast to decides. */
  async getMinGasPrices(): Promise<GasPrice[]> {
    const j = await this.get('/cosmos/base/node/v1beta1/config');
    const s: string = j?.minimum_gas_price ?? '';
    return s.split(',').filter(Boolean).map((x) => { const m = /^(\d+(?:\.\d+)?)([a-zA-Z][a-zA-Z0-9/:._-]*)$/.exec(x.trim()); if (!m) throw new CosmosApiError(`bad gas price '${x}'`); return { amount: m[1]!, denom: m[2]! }; });
  }
  async getMaxMemoChars(): Promise<number> {
    const j = await this.get('/cosmos/auth/v1beta1/params');
    return Number(j?.params?.max_memo_characters ?? 0);
  }
}
export function validateMemo(memo: string, maxChars: number): { ok: boolean; reason?: string } {
  if (maxChars <= 0) return { ok: false, reason: 'max memo length unknown: query auth params first' };
  return [...memo].length <= maxChars ? { ok: true } : { ok: false, reason: `memo exceeds ${maxChars} chars` };
}
