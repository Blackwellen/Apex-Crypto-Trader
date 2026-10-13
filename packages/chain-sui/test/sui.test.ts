import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateSuiAddress, normalizeSuiShortForm, validateCoinType, SuiRpcClient, SuiChainMismatchError, SuiRpcError, SUI_CHAIN_IDENTIFIERS,
  selectCoins, InsufficientCoins, SuiCoinLeaser, LeaseError, netGas, grossGas, gasBudgetFromDryRun, computeSuiReserve, SuiChainAdapter,
} from '../src/index.ts';
import type { JsonRpcRequest, JsonRpcResponse, SuiCoin } from '../src/index.ts';
import { emptyCapabilities } from '@apex/contracts';
import { freshDb } from './db.ts';
import type { TestDb } from './db.ts';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8')) as JsonRpcResponse;
const oid = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const OWNER = oid(0xabc);
const coin = (n: number, balance: bigint, version = 10n, coinType = '0x2::sui::SUI'): SuiCoin => ({ coinType, objectId: oid(n), version, digest: 'd', balance });

function xport(table: Record<string, unknown | ((p: unknown[]) => unknown)>, log: string[] = []) {
  return async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
    log.push(req.method);
    const h = table[req.method];
    if (h === undefined) return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } };
    const v = typeof h === 'function' ? (h as (p: unknown[]) => unknown)(req.params) : h;
    if (v && typeof v === 'object' && 'error' in (v as object)) return { jsonrpc: '2.0', id: req.id, ...(v as object) };
    return { jsonrpc: '2.0', id: req.id, result: v };
  };
}

