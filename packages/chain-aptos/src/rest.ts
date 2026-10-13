// Aptos REST (fullnode /v1) client with injectable transport. The transport returns the RAW body text so u64 values and bare-integer
// responses (e.g. /balance) are parsed without float precision loss.
import { validateAptosAddress, APT_COIN_TYPE } from './address.ts';

export interface RestRequest { method: 'GET' | 'POST'; path: string; headers?: Record<string, string>; body?: Uint8Array | string }
export interface RestResponse { status: number; body: string }
export type RestTransport = (req: RestRequest) => Promise<RestResponse>;

export class AptosRestError extends Error {
  status: number; errorCode?: string;
  constructor(path: string, status: number, message: string, errorCode?: string) { super(`${path}: HTTP ${status} ${message}`); this.name = 'AptosRestError'; this.status = status; if (errorCode) this.errorCode = errorCode; }
}
export class AptosChainIdMismatchError extends Error {
  expected: number; actual: number;
  constructor(expected: number, actual: number) { super(`node chain_id ${actual} != expected ${expected}; refusing to use this node`); this.name = 'AptosChainIdMismatchError'; this.expected = expected; this.actual = actual; }
}
/** Aptos chain ids (Aptos docs): 1 = mainnet, 2 = testnet. Observed live too. */
export const APTOS_CHAIN_IDS = { 'aptos:mainnet': 1, 'aptos:testnet': 2 } as const;

