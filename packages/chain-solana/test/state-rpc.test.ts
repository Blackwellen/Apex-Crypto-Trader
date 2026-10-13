import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blockhash as bh, SolanaRpcClient, ClusterMismatchError, SolanaRpcError, SOLANA_GENESIS_HASHES, SolanaChainAdapter, parseMint, TOKEN_PROGRAM_ID } from '../src/index.ts';
import type { JsonRpcRequest, JsonRpcResponse, SolTxState } from '../src/index.ts';
import { emptyCapabilities } from '@apex/contracts';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const LV = 1000n, SIG = 'sig1';
const submitted = (): SolTxState => bh.onSubmit(bh.build(LV), SIG);
const st = (c: 'processed' | 'confirmed' | 'finalized' | null, err: unknown = null) => (c || err ? { slot: 5n, confirmationStatus: c, err } : null);

test('submitted: status null inside validity window stays pending (never expired)', () => {
  const r = bh.advance(submitted(), { blockHeightBeforeQuery: 999n, status: null });
  assert.equal(r.state.kind, 'submitted'); assert.equal(bh.retryDecision(r.state), 'wait'); assert.equal(bh.canRebuildWithNewBlockhash(r.state), false);
  const edge = bh.advance(submitted(), { blockHeightBeforeQuery: LV, status: null }); assert.equal(edge.state.kind, 'submitted', 'height == lastValid is still valid');
});
test('blockhash expiry: height > lastValid BEFORE query + status null => expired => safe to rebuild', () => {
  const r = bh.advance(submitted(), { blockHeightBeforeQuery: LV + 1n, status: null });
  assert.equal(r.state.kind, 'expired'); assert.deepEqual(r.events, ['expired']); assert.equal(bh.canRebuildWithNewBlockhash(r.state), true); assert.equal(bh.retryDecision(r.state), 'safe_to_rebuild');
  assert.equal(bh.toTxStatus(r.state).state, 'expired');
});
test('landed at the last moment: status found even if height > lastValid => landed, NOT expired', () => {
  const r = bh.advance(submitted(), { blockHeightBeforeQuery: LV + 50n, status: st('confirmed') });
  assert.equal(r.state.kind, 'confirmed'); assert.equal(bh.canRebuildWithNewBlockhash(r.state), false);
});
test('commitment progression processed -> confirmed -> finalized; never regresses', () => {
  let s = submitted();
  s = bh.advance(s, { blockHeightBeforeQuery: 10n, status: st('processed') }).state; assert.equal(s.kind, 'processed');
  s = bh.advance(s, { blockHeightBeforeQuery: 11n, status: st('confirmed') }).state; assert.equal(s.kind, 'confirmed');
  const same = bh.advance(s, { blockHeightBeforeQuery: 12n, status: st('processed') }); assert.equal(same.state.kind, 'confirmed');
  s = bh.advance(s, { blockHeightBeforeQuery: 13n, status: st('finalized') }).state; assert.equal(s.kind, 'finalized'); assert.equal(bh.retryDecision(s), 'done_success');
  assert.equal(bh.advance(s, { blockHeightBeforeQuery: 9999n, status: null }).state.kind, 'finalized', 'finalized is terminal');
});
test('on-chain error => failed (not retried automatically)', () => {
  const r = bh.advance(submitted(), { blockHeightBeforeQuery: 10n, status: st('confirmed', { InstructionError: [0, 'Custom'] }) });
  assert.equal(r.state.kind, 'failed'); assert.equal(bh.retryDecision(r.state), 'done_failed'); assert.equal(bh.canRebuildWithNewBlockhash(r.state), false);
});
test('processed status that vanishes (fork) => reconcile, NOT expired, even past lastValid', () => {
  let s = bh.advance(submitted(), { blockHeightBeforeQuery: 10n, status: st('processed') }).state;
  const r = bh.advance(s, { blockHeightBeforeQuery: LV + 100n, status: null });
  assert.equal(r.state.kind, 'reconcile'); assert.deepEqual(r.events, ['needs_reconcile']); assert.equal(bh.canRebuildWithNewBlockhash(r.state), false);
});
test('ambiguous submit (timeout) => reconcile; resolves only through signature status or proven expiry', () => {
  let s = bh.onSubmitAmbiguous(bh.build(LV), SIG, 'sendTransaction timed out');
  assert.equal(bh.retryDecision(s), 'reconcile'); assert.equal(bh.canRebuildWithNewBlockhash(s), false); assert.match(bh.toTxStatus(s).detail!, /RECONCILE/);
  s = bh.advance(s, { blockHeightBeforeQuery: 500n, status: null }).state; assert.equal(s.kind, 'reconcile', 'still unresolved inside window');
  const landed = bh.advance(s, { blockHeightBeforeQuery: 600n, status: st('confirmed') }); assert.equal(landed.state.kind, 'confirmed');
  const exp = bh.advance(s, { blockHeightBeforeQuery: LV + 1n, status: null }); assert.equal(exp.state.kind, 'expired');
});
test('Jito bundle non-landing handling: unknown/failed/invalid bundle status => reconcile (unknown), never rebuild', () => {
  for (const b of ['unknown', 'failed', 'invalid'] as const) {
    const s = bh.onBundleStatus(submitted(), b);
    assert.equal(s.kind, 'reconcile', b); assert.equal(bh.canRebuildWithNewBlockhash(s), false); assert.equal(bh.toTxStatus(s).state, 'unknown');
  }
  assert.equal(bh.onBundleStatus(submitted(), 'pending').kind, 'submitted');
  // after reconcile, a bundle that never landed is only retried once the blockhash is provably expired
  let s = bh.onBundleStatus(submitted(), 'unknown');
  s = bh.advance(s, { blockHeightBeforeQuery: LV + 2n, status: null }).state;
  assert.equal(s.kind, 'expired'); assert.equal(bh.canRebuildWithNewBlockhash(s), true);
  // bundle says "landed" but the signature has not been seen: still not final until signature status confirms
  assert.equal(bh.onBundleStatus(submitted(), 'landed').kind, 'submitted');
});
test('cannot submit twice / from wrong state', () => {
  assert.throws(() => bh.onSubmit(submitted(), 'x'), /cannot submit/);
  assert.equal(bh.canRebuildWithNewBlockhash(bh.build(1n)), true);
});

