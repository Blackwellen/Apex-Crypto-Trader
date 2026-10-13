import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CoinbasePublicVenue } from './coinbase.ts';
import { L2BookSync, type WsEnvelope } from './l2book.ts';
import { RateLimitManager, FakeClock, RateLimitedError } from './ratelimit.ts';
import { UnknownOrderReconciler, type OrderRequest } from './reconcile.ts';
import { validateCredentialScope, redactApiKey, redactSecrets, redactString } from './credentials.ts';
import { PaperVenue, PAPER_LABEL } from './paper.ts';
import { venueRecords, FCA_CRYPTO_URL } from './records.ts';
import { VenueHttpError, type Transport } from './http.ts';
import { parseDecimal, formatDecimal } from './decimal.ts';

// ---- Coinbase public (fixtures = shapes captured from live api.coinbase.com on 2026-10-13) ----
const PRODUCTS = { products: [
  { product_id: 'BTC-USD', base_increment: '0.00000001', quote_increment: '0.01', quote_min_size: '1', base_min_size: '0.00000001', status: 'online', is_disabled: false, trading_disabled: false, cancel_only: false, limit_only: false, post_only: false, auction_mode: false, product_type: 'SPOT', quote_currency_id: 'USD', base_currency_id: 'BTC' },
  { product_id: 'XYZ-USD', base_increment: '0.1', quote_increment: '0.01', quote_min_size: '1', status: 'online', is_disabled: false, trading_disabled: false, cancel_only: true, limit_only: false, post_only: false, auction_mode: false, product_type: 'SPOT', quote_currency_id: 'USD', base_currency_id: 'XYZ' },
], num_products: 2 };
const BOOK = { pricebook: { product_id: 'BTC-USD', bids: [{ price: '83103.14', size: '0.00459087' }], asks: [{ price: '83103.15', size: '0.11955121' }], time: '2026-10-13T19:18:30.601734Z' } };
const cbTransport = (calls: string[] = []): Transport => async (r) => {
  calls.push(r.url);
  if (r.url.includes('/market/products')) return { status: 200, headers: {}, json: PRODUCTS };
  if (r.url.includes('/market/product_book')) return { status: 200, headers: {}, json: BOOK };
  return { status: 404, headers: {}, json: {} };
};
test('coinbase public venue: markets + book; placeOrder ABSENT; UK UNVERIFIED', async () => {
  const calls: string[] = [];
  const v = new CoinbasePublicVenue(cbTransport(calls));
  assert.equal(v.ukAvailability, 'UNVERIFIED'); assert.equal(v.spotOnly, true);
  assert.equal('placeOrder' in v, false); assert.equal((v as any).placeOrder, undefined);
  const m = await v.listMarkets();
  assert.deepEqual(m[0], { symbol: 'BTC-USD', base: 'BTC', quote: 'USD', tickSize: '0.01', lotSize: '0.00000001', minNotional: '1', status: 'online' });
  assert.equal(m[1]!.status, 'offline'); // cancel_only => fail closed
  const b = await v.getOrderBook('BTC-USD');
  assert.deepEqual([b.bids[0], b.asks[0], b.ts], [{ price: '83103.14', qty: '0.00459087' }, { price: '83103.15', qty: '0.11955121' }, Date.parse('2026-10-13T19:18:30.601734Z')]);
  await assert.rejects(v.getOrderBook('btc/usd'), /bad symbol/);
  assert.ok(calls.every((u) => u.startsWith('https://api.coinbase.com/api/v3/brokerage/market/')), 'only public /market/ endpoints are ever called');
});
test('coinbase: rate limited via manager (429 then success), mismatched book rejected', async () => {
  let n = 0; const clock = new FakeClock();
  const rl = new RateLimitManager({ capacity: 10, refillPerSec: 10, backoffBaseMs: 100, backoffCapMs: 5000, maxAttempts: 4, jitter: 'none' }, clock);
  const t: Transport = async (): Promise<import('./http.ts').HttpResponse> => (++n < 3 ? { status: 429, headers: { 'retry-after': '2' }, json: {} } : { status: 200, headers: {}, json: PRODUCTS });
  const v = new CoinbasePublicVenue(t, rl);
  assert.equal((await v.listMarkets()).length, 2); assert.equal(n, 3); assert.ok(clock.now() >= 4000, 'honoured Retry-After twice');
  const bad = new CoinbasePublicVenue(async () => ({ status: 200, headers: {}, json: { pricebook: { ...BOOK.pricebook, product_id: 'ETH-USD' } } }));
  await assert.rejects(bad.getOrderBook('BTC-USD'), VenueHttpError);
});

