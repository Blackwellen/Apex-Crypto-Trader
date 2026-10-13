import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateAptosAddress, validateMoveType, AptosRestClient, AptosChainIdMismatchError, AptosRestError, APTOS_CHAIN_IDS, quoteAptosGas, GasCapExceeded, maxGasFromSimulation,
  expirationFromLedger, isExpiredAt, resolveStatus, U64_MAX, SequenceAllocator, SequenceError, minReplacementGasPrice, simulateTransaction, AptosChainAdapter, computeAptosReserve,
} from '../src/index.ts';
import type { RestRequest, RestResponse, AptosTxLookup } from '../src/index.ts';
import { emptyCapabilities } from '@apex/contracts';
import { freshDb } from './db.ts';
import type { TestDb } from './db.ts';

const raw = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const fxText = (n: string) => raw(n + '.json');
const long = (n: number) => '0x' + n.toString(16).padStart(64, '0');
function xport(routes: Record<string, RestResponse | ((r: RestRequest) => RestResponse)>, log: string[] = []) {
  return async (req: RestRequest): Promise<RestResponse> => {
    log.push(`${req.method} ${req.path}`);
    const hit = Object.keys(routes).find((k) => req.path === k) ?? Object.keys(routes).find((k) => k.includes('*') && new RegExp('^' + k.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$').test(req.path)) ;
    if (!hit) return { status: 404, body: JSON.stringify({ message: 'not found', error_code: 'web_framework_error' }) };
    const v = routes[hit]!; return typeof v === 'function' ? v(req) : v;
  };
}
const ok = (body: string): RestResponse => ({ status: 200, body });
const LEDGER = ok(fxText('ledger'));

test('address: short and long forms normalise; strict rejects short non-special', () => {
  assert.equal(validateAptosAddress('0x1').normalized, long(1));
  assert.equal(validateAptosAddress('0x1').special, true);
  assert.equal(validateAptosAddress('0xF').normalized, long(15));
  assert.equal(validateAptosAddress('0x' + 'AB'.repeat(32)).normalized, '0x' + 'ab'.repeat(32));
  assert.equal(validateAptosAddress('0xabc').valid, true); assert.equal(validateAptosAddress('0xabc', { strict: true }).valid, false);
  assert.equal(validateAptosAddress('0x1', { strict: true }).valid, true);
  for (const bad of ['0x', '1', '0x' + 'a'.repeat(65), '0xzz', '', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed ']) {
    // the 40-hex EVM address is structurally a valid SHORT Aptos form; only strict mode (used by the adapter) rejects it
    if (bad.startsWith('0x5aAe')) continue;
    assert.equal(validateAptosAddress(bad).valid, false, bad);
  }
  assert.equal(validateAptosAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', { strict: true }).valid, false, 'EVM address rejected for destinations in strict mode');
  assert.equal(validateMoveType('0x1::aptos_coin::AptosCoin').valid, true); assert.equal(validateMoveType('APT').valid, false);
});

test('rest: chain id mismatch rejected; no other call reaches the node', async () => {
  const log: string[] = [];
  const c = new AptosRestClient({ expectedChainId: APTOS_CHAIN_IDS['aptos:testnet'], transport: xport({ '/': LEDGER, '/estimate_gas_price': ok(fxText('gasprice')) }, log) });
  await assert.rejects(() => c.estimateGasPrice(), AptosChainIdMismatchError); await assert.rejects(() => c.estimateGasPrice(), AptosChainIdMismatchError);
  assert.ok(!log.some((l) => l.includes('estimate_gas_price')));
});
test('rest: recorded real shapes (ledger info, account, gas price, bare-integer balance, health)', async () => {
  const c = new AptosRestClient({ expectedChainId: 1, transport: xport({ '/': LEDGER, '/accounts/0x0000000000000000000000000000000000000000000000000000000000000001': ok(fxText('account')), '/estimate_gas_price': ok(fxText('gasprice')), '/accounts/*/balance/*': ok(fxText('balance')), '/-/healthy': ok(fxText('healthy')) }) });
  const li = await c.ledgerInfo(); assert.equal(li.chainId, 1); assert.ok(li.ledgerTimestampUsec > 1_700_000_000_000_000n); assert.ok(li.blockHeight > 0n);
  const a = await c.getAccount('0x1'); assert.equal(a.sequenceNumber, 0n);
  assert.deepEqual(await c.estimateGasPrice(), { deprioritized: 100n, normal: 100n, prioritized: 150n });
  assert.equal(await c.getBalance('0x1'), 11120868786n);
  assert.equal(await c.isHealthy(), true);
  const big = new AptosRestClient({ transport: xport({ '/accounts/*/balance/*': ok('18446744073709551615') }) });
  assert.equal(await big.getBalance('0x1'), 18446744073709551615n, 'u64 balances keep full precision');
});
test('rest: committed / pending / not_found / orderless lookups', async () => {
  const committed = fxText('committed_tx'); const j = JSON.parse(committed);
  const c = new AptosRestClient({ transport: xport({
    [`/transactions/by_hash/${j.hash}`]: ok(committed),
    ['/transactions/by_hash/' + long(7)]: ok(JSON.stringify({ type: 'pending_transaction', hash: long(7), sender: long(9), sequence_number: '4', max_gas_amount: '2000', gas_unit_price: '100', expiration_timestamp_secs: '1791920500' })),
    '/transactions/by_hash/*': { status: 404, body: raw('not_found.txt').split('\n')[0]! } }) });
  const t = await c.getTransactionByHash(j.hash); assert.equal(t.kind, 'committed'); if (t.kind === 'committed') { assert.equal(t.success, true); assert.equal(t.sequenceNumber, U64_MAX, 'orderless txn uses u64::MAX'); }
  const p = await c.getTransactionByHash(long(7)); assert.equal(p.kind, 'pending'); if (p.kind === 'pending') assert.equal(p.sequenceNumber, 4n);
  assert.deepEqual(await c.getTransactionByHash(long(1)), { kind: 'not_found' });
  await assert.rejects(() => c.getTransactionByHash('0x12'), /0x \+ 64 hex/);
});
test('rest: HTTP errors typed', async () => {
  const c = new AptosRestClient({ transport: xport({ '/accounts/*': { status: 500, body: JSON.stringify({ message: 'boom', error_code: 'internal_error' }) } }) });
  await assert.rejects(() => c.getAccount('0x1'), (e: unknown) => e instanceof AptosRestError && e.status === 500 && e.errorCode === 'internal_error');
});

test('gas: unit price * max gas bound, urgency, caps', () => {
  const est = { deprioritized: 100n, normal: 100n, prioritized: 150n };
  const q = quoteAptosGas(est, { urgency: 'prioritized', maxGasAmount: 2_000n, maxUnitPrice: 200n }); assert.equal(q.maxCost, 300_000n);
  assert.throws(() => quoteAptosGas(est, { urgency: 'prioritized', maxGasAmount: 2_000n, maxUnitPrice: 120n }), GasCapExceeded);
  assert.throws(() => quoteAptosGas(est, { maxGasAmount: 2_000n, maxUnitPrice: 200n, maxCostOctas: 100_000n }), GasCapExceeded);
  assert.equal(maxGasFromSimulation(100n, { cap: 10_000n }), 130n); assert.throws(() => maxGasFromSimulation(9_000n, { cap: 10_000n }), GasCapExceeded);
});
test('expiration is derived from CHAIN time; expired iff chain time >= expiration', () => {
  const ledgerUsec = 1_791_920_056_910_127n;
  const exp = expirationFromLedger(ledgerUsec, 60n); assert.equal(exp, 1_791_920_056n + 60n);
  assert.equal(isExpiredAt(ledgerUsec, exp), false); assert.equal(isExpiredAt(exp * 1_000_000n, exp), true); assert.equal(isExpiredAt(exp * 1_000_000n - 1n, exp), false);
  assert.throws(() => expirationFromLedger(ledgerUsec, 5n)); assert.throws(() => expirationFromLedger(ledgerUsec, 3600n));
});

const nf: AptosTxLookup = { kind: 'not_found' };
const base = { txSequenceNumber: 5n, expirationTimestampSecs: 1000n };
test('status: committed success => final; committed failure => failed (seq consumed)', () => {
  const c = (success: boolean): AptosTxLookup => ({ kind: 'committed', hash: long(1), version: 9n, success, vmStatus: success ? 'Executed successfully' : 'Move abort', gasUsed: 5n, sender: long(2), sequenceNumber: 5n, gasUnitPrice: 100n, expirationTimestampSecs: 1000n, txType: 'user_transaction' });
  assert.equal(resolveStatus({ ...base, lookup: c(true), ledgerTimestampUsec: 0n, accountSequenceNumber: 6n }).state, 'final');
  const f = resolveStatus({ ...base, lookup: c(false), ledgerTimestampUsec: 0n, accountSequenceNumber: 6n }); assert.equal(f.state, 'failed');
});
test('status: not found is EXPIRED only after chain time passes AND sequence not consumed; else reconcile', () => {
  assert.equal(resolveStatus({ ...base, lookup: nf, ledgerTimestampUsec: 999n * 1_000_000n, accountSequenceNumber: 5n }).state, 'pending');
  const e = resolveStatus({ ...base, lookup: nf, ledgerTimestampUsec: 1000n * 1_000_000n, accountSequenceNumber: 5n }); assert.equal(e.state, 'expired'); if (e.state === 'expired') assert.equal(e.safeToReuseSequence, true);
  const consumed = resolveStatus({ ...base, lookup: nf, ledgerTimestampUsec: 2000n * 1_000_000n, accountSequenceNumber: 6n }); assert.equal(consumed.state, 'unknown'); assert.match((consumed as { detail: string }).detail, /replacement|consumed/);
  assert.equal(resolveStatus({ ...base, txSequenceNumber: U64_MAX, lookup: nf, ledgerTimestampUsec: 2000n * 1_000_000n, accountSequenceNumber: 0n }).state, 'unknown', 'orderless never claims expiry from sequence');
});
test('status: pending past expiration is unknown (re-query), pending inside window is pending', () => {
  const p: AptosTxLookup = { kind: 'pending', hash: long(1), sender: long(2), sequenceNumber: 5n, expirationTimestampSecs: 1000n, gasUnitPrice: 100n, maxGasAmount: 2000n };
  assert.equal(resolveStatus({ ...base, lookup: p, ledgerTimestampUsec: 500n * 1_000_000n, accountSequenceNumber: 5n }).state, 'pending');
  assert.equal(resolveStatus({ ...base, lookup: p, ledgerTimestampUsec: 1001n * 1_000_000n, accountSequenceNumber: 5n }).state, 'unknown');
});
test('simulate wrapper: ok => buffered max gas; VM failure => not ok; need above cap => not ok', async () => {
  const mk = (success: boolean, gas: number) => new AptosRestClient({ transport: xport({ '/transactions/simulate': (r) => { assert.equal(r.headers?.['content-type'], 'application/x.aptos.signed_transaction+bcs'); return ok(JSON.stringify([{ success, vm_status: success ? 'Executed successfully' : 'Move abort in 0x1::coin: EINSUFFICIENT_BALANCE', gas_used: String(gas), max_gas_amount: '200000', gas_unit_price: '100' }])); } }) });
  const good = await simulateTransaction(mk(true, 100), new Uint8Array([1]), { maxGasCap: 10_000n }); assert.equal(good.ok, true); assert.equal(good.maxGasAmount, 130n);
  const bad = await simulateTransaction(mk(false, 7), new Uint8Array([1]), { maxGasCap: 10_000n }); assert.equal(bad.ok, false); assert.match(bad.reason!, /EINSUFFICIENT/);
  const capped = await simulateTransaction(mk(true, 9_900), new Uint8Array([1]), { maxGasCap: 10_000n }); assert.equal(capped.ok, false);
});
test('adapter gates + status + reserve', async () => {
  const caps = emptyCapabilities(); caps.getBalances = { status: 'READ_ONLY', evidenceRef: 't' };
  const committed = fxText('committed_tx'); const j = JSON.parse(committed);
  const a = new AptosChainAdapter({ capabilitiesFor: () => caps, reserveConfigFor: () => ({ floor: 1n, perTxMaxCost: 10n, emergencyExitMaxCost: 20n }),
    clientFor: () => new AptosRestClient({ transport: xport({ '/': LEDGER, '/accounts/*/balance/*': ok(fxText('balance')), [`/transactions/by_hash/${j.hash}`]: ok(committed), '/transactions/by_hash/*': { status: 404, body: '{"message":"x","error_code":"transaction_not_found"}' } }) }) });
  assert.equal((await a.getBalances('aptos:mainnet', '0x' + 'a'.repeat(64)))[0]!.amount, 11120868786n);
  assert.equal((await a.getTransactionStatus('aptos:mainnet', j.hash)).state, 'final');
  assert.equal((await a.getTransactionStatus('aptos:mainnet', long(1))).state, 'unknown');
  await assert.rejects(() => a.getFeeQuote('aptos:mainnet'), /fail closed/); await assert.rejects(() => a.submit('aptos:mainnet'), /fail closed/);
  assert.equal(a.validateAddress('0x1').valid, true); assert.equal(a.validateAddress('0xabc').valid, false);
  assert.equal(computeAptosReserve('aptos:mainnet', { floor: 1n, perTxMaxCost: 10n, emergencyExitMaxCost: 20n }, { plannedTxCount: 2 }).total, 1n + 20n + 30n);
});

let db: TestDb;
before(async () => { db = await freshDb(); });
after(async () => { await db.close(); });
const ACC = long(0xabc), ACC2 = long(0xdef);

test('100 concurrent reservations for one (chain, account) => unique contiguous sequence numbers', async () => {
  const al = new SequenceAllocator(db.pool, { maxInflight: 1000 });
  const res = await Promise.all(Array.from({ length: 100 }, (_, i) => al.reserve('aptos:mainnet', ACC, `i-${i}`, 42n)));
  const seqs = res.map((r) => r.seq).sort((a, b) => (a < b ? -1 : 1));
  assert.equal(new Set(seqs.map(String)).size, 100);
  for (let i = 0; i < 100; i++) assert.equal(seqs[i], 42n + BigInt(i));
  const st = await db.pool.query(`select next_seq::text n from aptos_sequence_state where chain_id='aptos:mainnet' and account=$1`, [ACC]); assert.equal(st.rows[0].n, '142');
});
test('idempotent per intent; chains and accounts independent; chain-ahead adopted', async () => {
  const al = new SequenceAllocator(db.pool);
  const a = await al.reserve('aptos:testnet', ACC, 'x', 0n), b = await al.reserve('aptos:testnet', ACC, 'x', 0n); assert.equal(a.id, b.id);
  assert.equal((await al.reserve('aptos:mainnet', ACC2, 'x', 0n)).seq, 0n); assert.equal((await al.reserve('aptos:testnet', ACC2, 'x', 0n)).seq, 0n);
  assert.equal((await al.reserve('aptos:testnet', ACC, 'y', 10n)).seq, 10n);
});
test('lifecycle: broadcast -> replace (>=10% price, later expiry) -> commit; release only when never broadcast; gap reuse', async () => {
  const al = new SequenceAllocator(db.pool);
  const r = await al.reserve('aptos:mainnet', ACC2, 'life', 0n);
  await assert.rejects(() => al.replace(r.id, '0xh2', { gasUnitPrice: 200n, maxGasAmount: 10n }, 2000n), (e: unknown) => e instanceof SequenceError && e.code === 'bad_state');
  await al.markBroadcast(r.id, '0xh1', { gasUnitPrice: 100n, maxGasAmount: 2000n }, 1000n);
  await assert.rejects(() => al.release(r.id), (e: unknown) => e instanceof SequenceError && e.code === 'bad_state');
  await assert.rejects(() => al.replace(r.id, '0xh2', { gasUnitPrice: 109n, maxGasAmount: 2000n }, 2000n), (e: unknown) => e instanceof SequenceError && e.code === 'underpriced');
  await assert.rejects(() => al.replace(r.id, '0xh2', { gasUnitPrice: 110n, maxGasAmount: 2000n }, 1000n), (e: unknown) => e instanceof SequenceError && e.code === 'expiration');
  const rep = await al.replace(r.id, '0xh2', { gasUnitPrice: 110n, maxGasAmount: 2000n }, 2000n); assert.equal(rep.seq, r.seq); assert.equal(rep.replacementCount, 1);
  assert.equal(minReplacementGasPrice(100n), 110n);
  assert.equal((await al.commit(r.id, '0xh1')).state, 'committed');
  const g0 = await al.reserve('aptos:mainnet', ACC2, 'g0', 0n), g1 = await al.reserve('aptos:mainnet', ACC2, 'g1', 0n), g2 = await al.reserve('aptos:mainnet', ACC2, 'g2', 0n);
  await al.release(g1.id); const again = await al.reserve('aptos:mainnet', ACC2, 'g3', 0n); assert.equal(again.seq, g1.seq); assert.ok(g0.seq < g1.seq && g1.seq < g2.seq);
});
test('reconcile consumes lower reservations; released ones below the chain floor are never reused', async () => {
  const al = new SequenceAllocator(db.pool);
  const a = await al.reserve('aptos:testnet', long(0x77), 'a', 0n), b = await al.reserve('aptos:testnet', long(0x77), 'b', 0n);
  await al.markBroadcast(a.id, '0xa', { gasUnitPrice: 1n, maxGasAmount: 1n }, 10n);
  await al.reconcile('aptos:testnet', long(0x77), 2n);
  const c = await al.reserve('aptos:testnet', long(0x77), 'c', 2n); assert.ok(c.seq >= 2n);
  const left = await db.pool.query(`select state from aptos_sequence_reservations where id in ($1,$2) order by seq`, [a.id, b.id]); assert.deepEqual(left.rows.map((r) => r.state), ['committed', 'released']);
});
test('in-flight limit and DB-level duplicate protection', async () => {
  const al = new SequenceAllocator(db.pool, { maxInflight: 2 });
  await al.reserve('aptos:mainnet', long(0x99), '1', 0n); await al.reserve('aptos:mainnet', long(0x99), '2', 0n);
  await assert.rejects(() => al.reserve('aptos:mainnet', long(0x99), '3', 0n), (e: unknown) => e instanceof SequenceError && e.code === 'inflight_limit');
  await assert.rejects(() => db.pool.query(`insert into aptos_sequence_reservations(chain_id,account,seq,intent_id) values ('aptos:mainnet',$1,0,'sneak')`, [long(0x99)]), /aptos_seq_active_uq|duplicate/);
});
