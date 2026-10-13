import { parseQuantity, toQuantity } from './hex.ts';

export interface JsonRpcRequest { jsonrpc: '2.0'; id: number; method: string; params: unknown[] }
export interface JsonRpcResponse { jsonrpc?: string; id?: number | string | null; result?: unknown; error?: { code: number; message: string; data?: unknown } }
/** Injectable transport: tests supply recorded responses; production uses httpTransport. */
export type JsonRpcTransport = (req: JsonRpcRequest) => Promise<JsonRpcResponse>;

export class RpcError extends Error {
  code: number; data?: unknown; method: string;
  constructor(method: string, code: number, message: string, data?: unknown) {
    super(`${method}: ${message} (code ${code})`);
    this.name = 'RpcError'; this.code = code; this.data = data; this.method = method;
  }
}
export class ChainIdMismatchError extends Error {
  expected: bigint; actual: bigint;
  constructor(expected: bigint, actual: bigint) {
    super(`RPC node reports chainId ${actual}, expected ${expected}; refusing to use this node`);
    this.name = 'ChainIdMismatchError'; this.expected = expected; this.actual = actual;
  }
}

export function httpTransport(url: string, opts: { fetch?: typeof fetch; timeoutMs?: number; headers?: Record<string, string> } = {}): JsonRpcTransport {
  const f = opts.fetch ?? fetch;
  return async (req) => {
    const res = await f(url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...opts.headers }, body: JSON.stringify(req),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    const text = await res.text();
    let body: JsonRpcResponse;
    try { body = JSON.parse(text) as JsonRpcResponse; } catch { throw new Error(`non-JSON RPC response (HTTP ${res.status}): ${text.slice(0, 200)}`); }
    if (!res.ok && !body.error) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return body;
  };
}

export interface RpcBlock {
  number: bigint; hash: string; parentHash: string; timestamp: bigint; gasLimit: bigint; gasUsed: bigint;
  /** undefined on chains/blocks without EIP-1559 */
  baseFeePerGas?: bigint;
}
export interface RpcReceipt { transactionHash: string; blockNumber: bigint; blockHash: string; status: 'success' | 'reverted' | 'unknown'; gasUsed: bigint; effectiveGasPrice?: bigint }
export interface RpcFeeHistory { oldestBlock: bigint; baseFeePerGas: bigint[]; gasUsedRatio: number[]; reward?: bigint[][] }
export interface CallRequest { from?: string; to?: string; data?: string; value?: bigint; gas?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint }
export type BlockTag = 'latest' | 'pending' | 'safe' | 'finalized' | 'earliest' | bigint;
const tag = (t: BlockTag) => (typeof t === 'bigint' ? toQuantity(t) : t);

function parseBlock(r: unknown): RpcBlock | null {
  if (r === null || r === undefined) return null;
  const b = r as Record<string, string>;
  return {
    number: parseQuantity(b.number), hash: String(b.hash), parentHash: String(b.parentHash), timestamp: parseQuantity(b.timestamp),
    gasLimit: parseQuantity(b.gasLimit), gasUsed: parseQuantity(b.gasUsed),
    ...(b.baseFeePerGas !== undefined ? { baseFeePerGas: parseQuantity(b.baseFeePerGas) } : {}),
  };
}

/**
 * JSON-RPC client bound to ONE expected chain id. Every call first verifies eth_chainId once; a node that reports a
 * different chain id poisons the client permanently (no silent routing to another chain).
 */
export class EvmRpcClient {
  readonly expectedChainId: bigint;
  private transport: JsonRpcTransport;
  private nextId = 1;
  private verified: Promise<void> | null = null;
  private poisoned: ChainIdMismatchError | null = null;

  constructor(opts: { expectedChainId: bigint | number; transport: JsonRpcTransport }) {
    this.expectedChainId = BigInt(opts.expectedChainId); this.transport = opts.transport;
  }

  private async raw(method: string, params: unknown[]): Promise<unknown> {
    const res = await this.transport({ jsonrpc: '2.0', id: this.nextId++, method, params });
    if (res.error) throw new RpcError(method, res.error.code, res.error.message, res.error.data);
    if (res.result === undefined) throw new RpcError(method, -32603, 'missing result');
    return res.result;
  }

