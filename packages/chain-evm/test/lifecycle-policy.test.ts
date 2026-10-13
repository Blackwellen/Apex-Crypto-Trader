import test from 'node:test';
import assert from 'node:assert/strict';
import {
  advance, initialTxState, getFinalityPolicy, NoFinalityPolicyError, toTxStatus, computeNativeReserve, spendableNative, canSpendNative,
  buildScopedApprove, buildResetThenApprove, buildPermit2SingleTypedData, ApprovalRefused, MAX_UINT256, MAX_UINT160, needsApproval, readAllowance,
  simulate, TargetNotAllowed, EvmRpcClient, decodeRevert, FINALITY_POLICIES,
} from '../src/index.ts';
import type { TxState, ApprovalPolicy, JsonRpcRequest, JsonRpcResponse } from '../src/index.ts';

const H1 = '0x' + '1'.repeat(64), H2 = '0x' + '2'.repeat(64);
const pol = { requiredDepth: 5n, finalizedTag: 'unknown' as const, requireFinalizedTag: false, basis: 't' };
const rc = (n: bigint, h: string, status: 'success' | 'reverted' = 'success') => ({ blockNumber: n, blockHash: h, status });

test('pending -> included -> final by depth', () => {
  let s: TxState = initialTxState;
  let r = advance(s, { head: 100n, receipt: null }, pol); assert.equal(r.state.kind, 'pending');
  r = advance(r.state, { head: 100n, receipt: rc(100n, H1) }, pol); assert.equal(r.state.kind, 'included'); assert.deepEqual(r.events, ['included']);
  r = advance(r.state, { head: 103n, receipt: rc(100n, H1) }, pol); assert.equal(r.state.kind, 'included'); // depth 4 < 5
  r = advance(r.state, { head: 104n, receipt: rc(100n, H1) }, pol); assert.equal(r.state.kind, 'final'); assert.deepEqual(r.events, ['finalized']);
});
test('included -> reorged when receipt disappears, then reincluded in a new block', () => {
  let r = advance(initialTxState, { head: 100n, receipt: rc(100n, H1) }, pol);
  r = advance(r.state, { head: 101n, receipt: null }, pol); assert.equal(r.state.kind, 'reorged'); assert.deepEqual(r.events, ['reorged']);
  assert.equal(toTxStatus(r.state).state, 'reorged');
  r = advance(r.state, { head: 102n, receipt: null }, pol); assert.equal(r.state.kind, 'reorged');
  r = advance(r.state, { head: 103n, receipt: rc(102n, H2) }, pol); assert.equal(r.state.kind, 'included');
  assert.equal((r.state as { reorgCount: number }).reorgCount, 1); assert.deepEqual(r.events, ['reincluded']);
});
test('included -> reorged on canonical hash mismatch even if node still returns stale receipt', () => {
  let r = advance(initialTxState, { head: 100n, receipt: rc(100n, H1) }, pol);
  r = advance(r.state, { head: 101n, receipt: rc(100n, H1), canonicalHashAtInclusion: H2 }, pol);
  assert.equal(r.state.kind, 'reorged');
});
test('receipt moved to a different block => included(new) with reorgCount+1', () => {
  let r = advance(initialTxState, { head: 100n, receipt: rc(100n, H1) }, pol);
  r = advance(r.state, { head: 101n, receipt: rc(101n, H2) }, pol);
  assert.equal(r.state.kind, 'included'); assert.deepEqual(r.events, ['reorged', 'reincluded']); assert.equal((r.state as { reorgCount: number }).reorgCount, 1);
});
test('final is terminal; contradicting evidence is flagged, not silently reverted', () => {
  let r = advance(initialTxState, { head: 200n, receipt: rc(100n, H1) }, pol); assert.equal(r.state.kind, 'final');
  r = advance(r.state, { head: 201n, receipt: null }, pol);
  assert.equal(r.state.kind, 'final'); assert.deepEqual(r.events, ['finality_violation']); assert.match(toTxStatus(r.state).detail!, /VIOLATION/);
  r = advance(r.state, { head: 202n, receipt: null }, pol); assert.deepEqual(r.events, []); // reported once
});
test('reverted receipt maps to failed (included and final)', () => {
  let r = advance(initialTxState, { head: 100n, receipt: rc(100n, H1, 'reverted') }, pol);
  assert.equal(toTxStatus(r.state, 100n).state, 'failed');
  r = advance(r.state, { head: 110n, receipt: rc(100n, H1, 'reverted') }, pol);
  assert.equal(r.state.kind, 'final'); assert.equal(toTxStatus(r.state).state, 'failed');
});
test('requireFinalizedTag: depth alone is not final; tag required', () => {
  const p = { ...pol, finalizedTag: 'supported' as const, requireFinalizedTag: true };
  let r = advance(initialTxState, { head: 500n, receipt: rc(100n, H1) }, p); assert.equal(r.state.kind, 'included');
  r = advance(r.state, { head: 500n, finalized: 99n, receipt: rc(100n, H1) }, p); assert.equal(r.state.kind, 'included');
  r = advance(r.state, { head: 500n, finalized: 100n, receipt: rc(100n, H1) }, p); assert.equal(r.state.kind, 'final');
});
test('finalized tag shortcut when not required', () => {
  const r = advance(initialTxState, { head: 101n, finalized: 100n, receipt: rc(100n, H1) }, pol); assert.equal(r.state.kind, 'final');
});
test('finality policy: every registry EVM chain has one; unknown chain throws', () => {
  for (const id of ['eip155:1', 'eip155:8453', 'eip155:42161', 'eip155:10', 'eip155:137', 'eip155:56', 'eip155:43114', 'eip155:59144', 'eip155:534352', 'eip155:324', 'eip155:5000', 'eip155:81457'])
    assert.ok(getFinalityPolicy(id).requiredDepth > 0n, id);
  assert.throws(() => getFinalityPolicy('eip155:424242'), NoFinalityPolicyError);
  assert.equal(FINALITY_POLICIES['eip155:1']!.requireFinalizedTag, true);
});

