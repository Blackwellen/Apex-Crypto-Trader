import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  base58Encode, base58Decode, validateSolanaAddress, quoteSolanaFee, priorityFeeLamports, boundedJitoTip, JitoTipRefused, setComputeUnitLimitData, setComputeUnitPriceData,
  rentExemptMinimum, SYSTEM_ACCOUNT_RENT_FLOOR, LEGACY_RENT, OBSERVED_RENT_2026_10_13, rentParamsFromNode, ataCreationReserve, ataAccountLen, computeLamportsReserve, spendableLamports,
  parseMint, analyzeMint, MintParseError, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, calculateTransferFee, netReceived, activeTransferFee,
} from '../src/index.ts';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const mintBytes = (file: string) => Uint8Array.from(Buffer.from(fx(file).result.value.data[0], 'base64'));
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';

test('base58 round trip and known vector', () => {
  assert.equal(base58Encode(new TextEncoder().encode('Hello World!')), '2NEpo7TZRRrLZSi2U');
  assert.deepEqual([...base58Decode('2NEpo7TZRRrLZSi2U')], [...new TextEncoder().encode('Hello World!')]);
  assert.equal(base58Encode(new Uint8Array(32)), '1'.repeat(32));
  assert.deepEqual([...base58Decode('1'.repeat(32))], new Array(32).fill(0));
});
test('pubkey validation: 32 bytes only', () => {
  for (const ok of ['11111111111111111111111111111111', TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, USDC, PYUSD, 'ComputeBudget111111111111111111111111111111'])
    assert.equal(validateSolanaAddress(ok).valid, true, ok);
  assert.equal(validateSolanaAddress('').valid, false);
  assert.equal(validateSolanaAddress('0'.repeat(40)).valid, false, 'invalid alphabet (0)');
  assert.equal(validateSolanaAddress('O' + USDC.slice(1)).valid, false, 'O not in base58');
  assert.equal(validateSolanaAddress('1'.repeat(31)).valid, false, 'too short');
  assert.equal(validateSolanaAddress(base58Encode(new Uint8Array(33).fill(7))).valid, false, '33 bytes');
  assert.equal(validateSolanaAddress(base58Encode(new Uint8Array(31).fill(7)).padStart(32, '2')).valid, false);
  assert.equal(validateSolanaAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed').valid, false, 'EVM address is not Solana');
});

test('fee model: 5000/sig + ceil(cuLimit*price/1e6) + bounded tip + rent', () => {
  assert.equal(priorityFeeLamports(200_000n, 1_000n), 200n);
  assert.equal(priorityFeeLamports(200_001n, 1n), 1n, 'ceil');
  const q = quoteSolanaFee({ version: 'v0', numSignatures: 2, cuLimit: 300_000n, microLamportsPerCu: 5_000n, jitoTipLamports: 10_000n, newAccountRentLamports: 2_039_280n });
  assert.equal(q.baseFee, 10_000n); assert.equal(q.priorityFee, 1_500n); assert.equal(q.feeTotal, 21_500n); assert.equal(q.totalOutlay, 2_060_780n); assert.equal(q.complete, true);
  assert.throws(() => priorityFeeLamports(1_400_001n, 1n)); assert.throws(() => priorityFeeLamports(0n, 1n));
  const v1 = quoteSolanaFee({ version: 'v1', numSignatures: 1, cuLimit: 1n, microLamportsPerCu: 1n });
  assert.equal(v1.complete, false); assert.match(v1.unknownComponents[0]!, /v1/);
});
test('Jito tip is bounded: clamp to cap, floor at min, refuse if cap < min', () => {
  assert.equal(boundedJitoTip({ suggestedLamports: 5_000_000n, maxTipLamports: 100_000n }), 100_000n);
  assert.equal(boundedJitoTip({ suggestedLamports: 10n, maxTipLamports: 100_000n }), 1_000n);
  assert.equal(boundedJitoTip({ suggestedLamports: 50_000n, maxTipLamports: 100_000n, tradeValueLamports: 1_000_000n, maxTipFractionOfTradeBps: 100n }), 10_000n);
  assert.throws(() => boundedJitoTip({ suggestedLamports: 50_000n, maxTipLamports: 100_000n, tradeValueLamports: 10_000n, maxTipFractionOfTradeBps: 100n }), JitoTipRefused);
});
test('compute budget instruction data encoding', () => {
  assert.deepEqual([...setComputeUnitLimitData(200_000n)], [2, 0x40, 0x0d, 0x03, 0x00]);
  assert.deepEqual([...setComputeUnitPriceData(1_000n)], [3, 0xe8, 0x03, 0, 0, 0, 0, 0, 0]);
  assert.throws(() => setComputeUnitLimitData(2_000_000n));
});

test('rent (LEGACY schedule fallback): 890_880 system floor; 2_039_280 for 165 bytes; Token-2022 ATA 170 bytes = 2_074_080 (a real pre-change mainnet account)', () => {
  assert.equal(SYSTEM_ACCOUNT_RENT_FLOOR(LEGACY_RENT), 890_880n);
  assert.equal(rentExemptMinimum(165, LEGACY_RENT), 2_039_280n);
  assert.equal(ataAccountLen('token-2022', []).len, 170);
  assert.equal(rentExemptMinimum(170, LEGACY_RENT), 2_074_080n);
  assert.equal(SYSTEM_ACCOUNT_RENT_FLOOR(), 890_880n, 'conservative default = legacy (over-reserve)');
});
test('rent: live node schedule (recorded 2026-10-13: 0B=650240, 165B=1488440, 170B=1513840) is 5080 lamports/byte and is DERIVED, not assumed', async () => {
  const recorded: Record<number, bigint> = { 0: 650_240n, 82: 1_066_800n, 165: 1_488_440n, 170: 1_513_840n };
  const p = await rentParamsFromNode({ getMinimumBalanceForRentExemption: async (n: number) => recorded[n]! });
  assert.deepEqual(p, OBSERVED_RENT_2026_10_13);
  for (const [len, v] of Object.entries(recorded)) assert.equal(rentExemptMinimum(Number(len), p), v);
  assert.ok(rentExemptMinimum(165, p) < rentExemptMinimum(165, LEGACY_RENT), 'the legacy default over-reserves');
  await assert.rejects(() => rentParamsFromNode({ getMinimumBalanceForRentExemption: async (n: number) => (n === 0 ? 650_240n : 999n) }), /not linear/);
  await assert.rejects(() => rentParamsFromNode({ getMinimumBalanceForRentExemption: async () => 100n }), /multiple of/);
  assert.equal(ataCreationReserve({ ataExists: false, program: 'token-2022', rent: p }).lamports, 1_513_840n);
});
test('ATA reserve: 0 if exists; transfer-fee mint needs TransferFeeAmount space; confidential flagged unmodelled', () => {
  assert.equal(ataCreationReserve({ ataExists: true, program: 'spl-token' }).lamports, 0n);
  assert.equal(ataCreationReserve({ ataExists: false, program: 'spl-token' }).lamports, 2_039_280n);
  const tf = ataCreationReserve({ ataExists: false, program: 'token-2022', mintExtensions: ['TransferFeeConfig'] });
  assert.equal(tf.accountLen, 165 + 1 + 4 + (4 + 8)); assert.equal(tf.lamports, rentExemptMinimum(182));
  const c = ataCreationReserve({ ataExists: false, program: 'token-2022', mintExtensions: ['ConfidentialTransferMint'] });
  assert.equal(c.modelled, false);
});
test('lamports reserve: rent floor + next N + emergency exit; never negative spendable', () => {
  const r = computeLamportsReserve('solana:mainnet', { perTxCost: 10_000n, emergencyExitCost: 20_000n }, { plannedTxCount: 3 });
  assert.equal(r.floor, 890_880n); assert.equal(r.nextNTxEstimate, 30_000n); assert.equal(r.emergencyExit, 30_000n); assert.equal(r.total, 950_880n);
  assert.equal(spendableLamports(1_000_000n, r), 49_120n); assert.equal(spendableLamports(100n, r), 0n);
});

test('REAL recorded USDC mint (SPL Token): no extensions, freeze+mint authority warned, not blocked', () => {
  const m = parseMint(mintBytes(`mint-${USDC}.json`), TOKEN_PROGRAM_ID);
  assert.equal(m.program, 'spl-token'); assert.equal(m.decimals, 6); assert.ok(m.supply > 0n);
  const r = analyzeMint(m);
  assert.equal(r.blocked, false); assert.ok(r.flags.some((f) => f.code === 'FREEZE_AUTHORITY'));
});
test('REAL recorded PYUSD mint (Token-2022): extensions parsed; transfer-fee/hook/delegate analysed', () => {
  const m = parseMint(mintBytes(`mint-${PYUSD}.json`), TOKEN_2022_PROGRAM_ID);
  assert.equal(m.program, 'token-2022'); assert.equal(m.decimals, 6);
  assert.ok(m.extensions.length >= 3); assert.ok(!m.extensions.some((e) => e.name === 'Unknown'));
  const r = analyzeMint(m);
  assert.ok(r.flags.some((f) => f.code === 'TOKEN_2022_PROGRAM'));
  assert.equal(r.blocked, true, 'recorded PYUSD mint carries a PermanentDelegate => blocked by default policy');
  assert.ok(r.flags.some((f) => f.code === 'PERMANENT_DELEGATE') && r.flags.some((f) => f.code === 'TRANSFER_FEE'));
  // the recorded account has a TransferHook extension: severity must reflect whether a program is set
  const hook = m.extensions.find((e) => e.name === 'TransferHook');
  if (hook) assert.equal(r.flags.some((f) => f.code === 'TRANSFER_HOOK' && f.severity === 'block'), m.transferHook?.programId != null);
});

// ---- synthetic Token-2022 mints (layout per solana-program/token-2022) ----
function t22Mint(opts: { freeze?: Uint8Array; mintAuth?: Uint8Array; exts: { type: number; value: Uint8Array }[] }): Uint8Array {
  const buf = new Uint8Array(165 + 1 + opts.exts.reduce((n, e) => n + 4 + e.value.length, 0) + 8);
  const dv = new DataView(buf.buffer);
  if (opts.mintAuth) { dv.setUint32(0, 1, true); buf.set(opts.mintAuth, 4); }
  dv.setBigUint64(36, 1_000_000n, true); buf[44] = 9; buf[45] = 1;
  if (opts.freeze) { dv.setUint32(46, 1, true); buf.set(opts.freeze, 50); }
  buf[165] = 1; let off = 166;
  for (const e of opts.exts) { dv.setUint16(off, e.type, true); dv.setUint16(off + 2, e.value.length, true); buf.set(e.value, off + 4); off += 4 + e.value.length; }
  return buf;
}
const key = (n: number) => new Uint8Array(32).fill(n);
function feeCfg(oldBps: number, oldMax: bigint, newEpoch: bigint, newBps: number, newMax: bigint): Uint8Array {
  const v = new Uint8Array(108); const dv = new DataView(v.buffer);
  v.set(key(1), 0); v.set(key(2), 32); dv.setBigUint64(64, 5n, true);
  dv.setBigUint64(72, 0n, true); dv.setBigUint64(80, oldMax, true); dv.setUint16(88, oldBps, true);
  dv.setBigUint64(90, newEpoch, true); dv.setBigUint64(98, newMax, true); dv.setUint16(106, newBps, true);
  return v;
}
test('synthetic: TransferFeeConfig parsed; epoch-aware ceil fee with max; net received < gross', () => {
  const m = parseMint(t22Mint({ exts: [{ type: 1, value: feeCfg(100, 1_000n, 500n, 250, 10_000n) }] }), TOKEN_2022_PROGRAM_ID);
  assert.equal(m.transferFeeConfig!.older.basisPoints, 100); assert.equal(m.transferFeeConfig!.newer.basisPoints, 250); assert.equal(m.transferFeeConfig!.newer.epoch, 500n);
  assert.equal(activeTransferFee(m.transferFeeConfig!, 499n).basisPoints, 100); assert.equal(activeTransferFee(m.transferFeeConfig!, 500n).basisPoints, 250);
  assert.equal(netReceived(m, 10_000n, 499n), 9_900n);        // 1% of 10000 = 100 (cap 1000)
  assert.equal(netReceived(m, 1_000_000n, 499n), 999_000n);   // capped at maxFee 1000
  assert.equal(netReceived(m, 10_001n, 600n), 10_001n - 251n);// ceil(10001*250/10000)=251
  assert.equal(calculateTransferFee(0n, m.transferFeeConfig!.newer), 0n);
  const r = analyzeMint(m); assert.equal(r.severity, 'warn'); assert.ok(r.flags.some((f) => f.code === 'TRANSFER_FEE' && /LESS/.test(f.detail)));
});
test('synthetic: permanent delegate / transfer hook / default-frozen / pausable / unknown ext => BLOCK', () => {
  const pd = analyzeMint(parseMint(t22Mint({ exts: [{ type: 12, value: key(9) }] }), TOKEN_2022_PROGRAM_ID)); assert.equal(pd.blocked, true); assert.ok(pd.flags.some((f) => f.code === 'PERMANENT_DELEGATE'));
  const th = new Uint8Array(64); th.set(key(3), 0); th.set(key(4), 32);
  const hk = analyzeMint(parseMint(t22Mint({ exts: [{ type: 14, value: th }] }), TOKEN_2022_PROGRAM_ID)); assert.equal(hk.blocked, true);
  const hkNone = analyzeMint(parseMint(t22Mint({ exts: [{ type: 14, value: new Uint8Array(64) }] }), TOKEN_2022_PROGRAM_ID)); assert.equal(hkNone.blocked, false); assert.equal(hkNone.severity, 'warn');
  const fr = analyzeMint(parseMint(t22Mint({ exts: [{ type: 6, value: Uint8Array.of(2) }] }), TOKEN_2022_PROGRAM_ID)); assert.equal(fr.blocked, true);
  const pz = analyzeMint(parseMint(t22Mint({ exts: [{ type: 26, value: key(1) }] }), TOKEN_2022_PROGRAM_ID)); assert.equal(pz.blocked, true);
  const nt = analyzeMint(parseMint(t22Mint({ exts: [{ type: 9, value: new Uint8Array(0) }] }), TOKEN_2022_PROGRAM_ID)); assert.equal(nt.blocked, true);
  const unk = analyzeMint(parseMint(t22Mint({ exts: [{ type: 999, value: new Uint8Array(2) }] }), TOKEN_2022_PROGRAM_ID)); assert.equal(unk.blocked, true); assert.ok(unk.flags.some((f) => f.code === 'UNKNOWN_EXTENSION'));
});
test('synthetic: freeze + mint authority warn only; informational extensions do not escalate', () => {
  const r = analyzeMint(parseMint(t22Mint({ freeze: key(5), mintAuth: key(6), exts: [{ type: 18, value: new Uint8Array(64) }, { type: 19, value: new Uint8Array(10) }] }), TOKEN_2022_PROGRAM_ID));
  assert.equal(r.severity, 'warn'); assert.deepEqual(r.flags.map((f) => f.code).sort(), ['FREEZE_AUTHORITY', 'MINT_AUTHORITY_ACTIVE', 'TOKEN_2022_PROGRAM']);
});
test('parser rejects malformed data', () => {
  assert.throws(() => parseMint(new Uint8Array(10), TOKEN_PROGRAM_ID), MintParseError);
  assert.throws(() => parseMint(new Uint8Array(82), TOKEN_PROGRAM_ID), /not initialized/);
  assert.throws(() => parseMint(mintBytes(`mint-${USDC}.json`), '11111111111111111111111111111111'), /not a token program/);
  const bad = t22Mint({ exts: [{ type: 1, value: new Uint8Array(10) }] }); assert.throws(() => parseMint(bad, TOKEN_2022_PROGRAM_ID), /TransferFeeConfig length/);
  const over = t22Mint({ exts: [{ type: 12, value: key(1) }] }); new DataView(over.buffer).setUint16(168, 5000, true); assert.throws(() => parseMint(over, TOKEN_2022_PROGRAM_ID), /overruns/);
  const wrongType = t22Mint({ exts: [] }); wrongType[165] = 2; assert.throws(() => parseMint(wrongType, TOKEN_2022_PROGRAM_ID), /account type/);
  assert.throws(() => parseMint(new Uint8Array(100).fill(0).map((_, i) => (i === 45 ? 1 : 0)), TOKEN_2022_PROGRAM_ID), /malformed/);
});