  /** Verifies the node's chain id. Cached after first success; rejects (and stays rejected) on mismatch. */
  async verifyChainId(): Promise<bigint> {
    if (this.poisoned) throw this.poisoned;
    if (!this.verified) {
      this.verified = (async () => {
        const actual = parseQuantity(await this.raw('eth_chainId', []));
        if (actual !== this.expectedChainId) { this.poisoned = new ChainIdMismatchError(this.expectedChainId, actual); throw this.poisoned; }
      })();
      this.verified.catch(() => { if (!this.poisoned) this.verified = null; }); // transient failures may retry; mismatches may not
    }
    await this.verified;
    return this.expectedChainId;
  }

  async request(method: string, params: unknown[] = []): Promise<unknown> {
    await this.verifyChainId();
    return this.raw(method, params);
  }

  async blockNumber(): Promise<bigint> { return parseQuantity(await this.request('eth_blockNumber')); }
  async getBalance(address: string, block: BlockTag = 'latest'): Promise<bigint> { return parseQuantity(await this.request('eth_getBalance', [address, tag(block)])); }
  async getTransactionCount(address: string, block: BlockTag = 'pending'): Promise<bigint> { return parseQuantity(await this.request('eth_getTransactionCount', [address, tag(block)])); }
  async getBlock(block: BlockTag = 'latest'): Promise<RpcBlock | null> { return parseBlock(await this.request('eth_getBlockByNumber', [tag(block), false])); }
  async gasPrice(): Promise<bigint> { return parseQuantity(await this.request('eth_gasPrice')); }
  async maxPriorityFeePerGas(): Promise<bigint> { return parseQuantity(await this.request('eth_maxPriorityFeePerGas')); }
  async feeHistory(blockCount: number, newest: BlockTag, percentiles: number[]): Promise<RpcFeeHistory> {
    const r = (await this.request('eth_feeHistory', [toQuantity(BigInt(blockCount)), tag(newest), percentiles])) as Record<string, unknown>;
    return {
      oldestBlock: parseQuantity(r.oldestBlock),
      baseFeePerGas: (r.baseFeePerGas as string[]).map(parseQuantity),
      gasUsedRatio: r.gasUsedRatio as number[],
      ...(r.reward ? { reward: (r.reward as string[][]).map((row) => row.map(parseQuantity)) } : {}),
    };
  }
  private callObj(c: CallRequest) {
    return {
      ...(c.from ? { from: c.from } : {}), ...(c.to ? { to: c.to } : {}), ...(c.data ? { data: c.data } : {}),
      ...(c.value !== undefined ? { value: toQuantity(c.value) } : {}), ...(c.gas !== undefined ? { gas: toQuantity(c.gas) } : {}),
      ...(c.maxFeePerGas !== undefined ? { maxFeePerGas: toQuantity(c.maxFeePerGas) } : {}),
      ...(c.maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas: toQuantity(c.maxPriorityFeePerGas) } : {}),
      ...(c.gasPrice !== undefined ? { gasPrice: toQuantity(c.gasPrice) } : {}),
    };
  }
  async call(c: CallRequest, block: BlockTag = 'latest'): Promise<string> { return String(await this.request('eth_call', [this.callObj(c), tag(block)])); }
  async estimateGas(c: CallRequest, block: BlockTag = 'latest'): Promise<bigint> { return parseQuantity(await this.request('eth_estimateGas', [this.callObj(c), tag(block)])); }
  async getTransactionReceipt(hash: string): Promise<RpcReceipt | null> {
    const r = (await this.request('eth_getTransactionReceipt', [hash])) as Record<string, string> | null;
    if (!r) return null;
    return {
      transactionHash: r.transactionHash!, blockNumber: parseQuantity(r.blockNumber), blockHash: r.blockHash!,
      status: r.status === '0x1' ? 'success' : r.status === '0x0' ? 'reverted' : 'unknown',
      gasUsed: parseQuantity(r.gasUsed), ...(r.effectiveGasPrice ? { effectiveGasPrice: parseQuantity(r.effectiveGasPrice) } : {}),
    };
  }
  async sendRawTransaction(rawHex: string): Promise<string> { return String(await this.request('eth_sendRawTransaction', [rawHex])); }
}
