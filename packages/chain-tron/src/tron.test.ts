import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base58CheckEncode, base58CheckDecode, fromHex, toHex, sha256 } from './base58.ts';
import { validateTronAddress, tronBase58ToHex } from './address.ts';
import { parseChainParameters, estimateBurn, safeFeeLimit, trxReserve, classifyContractType, txBandwidthBytes, type GetChainParametersResponse } from './fees.ts';
import { TronClient, TronApiError, type Transport } from './client.ts';
import { TronAdapter } from './adapter.ts';
import { chainRecords } from './records.ts';

// Fixture shape per developers.tron.network /wallet/getchainparameters ({"chainParameter":[{"key","value"}...]}); zero values omitted by node.
const PARAMS: GetChainParametersResponse = { chainParameter: [
  { key: 'getMaintenanceTimeInterval', value: 21600000 }, { key: 'getCreateAccountFee', value: 100000 }, { key: 'getTransactionFee', value: 1000 },
  { key: 'getCreateNewAccountFeeInSystemContract', value: 1000000 }, { key: 'getEnergyFee', value: 100 }, { key: 'getMaxFeeLimit', value: 15000000000 },
  { key: 'getFreeNetLimit', value: 600 }, { key: 'getMemoFee', value: 1000000 }, { key: 'getAllowDynamicEnergy', value: 1 }, { key: 'getDynamicEnergyMaxFactor', value: 34000 },
  { key: 'getAllowMarketTransaction' },
] };