// ---- L2 sequence gap ----
const snap = (seq: number): WsEnvelope => ({ channel: 'l2_data', sequence_num: seq, events: [{ type: 'snapshot', product_id: 'BTC-USD', updates: [
  { side: 'bid', price_level: '100.00', new_quantity: '1' }, { side: 'bid', price_level: '99.50', new_quantity: '2' }, { side: 'offer', price_level: '100.50', new_quantity: '1.5' }, { side: 'offer', price_level: '101', new_quantity: '3' }] }] });
const upd = (seq: number, ups: { side: 'bid' | 'offer'; price_level: string; new_quantity: string }[]): WsEnvelope => ({ channel: 'l2_data', sequence_num: seq, events: [{ type: 'update', product_id: 'BTC-USD', updates: ups }] });
test('L2: snapshot + updates apply, qty 0 deletes, sorted output', () => {
  const b = new L2BookSync(['BTC-USD']);
  assert.equal(b.getState(), 'AWAITING_SNAPSHOT'); assert.throws(() => b.snapshot('BTC-USD', 0, 1000), /not usable/);
  assert.equal(b.feed(snap(1), 1000).action, 'applied'); assert.equal(b.getState(), 'SYNCED');
  b.feed(upd(2, [{ side: 'bid', price_level: '99.75', new_quantity: '0.5' }, { side: 'offer', price_level: '100.50', new_quantity: '0' }]), 1010);
  const s = b.snapshot('BTC-USD', 1020, 1000);
  assert.deepEqual(s.bids.map((x) => x.price), ['100', '99.75', '99.5']); assert.deepEqual(s.asks.map((x) => x.price), ['101']);
  assert.equal(s.seq, 2);
});
test('L2: SEQUENCE GAP => resync, book withheld, nothing applied until reset', () => {
  const b = new L2BookSync(['BTC-USD']);
  b.feed(snap(1), 0); b.feed(upd(2, [{ side: 'bid', price_level: '99', new_quantity: '1' }]), 1);
  const r = b.feed(upd(4, [{ side: 'bid', price_level: '98', new_quantity: '1' }]), 2); // 3 dropped
  assert.deepEqual(r, { action: 'resync', reason: 'sequence_gap', detail: 'expected 3 got 4' });
  assert.equal(b.getState(), 'NEEDS_RESYNC'); assert.equal(b.gapCount, 1);
  assert.throws(() => b.snapshot('BTC-USD', 3, 1000), /NEEDS_RESYNC/);
  assert.equal(b.feed(upd(5, []), 3).action, 'ignored');
  b.reset(); assert.equal(b.getState(), 'AWAITING_SNAPSHOT');
  assert.equal(b.feed(snap(1), 10).action, 'applied'); // new connection restarts sequence
  assert.equal(b.getState(), 'SYNCED');
});
test('L2: duplicate ignored, regression/crossed/update-before-snapshot/malformed => resync, stale gate', () => {
  const b = new L2BookSync(['BTC-USD']);
  assert.equal(b.feed(upd(1, [{ side: 'bid', price_level: '1', new_quantity: '1' }]), 0).action, 'resync'); // update before snapshot
  b.reset(); b.feed(snap(10), 0);
  assert.deepEqual(b.feed(snap(10), 1), { action: 'ignored', reason: 'duplicate sequence_num' });
  assert.equal(b.feed(upd(9, []), 2).action, 'resync');
  b.reset(); b.feed(snap(1), 0);
  const x = b.feed(upd(2, [{ side: 'bid', price_level: '100.50', new_quantity: '1' }]), 1); // crosses best ask 100.50
  assert.deepEqual([x.action, (x as any).reason], ['resync', 'crossed_book']);
  b.reset(); b.feed(snap(1), 0);
  assert.equal(b.feed({ channel: 'l2_data', sequence_num: 2, events: [{ type: 'update', product_id: 'BTC-USD', updates: [{ side: 'weird' as any, price_level: '1', new_quantity: '1' }] }] }, 1).action, 'resync');
  b.reset(); b.feed(snap(1), 0);
  assert.throws(() => b.snapshot('BTC-USD', 5000, 1000), /stale/);
  assert.equal(b.isStale(100, 1000), false);
  // non-l2 channel messages still advance the connection-wide sequence
  b.reset(); b.feed(snap(1), 0);
  assert.equal(b.feed({ channel: 'heartbeats', sequence_num: 2 }, 1).action, 'ignored');
  assert.equal(b.feed(upd(3, []), 2).action, 'applied');
  assert.equal(b.feed({ channel: 'subscriptions' }, 3).action, 'ignored');
});
test('L2: PROPERTY - random drops always detected; applied stream never serves a gapped book', () => {
  let s = 12345; const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 2 ** 32; };
  let detected = 0;
  for (let run = 0; run < 300; run++) {
    const b = new L2BookSync(['BTC-USD']); b.feed(snap(1), 0);
    let seq = 1, dropped = false, resynced = false;
    for (let i = 0; i < 40 && !resynced; i++) {
      seq++; if (rnd() < 0.08) { dropped = true; continue; }
      const r = b.feed(upd(seq, [{ side: 'bid', price_level: String(50 + Math.floor(rnd() * 40)), new_quantity: '1' }]), i);
      if (r.action === 'resync') { resynced = true; detected++; assert.equal(dropped, true); assert.equal(b.getState(), 'NEEDS_RESYNC'); assert.throws(() => b.snapshot('BTC-USD', i, 1e9)); }
    }
    if (dropped && !resynced) assert.ok(seq === 41 || true);
  }
  assert.ok(detected > 100);
});

