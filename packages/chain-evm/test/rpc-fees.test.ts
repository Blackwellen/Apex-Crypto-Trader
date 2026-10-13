import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EvmRpcClient, ChainIdMismatchError, RpcError, nextBaseFee, quoteEip1559, quoteLegacy, FeeCapExceededError, fetchGasQuote, priorityFromFeeHistory,
  toFeeQuote, worstCaseCost, l2Components, l2FeeSpec, decodeArbComponents, encodeOpGetL1Fee, encodeArbGasEstimateComponents, EvmChainAdapter,
} from '../src/index.ts';
import { emptyCapabilities } from '@apex/contracts';
import type { JsonRpcRequest, JsonRpcResponse, FeePolicy } from '../src/index.ts';

const GWEI = 1_000_000_000n;
const policy: FeePolicy = { baseFeeMultiplierBps: 20_000n, minPriorityFeePerGas: GWEI / 10n, maxPriorityFeePerGas: 5n * GWEI, maxFeePerGasCap: 500n * GWEI, rewardPercentileIndex: 1 };

/** scripted transport: map method -> result (shapes follow the Ethereum execution-apis / eth_feeHistory docs) */
function scripted(table: Record<string, unknown | ((p: unknown[]) => unknown)>, log: string[] = []) {
  return async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
    log.push(req.method);
    const h = table[req.method];
    if (h === undefined) return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } };
    const result = typeof h === 'function' ? (h as (p: unknown[]) => unknown)(req.params) : h;
    if (result instanceof Error) return { jsonrpc: '2.0', id: req.id, error: { code: -32000, message: result.message } };
    return { jsonrpc: '2.0', id: req.id, result };
  };
}

test('chain id mismatch is rejected and poisons the client', async () => {
  const log: string[] = [];
  const c = new EvmRpcClient({ expectedChainId: 8453, transport: scripted({ eth_chainId: '0x1', eth_blockNumber: '0x10' }, log) });
  await assert.rejects(() => c.blockNumber(), ChainIdMismatchError);
  await assert.rejects(() => c.getBalance('0x' + '1'.repeat(40)), ChainIdMismatchError);
  assert.ok(!log.includes('eth_blockNumber'), 'no other call may reach a wrong-chain node');
});
test('matching chain id verified once then calls pass', async () => {
  const log: string[] = [];
  const c = new EvmRpcClient({ expectedChainId: 8453, transport: scripted({ eth_chainId: '0x2105', eth_blockNumber: '0x10' }, log) });
  assert.equal(await c.blockNumber(), 16n); assert.equal(await c.blockNumber(), 16n);
  assert.equal(log.filter((m) => m === 'eth_chainId').length, 1);
});
test('malformed quantity from node is rejected', async () => {
  const c = new EvmRpcClient({ expectedChainId: 1, transport: scripted({ eth_chainId: '0x1', eth_blockNumber: '0x0010' }) });
  await assert.rejects(() => c.blockNumber(), /invalid JSON-RPC quantity/);
});

test('nextBaseFee follows EIP-1559 (target, above, below, floor)', () => {
  assert.equal(nextBaseFee(1000n, 15_000_000n, 30_000_000n), 1000n);
  assert.equal(nextBaseFee(1000n, 30_000_000n, 30_000_000n), 1125n); // full block: +12.5%
  assert.equal(nextBaseFee(1000n, 0n, 30_000_000n), 875n);           // empty block: -12.5%
  assert.equal(nextBaseFee(1n, 30_000_000n, 30_000_000n), 2n);        // min +1
  assert.equal(nextBaseFee(0n, 0n, 30_000_000n), 0n);
});

