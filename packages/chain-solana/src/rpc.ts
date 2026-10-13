import { validateSolanaAddress } from './base58.ts';
import type { Commitment, SigStatus } from './blockhash.ts';

export interface JsonRpcRequest { jsonrpc: '2.0'; id: number; method: string; params: unknown[] }
export interface JsonRpcResponse { jsonrpc?: string; id?: number | string | null; result?: unknown; error?: { code: number; message: string; data?: unknown } }
export type JsonRpcTransport = (req: JsonRpcRequest) => Promise<JsonRpcResponse>;

export class SolanaRpcError extends Error {
  code: number; data?: unknown; method: string;
  constructor(method: string, code: number, message: string, data?: unknown) { super(`${method}: ${message} (code ${code})`); this.name = 'SolanaRpcError'; this.code = code; this.method = method; this.data = data; }
}
export class ClusterMismatchError extends Error {
  expected: string; actual: string;
  constructor(expected: string, actual: string) { super(`RPC node genesis hash ${actual} != expected ${expected}; refusing to use this node`); this.name = 'ClusterMismatchError'; this.expected = expected; this.actual = actual; }
}
/** Genesis hashes identify the cluster (the Solana analogue of an EVM chain id). */
export const SOLANA_GENESIS_HASHES = {
  'solana:mainnet': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  'solana:devnet': 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'solana:testnet': '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
} as const;

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

export interface TokenAccount { pubkey: string; mint: string; owner: string; amount: bigint; decimals: number; state: string; program: string }
export interface SimulationOutcome { ok: boolean; err: unknown | null; logs: string[]; unitsConsumed?: bigint; slot: bigint }
export interface AccountInfo { lamports: bigint; owner: string; executable: boolean; data: Uint8Array; space: number }

export class SolanaRpcClient {
  readonly expectedGenesisHash: string | undefined;
  private transport: JsonRpcTransport; private nextId = 1;
  private verified: Promise<void> | null = null; private poisoned: ClusterMismatchError | null = null;
  /** expectedGenesisHash: when set, the node is verified once (getGenesisHash) before any other call. */
  constructor(opts: { transport: JsonRpcTransport; expectedGenesisHash?: string }) { this.transport = opts.transport; this.expectedGenesisHash = opts.expectedGenesisHash; }

  private async raw(method: string, params: unknown[]): Promise<unknown> {
    const r = await this.transport({ jsonrpc: '2.0', id: this.nextId++, method, params });
    if (r.error) { const e = r.error as unknown; if (typeof e === 'object' && e !== null) { const o = e as { code?: unknown; message?: unknown; data?: unknown }; throw new SolanaRpcError(method, typeof o.code === 'number' ? o.code : -1, String(o.message ?? JSON.stringify(e)), o.data); } throw new SolanaRpcError(method, -1, String(e)); }
    if (r.result === undefined) throw new SolanaRpcError(method, -32603, 'missing result');
    return r.result;
  }
  async verifyCluster(): Promise<void> {
    if (!this.expectedGenesisHash) return;
    if (this.poisoned) throw this.poisoned;
    if (!this.verified) {
      this.verified = (async () => {
        const actual = String(await this.raw('getGenesisHash', []));
        if (actual !== this.expectedGenesisHash) { this.poisoned = new ClusterMismatchError(this.expectedGenesisHash!, actual); throw this.poisoned; }
      })();
      this.verified.catch(() => { if (!this.poisoned) this.verified = null; });
    }
    await this.verified;
  }
  async request(method: string, params: unknown[] = []): Promise<unknown> { await this.verifyCluster(); return this.raw(method, params); }

