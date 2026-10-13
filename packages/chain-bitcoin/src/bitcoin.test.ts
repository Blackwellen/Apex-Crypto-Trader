import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBitcoinAddress } from './address.ts';
import { segwitEncode, bech32Decode } from './segwit.ts';
import { base58CheckEncode } from './base58.ts';
import { txVsize, txWeight, feeForVsize, DUST_LIMIT, satPerVbToKvb, btcPerKvbToSatKvb, chooseFeeRate, checkRbfReplacement, cpfpChildFee, classifyFinality, requiredDepth, BITCOIN_NOT_AMM } from './fees.ts';
import { selectCoins, SelectionError, eligible, type Utxo, type SelectParams, type TxOutput } from './utxo.ts';
import { EsploraClient, type Transport } from './client.ts';
import { chainRecords } from './records.ts';
import { BitcoinAdapter } from './adapter.ts';

test('BIP173/BIP350 valid vectors', () => {
  const ok: [string, string, string][] = [
    ['BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', 'p2wpkh', 'mainnet'],
    ['tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7', 'p2wsh', 'testnet'],
    ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', 'p2tr', 'mainnet'],
    ['tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c', 'p2tr', 'testnet'],
    ['1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'p2pkh', 'mainnet'], ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'p2pkh', 'mainnet'],
    ['3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'p2sh', 'mainnet'],
    ['mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', 'p2pkh', 'testnet'], ['2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc', 'p2sh', 'testnet'],
  ];
  for (const [a, t, n] of ok) { const r = validateBitcoinAddress(a); assert.equal(r.valid, true, a + ' ' + r.reason); assert.equal(r.type, t, a); assert.equal(r.network, n, a); }
});
test('BIP173/BIP350 invalid vectors', () => {
  const bad = [
    'tc1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', 'BC13W508D6QEJXTDG4Y5R3ZARVARY0C5XW7KN40WF2', 'bc1rw5uspcuh',
    'bc10w508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kw5rljs90',
    'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd', // bech32 checksum on v1
    'tb1z0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqglt7rf',
    'BC1S0XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ54WELL',
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh', // bech32m on v0
    'tb1q0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq24jc47',
    'bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4', // invalid char
    'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7kv8f3t4', // mixed case
    '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3', // base58 bad checksum
    '', '0x' + '11'.repeat(20),
    'bc1sw50qgdz25j', // v16: valid bech32m but unsupported by policy
  ];
  for (const a of bad) assert.equal(validateBitcoinAddress(a).valid, false, a);
});
test('network expectation enforced', () => {
  assert.equal(validateBitcoinAddress('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'testnet').valid, false);
  assert.equal(validateBitcoinAddress('tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7', 'mainnet').valid, false);
  assert.equal(validateBitcoinAddress('tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7', 'testnet').valid, true);
  const prog = Array.from({ length: 20 }, (_, i) => i);
  assert.equal(validateBitcoinAddress(segwitEncode('bc', 0, prog)).type, 'p2wpkh');
  assert.equal(bech32Decode(segwitEncode('bc', 1, Array(32).fill(7))).variant, 'bech32m');
  assert.equal(validateBitcoinAddress(base58CheckEncode(Uint8Array.from([0x00, ...Array(20).fill(1)]))).type, 'p2pkh');
});
test('weights / vsize known values', () => {
  assert.equal(txVsize(['p2wpkh'], ['p2wpkh', 'p2wpkh']), 141n); // widely-cited 1-in-2-out P2WPKH = 141 vB
  assert.equal(txVsize(['p2pkh'], ['p2pkh', 'p2pkh']), 226n);     // 1-in-2-out legacy = 226 B
  assert.equal(txWeight(['p2pkh'], ['p2pkh']) % 4, 0);
  assert.equal(feeForVsize(1000n, 141n), 141n);
  assert.equal(feeForVsize(1500n, 141n), 212n); // ceil(211.5)
  assert.equal(satPerVbToKvb('1.5'), 1500n); assert.equal(btcPerKvbToSatKvb('0.00001'), 1000n);
  assert.throws(() => satPerVbToKvb('-1')); assert.throws(() => satPerVbToKvb('1e3'));
});
test('fee rate choice clamps and rejects nonsense', () => {
  const rec = { fastestFee: 20, halfHourFee: 10, hourFee: 5, economyFee: 2, minimumFee: 1 };
  const o = { minRelayFeeSatKvb: 1000n, maxFeeRateSatKvb: 15_000n };
  assert.equal(chooseFeeRate(rec, 'halfHour', o).satPerKvb, 10_000n);
  assert.deepEqual(chooseFeeRate(rec, 'fastest', o), { satPerKvb: 15_000n, source: 'mempool.space:fastest', clampedBy: 'cap' });
  assert.equal(chooseFeeRate({ ...rec, economyFee: 1, minimumFee: 1 }, 'economy', { ...o, minRelayFeeSatKvb: 2000n }).clampedBy, 'min');
  assert.throws(() => chooseFeeRate({ ...rec, hourFee: 50 }, 'hour', o), /monotone/);
  assert.throws(() => chooseFeeRate({ ...rec, minimumFee: 0 }, 'hour', o), /non-positive/);
});
test('BIP125 RBF rules', () => {
  const base = { originalSignalsRbf: true, fullRbfPolicy: false, evictedFeesSat: 1000n, evictedTxCount: 1, replacementFeeSat: 1200n, replacementVsize: 200n, incrementalRelayFeeSatKvb: 1000n, replacementAddsUnconfirmedInputs: false };
  assert.deepEqual(checkRbfReplacement(base), { ok: true, minReplacementFeeSat: 1200n, failures: [] });
  assert.equal(checkRbfReplacement({ ...base, replacementFeeSat: 1199n }).ok, false); // rule 4
  assert.match(checkRbfReplacement({ ...base, replacementFeeSat: 900n }).failures.join(), /rule3/);
  assert.match(checkRbfReplacement({ ...base, originalSignalsRbf: false }).failures.join(), /rule1/);
  assert.equal(checkRbfReplacement({ ...base, originalSignalsRbf: false, fullRbfPolicy: true }).ok, true);
  assert.match(checkRbfReplacement({ ...base, replacementAddsUnconfirmedInputs: true }).failures.join(), /rule2/);
  assert.match(checkRbfReplacement({ ...base, evictedTxCount: 101 }).failures.join(), /rule5/);
});
test('CPFP math', () => {
  // parent 200vB paying 200 sat (1 sat/vB); child 150vB; target 10 sat/vB => package 350vB*10=3500 - 200 = 3300
  assert.equal(cpfpChildFee({ parentFeeSat: 200n, parentVsize: 200n, childVsize: 150n, targetRateSatKvb: 10_000n }), 3300n);
  assert.equal(cpfpChildFee({ parentFeeSat: 5000n, parentVsize: 200n, childVsize: 150n, targetRateSatKvb: 10_000n }), 0n);
  // parent overpays hugely but need>0 small: child still pays own way
  assert.equal(cpfpChildFee({ parentFeeSat: 3400n, parentVsize: 200n, childVsize: 150n, targetRateSatKvb: 10_000n }), 1500n);
});
test('finality by confirmation depth + reorg', () => {
  assert.equal(classifyFinality({ inMempool: true, tipHeight: 100, amountSat: 1n }).state, 'mempool');
  assert.equal(classifyFinality({ inMempool: false, tipHeight: 100, amountSat: 1n }).state, 'unknown');
  const f = (h: number, amt: bigint) => classifyFinality({ inMempool: false, blockHeight: h, blockHash: 'a', canonicalHashAtHeight: 'a', tipHeight: 100, amountSat: amt });
  assert.deepEqual([f(100, 5_000_000n).state, f(100, 5_000_000n).confirmations], ['included', 1]);
  assert.equal(f(98, 5_000_000n).state, 'confirmed');
  assert.equal(f(95, 5_000_000n).state, 'final'); // 6 confs, required 6
  assert.equal(f(96, 5_000_000n).state, 'confirmed'); // 5 confs
  assert.equal(f(95, 50_000_000_000n).state, 'confirmed'); // needs 12
  assert.equal(requiredDepth(10n ** 12n), 12);
  assert.equal(classifyFinality({ inMempool: false, blockHeight: 90, blockHash: 'a', canonicalHashAtHeight: 'b', tipHeight: 100, amountSat: 1n }).state, 'reorged');
});

// ---------- coin selection ----------
const u = (id: number, v: bigint, conf = 6, t: Utxo['inputType'] = 'p2wpkh', extra: Partial<Utxo> = {}): Utxo => ({ txid: id.toString(16).padStart(64, '0'), vout: 0, valueSat: v, inputType: t, confirmations: conf, ...extra });
const params = (utxos: Utxo[], outputs: TxOutput[], over: Partial<SelectParams> = {}): SelectParams => ({ utxos, outputs, feeRateSatKvb: 10_000n, changeScript: 'p2wpkh', maxFeeSat: 100_000n, maxFeeRateSatKvb: 100_000n, ...over });
const pay = (v: bigint, script: TxOutput['script'] = 'p2wpkh'): TxOutput => ({ script, valueSat: v });

test('selection: basic with change; sums balance', () => {
  const s = selectCoins(params([u(1, 100_000n), u(2, 50_000n)], [pay(60_000n)]));
  const inSum = s.inputs.reduce((a, x) => a + x.valueSat, 0n);
  assert.equal(inSum, 60_000n + (s.change?.valueSat ?? 0n) + s.feeSat);
  assert.ok(s.change && s.change.valueSat >= DUST_LIMIT.p2wpkh);
});
test('selection: BnB exact match avoids change', () => {
  const rate = 10_000n; const vs = txVsize(['p2wpkh'], ['p2wpkh']); const fee = feeForVsize(rate, vs);
  const s = selectCoins(params([u(1, 60_000n + fee), u(2, 123_456n), u(3, 7_777n)], [pay(60_000n)]));
  assert.equal(s.algorithm, 'bnb'); assert.equal(s.change, undefined); assert.equal(s.inputs.length, 1);
});
test('selection: never spends unconfirmed external by default', () => {
  assert.throws(() => selectCoins(params([u(1, 1_000_000n, 0)], [pay(10_000n)])), (e: any) => e instanceof SelectionError && e.code === 'INSUFFICIENT_FUNDS');
  assert.throws(() => selectCoins(params([u(1, 1_000_000n, 0, 'p2wpkh', { isOwnChange: true })], [pay(10_000n)])), SelectionError);
  const ok = selectCoins(params([u(1, 1_000_000n, 0, 'p2wpkh', { isOwnChange: true })], [pay(10_000n)], { allowUnconfirmedChange: true }));
  assert.equal(ok.inputs.length, 1);
  assert.equal(eligible(u(1, 5n, 0), params([], [])), false);
  assert.equal(eligible(u(1, 5n, 0), params([], [], { allowUnconfirmedExternal: true })), true);
  assert.equal(eligible(u(1, 5n, 6, 'p2wpkh', { frozen: true }), params([], [])), false);
});
test('selection: dust outputs and fee caps rejected', () => {
  assert.throws(() => selectCoins(params([u(1, 1_000_000n)], [pay(293n)])), (e: any) => e.code === 'DUST_OUTPUT');
  assert.throws(() => selectCoins(params([u(1, 1_000_000n)], [pay(545n, 'p2pkh')])), (e: any) => e.code === 'DUST_OUTPUT');
  assert.throws(() => selectCoins(params([u(1, 1_000_000n)], [pay(10_000n)], { maxFeeSat: 10n })), (e: any) => e.code === 'FEE_CAP_EXCEEDED');
  assert.throws(() => selectCoins(params([u(1, 20_000n)], [pay(19_900n)])), SelectionError); // cannot cover fee
  // dust change is absorbed in fee but only within caps
  const absorbed = selectCoins(params([u(1, 10_300n)], [pay(10_000n)], { feeRateSatKvb: 1000n }));
  assert.equal(absorbed.change, undefined); assert.equal(absorbed.inputs[0]!.valueSat - 10_000n, absorbed.feeSat);
  assert.throws(() => selectCoins(params([u(1, 10_300n)], [pay(10_000n)], { feeRateSatKvb: 1000n, maxFeeRateSatKvb: 2000n })), (e: any) => e.code === 'FEE_CAP_EXCEEDED' || e.code === 'INSUFFICIENT_FUNDS');
});
test('selection: negative-effective-value inputs are skipped', () => {
  assert.throws(() => selectCoins(params([u(1, 600n, 6, 'p2pkh')], [pay(300n)], { feeRateSatKvb: 20_000n })), SelectionError);
});

// deterministic PRNG for property tests
function rng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }
test('PROPERTY (5000 random cases): inputs always cover outputs+fee, fee never exceeds cap, no unconfirmed external, change >= dust', () => {
  const r = rng(0xC0FFEE);
  const types: Utxo['inputType'][] = ['p2pkh', 'p2sh-p2wpkh', 'p2wpkh', 'p2tr-keypath'];
  const scripts: TxOutput['script'][] = ['p2pkh', 'p2sh', 'p2wpkh', 'p2wsh', 'p2tr'];
  let ok = 0, rejected = 0;
  for (let n = 0; n < 5000; n++) {
    const utxos: Utxo[] = Array.from({ length: 1 + Math.floor(r() * 25) }, (_, i) => u(i + n * 100, BigInt(Math.floor(200 + r() ** 3 * 2e8)), Math.floor(r() * 4), types[Math.floor(r() * 4)]!, { isOwnChange: r() < 0.3 }));
    const outputs = Array.from({ length: 1 + Math.floor(r() * 3) }, () => { const sc = scripts[Math.floor(r() * 5)]!; return pay(DUST_LIMIT[sc] + BigInt(Math.floor(r() ** 2 * 5e7)), sc); });
    const p = params(utxos, outputs, {
      feeRateSatKvb: BigInt(1000 + Math.floor(r() * 300_000)), maxFeeSat: BigInt(Math.floor(500 + r() * 400_000)),
      maxFeeRateSatKvb: BigInt(1000 + Math.floor(r() * 400_000)), allowUnconfirmedChange: r() < 0.3, changeScript: scripts[Math.floor(r() * 5)]!,
    });
    try {
      const s = selectCoins(p);
      ok++;
      const inSum = s.inputs.reduce((a, x) => a + x.valueSat, 0n);
      const outSum = s.outputs.reduce((a, x) => a + x.valueSat, 0n);
      const ch = s.change?.valueSat ?? 0n;
      assert.equal(inSum, outSum + ch + s.feeSat, 'conservation');
      assert.ok(inSum >= outSum + s.feeSat, 'cover');
      assert.ok(s.feeSat <= p.maxFeeSat, 'abs cap');
      assert.ok(s.feeSat * 1000n <= p.maxFeeRateSatKvb * s.vsize, 'rate cap');
      assert.ok(s.feeSat >= feeForVsize(p.feeRateSatKvb, s.vsize), 'min fee');
      assert.ok(ch === 0n || ch >= DUST_LIMIT[p.changeScript], 'change dust');
      assert.equal(new Set(s.inputs.map((x) => x.txid + x.vout)).size, s.inputs.length, 'no dup inputs');
      for (const x of s.inputs) assert.ok(eligible(x, p), 'eligible only');
      for (const x of s.inputs) assert.ok(x.confirmations >= 1 || (x.isOwnChange && p.allowUnconfirmedChange), 'no unconfirmed external');
    } catch (e) {
      if (!(e instanceof SelectionError)) throw e;
      rejected++;
    }
  }
  assert.ok(ok > 500 && rejected > 100, `distribution sanity ok=${ok} rejected=${rejected}`);
});
const fake: Transport = async (r) => {
  const p = new URL(r.url).pathname;
  const m: Record<string, { status: number; json?: unknown; text?: string }> = {
    '/api/blocks/tip/height': { status: 200, text: '971289' },
    '/api/v1/fees/recommended': { status: 200, json: { fastestFee: 3, halfHourFee: 2, hourFee: 1, economyFee: 1, minimumFee: 1 } },
    '/api/address/1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2': { status: 200, json: { chain_stats: { funded_txo_sum: 100, spent_txo_sum: 40 }, mempool_stats: { funded_txo_sum: 5, spent_txo_sum: 0 } } },
  };
  return m[p] ? { json: null, ...m[p]! } : { status: 404, json: null };
};
test('esplora client + adapter fail-closed', async () => {
  const c = new EsploraClient('https://x', fake);
  assert.equal(await c.getTipHeight(), 971289);
  assert.equal((await c.getRecommendedFees()).fastestFee, 3);
  assert.deepEqual(await c.getAddressBalance('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'), { confirmedSat: 60n, unconfirmedDeltaSat: 5n });
  assert.equal(await c.getTxStatus('a'.repeat(64)), null);
  const a = new BitcoinAdapter(fake);
  const id = chainRecords[0]!.id;
  assert.deepEqual(await a.getBalances(id, '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'), [{ assetId: 'native:BTC', amount: 60n, decimals: 8 }]);
  await assert.rejects(a.getBalances(id, 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7'), /expected mainnet/);
  await assert.rejects(a.submit(id), /fail closed/);
});
test('records: no swap capabilities, never CERTIFIED, statement present', () => {
  for (const r of chainRecords) {
    for (const c of Object.values(r.capabilities)) assert.notEqual(c.status, 'CERTIFIED');
    for (const k of ['swap', 'buildSwapQuote', 'getLiquidity', 'subscribePools'] as const) assert.equal(r.capabilities[k].status, 'UNSUPPORTED');
  }
  assert.match(BITCOIN_NOT_AMM, /not AMM swaps/);
});