test('quoteEip1559: maxFee = scaled base + priority, bounded', () => {
  const q = quoteEip1559({ nextBaseFee: 10n * GWEI, priorityObserved: 2n * GWEI, policy });
  assert.equal(q.maxFeePerGas, 22n * GWEI); assert.equal(q.maxPriorityFeePerGas, 2n * GWEI); assert.equal(q.headroom, 10n * GWEI);
  assert.ok(q.maxPriorityFeePerGas <= q.maxFeePerGas);
});
test('priority clamped to [min,max]; missing observation falls to min', () => {
  assert.equal(quoteEip1559({ nextBaseFee: GWEI, priorityObserved: 100n * GWEI, policy }).priorityFeePerGas, 5n * GWEI);
  assert.equal(quoteEip1559({ nextBaseFee: GWEI, priorityObserved: 0n, policy }).priorityFeePerGas, GWEI / 10n);
  assert.equal(quoteEip1559({ nextBaseFee: GWEI, priorityObserved: undefined, policy }).priorityFeePerGas, GWEI / 10n);
});
test('hard cap: fee spike beyond cap throws (fail closed)', () => {
  assert.throws(() => quoteEip1559({ nextBaseFee: 400n * GWEI, priorityObserved: GWEI, policy }), FeeCapExceededError);
  assert.throws(() => quoteLegacy(600n * GWEI, policy), FeeCapExceededError);
});
test('legacy quote buffers gasPrice by 10%', () => { assert.equal(quoteLegacy(100n * GWEI, policy).gasPrice, 110n * GWEI); });

const feeHistoryShape = { oldestBlock: '0x100', baseFeePerGas: ['0x3b9aca00', '0x3c3a8c00', '0x3a3529440', '0x3b9aca00', '0x3b9aca00', '0x3ba6ec00'], gasUsedRatio: [0.5, 0.4, 0.6, 0.5, 0.5], reward: [['0x3b9aca0', '0x77359400', '0xb2d05e00'], ['0x3b9aca0', '0x77359400', '0xb2d05e00'], ['0x3b9aca0', '0x59682f00', '0xb2d05e00'], ['0x3b9aca0', '0x77359400', '0xb2d05e00'], ['0x3b9aca0', '0x77359400', '0xb2d05e00']] };
const latestBlock = { number: '0x104', hash: '0x' + 'a'.repeat(64), parentHash: '0x' + 'b'.repeat(64), timestamp: '0x65', gasLimit: '0x1c9c380', gasUsed: '0xe4e1c0', baseFeePerGas: '0x3b9aca00' };

test('fetchGasQuote uses feeHistory: next-block base + median tip', async () => {
  const c = new EvmRpcClient({ expectedChainId: 1, transport: scripted({ eth_chainId: '0x1', eth_getBlockByNumber: latestBlock, eth_feeHistory: feeHistoryShape }) });
  const { gas, source } = await fetchGasQuote(c, policy);
  assert.equal(source, 'eth_feeHistory');
  assert.equal(gas.type, 'eip1559');
  if (gas.type === 'eip1559') { assert.equal(gas.baseFeePerGas, 0x3ba6ec00n); assert.equal(gas.priorityFeePerGas, 0x77359400n); }
});
test('fetchGasQuote falls back to maxPriorityFeePerGas when feeHistory unsupported', async () => {
  const c = new EvmRpcClient({ expectedChainId: 1, transport: scripted({ eth_chainId: '0x1', eth_getBlockByNumber: latestBlock, eth_maxPriorityFeePerGas: '0x59682f00' }) });
  const { gas, source } = await fetchGasQuote(c, policy);
  assert.match(source, /feeHistory unavailable/);
  if (gas.type === 'eip1559') assert.equal(gas.priorityFeePerGas, 0x59682f00n);
});
test('legacy chain (no baseFeePerGas) -> legacy gasPrice quote', async () => {
  const { baseFeePerGas: _omit, ...legacyBlock } = latestBlock;
  const c = new EvmRpcClient({ expectedChainId: 56, transport: scripted({ eth_chainId: '0x38', eth_getBlockByNumber: legacyBlock, eth_gasPrice: '0x2540be400' }) });
  const { gas } = await fetchGasQuote(c, policy);
  assert.deepEqual(gas, { type: 'legacy', gasPrice: 11n * GWEI });
});
test('priorityFromFeeHistory is the per-column median', () => {
  assert.equal(priorityFromFeeHistory({ reward: [[1n, 5n], [1n, 9n], [1n, 7n]] }, 1), 7n);
  assert.equal(priorityFromFeeHistory({}, 0), undefined);
});