  async getHealth(): Promise<string> { return String(await this.request('getHealth')); }
  async getGenesisHash(): Promise<string> { return String(await this.request('getGenesisHash')); }
  async getSlot(commitment: Commitment = 'confirmed'): Promise<bigint> { return big(await this.request('getSlot', [{ commitment }]), 'slot'); }
  async getBlockHeight(commitment: Commitment = 'confirmed'): Promise<bigint> { return big(await this.request('getBlockHeight', [{ commitment }]), 'blockHeight'); }
  async getEpoch(commitment: Commitment = 'confirmed'): Promise<bigint> { return big(((await this.request('getEpochInfo', [{ commitment }])) as { epoch: unknown }).epoch, 'epoch'); }
  async getBalance(address: string, commitment: Commitment = 'confirmed'): Promise<bigint> {
    const v = validateSolanaAddress(address); if (!v.valid) throw new Error(`invalid pubkey: ${v.reason}`);
    return big(((await this.request('getBalance', [address, { commitment }])) as { value: unknown }).value, 'balance');
  }
  async getLatestBlockhash(commitment: Commitment = 'confirmed'): Promise<{ blockhash: string; lastValidBlockHeight: bigint }> {
    const r = (await this.request('getLatestBlockhash', [{ commitment }])) as { value: { blockhash: string; lastValidBlockHeight: unknown } };
    return { blockhash: r.value.blockhash, lastValidBlockHeight: big(r.value.lastValidBlockHeight, 'lastValidBlockHeight') };
  }
  async getMinimumBalanceForRentExemption(dataLen: number): Promise<bigint> { return big(await this.request('getMinimumBalanceForRentExemption', [dataLen]), 'rent'); }
  async getAccountInfo(address: string, commitment: Commitment = 'confirmed'): Promise<AccountInfo | null> {
    const v = validateSolanaAddress(address); if (!v.valid) throw new Error(`invalid pubkey: ${v.reason}`);
    const r = (await this.request('getAccountInfo', [address, { encoding: 'base64', commitment }])) as { value: null | { lamports: unknown; owner: string; executable: boolean; space?: number; data: [string, string] } };
    if (!r.value) return null;
    if (r.value.data[1] !== 'base64') throw new Error('unexpected account data encoding');
    const data = Uint8Array.from(Buffer.from(r.value.data[0], 'base64'));
    return { lamports: big(r.value.lamports, 'lamports'), owner: r.value.owner, executable: r.value.executable, data, space: r.value.space ?? data.length };
  }
  /** filter by token program (spl / token-2022) or by a specific mint. */
  async getTokenAccountsByOwner(owner: string, filter: { programId: string } | { mint: string }, commitment: Commitment = 'confirmed'): Promise<TokenAccount[]> {
    const v = validateSolanaAddress(owner); if (!v.valid) throw new Error(`invalid pubkey: ${v.reason}`);
    const r = (await this.request('getTokenAccountsByOwner', [owner, filter, { encoding: 'jsonParsed', commitment }])) as {
      value: { pubkey: string; account: { data: { program: string; parsed: { info: { mint: string; owner: string; state: string; tokenAmount: { amount: string; decimals: number } } } } } }[] };
    return r.value.map((a) => ({
      pubkey: a.pubkey, mint: a.account.data.parsed.info.mint, owner: a.account.data.parsed.info.owner, state: a.account.data.parsed.info.state,
      amount: big(a.account.data.parsed.info.tokenAmount.amount, 'tokenAmount'), decimals: a.account.data.parsed.info.tokenAmount.decimals, program: a.account.data.program,
    }));
  }
  /** simulate a base64 transaction. sigVerify is disabled and the blockhash replaced so unsigned/stale transactions can be dry-run. */
  async simulateTransaction(txBase64: string, opts: { commitment?: Commitment; replaceRecentBlockhash?: boolean } = {}): Promise<SimulationOutcome> {
    const r = (await this.request('simulateTransaction', [txBase64, {
      encoding: 'base64', commitment: opts.commitment ?? 'confirmed', sigVerify: false, replaceRecentBlockhash: opts.replaceRecentBlockhash ?? true,
    }])) as { context: { slot: unknown }; value: { err: unknown | null; logs: string[] | null; unitsConsumed?: unknown } };
    return {
      ok: r.value.err === null, err: r.value.err, logs: r.value.logs ?? [], slot: big(r.context.slot, 'slot'),
      ...(r.value.unitsConsumed !== undefined ? { unitsConsumed: big(r.value.unitsConsumed, 'unitsConsumed') } : {}),
    };
  }
  async getSignatureStatuses(signatures: string[], searchTransactionHistory = true): Promise<(SigStatus | null)[]> {
    if (signatures.length === 0 || signatures.length > 256) throw new Error('1..256 signatures per call');
    const r = (await this.request('getSignatureStatuses', [signatures, { searchTransactionHistory }])) as { value: ({ slot: unknown; confirmationStatus: Commitment | null; err: unknown | null } | null)[] };
    return r.value.map((s) => (s ? { slot: big(s.slot, 'slot'), confirmationStatus: s.confirmationStatus, err: s.err } : null));
  }
  async getRecentPrioritizationFees(accounts: string[] = []): Promise<{ slot: bigint; prioritizationFee: bigint }[]> {
    const r = (await this.request('getRecentPrioritizationFees', [accounts])) as { slot: unknown; prioritizationFee: unknown }[];
    return r.map((x) => ({ slot: big(x.slot, 'slot'), prioritizationFee: big(x.prioritizationFee, 'fee') }));
  }
}
