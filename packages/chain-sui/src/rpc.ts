// Sui JSON-RPC client (injectable transport). NOTE: Sui deprecated JSON-RPC on the official public fullnodes
// (fullnode.<net>.sui.io answers "Method not found... migrate to gRPC or GraphQL"); third-party providers and self-hosted
// nodes still serve it. This client therefore only trusts a node after sui_getChainIdentifier matches the expected value.
export interface JsonRpcRequest { jsonrpc: '2.0'; id: number; method: string; params: unknown[] }
export interface JsonRpcResponse { jsonrpc?: string; id?: number | string | null; result?: unknown; error?: { code: number; message: string; data?: unknown } }
export type JsonRpcTransport = (req: JsonRpcRequest) => Promise<JsonRpcResponse>;

export class SuiRpcError extends Error {
  code: number; method: string;
  constructor(method: string, code: number, message: string) { super(`${method}: ${message} (code ${code})`); this.name = 'SuiRpcError'; this.code = code; this.method = method; }
}
export class SuiChainMismatchError extends Error {
  expected: string; actual: string;
  constructor(expected: string, actual: string) { super(`RPC node chain identifier ${actual} != expected ${expected}; refusing to use this node`); this.name = 'SuiChainMismatchError'; this.expected = expected; this.actual = actual; }
}
/** sui_getChainIdentifier = first 4 bytes of the genesis checkpoint digest, hex. Observed live (see docs/evidence/chains-a-live-reads.md). */
export const SUI_CHAIN_IDENTIFIERS = { 'sui:mainnet': '35834a8a', 'sui:testnet': '4c78adac' } as const;

export function httpTransport(url: string, opts: { fetch?: typeof fetch; timeoutMs?: number; headers?: Record<string, string> } = {}): JsonRpcTransport {
  const f = opts.fetch ?? fetch;
  return async (req) => {
    const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', ...opts.headers }, body: JSON.stringify(req), signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
    const text = await res.text();
    let body: JsonRpcResponse;
    try { body = JSON.parse(text) as JsonRpcResponse; } catch { throw new Error(`non-JSON RPC response (HTTP ${res.status}): ${text.slice(0, 200)}`); }
    if (!res.ok && !body.error) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return body;
  };
}

const big = (x: unknown, what: string): bigint => {
  if (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0) return BigInt(x);
  if (typeof x === 'string' && /^\d+$/.test(x)) return BigInt(x);
  throw new Error(`invalid integer for ${what}: ${JSON.stringify(x)}`);
};

export interface SuiCoin { coinType: string; objectId: string; version: bigint; digest: string; balance: bigint }
export interface SuiBalance { coinType: string; total: bigint; coinObjectCount: number; lockedBalance: bigint; fundsInAddressBalance?: bigint }
export interface GasSummary { computationCost: bigint; storageCost: bigint; storageRebate: bigint; nonRefundableStorageFee: bigint }
export interface SuiEffects { status: 'success' | 'failure'; error?: string; gasUsed: GasSummary }
export type SuiOwner = 'Immutable' | { AddressOwner: string } | { ObjectOwner: string } | { Shared: { initial_shared_version: number | string } } | { ConsensusAddressOwner: unknown };
export interface SuiObjectRef { objectId: string; version: bigint; digest: string; owner?: SuiOwner }

function parseGas(g: Record<string, unknown>): GasSummary {
  return { computationCost: big(g.computationCost, 'computationCost'), storageCost: big(g.storageCost, 'storageCost'), storageRebate: big(g.storageRebate, 'storageRebate'), nonRefundableStorageFee: big(g.nonRefundableStorageFee ?? '0', 'nonRefundableStorageFee') };
}
function parseEffects(e: Record<string, any>): SuiEffects {
  return { status: e.status.status, ...(e.status.error ? { error: String(e.status.error) } : {}), gasUsed: parseGas(e.gasUsed) };
}

export class SuiRpcClient {
  readonly expectedChainIdentifier: string | undefined;
  private transport: JsonRpcTransport; private nextId = 1;
  private verified: Promise<void> | null = null; private poisoned: SuiChainMismatchError | null = null;
  constructor(opts: { transport: JsonRpcTransport; expectedChainIdentifier?: string }) { this.transport = opts.transport; this.expectedChainIdentifier = opts.expectedChainIdentifier; }

  private async raw(method: string, params: unknown[]): Promise<unknown> {
    const r = await this.transport({ jsonrpc: '2.0', id: this.nextId++, method, params });
    if (r.error) { const e = r.error as unknown; if (typeof e === 'object' && e !== null) { const o = e as { code?: unknown; message?: unknown }; throw new SuiRpcError(method, typeof o.code === 'number' ? o.code : -1, String(o.message ?? JSON.stringify(e))); } throw new SuiRpcError(method, -1, String(e)); }
    if (r.result === undefined) throw new SuiRpcError(method, -32603, 'missing result');
    return r.result;
  }
  async verifyChain(): Promise<void> {
    if (!this.expectedChainIdentifier) return;
    if (this.poisoned) throw this.poisoned;
    if (!this.verified) {
      this.verified = (async () => {
        const actual = String(await this.raw('sui_getChainIdentifier', []));
        if (actual !== this.expectedChainIdentifier) { this.poisoned = new SuiChainMismatchError(this.expectedChainIdentifier!, actual); throw this.poisoned; }
      })();
      this.verified.catch(() => { if (!this.poisoned) this.verified = null; });
    }
    await this.verified;
  }
  async request(method: string, params: unknown[] = []): Promise<unknown> { await this.verifyChain(); return this.raw(method, params); }

