import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateNearAccountId, canCreateSubAccount } from './account.ts';
import { TGAS, YOCTO_PER_NEAR, gasFeeYocto, checkPrepaidGas, spendableYocto, NonceManager, validateTxNonce, blockHashStillValid, classifyTxStatus } from './model.ts';
import { NearRpcClient, NearRpcError, type Transport } from './client.ts';
import { chainRecords } from './records.ts';

test('account id rules (nomicon examples)', () => {
  for (const ok of ['alice.near', 'bob_the-builder.near', 'a1', 'near', 'sub.alice.near', 'a'.repeat(64).replace(/a/g, 'b').slice(0, 63) + 'c', '1'.repeat(64), 'deadbeef'.repeat(8), '0x' + 'ab'.repeat(20)])
    assert.equal(validateNearAccountId(ok).valid, true, ok);
  for (const bad of ['a', 'Alice.near', 'alice..near', '.alice', 'alice.', 'alice-.near', '-alice', 'al_-ice', 'alice@near', 'a'.repeat(65), 'alice near', '', '0x' + 'AB'.repeat(20)])
    assert.equal(validateNearAccountId(bad).valid, false, bad);
  assert.equal(validateNearAccountId('deadbeef'.repeat(8)).kind, 'near-implicit');
  assert.equal(validateNearAccountId('0x' + 'ab'.repeat(20)).kind, 'eth-implicit');
  assert.deepEqual([validateNearAccountId('sub.alice.near').kind, validateNearAccountId('sub.alice.near').parent], ['named', 'alice.near']);
  assert.equal(canCreateSubAccount('alice.near', 'sub.alice.near'), true);
  assert.equal(canCreateSubAccount('mallory.near', 'sub.alice.near'), false);
});
test('gas in TGas / yocto', () => {
  assert.equal(TGAS, 10n ** 12n);
  assert.equal(gasFeeYocto(30n * TGAS, 100_000_000n), 3_000_000_000_000_000_000_000n);
  const ok = checkPrepaidGas({ gasUnits: 30n * TGAS, gasPriceYocto: 100_000_000n, maxTotalPrepaidGas: 300n * TGAS, attachedDepositYocto: YOCTO_PER_NEAR, spendableYocto: 2n * YOCTO_PER_NEAR });
  assert.equal(ok.ok, true);
  assert.equal(checkPrepaidGas({ gasUnits: 301n * TGAS, gasPriceYocto: 1n, maxTotalPrepaidGas: 300n * TGAS, attachedDepositYocto: 0n, spendableYocto: 10n ** 30n }).ok, false);
  assert.equal(checkPrepaidGas({ gasUnits: 30n * TGAS, gasPriceYocto: 100_000_000n, maxTotalPrepaidGas: 300n * TGAS, attachedDepositYocto: 2n * YOCTO_PER_NEAR, spendableYocto: 2n * YOCTO_PER_NEAR }).ok, false);
  assert.throws(() => gasFeeYocto(1n, 0n));
  assert.equal(spendableYocto({ amount: 5n * YOCTO_PER_NEAR, locked: 0n, storageUsageBytes: 100_000n, storageAmountPerByte: 10n ** 19n }), 4n * YOCTO_PER_NEAR);
  assert.equal(spendableYocto({ amount: 1n, locked: 5n, storageUsageBytes: 0n, storageAmountPerByte: 1n }), 0n);
});
test('nonce manager + validity', () => {
  const n = new NonceManager();
  assert.throws(() => n.reserve('a', 'k'), /not seeded/);
  n.seed('a', 'k', 100n);
  assert.deepEqual([n.reserve('a', 'k'), n.reserve('a', 'k')], [101n, 102n]);
  n.seed('a', 'k', 50n); assert.equal(n.reserve('a', 'k'), 103n);
  assert.equal(n.onError('a', 'k', 'InvalidNonce { tx_nonce: 90, ak_nonce: 200 }'), 201n);
  assert.equal(n.reserve('a', 'k'), 201n);
  assert.equal(validateTxNonce(101n, 100n, 1000n, 1_000_000n).ok, true);
  assert.equal(validateTxNonce(100n, 100n, 1000n, 1_000_000n).ok, false);
  assert.equal(validateTxNonce(2_000_000_000n, 100n, 1000n, 1_000_000n).ok, false);
  assert.equal(blockHashStillValid(100n, 150n, 86400n), true); assert.equal(blockHashStillValid(100n, 100n + 86400n, 86400n), false);
});
test('finality classification', () => {
  assert.equal(classifyTxStatus({ finalExecutionStatus: 'FINAL' }).state, 'final');
  assert.equal(classifyTxStatus({ finalExecutionStatus: 'EXECUTED_OPTIMISTIC' }).state, 'included');
  assert.equal(classifyTxStatus({ finalExecutionStatus: 'EXECUTED', failure: true }).state, 'pending');
  assert.equal(classifyTxStatus({ finalExecutionStatus: 'FINAL', failure: true }).state, 'failed');
  assert.equal(classifyTxStatus({}).state, 'unknown');
});
test('rpc client', async () => {
  const t: Transport = async (r) => {
    const b = r.body as any;
    if (b.method === 'status') return { status: 200, json: { result: { chain_id: 'mainnet', protocol_version: 86, sync_info: { latest_block_height: 5, latest_block_hash: 'h', syncing: false } } } };
    if (b.method === 'gas_price') return { status: 200, json: { result: { gas_price: '100000000' } } };
    if (b.method === 'query') return { status: 200, json: { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } } } };
    return { status: 500, json: null };
  };
  const c = new NearRpcClient('https://x', t);
  assert.equal((await c.status()).chainId, 'mainnet'); assert.equal(await c.gasPriceYocto(), 100000000n);
  assert.equal(await c.viewAccount('nobody.near'), null);
  await assert.rejects(c.protocolConfig(), NearRpcError);
});
test('record: execution UNSUPPORTED with blocker', () => {
  const c = chainRecords[0]!.capabilities;
  for (const k of ['submit', 'buildTransaction', 'transfer'] as const) { assert.equal(c[k].status, 'UNSUPPORTED'); assert.match(c[k].note ?? '', /blocker/); }
  for (const v of Object.values(c)) assert.notEqual(v.status, 'CERTIFIED');
});
