import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTonAddress, toFriendly, sameTonAccount, crc16 } from './address.ts';
import { validateWalletMessage, resolveMessage, estimateTonFee, TON_FEE_NOTE } from './messages.ts';
import { ToncenterClient, TonApiError, type Transport } from './client.ts';
import { chainRecords } from './records.ts';

const RAW = '0:ca6e321c7cce9ecedf0a8ca2492ec8592494aa5fb5ce0387dff96ef6af982a3e';
// Vectors cross-checked live against toncenter detectAddress on 2026-10-13
const B = 'EQDKbjIcfM6ezt8KjKJJLshZJJSqX7XOA4ff-W72r5gqPrHF', NB = 'UQDKbjIcfM6ezt8KjKJJLshZJJSqX7XOA4ff-W72r5gqPuwA';
test('crc16 xmodem check value', () => assert.equal(crc16(new TextEncoder().encode('123456789')), 0x31c3));
test('friendly/raw validation + conversion', () => {
  const r = validateTonAddress(B); assert.deepEqual([r.valid, r.bounceable, r.workchain, r.raw], [true, true, 0, RAW]);
  assert.equal(validateTonAddress(NB).bounceable, false);
  assert.equal(validateTonAddress(RAW).valid, true);
  assert.equal(toFriendly(RAW, { bounceable: true }), B);
  assert.equal(toFriendly(RAW, { bounceable: false }), NB);
  assert.equal(validateTonAddress('EQDKbjIcfM6ezt8KjKJJLshZJJSqX7XOA4ff+W72r5gqPrHF').valid, true); // std base64 form
  assert.equal(sameTonAccount(B, NB), true); assert.equal(sameTonAccount(B, RAW), true);
  assert.equal(validateTonAddress(toFriendly(RAW, { bounceable: true, testnetOnly: true })).testnetOnly, true);
});
test('rejects corrupted / foreign addresses', () => {
  assert.equal(validateTonAddress(B.slice(0, -1) + 'A').valid, false);
  assert.match(validateTonAddress(B.slice(0, 10) + 'x' + B.slice(11)).reason ?? '', /CRC/);
  assert.equal(validateTonAddress(B.slice(1)).valid, false);
  assert.equal(validateTonAddress('0:abcd').valid, false);
  assert.equal(validateTonAddress('5:' + 'a'.repeat(64)).valid, false);
  assert.equal(validateTonAddress('0x' + '11'.repeat(20)).valid, false);
  assert.equal(validateTonAddress('').valid, false);
});
test('message validity window and seqno', () => {
  const m = { seqno: 982, validUntil: 1_000_060, subwalletId: 698983191, sendMode: 3, bounce: true };
  assert.equal(validateWalletMessage(m, 1_000_000, 982).ok, true);
  assert.equal(validateWalletMessage(m, 1_000_000, 983).ok, false);
  assert.equal(validateWalletMessage({ ...m, validUntil: 1_000_010 }, 1_000_000, 982).ok, false);
  assert.equal(validateWalletMessage({ ...m, validUntil: 1_005_000 }, 1_000_000, 982).ok, false);
  assert.equal(validateWalletMessage({ ...m, seqno: -1 }, 1_000_000, 982).ok, false);
});
test('message resolution: only re-sign after expiry with unchanged seqno', () => {
  const m = { seqno: 5, validUntil: 100, subwalletId: 0, sendMode: 3, bounce: true };
  assert.deepEqual([resolveMessage(m, 50, 5).state, resolveMessage(m, 50, 5).safeToResign], ['pending', false]);
  assert.deepEqual([resolveMessage(m, 101, 5).state, resolveMessage(m, 101, 5).safeToResign], ['expired_unsent', true]);
  assert.deepEqual([resolveMessage(m, 50, 6).state, resolveMessage(m, 50, 6).safeToResign], ['consumed', false]);
  assert.equal(resolveMessage(m, 500, 6).safeToResign, false);
});
test('fee model and note', () => {
  assert.equal(estimateTonFee({ gasUsed: 10_000n, gasPriceNanoPerGas: 400n, forwardFeeNano: 1_000_000n, storageFeeNano: 0n, hops: 2n }), 6_000_000n);
  assert.throws(() => estimateTonFee({ gasUsed: 1n, gasPriceNanoPerGas: 0n, forwardFeeNano: 0n, storageFeeNano: 0n, hops: 1n }));
  assert.match(TON_FEE_NOTE, /config param 21/);
});
test('client; unknown seqno is null not 0', async () => {
  const t: Transport = async (r) => {
    const m = new URL(r.url).pathname.split('/').pop();
    if (m === 'getWalletInformation') return { status: 200, json: { ok: true, result: { wallet: false, balance: '5', account_state: 'uninitialized' } } };
    return { status: 429, json: { ok: false, error: 'rate' } };
  };
  const c = new ToncenterClient('https://x', t);
  assert.deepEqual(await c.getWalletInfo(B), { balance: 5n, seqno: null, state: 'uninitialized', isWallet: false });
  await assert.rejects(c.getMasterchainInfo(), TonApiError);
});
test('record: execution UNSUPPORTED with blocker, never CERTIFIED', () => {
  const c = chainRecords[0]!.capabilities;
  for (const k of ['submit', 'buildTransaction', 'transfer', 'signThroughPolicyService'] as const) { assert.equal(c[k].status, 'UNSUPPORTED'); assert.match(c[k].note ?? '', /blocker/); }
  for (const v of Object.values(c)) assert.notEqual(v.status, 'CERTIFIED');
  assert.equal(chainRecords[0]!.unverified, true);
});
