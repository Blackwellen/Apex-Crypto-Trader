import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bech32Encode, bech32Decode } from './bech32.ts';
import { validateCosmosAddress, convertPrefix } from './address.ts';
import { ibcDenomHash, ibcDenom, resolveDenom, parseTracePath, canonicalAssetId } from './denom.ts';
import { computeFee, parseDec, meetsMinGasPrice } from './fees.ts';
import { SequenceTracker } from './sequence.ts';
import { newPacket, transition, applyEvent, settlement, isFinal, isTimeoutReached, validateChannel } from './ibc.ts';
import { CosmosLcdClient, validateMemo, type Transport } from './client.ts';
import { chainRecords } from './records.ts';
import { registerChain, COSMOS_CHAINS } from './config.ts';

test('bech32 BIP-173 official valid vectors', () => {
  for (const s of ['A12UEL5L', 'a12uel5l', 'an83characterlonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1tt5tgs', 'abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw', '?1ezyfcl'])
    assert.doesNotThrow(() => bech32Decode(s), s);
  for (const s of ['pzry9x0s0muk', '1pzry9x0s0muk', 'x1b4n0q5v', 'li1dgmt3', 'A1G7SGD8', '10a06t8', '1qzzfhee'])
    assert.throws(() => bech32Decode(s), s);
  const { hrp, data } = bech32Decode('abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw');
  assert.equal(bech32Encode(hrp, data), 'abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw');
});
test('cosmos address validation by prefix + prefix conversion', () => {
  const addr = bech32Encode('cosmos', (() => { const d = bech32Decode(bech32Encode('x', [])); return d.data; })().concat([]));
  assert.ok(addr);
  // build a real 20-byte address
  const bytes = Array.from({ length: 20 }, (_, i) => i * 7);
  const five = [] as number[]; { let acc = 0, bits = 0; for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; five.push((acc >> bits) & 31); } acc &= (1 << bits) - 1; } if (bits) five.push((acc << (5 - bits)) & 31); }
  const cosmos = bech32Encode('cosmos', five);
  assert.equal(validateCosmosAddress(cosmos, 'cosmos').valid, true);
  assert.equal(validateCosmosAddress(cosmos, 'osmo').valid, false);
  const osmo = convertPrefix(cosmos, 'cosmos', 'osmo');
  assert.equal(validateCosmosAddress(osmo, 'osmo').valid, true);
  assert.equal(validateCosmosAddress(cosmos.slice(0, -1) + (cosmos.endsWith('q') ? 'p' : 'q'), 'cosmos').valid, false);
  assert.equal(validateCosmosAddress(bech32Encode('cosmos', five.slice(0, 20)), 'cosmos').valid, false); // 12 bytes
  assert.equal(validateCosmosAddress('', 'cosmos').valid, false);
  assert.equal(validateCosmosAddress('0x' + '11'.repeat(20), 'cosmos').valid, false);
});
test('IBC denom hash: documented example ATOM on Osmosis (transfer/channel-0/uatom)', () => {
  assert.equal(ibcDenom('transfer/channel-0', 'uatom'), 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2');
  // live-verified against osmosis LCD denom_traces on 2026-10-13: CRO
  assert.equal(ibcDenomHash('transfer/channel-5', 'basecro'), 'E6931F78057F7CC5DA0FD6CEF82FF39373A6E0452BF1FD76910B93292CF356C1');
  assert.equal(ibcDenom('', 'uatom'), 'uatom');
});
test('denom resolver rejects spoofed traces', async () => {
  const H = '27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2';
  const good = await resolveDenom(`ibc/${H}`, async () => ({ path: 'transfer/channel-0', base_denom: 'uatom' }));
  assert.equal(good.kind, 'ibc'); if (good.kind === 'ibc') assert.deepEqual(good.hops, [{ port: 'transfer', channel: 'channel-0' }]);
  const bad = await resolveDenom(`ibc/${H}`, async () => ({ path: 'transfer/channel-9', base_denom: 'uatom' }));
  assert.equal(bad.kind, 'unresolved');
  assert.equal((await resolveDenom('ibc/abc', async () => null)).kind, 'unresolved');
  assert.equal((await resolveDenom(`ibc/${H}`, async () => null)).kind, 'unresolved');
  assert.equal((await resolveDenom('uosmo', async () => null)).kind, 'native');
  assert.equal((await resolveDenom('factory/osmo1abc/foo', async () => null)).kind, 'factory');
  assert.equal(canonicalAssetId('osmosis-1', good), `cosmos:osmosis-1/ibc:${H}`);
  assert.deepEqual(parseTracePath('transfer/channel-1/transfer/channel-2').length, 2);
  assert.throws(() => parseTracePath('transfer/channel-1/transfer'));
  assert.throws(() => parseTracePath('transfer/notachannel'));
});
test('gas/fee model', () => {
  assert.equal(parseDec('0.0025'), 2_500_000_000_000_000n);
  const r = computeFee({ gasUsedSimulated: 100_000n, gasAdjustmentBps: 13_000n, gasPrice: { denom: 'uatom', amount: '0.0025' }, allowedFeeDenoms: ['uatom'], maxFee: 10_000n });
  assert.deepEqual(r, { gasLimit: 130_000n, feeDenom: 'uatom', feeAmount: 325n });
  assert.equal(computeFee({ gasUsedSimulated: 1n, gasAdjustmentBps: 10_000n, gasPrice: { denom: 'uatom', amount: '0.0025' }, allowedFeeDenoms: ['uatom'], maxFee: 10n }).feeAmount, 1n); // ceil
  assert.throws(() => computeFee({ gasUsedSimulated: 100_000n, gasAdjustmentBps: 13_000n, gasPrice: { denom: 'uatom', amount: '0.0025' }, allowedFeeDenoms: ['uatom'], maxFee: 100n }), /cap/);
  assert.throws(() => computeFee({ gasUsedSimulated: 1n, gasAdjustmentBps: 10_000n, gasPrice: { denom: 'ufoo', amount: '1' }, allowedFeeDenoms: ['uatom'], maxFee: 10n }), /not accepted/);
  assert.throws(() => parseDec('1e3'));
  assert.equal(meetsMinGasPrice({ denom: 'uatom', amount: '0.0025' }, [{ denom: 'uatom', amount: '0.0030' }]), false);
  assert.equal(meetsMinGasPrice({ denom: 'uatom', amount: '0.0030' }, [{ denom: 'uatom', amount: '0.0030' }]), true);
});
test('sequence tracker: concurrent reserve + mismatch resync', () => {
  const t = new SequenceTracker();
  assert.throws(() => t.reserve('a'), /not seeded/);
  t.seed('a', 5n);
  assert.deepEqual([t.reserve('a'), t.reserve('a'), t.reserve('a')], [5n, 6n, 7n]);
  t.seed('a', 6n); assert.equal(t.reserve('a'), 8n); // stale chain read does not lower
  assert.equal(t.onBroadcastError('a', 'account sequence mismatch, expected 12, got 9: incorrect account sequence'), 12n);
  assert.equal(t.reserve('a'), 12n);
  assert.equal(t.onBroadcastError('a', 'out of gas'), null);
  assert.equal(t.releaseUnbroadcast('a', 12n), true);
});
const pkt = () => newPacket({ sourcePort: 'transfer', sourceChannel: 'channel-0', destPort: 'transfer', destChannel: 'channel-141', sequence: 9n, timeoutTimestampNs: 1_000n }, 1);
test('IBC lifecycle: sent is NOT final', () => {
  let p = pkt();
  assert.equal(settlement(p), 'in_flight'); assert.equal(isFinal(p), false);
  p = transition(p, 'RECEIVED', 2); assert.equal(isFinal(p), false);
  p = transition(p, 'ACKNOWLEDGED', 3, 'success'); assert.equal(settlement(p), 'delivered'); assert.equal(isFinal(p), true);
  const e = transition(transition(pkt(), 'RECEIVED', 2), 'ACKNOWLEDGED', 3, 'error'); assert.equal(settlement(e), 'refunded');
  const t = transition(pkt(), 'TIMED_OUT', 2); assert.equal(settlement(t), 'refunded');
});
test('IBC illegal transitions and idempotent events', () => {
  assert.throws(() => transition(pkt(), 'ACKNOWLEDGED', 2, 'success'), /illegal/);
  assert.throws(() => transition(transition(pkt(), 'RECEIVED', 2), 'TIMED_OUT', 3), /illegal/);
  assert.throws(() => transition(pkt(), 'RECEIVED', 2, 'success'), /ack only/);
  assert.throws(() => newPacket({ sourcePort: 'transfer', sourceChannel: 'channel-0', destPort: 'transfer', destChannel: 'channel-1', sequence: 1n }, 0), /timeout/);
  let p = applyEvent(pkt(), { type: 'ack', ack: 'success' }, 5); // recv event lost
  assert.equal(p.state, 'ACKNOWLEDGED');
  assert.equal(applyEvent(p, { type: 'ack', ack: 'success' }, 6), p); // duplicate
  assert.equal(applyEvent(p, { type: 'recv' }, 6), p);
  assert.throws(() => applyEvent(p, { type: 'ack', ack: 'error' }, 6), /conflicting/);
  assert.throws(() => applyEvent(p, { type: 'timeout' }, 6), /inconsistent/);
  const to = applyEvent(pkt(), { type: 'timeout' }, 2);
  assert.equal(applyEvent(to, { type: 'timeout' }, 3), to);
  assert.throws(() => applyEvent(to, { type: 'ack', ack: 'success' }, 3), /inconsistent/);
});
test('timeout reached by height or timestamp', () => {
  const p = newPacket({ sourcePort: 'transfer', sourceChannel: 'channel-0', destPort: 'transfer', destChannel: 'channel-1', sequence: 1n, timeoutHeight: { revisionNumber: 1n, revisionHeight: 100n } }, 0);
  assert.equal(isTimeoutReached(p, { revisionNumber: 1n, height: 99n, timeNs: 0n }), false);
  assert.equal(isTimeoutReached(p, { revisionNumber: 1n, height: 100n, timeNs: 0n }), true);
  assert.equal(isTimeoutReached(p, { revisionNumber: 2n, height: 1n, timeNs: 0n }), true);
  assert.equal(isTimeoutReached(pkt(), { revisionNumber: 1n, height: 1n, timeNs: 999n }), false);
  assert.equal(isTimeoutReached(pkt(), { revisionNumber: 1n, height: 1n, timeNs: 1000n }), true);
});
test('channel validation', () => {
  const ok = { state: 'STATE_OPEN', ordering: 'ORDER_UNORDERED', counterparty: { port_id: 'transfer', channel_id: 'channel-141' }, connection_hops: ['connection-0'], port_id: 'transfer' };
  assert.equal(validateChannel(ok, { port: 'transfer', channel: 'channel-0', counterpartyChannel: 'channel-141' }).valid, true);
  assert.equal(validateChannel({ ...ok, state: 'STATE_CLOSED' }, { port: 'transfer', channel: 'channel-0', counterpartyChannel: 'channel-141' }).valid, false);
  assert.equal(validateChannel(ok, { port: 'transfer', channel: 'channel-0', counterpartyChannel: 'channel-999' }).valid, false);
  assert.equal(validateChannel({ ...ok, connection_hops: ['a', 'b'] }, { port: 'transfer', channel: 'channel-0', counterpartyChannel: 'channel-141' }).valid, false);
});
test('LCD client with injected transport', async () => {
  const routes: Record<string, unknown> = {
    '/cosmos/base/tendermint/v1beta1/node_info': { default_node_info: { network: 'cosmoshub-4' }, application_version: { app_name: 'gaiad', version: 'v28.3.0' } },
    '/cosmos/bank/v1beta1/balances/cosmos1x': { balances: [{ denom: 'uatom', amount: '123' }] },
    '/cosmos/auth/v1beta1/accounts/cosmos1x': { account: { '@type': '/cosmos.auth.v1beta1.BaseAccount', account_number: '7', sequence: '3' } },
    '/cosmos/base/node/v1beta1/config': { minimum_gas_price: '0.005uatom,0.01ibc/ABC' },
    '/cosmos/auth/v1beta1/params': { params: { max_memo_characters: '256' } },
  };
  const t: Transport = async (r) => { const p = new URL(r.url).pathname; return p in routes ? { status: 200, json: routes[p] } : { status: 404, json: { code: 5 } }; };
  const c = new CosmosLcdClient('https://lcd', t);
  assert.equal((await c.getNodeInfo()).network, 'cosmoshub-4');
  assert.deepEqual(await c.getBalances('cosmos1x'), [{ denom: 'uatom', amount: 123n }]);
  assert.deepEqual(await c.getAccountSequence('cosmos1x'), { accountNumber: 7n, sequence: 3n });
  assert.equal(await c.getAccountSequence('cosmos1new'), null);
  assert.deepEqual((await c.getMinGasPrices()).map((g) => g.denom), ['uatom', 'ibc/ABC']);
  assert.equal(await c.getMaxMemoChars(), 256);
  assert.equal(validateMemo('x'.repeat(257), 256).ok, false); assert.equal(validateMemo('hi', 0).ok, false);
  await assert.rejects(new CosmosLcdClient('https://lcd', async () => ({ status: 500, json: {} })).getNodeInfo(), /HTTP 500/);
});
test('records + extensible config', () => {
  assert.deepEqual(chainRecords.map((r) => r.id), ['cosmos:cosmoshub-4', 'cosmos:osmosis-1']);
  for (const r of chainRecords) for (const c of Object.values(r.capabilities)) assert.notEqual(c.status, 'CERTIFIED');
  const more = registerChain({ chainId: 'neutron-1', name: 'Neutron', bech32Prefix: 'neutron', nativeDenom: 'untrn', nativeSymbol: 'NTRN', decimals: 6, feeDenoms: ['untrn'], lcd: [], isTestnet: false });
  assert.equal(more.length, COSMOS_CHAINS.length + 1);
  assert.throws(() => registerChain(COSMOS_CHAINS[0]!));
});