test('base58check roundtrip and checksum failure', () => {
  const p = fromHex('41' + '00'.repeat(20));
  const s = base58CheckEncode(p);
  assert.equal(s, 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'); // well-known all-zero TRON address
  assert.deepEqual(base58CheckDecode(s), p);
  assert.throws(() => base58CheckDecode(s.slice(0, -1) + 'c'), /checksum/);
});
test('sha256 known vector', () => {
  assert.equal(toHex(sha256(new TextEncoder().encode('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
test('address validation', () => {
  assert.equal(validateTronAddress('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb').valid, true);
  assert.equal(tronBase58ToHex('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'), '41' + '00'.repeat(20));
  // real witness address from live getnowblock (hex form) converts and revalidates
  const w = validateTronAddress('4104d7c791ace5750943fc8330b4a285b365dcbb42');
  assert.equal(w.valid, true); assert.equal(validateTronAddress(w.normalized!).valid, true);
  // flipped char => checksum invalid
  const bad = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwc';
  assert.equal(validateTronAddress(bad).valid, false);
  assert.equal(validateTronAddress('0x' + '11'.repeat(20)).valid, false);
  assert.equal(validateTronAddress('').valid, false);
  // wrong prefix byte with valid checksum
  const wrongPrefix = base58CheckEncode(fromHex('42' + '00'.repeat(20)));
  assert.match(validateTronAddress(wrongPrefix).reason ?? '', /0x41|T/);
  // bitcoin address is not TRON
  assert.equal(validateTronAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2').valid, false);
});
test('chain params parsed; missing required key throws; zero-omitted => 0', () => {
  const p = parseChainParameters(PARAMS);
  assert.equal(p.energyFeeSun, 100n); assert.equal(p.bandwidthFeeSun, 1000n); assert.equal(p.maxFeeLimitSun, 15000000000n);
  assert.equal(p.raw['getAllowMarketTransaction'], 0n);
  assert.throws(() => parseChainParameters({ chainParameter: [{ key: 'getEnergyFee', value: 100 }] }), /required key/);
  assert.throws(() => parseChainParameters({} as any), /missing/);
});
test('model follows parameters (change energy price => change burn)', () => {
  const p1 = parseChainParameters(PARAMS);
  const p2 = parseChainParameters({ chainParameter: PARAMS.chainParameter.map((e) => e.key === 'getEnergyFee' ? { key: e.key, value: 420 } : e) });
  const input = { kind: 'contract_call' as const, bandwidthBytes: 345n, energyRequired: 65_000n, resources: { stakedBandwidthAvailable: 0n, freeBandwidthAvailable: 0n, energyAvailable: 0n } };
  assert.equal(estimateBurn({ ...input, params: p1 }).energyBurnSun, 6_500_000n);
  assert.equal(estimateBurn({ ...input, params: p2 }).energyBurnSun, 27_300_000n);
});
test('burn: native transfer uses free bandwidth, no energy; exhaustion burns TRX', () => {
  const params = parseChainParameters(PARAMS);
  const bytes = txBandwidthBytes(134);
  const r = { stakedBandwidthAvailable: 0n, freeBandwidthAvailable: 600n, energyAvailable: 0n };
  const a = estimateBurn({ kind: 'native_transfer', bandwidthBytes: bytes, resources: r, params });
  assert.equal(a.bandwidthSource, 'free'); assert.equal(a.totalBurnSun, 0n);
  const b = estimateBurn({ kind: 'native_transfer', bandwidthBytes: bytes, resources: { ...r, freeBandwidthAvailable: 10n }, params });
  assert.equal(b.bandwidthSource, 'burn'); assert.equal(b.totalBurnSun, bytes * 1000n);
  const c = estimateBurn({ kind: 'native_transfer', bandwidthBytes: bytes, recipientIsNewAccount: true, resources: r, params });
  assert.equal(c.activationBurnSun, 1_000_000n);
});
test('burn: contract call uses staked energy first, flags missing estimate, dynamic energy penalty', () => {
  const params = parseChainParameters(PARAMS);
  const res = { stakedBandwidthAvailable: 1000n, freeBandwidthAvailable: 0n, energyAvailable: 40_000n };
  const r = estimateBurn({ kind: 'contract_call', bandwidthBytes: 300n, energyRequired: 65_000n, resources: res, params });
  assert.equal(r.energyUsedFromStake, 40_000n); assert.equal(r.energyBurned, 25_000n); assert.equal(r.energyBurnSun, 2_500_000n);
  const pen = estimateBurn({ kind: 'contract_call', bandwidthBytes: 300n, energyRequired: 10_000n, dynamicEnergyPenaltyBps: 5000n, resources: { ...res, energyAvailable: 0n }, params });
  assert.equal(pen.energyBurned, 15_000n);
  assert.ok(estimateBurn({ kind: 'contract_call', bandwidthBytes: 300n, resources: res, params }).notes.some((n) => /UNDERESTIMATED/.test(n)));
});
test('fee_limit bounds', () => {
  const params = parseChainParameters(PARAMS);
  const ok = safeFeeLimit({ energyEstimate: 65_000n, params, bufferBps: 2000n, spendableSun: 100_000_000n, policyCapSun: 50_000_000n });
  assert.deepEqual([ok.ok, ok.feeLimitSun], [true, 7_800_000n]);
  const cap = safeFeeLimit({ energyEstimate: 65_000n, params, bufferBps: 2000n, spendableSun: 100_000_000n, policyCapSun: 7_000_000n });
  assert.deepEqual([cap.ok, cap.clampedBy], [true, 'policy']);
  const low = safeFeeLimit({ energyEstimate: 65_000n, params, bufferBps: 0n, spendableSun: 5_000_000n, policyCapSun: 50_000_000n });
  assert.equal(low.ok, false); assert.match(low.reason!, /OUT_OF_ENERGY/);
  const huge = safeFeeLimit({ energyEstimate: 1_000_000_000n, params, bufferBps: 0n, spendableSun: 10n ** 15n, policyCapSun: 10n ** 15n });
  assert.equal(huge.ok, false); // clamped to network max below needed
  assert.equal(safeFeeLimit({ energyEstimate: 0n, params, bufferBps: 0n, spendableSun: 1n, policyCapSun: 1n }).ok, false);
});
test('contract class + reserve', () => {
  assert.equal(classifyContractType('TransferContract'), 'native_transfer');
  assert.equal(classifyContractType('TriggerSmartContract'), 'contract_call');
  assert.equal(classifyContractType('VoteWitnessContract'), 'other');
  const params = parseChainParameters(PARAMS);
  const r = trxReserve({ params, plannedTxCount: 3, perTx: { bandwidthBytes: 350n, energy: 65_000n }, exit: { bandwidthBytes: 350n, energy: 130_000n }, floorSun: 2_000_000n });
  assert.equal(r.nextNTxEstimate, 3n * (350_000n + 6_500_000n)); assert.equal(r.emergencyExit, 350_000n + 13_000_000n);
  assert.equal(r.total, r.floor + r.nextNTxEstimate + r.emergencyExit);
});
const fake = (routes: Record<string, unknown>, status = 200): Transport => async (req) => {
  const k = new URL(req.url).pathname;
  if (!(k in routes)) return { status: 404, json: { Error: 'nf' } };
  return { status, json: routes[k] };
};
test('client with injected transport', async () => {
  const c = new TronClient('https://x', fake({
    '/wallet/getnowblock': { blockID: '00ab', block_header: { raw_data: { number: 87082070, timestamp: 1791919104000 } } },
    '/wallet/getchainparameters': PARAMS,
    '/wallet/getaccount': {},
    '/wallet/gettransactioninfobyid': {},
    '/walletsolidity/getnowblock': { block_header: { raw_data: { number: 87082051 } } },
  }));
  assert.equal((await c.getNowBlock()).number, 87082070n);
  assert.equal((await c.getChainParameters()).energyFeeSun, 100n);
  assert.deepEqual(await c.getAccount('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'), { address: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', balanceSun: 0n, exists: false });
  assert.equal(await c.getTransactionInfo('a'.repeat(64)), null);
  assert.equal(await c.getSolidifiedBlockNumber(), 87082051n);
  await assert.rejects(c.getAccount('nope'), TronApiError);
  await assert.rejects(new TronClient('https://x', fake({}, 500)).getNowBlock(), /HTTP|404/);
});
test('adapter: execution fails closed; reserve requires loaded params', async () => {
  const a = new TronAdapter(fake({ '/wallet/getchainparameters': PARAMS }));
  assert.throws(() => a.nativeReserveRequired('tron:0x2b6653dc', { plannedTxCount: 1 }), /not loaded/);
  await a.getFeeQuote('tron:0x2b6653dc');
  assert.ok(a.nativeReserveRequired('tron:0x2b6653dc', { plannedTxCount: 2 }).total > 0n);
  await assert.rejects(a.submit('tron:0x2b6653dc'), /fail closed/);
});
test('chain records never CERTIFIED and carry provenance', () => {
  assert.deepEqual(chainRecords.map((r) => r.id), ['tron:0x2b6653dc', 'tron:0xcd8690dc']);
  for (const r of chainRecords) {
    assert.ok(r.verifiedFrom.length > 0); assert.equal(r.enabled, false);
    for (const c of Object.values(r.capabilities)) assert.notEqual(c.status, 'CERTIFIED');
  }
});