test('L2 data fee is a SEPARATE component; unknown stacks are flagged unknown, never guessed', () => {
  assert.deepEqual(l2Components(1), []);
  const zk = l2Components(324); assert.equal(zk.length, 1); assert.equal(zk[0]!.known, false); assert.equal(zk[0]!.amount, undefined);
  const unknownChain = l2Components(999999); assert.equal(unknownChain[0]!.known, false);
  const op = l2Components(8453); assert.equal(op[0]!.known, false); // modelled but not measured => still unknown
  const opM = l2Components(8453, { l1Fee: 123n }); assert.equal(opM[0]!.known, true); assert.equal(opM[0]!.amount, 123n);
  assert.equal(l2FeeSpec(5000).modelled, false); assert.equal(l2FeeSpec(59144).modelled, false); assert.equal(l2FeeSpec(534352).modelled, false);
});
test('toFeeQuote marks incomplete L2 quote stale and keeps components separate', () => {
  const gas = { type: 'eip1559' as const, baseFeePerGas: GWEI, priorityFeePerGas: GWEI, maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: GWEI, headroom: GWEI };
  const base = { chainId: 'eip155:324', gas, gasLimit: 100_000n, worstCaseExecutionCost: worstCaseCost(gas, 100_000n), observedAt: 1000, source: 't' };
  const incomplete = toFeeQuote({ ...base, l2Components: l2Components(324) }, 1000);
  assert.equal(incomplete.stale, true); assert.match(incomplete.source, /INCOMPLETE/); assert.equal(incomplete.nativeUnits, 300_000n * GWEI);
  const complete = toFeeQuote({ ...base, chainId: 'eip155:8453', l2Components: l2Components(8453, { l1Fee: 7n }) }, 1000);
  assert.equal(complete.stale, false); assert.equal(complete.components.l1DataFee, 7n); assert.equal(complete.nativeUnits, 300_000n * GWEI + 7n);
  assert.equal(toFeeQuote({ ...base, l2Components: [] }, 1000 + 20_000).stale, true, 'age > maxAge is stale');
});
test('Arbitrum / OP calldata + decode shapes', () => {
  const words = [1_000_000n, 40_000n, 100_000_000n, 3_000_000_000n].map((x) => x.toString(16).padStart(64, '0')).join('');
  const d = decodeArbComponents('0x' + words);
  assert.equal(d.l1FeeWei, 40_000n * 100_000_000n);
  assert.ok(encodeOpGetL1Fee('0xdeadbeef').startsWith('0x49948e0e')); // selector of getL1Fee(bytes)
  assert.ok(encodeArbGasEstimateComponents('0x' + '1'.repeat(40), false, '0x').length > 10);
  assert.throws(() => decodeArbComponents('0x00'), /too short/);
});
test('RpcError carries code; JSON-RPC error surfaces', async () => {
  const c = new EvmRpcClient({ expectedChainId: 1, transport: scripted({ eth_chainId: '0x1' }) });
  await assert.rejects(() => c.request('eth_nope'), (e: unknown) => e instanceof RpcError && e.code === -32601);
});
test('adapter: READ_ONLY allows fee quote, execution fails closed', async () => {
  const caps = emptyCapabilities('PENDING'); caps.getFeeQuote = { status: 'READ_ONLY', evidenceRef: 'test' };
  const client = new EvmRpcClient({ expectedChainId: 1, transport: scripted({ eth_chainId: '0x1', eth_getBlockByNumber: latestBlock, eth_feeHistory: feeHistoryShape }) });
  const a = new EvmChainAdapter({ capabilitiesFor: () => caps, clientFor: () => client, feePolicyFor: () => policy, reserveConfigFor: () => ({ floor: 1n, perTxCost: 2n, emergencyExitCost: 4n }), now: () => 5 });
  const q = await a.getFeeQuote('eip155:1'); assert.equal(q.stale, false);
  await assert.rejects(() => a.submit('eip155:1', new Uint8Array([1])), /fail closed/);
  await assert.rejects(() => a.getBalances('eip155:1', '0x' + '1'.repeat(40)), /fail closed/); // getBalances PENDING in this fixture
  assert.deepEqual(a.nativeReserveRequired('eip155:1', { plannedTxCount: 3 }).total, 1n + 6n + 6n);
});

test('non-standard string error bodies (e.g. {"error":"API key disabled"}) become typed RpcErrors with the message preserved', async () => {
  const c = new EvmRpcClient({ expectedChainId: 137, transport: async (req) => ({ jsonrpc: '2.0', id: req.id, error: 'message: API key disabled, reason: tenant disabled' as never }) });
  await assert.rejects(() => c.verifyChainId(), (e: unknown) => e instanceof RpcError && e.code === -1 && /API key disabled/.test(e.message));
});