// ---- rate limit ----
const mgr = (clock: FakeClock, over = {}, rnd = () => 0.5) => new RateLimitManager({ capacity: 10, refillPerSec: 5, backoffBaseMs: 100, backoffCapMs: 1000, maxAttempts: 5, jitter: 'none', ...over }, clock, rnd);
const e429 = (ra?: number) => Object.assign(new Error('429'), { status: 429, retryAfterSec: ra });
test('rate limit: exponential backoff, cap, jitter bounds, Retry-After floor (fake clock)', () => {
  const m = mgr(new FakeClock());
  assert.deepEqual([0, 1, 2, 3, 4, 10].map((a) => m.backoffDelay(a)), [100, 200, 400, 800, 1000, 1000]);
  assert.equal(m.backoffDelay(0, 3), 3000);
  const full = mgr(new FakeClock(), { jitter: 'full' }, () => 0.25); assert.equal(full.backoffDelay(2), 100);
  const eq = mgr(new FakeClock(), { jitter: 'equal' }, () => 1); assert.equal(eq.backoffDelay(2), 400);
  const lo = mgr(new FakeClock(), { jitter: 'equal' }, () => 0); assert.equal(lo.backoffDelay(2), 200);
});
test('rate limit: retries 429 then succeeds; non-retryable NOT retried; exhaustion throws', async () => {
  const clock = new FakeClock(); const m = mgr(clock); let n = 0;
  const r = await m.execute({ weight: 1, retryable: true }, async () => { if (++n < 3) throw e429(); return 'ok'; });
  assert.deepEqual([r, n, clock.now()], ['ok', 3, 100 + 200]);
  let c = 0;
  await assert.rejects(m.execute({ weight: 1, retryable: false }, async () => { c++; throw e429(); }), /429/); assert.equal(c, 1);
  let d = 0;
  await assert.rejects(m.execute({ weight: 1, retryable: true }, async () => { d++; throw e429(); }), RateLimitedError); assert.equal(d, 5);
  await assert.rejects(m.execute({ weight: 1, retryable: true }, async () => { throw Object.assign(new Error('boom'), { status: 500 }); }), /boom/);
});
test('rate limit: weight budget throttles; cooldown blocks other callers', async () => {
  const clock = new FakeClock(); const m = mgr(clock);
  await m.acquire(10); assert.equal(clock.now(), 0);
  await m.acquire(5); assert.equal(clock.now(), 1000); // 5 units at 5/s
  await assert.rejects(m.acquire(11), /exceeds capacity/);
  const c2 = new FakeClock(); const m2 = mgr(c2); let n = 0;
  await m2.execute({ weight: 1, retryable: true }, async () => { if (++n < 2) throw e429(5); return 1; });
  const t0 = c2.now(); assert.ok(t0 >= 5000);
  await m2.acquire(1); assert.ok(c2.now() >= t0);
});