test('native reserve: floor + next N + emergency exit; spendable never negative', () => {
  const r = computeNativeReserve('eip155:1', { floor: 100n, perTxCost: 50n, emergencyExitCost: 200n }, { plannedTxCount: 4 });
  assert.equal(r.nextNTxEstimate, 200n); assert.equal(r.emergencyExit, 300n); assert.equal(r.total, 600n);
  assert.equal(spendableNative(1000n, r), 400n); assert.equal(spendableNative(500n, r), 0n);
  assert.equal(canSpendNative(1000n, 400n, r), true); assert.equal(canSpendNative(1000n, 601n, r), false);
  assert.throws(() => computeNativeReserve('x', { floor: 0n, perTxCost: 0n, emergencyExitCost: 0n }, { plannedTxCount: -1 }));
});

const SPENDER = '0x1111111111111111111111111111111111111111', TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', P2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const ap: ApprovalPolicy = { spenderAllowlist: { 'eip155:1': [SPENDER] }, permit2ByChain: { 'eip155:1': P2 }, maxPermitLifetimeSec: 1800 };
const req = (over: Partial<Parameters<typeof buildScopedApprove>[0]> = {}) => ({ chainId: 'eip155:1', token: TOKEN, spender: SPENDER, amount: 1000n, requiredAmount: 1000n, ...over });
test('approve: exact amount on allowlisted spender ok; encodes approve selector', () => {
  const c = buildScopedApprove(req(), ap); assert.ok(c.data.startsWith('0x095ea7b3')); assert.equal(c.to, TOKEN);
});
test('approve: infinite refused by default (max uint256 and 2^255)', () => {
  for (const amount of [MAX_UINT256, 1n << 255n]) assert.throws(() => buildScopedApprove(req({ amount, requiredAmount: amount }), ap), (e: unknown) => e instanceof ApprovalRefused && e.code === 'infinite');
});
test('approve: spender must be allowlisted PER CHAIN; empty / other-chain allowlist refuses', () => {
  assert.throws(() => buildScopedApprove(req({ chainId: 'eip155:8453' }), ap), (e: unknown) => e instanceof ApprovalRefused && e.code === 'spender_not_allowlisted');
  assert.throws(() => buildScopedApprove(req(), { spenderAllowlist: {} }), /allowlist/);
  assert.throws(() => buildScopedApprove(req(), { spenderAllowlist: { 'eip155:1': [] } }), /allowlist/);
  assert.throws(() => buildScopedApprove(req({ spender: '0x2222222222222222222222222222222222222222' }), ap), /allowlist/);
});
test('approve: amount above required scope refused; revoke (0) always allowed', () => {
  assert.throws(() => buildScopedApprove(req({ amount: 1001n }), ap), (e: unknown) => e instanceof ApprovalRefused && e.code === 'over_scope');
  assert.ok(buildScopedApprove(req({ amount: 0n, spender: '0x2222222222222222222222222222222222222222' }), ap).description.includes('revoke'));
  assert.ok(buildScopedApprove(req({ amount: 1010n }), { ...ap, slackBps: 100n }));
});
test('reset-then-approve and needsApproval', () => {
  assert.equal(buildResetThenApprove(req(), ap, 5n).length, 2); assert.equal(buildResetThenApprove(req(), ap, 0n).length, 1);
  assert.equal(needsApproval(999n, 1000n), true); assert.equal(needsApproval(1000n, 1000n), false);
});
const NOW = 1_700_000_000n;
const p2 = (over = {}) => ({ chainId: 'eip155:1', chainIdNumeric: 1n, token: TOKEN, spender: SPENDER, amount: 1000n, expiration: NOW + 600n, nonce: 0n, sigDeadline: NOW + 600n, ...over });
test('Permit2: exact short-lived permit builds typed data; domain uses configured per-chain address', () => {
  const t = buildPermit2SingleTypedData(p2(), ap, NOW);
  assert.equal(t.domain.name, 'Permit2'); assert.equal(t.domain.verifyingContract, P2); assert.equal(t.message.details.amount, 1000n); assert.equal(t.primaryType, 'PermitSingle');
});
test('Permit2: no configured deployment => refused (no hardcoded address); infinite/long/expired refused', () => {
  assert.throws(() => buildPermit2SingleTypedData(p2({ chainId: 'eip155:8453', chainIdNumeric: 8453n }), { ...ap, spenderAllowlist: { 'eip155:8453': [SPENDER] } }, NOW), (e: unknown) => e instanceof ApprovalRefused && e.code === 'no_permit2_address');
  assert.throws(() => buildPermit2SingleTypedData(p2({ amount: MAX_UINT160 }), ap, NOW), /infinite|unlimited/);
  assert.throws(() => buildPermit2SingleTypedData(p2({ expiration: NOW + 86_400n }), ap, NOW), /lifetime/);
  assert.throws(() => buildPermit2SingleTypedData(p2({ expiration: NOW - 1n }), ap, NOW), /past/);
  assert.throws(() => buildPermit2SingleTypedData(p2({ sigDeadline: NOW + 86_400n }), ap, NOW), /deadline/);
  assert.throws(() => buildPermit2SingleTypedData(p2({ spender: '0x3333333333333333333333333333333333333333' }), ap, NOW), /allowlist/);
});