  async getChainIdentifier(): Promise<string> { return String(await this.request('sui_getChainIdentifier')); }
  async getReferenceGasPrice(): Promise<bigint> { return big(await this.request('suix_getReferenceGasPrice'), 'referenceGasPrice'); }
  async getLatestCheckpoint(): Promise<bigint> { return big(await this.request('sui_getLatestCheckpointSequenceNumber'), 'checkpoint'); }
  async getBalance(owner: string, coinType = '0x2::sui::SUI'): Promise<SuiBalance> {
    const r = (await this.request('suix_getBalance', [owner, coinType])) as Record<string, unknown>;
    return {
      coinType: String(r.coinType), total: big(r.totalBalance, 'totalBalance'), coinObjectCount: Number(r.coinObjectCount),
      lockedBalance: 0n, ...(r.fundsInAddressBalance !== undefined ? { fundsInAddressBalance: big(r.fundsInAddressBalance, 'fundsInAddressBalance') } : {}),
    };
  }
  /** one page of owned coin OBJECTS */
  async getCoinsPage(owner: string, coinType = '0x2::sui::SUI', cursor: string | null = null, limit = 50): Promise<{ coins: SuiCoin[]; nextCursor: string | null; hasNextPage: boolean }> {
    const r = (await this.request('suix_getCoins', [owner, coinType, cursor, limit])) as { data: Record<string, unknown>[]; nextCursor: string | null; hasNextPage: boolean };
    return {
      coins: r.data.map((c) => ({ coinType: String(c.coinType), objectId: String(c.coinObjectId), version: big(c.version, 'version'), digest: String(c.digest), balance: big(c.balance, 'balance') })),
      nextCursor: r.nextCursor ?? null, hasNextPage: !!r.hasNextPage,
    };
  }
  /** all owned coin objects of a type (bounded page loop) */
  async getAllCoins(owner: string, coinType = '0x2::sui::SUI', maxPages = 20): Promise<SuiCoin[]> {
    const out: SuiCoin[] = []; let cursor: string | null = null;
    for (let i = 0; i < maxPages; i++) {
      const p = await this.getCoinsPage(owner, coinType, cursor, 50); out.push(...p.coins);
      if (!p.hasNextPage) return out; cursor = p.nextCursor;
    }
    throw new Error(`more than ${maxPages} pages of coins; refusing to act on a partial view`);
  }
  async getObject(id: string): Promise<SuiObjectRef | null> {
    const r = (await this.request('sui_getObject', [id, { showOwner: true }])) as { data?: Record<string, unknown>; error?: { code: string } };
    if (!r.data) return null;
    return { objectId: String(r.data.objectId), version: big(r.data.version, 'version'), digest: String(r.data.digest), ...(r.data.owner ? { owner: r.data.owner as SuiOwner } : {}) };
  }
  async multiGetObjects(ids: string[]): Promise<(SuiObjectRef | null)[]> {
    const r = (await this.request('sui_multiGetObjects', [ids, { showOwner: true }])) as { data?: Record<string, unknown>; error?: unknown }[];
    return r.map((x) => (x.data ? { objectId: String(x.data.objectId), version: big(x.data.version, 'version'), digest: String(x.data.digest), ...(x.data.owner ? { owner: x.data.owner as SuiOwner } : {}) } : null));
  }
  /** dry-run (simulation) of BCS transaction bytes (base64). Returns effects summary; never executes. */
  async dryRunTransactionBlock(txBytesBase64: string): Promise<{ effects: SuiEffects; raw: unknown }> {
    const r = (await this.request('sui_dryRunTransactionBlock', [txBytesBase64])) as { effects: Record<string, any> };
    return { effects: parseEffects(r.effects), raw: r };
  }
  /** null when the node does not know the digest */
  async getTransaction(digest: string): Promise<{ digest: string; effects: SuiEffects; checkpoint?: bigint } | null> {
    try {
      const r = (await this.request('sui_getTransactionBlock', [digest, { showEffects: true }])) as { digest: string; effects: Record<string, any>; checkpoint?: unknown };
      return { digest: r.digest, effects: parseEffects(r.effects), ...(r.checkpoint !== undefined ? { checkpoint: big(r.checkpoint, 'checkpoint') } : {}) };
    } catch (e) {
      if (e instanceof SuiRpcError && /Could not find the referenced transaction/i.test(e.message)) return null;
      throw e;
    }
  }
}