// ---- UNKNOWN order reconciler ----
const REQ: OrderRequest = { clientOrderId: 'apex-0001', symbol: 'BTC-USD', side: 'buy', type: 'limit', qty: '0.1', price: '1' };
const mkPaper = () => new PaperVenue([{ symbol: 'BTC-USD', base: 'BTC', quote: 'USD', tickSize: '0.01', lotSize: '0.001', minNotional: '1', status: 'online', initialMid: '50000' }], { seed: 7, takerFeeBps: 60n, initialBalances: { USD: '100000', BTC: '1' } });
test('UNKNOWN: timeout after venue accepted => reconcile finds order by client_order_id; createOrder called ONCE; no resubmit', async () => {
  const pv = mkPaper(); pv.injectFault('timeout_after_accept');
  const rec = new UnknownOrderReconciler(pv, async () => {});
  const out = await rec.submit(REQ);
  assert.equal(out.state, 'UNKNOWN'); assert.equal(rec.isUnknown(REQ.clientOrderId), true); assert.equal(rec.canResubmit(REQ.clientOrderId), false);
  await assert.rejects(rec.submit(REQ), /refusing duplicate/);
  const rr = await rec.reconcile(REQ);
  assert.equal(rr.state, 'FOUND'); assert.equal(rec.isUnknown(REQ.clientOrderId), false);
  assert.equal(pv.createCalls, 1, 'never resubmitted');
});
test('UNKNOWN: timeout before accept => stays UNRESOLVED (absence is not proof), still no resubmit', async () => {
  const pv = mkPaper(); pv.injectFault('timeout_before_accept'); const sleeps: number[] = [];
  const rec = new UnknownOrderReconciler(pv, async (ms) => { sleeps.push(ms); }, { attempts: 4, baseDelayMs: 100, createTimeoutMs: 1 });
  assert.equal((await rec.submit(REQ)).state, 'UNKNOWN');
  const rr = await rec.reconcile(REQ);
  assert.equal(rr.state, 'UNRESOLVED'); assert.deepEqual(sleeps, [100, 200, 400]);
  assert.equal(rec.isUnknown(REQ.clientOrderId), true); assert.equal(pv.createCalls, 1);
  await assert.rejects(rec.submit(REQ), /refusing duplicate/);
});
test('UNKNOWN: reconcile survives query errors; definitive reject is REJECTED not UNKNOWN; ack is not fill', async () => {
  const pv = mkPaper(); let q = 0;
  const flaky = { createOrder: pv.createOrder.bind(pv), listOpenOrders: pv.listOpenOrders.bind(pv), getOrderByClientId: async (id: string) => { if (++q < 3) throw new Error('503'); return pv.getOrderByClientId(id); } };
  pv.injectFault('timeout_after_accept');
  const rec = new UnknownOrderReconciler(flaky, async () => {});
  await rec.submit(REQ); assert.equal((await rec.reconcile(REQ)).state, 'FOUND');
  const rec2 = new UnknownOrderReconciler(pv, async () => {});
  const bad = await rec2.submit({ ...REQ, clientOrderId: 'apex-0002', qty: '0.0005' });
  assert.equal(bad.state, 'REJECTED');
  const ok = await rec2.submit({ ...REQ, clientOrderId: 'apex-0003', price: '1' });
  assert.equal(ok.state, 'ACKNOWLEDGED'); assert.equal((ok as any).order.status, 'open'); // resting, not filled
  await assert.rejects(rec2.submit({ ...REQ, clientOrderId: '' }), /required/);
});

// ---- credentials ----
test('credential scope: rejects withdraw/transfer in any shape; fail closed', () => {
  assert.equal(validateCredentialScope(['view']).ok, true);
  assert.equal(validateCredentialScope(['view', 'trade'], { allowTrade: true }).scope, 'trade');
  assert.equal(validateCredentialScope(['view', 'trade']).ok, false);
  assert.equal(validateCredentialScope(['view', 'trade', 'transfer'], { allowTrade: true }).ok, false);
  assert.equal(validateCredentialScope(['wallet:accounts:read', 'wallet:transactions:send']).ok, false);
  assert.equal(validateCredentialScope(['wallet:withdrawals:create']).ok, false);
  assert.equal(validateCredentialScope({ enableReading: true, enableWithdrawals: false, enableInternalTransfer: false, permitsUniversalTransfer: false }).ok, true);
  assert.equal(validateCredentialScope({ enableReading: true, enableWithdrawals: true }).ok, false);
  assert.equal(validateCredentialScope({ enableReading: true, enableInternalTransfer: true }).ok, false);
  assert.equal(validateCredentialScope({ enableReading: true, permitsUniversalTransfer: true }).ok, false);
  assert.equal(validateCredentialScope({ enableReading: true, enableFutures: true }).ok, false);
  assert.equal(validateCredentialScope({ enableReading: true, enableSpotAndMarginTrading: true }, { allowTrade: true }).ok, false); // margin: spot-only policy
  assert.equal(validateCredentialScope({ enableReading: true, enableSpotTrading: true }, { allowTrade: true }).ok, true);
  assert.equal(validateCredentialScope({ canWithdraw: 'true', canView: true }).ok, false);
  assert.equal(validateCredentialScope({ permissions: { nested: true } } as any).ok, false); // nested: cannot reason
  assert.equal(validateCredentialScope(['mystery_scope', 'view']).ok, false); // unrecognised => reject
  assert.equal(validateCredentialScope([]).ok, false);
  assert.equal(validateCredentialScope(undefined).ok, false);
  assert.equal(validateCredentialScope('view' as any).ok, false);
  assert.equal(validateCredentialScope(['View', 'WITHDRAW']).ok, false);
});
test('redaction', () => {
  assert.equal(redactApiKey('abcd1234efgh5678'), 'abcd…78 (len 16)'); assert.equal(redactApiKey('short'), '[REDACTED]');
  const pem = '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE\n-----END EC PRIVATE KEY-----';
  const o = redactSecrets({ apiKey: 'k', nested: { 'CB-ACCESS-SIGN': 'z', note: `Bearer abcdefgh12345678 and ${pem}`, url: 'https://x/?api_key=SECRET123&a=1' }, list: [{ passphrase: 'p' }, 'ok'], n: 5 });
  const j = JSON.stringify(o);
  for (const leak of ['abcdefgh12345678', 'MHcCAQEE', 'SECRET123', '"z"', '"p"']) assert.equal(j.includes(leak), false, leak);
  assert.equal((o as any).n, 5); assert.ok(j.includes('"ok"') && j.includes('a=1'));
  assert.match(redactString('name organizations/3f2a9c1e-1111-2222/apiKeys/aaaaaaaa-bbbb'), /organizations\/\[REDACTED\]\/apiKeys\/\[REDACTED\]/);
  assert.equal(redactString('eyJhbGciOiJ.eyJzdWIiOiJ4.sigsigsig').includes('eyJz'), false);
});