function xport(table: Record<string, (p: unknown[]) => { result?: unknown; error?: { code: number; message: string; data?: unknown } }>) {
  return async (req: JsonRpcRequest): Promise<JsonRpcResponse> => ({ jsonrpc: '2.0', id: req.id, ...(table[req.method] ?? (() => ({ error: { code: -32601, message: 'nf' } })))(req.params) });
}
test('readAllowance decodes eth_call word', async () => {
  const c = new EvmRpcClient({ expectedChainId: 1, transport: xport({ eth_chainId: () => ({ result: '0x1' }), eth_call: () => ({ result: '0x' + (777n).toString(16).padStart(64, '0') }) }) });
  assert.equal(await readAllowance(c, TOKEN, SPENDER, SPENDER), 777n);
});
test('simulate: success returns buffered gas limit; revert decoded; allowlist enforced; gas cap', async () => {
  const errStr = '0x08c379a0' + '20'.padStart(64, '0') + '9'.padStart(64, '0') + Buffer.from('too early').toString('hex').padEnd(64, '0');
  let mode: 'ok' | 'revert' = 'ok';
  const c = new EvmRpcClient({ expectedChainId: 1, transport: xport({
    eth_chainId: () => ({ result: '0x1' }),
    eth_call: () => (mode === 'ok' ? { result: '0x01' } : { error: { code: 3, message: 'execution reverted', data: errStr } }),
    eth_estimateGas: () => ({ result: '0x186a0' }),
  }) });
  const ok = await simulate(c, { to: SPENDER, data: '0x' }); assert.equal(ok.ok, true); assert.equal(ok.gasLimit, 120_000n);
  assert.equal((await simulate(c, { to: SPENDER }, { maxGasLimit: 110_000n })).gasLimit, 110_000n);
  const capped = await simulate(c, { to: SPENDER }, { maxGasLimit: 50_000n }); assert.equal(capped.ok, false); assert.equal(capped.revert!.kind, 'gas_cap');
  mode = 'revert';
  const bad = await simulate(c, { to: SPENDER }); assert.equal(bad.ok, false); assert.equal(bad.revert!.message, 'too early');
  await assert.rejects(() => simulate(c, { to: TOKEN }, { allowedTargets: [SPENDER] }), TargetNotAllowed);
  await assert.rejects(() => simulate(c, {}, { allowedTargets: [SPENDER] }), TargetNotAllowed);
  assert.equal(decodeRevert('0x4e487b71' + '11'.padStart(64, '0')).message, 'Panic(0x11)');
});