export function httpTransport(baseUrl: string, opts: { fetch?: typeof fetch; timeoutMs?: number; headers?: Record<string, string> } = {}): RestTransport {
  const f = opts.fetch ?? fetch; const base = baseUrl.replace(/\/$/, '');
  return async (req) => {
    const res = await f(base + req.path, {
      method: req.method, headers: { accept: 'application/json', ...opts.headers, ...req.headers },
      ...(req.body !== undefined ? { body: typeof req.body === 'string' ? req.body : (req.body as unknown as BodyInit) } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    return { status: res.status, body: await res.text() };
  };
}

const big = (x: unknown, what: string): bigint => {
  if (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0) return BigInt(x);
  if (typeof x === 'string' && /^\d+$/.test(x)) return BigInt(x);
  throw new Error(`invalid integer for ${what}: ${JSON.stringify(x)}`);
};

export interface LedgerInfo { chainId: number; epoch: bigint; ledgerVersion: bigint; /** microseconds since epoch (chain time) */ ledgerTimestampUsec: bigint; blockHeight: bigint; nodeRole: string }
export interface AccountInfo { sequenceNumber: bigint; authenticationKey: string }
export interface GasEstimate { deprioritized: bigint; normal: bigint; prioritized: bigint }
export type AptosTxLookup =
  | { kind: 'not_found' }
  | { kind: 'pending'; hash: string; sender: string; sequenceNumber: bigint; expirationTimestampSecs: bigint; gasUnitPrice: bigint; maxGasAmount: bigint }
  | { kind: 'committed'; hash: string; version: bigint; success: boolean; vmStatus: string; gasUsed: bigint; sender: string; sequenceNumber: bigint; gasUnitPrice: bigint; expirationTimestampSecs: bigint; txType: string };
export interface SimulationResult { success: boolean; vmStatus: string; gasUsed: bigint; maxGasAmount: bigint; gasUnitPrice: bigint }

export class AptosRestClient {
  readonly expectedChainId: number | undefined;
  private transport: RestTransport;
  private verified: Promise<void> | null = null; private poisoned: AptosChainIdMismatchError | null = null;
  constructor(opts: { transport: RestTransport; expectedChainId?: number }) { this.transport = opts.transport; this.expectedChainId = opts.expectedChainId; }

  private async rawGet(path: string): Promise<RestResponse> { return this.transport({ method: 'GET', path }); }
  private parseOrThrow(path: string, r: RestResponse): unknown {
    let j: unknown;
    try { j = JSON.parse(r.body); } catch { if (r.status >= 200 && r.status < 300) return r.body; throw new AptosRestError(path, r.status, r.body.slice(0, 200)); }
    if (r.status < 200 || r.status >= 300) { const m = j as { message?: string; error_code?: string }; throw new AptosRestError(path, r.status, m.message ?? r.body.slice(0, 200), m.error_code); }
    return j;
  }
  async getLedgerInfo(): Promise<LedgerInfo> {
    const r = this.parseOrThrow('/', await this.rawGet('/')) as Record<string, unknown>;
    return { chainId: Number(r.chain_id), epoch: big(r.epoch, 'epoch'), ledgerVersion: big(r.ledger_version, 'ledger_version'), ledgerTimestampUsec: big(r.ledger_timestamp, 'ledger_timestamp'), blockHeight: big(r.block_height, 'block_height'), nodeRole: String(r.node_role) };
  }
  async verifyChain(): Promise<void> {
    if (this.expectedChainId === undefined) return;
    if (this.poisoned) throw this.poisoned;
    if (!this.verified) {
      this.verified = (async () => {
        const li = await this.getLedgerInfo();
        if (li.chainId !== this.expectedChainId) { this.poisoned = new AptosChainIdMismatchError(this.expectedChainId!, li.chainId); throw this.poisoned; }
      })();
      this.verified.catch(() => { if (!this.poisoned) this.verified = null; });
    }
    await this.verified;
  }
  private async get(path: string): Promise<{ r: RestResponse; j: unknown }> { await this.verifyChain(); const r = await this.rawGet(path); return { r, j: undefined }; }

  async ledgerInfo(): Promise<LedgerInfo> { await this.verifyChain(); return this.getLedgerInfo(); }
  async isHealthy(): Promise<boolean> { const { r } = await this.get('/-/healthy'); return r.status === 200; }
  async getAccount(address: string): Promise<AccountInfo> {
    const a = validateAptosAddress(address); if (!a.valid) throw new Error(`invalid address: ${a.reason}`);
    const path = `/accounts/${a.normalized}`; const { r } = await this.get(path);
    const j = this.parseOrThrow(path, r) as Record<string, unknown>;
    return { sequenceNumber: big(j.sequence_number, 'sequence_number'), authenticationKey: String(j.authentication_key) };
  }
  /** balance in the asset's base units (octas for APT). The endpoint returns a bare integer. */
  async getBalance(address: string, assetType: string = APT_COIN_TYPE): Promise<bigint> {
    const a = validateAptosAddress(address); if (!a.valid) throw new Error(`invalid address: ${a.reason}`);
    const path = `/accounts/${a.normalized}/balance/${assetType}`; const { r } = await this.get(path);
    if (r.status !== 200) this.parseOrThrow(path, r);
    const t = r.body.trim(); if (!/^\d+$/.test(t)) throw new Error(`unexpected balance body: ${t.slice(0, 40)}`);
    return BigInt(t);
  }
  async estimateGasPrice(): Promise<GasEstimate> {
    const path = '/estimate_gas_price'; const { r } = await this.get(path);
    const j = this.parseOrThrow(path, r) as Record<string, unknown>;
    return { deprioritized: big(j.deprioritized_gas_estimate ?? j.gas_estimate, 'deprioritized'), normal: big(j.gas_estimate, 'gas_estimate'), prioritized: big(j.prioritized_gas_estimate ?? j.gas_estimate, 'prioritized') };
  }
  async getTransactionByHash(hash: string): Promise<AptosTxLookup> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('tx hash must be 0x + 64 hex');
    const path = `/transactions/by_hash/${hash}`; const { r } = await this.get(path);
    if (r.status === 404) return { kind: 'not_found' };
    const j = this.parseOrThrow(path, r) as Record<string, any>;
    if (j.type === 'pending_transaction') {
      return { kind: 'pending', hash: j.hash, sender: j.sender, sequenceNumber: big(j.sequence_number, 'seq'), expirationTimestampSecs: big(j.expiration_timestamp_secs, 'exp'), gasUnitPrice: big(j.gas_unit_price, 'gup'), maxGasAmount: big(j.max_gas_amount, 'mga') };
    }
    return { kind: 'committed', hash: j.hash, version: big(j.version, 'version'), success: j.success === true, vmStatus: String(j.vm_status), gasUsed: big(j.gas_used, 'gas_used'), sender: String(j.sender ?? ''),
      sequenceNumber: j.sequence_number === undefined ? 0n : big(j.sequence_number, 'seq'), gasUnitPrice: j.gas_unit_price === undefined ? 0n : big(j.gas_unit_price, 'gup'), expirationTimestampSecs: j.expiration_timestamp_secs === undefined ? 0n : big(j.expiration_timestamp_secs, 'exp'), txType: String(j.type) };
  }
  /** POST /transactions/simulate with a BCS-encoded SignedTransaction carrying an INVALID (zeroed) signature. Never submits. */
  async simulate(signedTxBcs: Uint8Array): Promise<SimulationResult> {
    await this.verifyChain();
    const path = '/transactions/simulate';
    const r = await this.transport({ method: 'POST', path, headers: { 'content-type': 'application/x.aptos.signed_transaction+bcs' }, body: signedTxBcs });
    const j = this.parseOrThrow(path, r) as Record<string, any>[];
    const t = j[0]; if (!t) throw new Error('simulate returned no transactions');
    return { success: t.success === true, vmStatus: String(t.vm_status), gasUsed: big(t.gas_used, 'gas_used'), maxGasAmount: big(t.max_gas_amount, 'max_gas_amount'), gasUnitPrice: big(t.gas_unit_price, 'gas_unit_price') };
  }
}