test('address: strict 0x + 64 hex', () => {
  assert.equal(validateSuiAddress(oid(5)).valid, true);
  assert.equal(validateSuiAddress('0x' + 'A'.repeat(64)).normalized, '0x' + 'a'.repeat(64));
  for (const bad of ['0x2', '0x' + 'a'.repeat(63), '0x' + 'a'.repeat(65), 'a'.repeat(66), '0x' + 'g'.repeat(64), '', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'])
    assert.equal(validateSuiAddress(bad).valid, false, bad);
  assert.equal(normalizeSuiShortForm('0x2'), oid(2));
  assert.throws(() => normalizeSuiShortForm('0xzz'));
});
test('coin type validation', () => {
  assert.equal(validateCoinType('0x2::sui::SUI').valid, true);
  assert.equal(validateCoinType('0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC').valid, true);
  assert.equal(validateCoinType('SUI').valid, false);
});

test('rpc: chain identifier mismatch rejected (mainnet client vs testnet node)', async () => {
  const log: string[] = [];
  const c = new SuiRpcClient({ expectedChainIdentifier: SUI_CHAIN_IDENTIFIERS['sui:mainnet'], transport: xport({ sui_getChainIdentifier: '4c78adac', suix_getReferenceGasPrice: '100' }, log) });
  await assert.rejects(() => c.getReferenceGasPrice(), SuiChainMismatchError);
  assert.ok(!log.includes('suix_getReferenceGasPrice'));
});
test('rpc: recorded real response shapes (balance incl. fundsInAddressBalance, coins page, object, gas price, checkpoint)', async () => {
  const f = (n: string) => fx(n).result;
  const c = new SuiRpcClient({ expectedChainIdentifier: '35834a8a', transport: xport({
    sui_getChainIdentifier: '35834a8a', suix_getBalance: f('getBalance'), suix_getCoins: f('getCoins'), sui_getObject: f('getObject'), suix_getReferenceGasPrice: f('refgas'), sui_getLatestCheckpointSequenceNumber: f('checkpoint') }) });
  const b = await c.getBalance(oid(5)); assert.equal(b.coinType, '0x2::sui::SUI'); assert.ok(b.total > 0n); assert.equal(b.fundsInAddressBalance, 0n);
  const p = await c.getCoinsPage(oid(5), '0x2::sui::SUI', null, 3); assert.equal(p.coins.length, 3); assert.equal(typeof p.coins[0]!.balance, 'bigint'); assert.ok(p.coins[0]!.version > 0n);
  const o = await c.getObject(oid(6)); assert.deepEqual(o!.owner, { Shared: { initial_shared_version: 1 } });
  assert.equal(await c.getReferenceGasPrice(), 100n); assert.ok((await c.getLatestCheckpoint()) > 0n);
});
test('rpc: getAllCoins paginates and refuses a partial view', async () => {
  let page = 0;
  const mk = (n: number) => ({ coinType: '0x2::sui::SUI', coinObjectId: oid(n), version: '1', digest: 'd', balance: '5' });
  const c = new SuiRpcClient({ transport: xport({ suix_getCoins: () => (page++ < 2 ? { data: [mk(page * 10)], nextCursor: 'c', hasNextPage: true } : { data: [mk(99)], nextCursor: null, hasNextPage: false }) }) });
  assert.equal((await c.getAllCoins(OWNER)).length, 3);
  const inf = new SuiRpcClient({ transport: xport({ suix_getCoins: { data: [mk(1)], nextCursor: 'c', hasNextPage: true } }) });
  await assert.rejects(() => inf.getAllCoins(OWNER, '0x2::sui::SUI', 3), /partial view/);
});
test('dry-run wrapper + gas math (recorded effects gasUsed shape)', async () => {
  const tx = fx('txblock').result as { effects: unknown; digest: string; checkpoint: unknown };
  const c = new SuiRpcClient({ transport: xport({ sui_dryRunTransactionBlock: { effects: (tx as any).effects }, sui_getTransactionBlock: tx }) });
  const d = await c.dryRunTransactionBlock('AAAA'); assert.equal(d.effects.status, 'success');
  const g = d.effects.gasUsed; assert.equal(grossGas(g), g.computationCost + g.storageCost); assert.equal(netGas(g), g.computationCost + g.storageCost - g.storageRebate);
  const budget = gasBudgetFromDryRun(g, { maxBudget: 10n ** 12n }); assert.ok(budget >= grossGas(g)); // budget covers GROSS, not net
  assert.throws(() => gasBudgetFromDryRun(g, { maxBudget: 1000n }), /exceeds cap/);
  const t = await c.getTransaction(tx.digest); assert.ok(t!.checkpoint! > 0n);
});
test('adapter: tx status final in checkpoint; missing digest => unknown (reconcile); read-only gates', async () => {
  const tx = fx('txblock').result as any;
  const caps = emptyCapabilities(); caps.getBalances = { status: 'READ_ONLY', evidenceRef: 't' };
  const mkA = (t: Record<string, unknown>) => new SuiChainAdapter({ capabilitiesFor: () => caps, clientFor: () => new SuiRpcClient({ transport: xport(t) }), reserveConfigFor: () => ({ floor: 0n, perTxBudget: 10n, emergencyExitBudget: 20n }) });
  assert.equal((await mkA({ sui_getTransactionBlock: tx }).getTransactionStatus('sui:mainnet', tx.digest)).state, 'final');
  const nf = await mkA({ sui_getTransactionBlock: { error: { code: -32602, message: 'Could not find the referenced transaction [x].' } } }).getTransactionStatus('sui:mainnet', 'x');
  assert.equal(nf.state, 'unknown');
  const a = mkA({ suix_getBalance: fx('getBalance').result });
  assert.ok((await a.getBalances('sui:mainnet', oid(5)))[0]!.amount > 0n);
  await assert.rejects(() => a.getFeeQuote('sui:mainnet'), /fail closed/); await assert.rejects(() => a.submit('sui:mainnet'), /fail closed/);
  assert.equal(a.nativeReserveRequired('sui:mainnet', { plannedTxCount: 2 }).total, 0n + 20n + 30n);
  assert.equal(a.validateAddress('0x2').valid, false);
});
test('pure selection: best-fit single, else largest-first; honours exclusions', () => {
  const cs = [coin(1, 5n), coin(2, 50n), coin(3, 500n)];
  assert.deepEqual(selectCoins(cs, 40n).map((c) => c.objectId), [oid(2)]);
  assert.deepEqual(selectCoins(cs, 540n).map((c) => c.objectId), [oid(3), oid(2)]);
  assert.throws(() => selectCoins(cs, 40n, { exclude: new Set([oid(2), oid(3)]) }), InsufficientCoins);
  assert.throws(() => selectCoins(cs, 10_000n), InsufficientCoins);
  assert.throws(() => selectCoins([coin(1, 1n), coin(2, 1n), coin(3, 1n)], 3n, { maxObjects: 2 }), InsufficientCoins);
});

let db: TestDb;
before(async () => { db = await freshDb(); });
after(async () => { await db.close(); });

test('100 simultaneous requests cannot double-spend ONE coin object', async () => {
  const leaser = new SuiCoinLeaser(db.pool);
  const only = [coin(1, 1_000_000n)];
  const results = await Promise.allSettled(Array.from({ length: 100 }, (_, i) => leaser.lease({ chainId: 'sui:mainnet', owner: OWNER, intentId: `race-${i}`, candidates: only, gasNeed: 1000n })));
  const ok = results.filter((r) => r.status === 'fulfilled'); const bad = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, 'exactly one order gets the object'); assert.equal(bad.length, 99);
  for (const b of bad) assert.ok((b as PromiseRejectedResult).reason instanceof LeaseError && (b as PromiseRejectedResult).reason.code === 'insufficient');
  const live = await db.pool.query(`select count(*)::int c from sui_object_leases where chain_id='sui:mainnet' and object_id=$1 and state in ('held','expired')`, [oid(1)]);
  assert.equal(live.rows[0].c, 1);
});
test('100 simultaneous requests over 10 coins: exactly 10 winners, each with a distinct object', async () => {
  const leaser = new SuiCoinLeaser(db.pool);
  const ten = Array.from({ length: 10 }, (_, i) => coin(100 + i, 5_000n));
  const results = await Promise.allSettled(Array.from({ length: 100 }, (_, i) => leaser.lease({ chainId: 'sui:testnet', owner: OWNER, intentId: `r10-${i}`, candidates: ten, gasNeed: 1000n })));
  const wins = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<SuiCoinLeaser['lease']>>> => r.status === 'fulfilled');
  assert.equal(wins.length, 10);
  assert.equal(new Set(wins.map((w) => w.value[0]!.objectId)).size, 10, 'all distinct objects');
});
test('gas coin and input coin are never the same object; gas best-fit keeps big coin for input', async () => {
  const leaser = new SuiCoinLeaser(db.pool);
  const cs = [coin(200, 2_000n), coin(201, 90_000n), coin(202, 40_000n)];
  const ls = await leaser.lease({ chainId: 'sui:mainnet', owner: OWNER, intentId: 'gi', candidates: cs, gasNeed: 1_500n, input: { coinType: '0x2::sui::SUI', need: 80_000n } });
  const gas = ls.find((l) => l.purpose === 'gas')!, inp = ls.filter((l) => l.purpose === 'input');
  assert.equal(gas.objectId, oid(200)); assert.deepEqual(inp.map((l) => l.objectId), [oid(201)]);
  const again = await leaser.lease({ chainId: 'sui:mainnet', owner: OWNER, intentId: 'gi', candidates: cs, gasNeed: 1_500n }); // idempotent
  assert.deepEqual(again.map((l) => l.id).sort(), ls.map((l) => l.id).sort());
  // multi-coin input accumulation when no single coin covers the need
  const multi = await leaser.lease({ chainId: 'sui:mainnet', owner: OWNER, intentId: 'multi', candidates: [coin(210, 30n), coin(211, 20n), coin(212, 10n)], input: { coinType: '0x2::sui::SUI', need: 45n } });
  assert.deepEqual(multi.map((l) => l.objectId).sort(), [oid(210), oid(211)].sort());
});
test('release frees the object; consume burns the version (stale candidates rejected, fresh version allowed)', async () => {
  const leaser = new SuiCoinLeaser(db.pool);
  const c1 = coin(300, 9_999n, 7n);
  await leaser.lease({ chainId: 'sui:mainnet', owner: OWNER, intentId: 'a', candidates: [c1], gasNeed: 10n });
  await assert.rejects(() => leaser.lease({ chainId: 'sui:mainnet', owner: OWNER, intentId: 'b', candidates: [c1], gasNeed: 10n }), LeaseError);
  assert.equal(await leaser.release('sui:mainnet', 'a'), 1);
  await leaser.lease({ chainId: 'sui:mainnet', owner: OWNER, intentId: 'b', candidates: [c1], gasNeed: 10n });
  assert.equal(await leaser.consume('sui:mainnet', 'b'), 1);
  await assert.rejects(() => leaser.lease({ chainId: 'sui:mainnet', owner: OWNER, intentId: 'c', candidates: [c1], gasNeed: 10n }), LeaseError); // same version = stale
  await assert.rejects(() => leaser.lease({ chainId: 'sui:mainnet', owner: OWNER, intentId: 'c2', candidates: [coin(300, 9_000n, 6n)], gasNeed: 10n }), LeaseError); // older version = stale
  const fresh = await leaser.lease({ chainId: 'sui:mainnet', owner: OWNER, intentId: 'd', candidates: [coin(300, 9_000n, 8n)], gasNeed: 10n }); // new version after execution
  assert.equal(fresh[0]!.version, 8n);
});
test('expired lease keeps BLOCKING until reconciled; resolve unused frees, consumed burns', async () => {
  const leaser = new SuiCoinLeaser(db.pool);
  const c1 = coin(400, 1_000n, 3n), c2 = coin(401, 1_000n, 3n);
  const l1 = await leaser.lease({ chainId: 'sui:mainnet', owner: OWNER, intentId: 'e1', candidates: [c1], gasNeed: 10n, ttlSeconds: 0 });
  await leaser.lease({ chainId: 'sui:mainnet', owner: OWNER, intentId: 'e2', candidates: [c2], gasNeed: 10n, ttlSeconds: 0 });
  assert.ok((await leaser.expireDue('sui:mainnet')) >= 2);
  await assert.rejects(() => leaser.lease({ chainId: 'sui:mainnet', owner: OWNER, intentId: 'e3', candidates: [c1], gasNeed: 10n }), LeaseError, 'expired but unresolved => still blocked');
  await leaser.resolveExpired(l1[0]!.id, 'unused');
  assert.equal((await leaser.lease({ chainId: 'sui:mainnet', owner: OWNER, intentId: 'e3', candidates: [c1], gasNeed: 10n }))[0]!.objectId, oid(400));
  const l2 = await db.pool.query(`select id from sui_object_leases where intent_id='e2'`);
  await leaser.resolveExpired(l2.rows[0].id, 'consumed');
  await assert.rejects(() => leaser.lease({ chainId: 'sui:mainnet', owner: OWNER, intentId: 'e4', candidates: [c2], gasNeed: 10n }), LeaseError, 'consumed version is stale');
  await assert.rejects(() => leaser.resolveExpired(l2.rows[0].id, 'unused'), (e: unknown) => e instanceof LeaseError && e.code === 'bad_state');
});
test('chains are independent: same object id on another chain is a different lease', async () => {
  const leaser = new SuiCoinLeaser(db.pool); const c1 = coin(500, 100n);
  await leaser.lease({ chainId: 'sui:mainnet', owner: OWNER, intentId: 'x', candidates: [c1], gasNeed: 1n });
  await leaser.lease({ chainId: 'sui:testnet', owner: OWNER, intentId: 'x', candidates: [c1], gasNeed: 1n });
});
test('DB invariant holds even when bypassing the function (unique live lease per object)', async () => {
  const leaser = new SuiCoinLeaser(db.pool);
  await leaser.lease({ chainId: 'sui:mainnet', owner: OWNER, intentId: 'bypass', candidates: [coin(600, 100n)], gasNeed: 1n });
  await assert.rejects(() => db.pool.query(`insert into sui_object_leases(chain_id,owner,object_id,coin_type,purpose,intent_id,object_version,balance,expires_at) values ('sui:mainnet',$1,$2,'0x2::sui::SUI','gas','sneak',10,100,now()+interval '1 minute')`, [OWNER, oid(600)]), /sui_lease_live_uq|duplicate/);
});
test('reserve model', () => { assert.equal(computeSuiReserve('sui:mainnet', { floor: 5n, perTxBudget: 10n, emergencyExitBudget: 20n }, { plannedTxCount: 3 }).total, 5n + 30n + 30n); });
test('rpc errors typed', async () => { await assert.rejects(() => new SuiRpcClient({ transport: xport({}) }).getReferenceGasPrice(), SuiRpcError); });