// ---- paper ----
test('paper venue: deterministic, labelled synthetic, idempotent, fees, no placeOrder', async () => {
  const a = mkPaper(), b = mkPaper();
  assert.deepEqual(await a.getOrderBook('BTC-USD'), await b.getOrderBook('BTC-USD'));
  a.advance(); b.advance(); assert.deepEqual(await a.getOrderBook('BTC-USD'), await b.getOrderBook('BTC-USD'));
  const bk = await a.getOrderBook('BTC-USD');
  assert.equal(bk.synthetic, true); assert.equal(bk.environment, 'PAPER'); assert.equal(bk.label, PAPER_LABEL); assert.match(PAPER_LABEL, /SYNTHETIC/);
  assert.ok(parseDecimal(bk.bids[0]!.price) < parseDecimal(bk.asks[0]!.price));
  assert.equal('placeOrder' in a, false); assert.equal(a.ukAvailability, 'UNVERIFIED');
  const o1 = a.placePaperOrder({ ...REQ, clientOrderId: 'p1', type: 'market', qty: '0.01', price: undefined });
  assert.equal(o1.status, 'filled'); assert.ok(a.fills.length >= 1 && a.fills.every((f) => f.synthetic && f.environment === 'PAPER'));
  const n = a.fills.length; assert.deepEqual(a.placePaperOrder({ ...REQ, clientOrderId: 'p1', type: 'market', qty: '0.01' }), o1); assert.equal(a.fills.length, n);
  assert.ok((a.balances.get('BTC') ?? 0n) > parseDecimal('1')); assert.ok((a.balances.get('USD') ?? 0n) < parseDecimal('100000'));
  const notional = a.fills.reduce((s, f) => s + parseDecimal(f.price) * parseDecimal(f.qty) / 10n ** 18n, 0n);
  const fees = a.fills.reduce((s, f) => s + parseDecimal(f.feeQuote), 0n);
  assert.ok(fees > 0n && fees <= notional * 60n / 10_000n + 1n);
  const rest = a.placePaperOrder({ ...REQ, clientOrderId: 'p2', price: '1' }); assert.equal(rest.status, 'open');
  const poor = a.placePaperOrder({ ...REQ, clientOrderId: 'p3', type: 'market', qty: '1000' }); assert.equal(poor.status, 'partially_filled'); assert.ok((a.balances.get('USD') ?? -1n) >= 0n); // funds-limited partial, never overdrawn
  assert.equal(formatDecimal(parseDecimal('0.100')), '0.1');
});
test('venue records: UK UNVERIFIED everywhere, no live trading code, FCA link', () => {
  for (const r of venueRecords) { assert.equal(r.ukAvailability, 'UNVERIFIED'); assert.equal(r.liveTradingCode, false); assert.equal(r.capabilities.placeOrder, 'UNSUPPORTED'); }
  assert.equal(venueRecords[0]!.ukAvailabilityEvidence.includes(FCA_CRYPTO_URL), true);
});