function xport(h: Record<string, unknown | ((p: unknown[]) => unknown)>, log: string[] = []) {
  return async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
    log.push(req.method);
    const v = h[req.method]; if (v === undefined) return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } };
    return { jsonrpc: '2.0', id: req.id, result: typeof v === 'function' ? (v as (p: unknown[]) => unknown)(req.params) : v };
  };
}
const ADDR = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
test('rpc: cluster (genesis hash) mismatch rejected, no other call goes through', async () => {
  const log: string[] = [];
  const c = new SolanaRpcClient({ expectedGenesisHash: SOLANA_GENESIS_HASHES['solana:mainnet'], transport: xport({ getGenesisHash: SOLANA_GENESIS_HASHES['solana:devnet'], getSlot: 5 }, log) });
  await assert.rejects(() => c.getSlot(), ClusterMismatchError); await assert.rejects(() => c.getSlot(), ClusterMismatchError);
  assert.ok(!log.includes('getSlot'));
});
test('rpc: getBalance / getLatestBlockhash / getSlot / health (recorded shapes)', async () => {
  const lb = fx('getLatestBlockhash.json').result;
  const c = new SolanaRpcClient({ expectedGenesisHash: SOLANA_GENESIS_HASHES['solana:mainnet'], transport: xport({
    getGenesisHash: SOLANA_GENESIS_HASHES['solana:mainnet'], getBalance: { context: { slot: 1 }, value: 1_500_000_000 }, getLatestBlockhash: lb, getSlot: 456557415, getHealth: 'ok', getBlockHeight: 434593000 }) });
  assert.equal(await c.getBalance(ADDR), 1_500_000_000n);
  const b = await c.getLatestBlockhash(); assert.equal(b.lastValidBlockHeight, 434594011n); assert.equal(b.blockhash, '9u8rX6JDFaeortwZSZEQWb2VtHo1vxv3SpdhHgApRK2T');
  assert.equal(await c.getSlot(), 456557415n); assert.equal(await c.getHealth(), 'ok');
  await assert.rejects(() => c.getBalance('not-a-pubkey'), /invalid pubkey/);
});
test('rpc: getTokenAccountsByOwner (jsonParsed shape) and getAccountInfo (base64) decode', async () => {
  const mintFx = fx('mint-EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v.json').result;
  const c = new SolanaRpcClient({ transport: xport({
    getTokenAccountsByOwner: { context: { slot: 1 }, value: [{ pubkey: ADDR, account: { lamports: 2039280, data: { program: 'spl-token', parsed: { info: { mint: ADDR, owner: ADDR, state: 'initialized', tokenAmount: { amount: '123456789012345678901', decimals: 6 } } } } } }] },
    getAccountInfo: mintFx }) });
  const ta = await c.getTokenAccountsByOwner(ADDR, { programId: TOKEN_PROGRAM_ID });
  assert.equal(ta[0]!.amount, 123456789012345678901n, 'amounts beyond 2^53 survive as bigint strings'); assert.equal(ta[0]!.decimals, 6);
  const ai = await c.getAccountInfo(ADDR); assert.equal(ai!.owner, TOKEN_PROGRAM_ID); assert.equal(parseMint(ai!.data, ai!.owner).decimals, 6);
});
test('rpc: simulateTransaction + getSignatureStatuses', async () => {
  const seen: unknown[][] = [];
  const c = new SolanaRpcClient({ transport: xport({
    simulateTransaction: (p: unknown[]) => { seen.push(p); return { context: { slot: 9 }, value: { err: { InstructionError: [0, 'InvalidAccountData'] }, logs: ['Program log: x'], unitsConsumed: 1234 } }; },
    getSignatureStatuses: { context: { slot: 9 }, value: [null, { slot: 8, confirmations: null, err: null, confirmationStatus: 'finalized' }] } }) });
  const sim = await c.simulateTransaction('AQ=='); assert.equal(sim.ok, false); assert.equal(sim.unitsConsumed, 1234n);
  assert.deepEqual((seen[0]![1] as Record<string, unknown>).sigVerify, false);
  const s = await c.getSignatureStatuses(['a', 'b']); assert.equal(s[0], null); assert.equal(s[1]!.confirmationStatus, 'finalized');
  await assert.rejects(() => c.getSignatureStatuses([]), /1\.\.256/);
});
test('rpc error is typed', async () => {
  const c = new SolanaRpcClient({ transport: xport({}) });
  await assert.rejects(() => c.getHealth(), (e: unknown) => e instanceof SolanaRpcError && e.code === -32601);
});
test('adapter: validateAddress; READ_ONLY allows balances; execution + PENDING reads fail closed', async () => {
  const caps = emptyCapabilities(); caps.getBalances = { status: 'READ_ONLY', evidenceRef: 't' };
  const c = new SolanaRpcClient({ transport: xport({ getBalance: { value: 7 } }) });
  const a = new SolanaChainAdapter({ capabilitiesFor: () => caps, clientFor: () => c, reserveConfigFor: () => ({ perTxCost: 1n, emergencyExitCost: 1n }) });
  assert.equal(a.validateAddress(ADDR).valid, true); assert.equal(a.validateAddress('x').valid, false);
  assert.deepEqual(await a.getBalances('solana:mainnet', ADDR), [{ assetId: 'native', amount: 7n, decimals: 9 }]);
  await assert.rejects(() => a.getFeeQuote('solana:mainnet'), /fail closed/);
  await assert.rejects(() => a.submit('solana:mainnet'), /fail closed/);
  assert.equal(a.nativeReserveRequired('solana:mainnet', { plannedTxCount: 0 }).floor, 890_880n);
  const status = await new SolanaChainAdapter({ capabilitiesFor: () => caps, clientFor: () => new SolanaRpcClient({ transport: xport({ getBlockHeight: 10, getSignatureStatuses: { value: [null] } }) }), reserveConfigFor: () => ({ perTxCost: 1n, emergencyExitCost: 1n }) }).getTransactionStatus('solana:mainnet', 'sig');
  assert.equal(status.state, 'unknown', 'a bare unknown signature is never reported expired');
});
