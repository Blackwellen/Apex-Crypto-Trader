import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// @ts-expect-error plain ESM helper shared with the DB test-suite
import { freshDb } from '../../../packages/db/tests/helpers.mjs';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { makePool } from '../src/db.ts';
import { signDevToken } from '../src/auth.ts';

const secret = 'test-secret-test-secret-test-secret-123456';
let db: any, app: Awaited<ReturnType<typeof buildApp>>, pool: any;
const users = { a: randomUUID(), b: randomUUID(), t: randomUUID() };
let tok: Record<string, string> = {};
let USDC: string, ETH: string;

before(async () => {
  db = await freshDb();
  await db.pool.query(`insert into auth.users(id,email) values ($1,'a@t'),($2,'b@t'),($3,'t@t')`, [users.a, users.b, users.t]);
  await db.pool.query(`insert into chain_registry(id,namespace,chain_ref,family,name,native_symbol,native_decimals,finality_model,address_format) values ('eip155:1','eip155','1','evm','Ethereum','ETH',18,'probabilistic','0x-hex20'),('solana:mainnet','solana','mainnet','svm','Solana','SOL',9,'confirmed','base58-32') on conflict (id) do nothing`);   // later migrations may already seed the registry
  await db.pool.query(`insert into assets(chain_id,contract,symbol,decimals) values ('eip155:1','native','ETH',18),('eip155:1','0xusdc','USDC',6) on conflict (chain_id,contract) do nothing`);
  USDC = (await db.pool.query(`select id from assets where chain_id='eip155:1' and contract='0xusdc'`)).rows[0].id; ETH = (await db.pool.query(`select id from assets where chain_id='eip155:1' and contract='native'`)).rows[0].id;
  const url = db.url.replace('postgres@', 'apex_app:apex_app@');
  pool = makePool(url);
  const cfg = { ...loadConfig({ SUPABASE_JWT_SECRET: secret, DATABASE_URL: url } as any), devAuth: true, devAdminDatabaseUrl: db.url, rateLimitMax: 100000 };
  app = await buildApp(pool, cfg);
  tok = { a: await signDevToken(users.a, secret), b: await signDevToken(users.b, secret), t: await signDevToken(users.t, secret) };
});
after(async () => { await app.close(); await pool.end(); await db.close(); });

const call = (method: 'GET' | 'POST', url: string, who: 'a' | 'b' | 't' | null, payload?: unknown, key?: string) =>
  app.inject({ method, url, payload: payload as any, headers: { ...(who ? { authorization: `Bearer ${tok[who]}` } : {}), ...(key ? { 'idempotency-key': key } : {}) } });
const cmd = (name: string, who: 'a' | 'b' | 't', body: unknown, key: string = randomUUID()) => call('POST', `/v1/commands/${name}`, who, body, key);

let W: string, PF: string, B1: string, B2: string, BSH: string, WAL: string, WCA: string, WAL2: string;
const A1 = '0x9a4Fc2bC7897dd21305B92C0e5cb86DFFc984362', A2 = '0x44f9830d8f779C62ba1C3B98ecbB17C260A69aC4';

test('setup + auth: new read endpoints reject unauthenticated callers', async () => {
  for (const u of ['/v1/portfolios/summary?workspace=' + randomUUID(), '/v1/baskets?workspace=' + randomUUID(), `/v1/wallets/${randomUUID()}/activity`, `/v1/wallets/${randomUUID()}/fees`, `/v1/wallets/${randomUUID()}/obligations`])
    assert.equal((await call('GET', u, null)).statusCode, 401, u);
  for (const c of ['pauseWallet', 'resumeWallet', 'archiveWallet', 'revokeWallet', 'moveWalletBucket']) assert.equal((await call('POST', `/v1/commands/${c}`, null, {})).statusCode, 401);
  W = (await cmd('createWorkspace', 'a', { name: 'Alpha' })).json().result.id;
  PF = (await cmd('createPortfolio', 'a', { workspace: W, name: 'Core' })).json().result.id;
  B1 = (await cmd('createBucket', 'a', { portfolio: PF, name: 'Trading' })).json().result.id;
  B2 = (await cmd('createBucket', 'a', { portfolio: PF, name: 'Quant' })).json().result.id;
  BSH = (await cmd('createBucket', 'a', { portfolio: PF, name: 'Shared', segregation: 'logical' })).json().result.id;
  WAL = (await cmd('connectWallet', 'a', { workspace: W, nickname: 'W1', family: 'evm', address: A1, chains: ['eip155:1'] })).json().result.id;
  WAL2 = (await cmd('connectWallet', 'a', { workspace: W, nickname: 'W2', family: 'evm', address: A2, chains: ['eip155:1'] })).json().result.id;
  WCA = (await db.pool.query(`select id from wallet_chain_accounts where wallet_id=$1`, [WAL])).rows[0].id;
  assert.ok(W && PF && B1 && WAL);
  // membership for a trader (cosmetic role gating is re-checked by the DB)
  await db.pool.query(`insert into memberships values ($1,$2,'trader')`, [W, users.t]);
});

test('address validation (server): seed phrases, keys and bad structure per family are refused; EVM canonicalised', async () => {
  const bad = async (family: string, address: string, capability?: string) => {
    const r = await cmd('connectWallet', 'a', { workspace: W, nickname: 'x', family, address, ...(capability ? { capability } : {}) });
    assert.ok([400, 422].includes(r.statusCode), `${family} ${address} -> ${r.statusCode} ${r.body}`);
  };
  await bad('evm', 'abandon abandon abandon abandon abandon abandon abandon about');                    // short seed phrase (no zod BIP39 match, DB must refuse)
  await bad('evm', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  await bad('evm', '0x9a4Fc2bC7897dd21305B92C0e5cb86DFFc98436');                                         // 39 hex
  await bad('svm', '0x9a4Fc2bC7897dd21305B92C0e5cb86DFFc984362');                                        // EVM string into SVM family (0 not base58)
  await bad('sui', '0x9a4Fc2bC7897dd21305B92C0e5cb86DFFc984362');                                        // sui needs 64 hex
  await bad('tron', 'T' + '1'.repeat(10) + '0'.repeat(23));                                              // 0 not base58
  await bad('evm', A1, 'cex_view_only');                                                                  // capability/family mismatch
  await bad('cex', 'binance-subaccount-main-0001', 'watch_only');
  const pk = await cmd('connectWallet', 'a', { workspace: W, nickname: 'x', family: 'evm', address: A1, privateKey: '0xdead' }); assert.equal(pk.statusCode, 400); assert.equal(pk.json().error, 'secret_field_rejected');
  const good = await cmd('connectWallet', 'a', { workspace: W, nickname: 'sol', family: 'svm', address: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', chains: ['solana:mainnet'] });
  assert.equal(good.statusCode, 200, good.body);
  const dup = await cmd('connectWallet', 'a', { workspace: W, nickname: 'dup', family: 'evm', address: A1.toLowerCase() });
  assert.equal(dup.statusCode, 409, 'same EVM address in different case is the same wallet');
  const stored = (await call('GET', `/v1/wallets?workspace=${W}`, 'a')).json().items.find((w: any) => w.id === WAL);
  assert.equal(stored.address, A1.toLowerCase());
});

test('physical bucket refuses shared wallets; logical bucket requires acknowledgement', async () => {
  assert.equal((await cmd('assignWalletToBucket', 'a', { wallet: WAL, bucket: B1, exclusive: false, maxAllocationBps: 5000, logicalAck: true })).statusCode, 422, 'physical bucket + shared wallet');
  assert.equal((await cmd('assignWalletToBucket', 'a', { wallet: WAL, bucket: BSH, exclusive: false, maxAllocationBps: 5000, logicalAck: false })).statusCode, 422, 'no ack');
  assert.equal((await cmd('assignWalletToBucket', 'a', { wallet: WAL, bucket: BSH, exclusive: false, maxAllocationBps: 5000, logicalAck: true })).statusCode, 200);
  assert.equal((await cmd('assignWalletToBucket', 'a', { wallet: WAL2, bucket: B1 })).statusCode, 200);
});

test('portfolio summary reports declared vs effective segregation facts; RLS hides other tenants', async () => {
  const s = (await call('GET', `/v1/portfolios/summary?workspace=${W}`, 'a')).json();
  const p = s.portfolios.find((x: any) => x.id === PF);
  assert.equal(p.bucket_count, 3); assert.equal(p.declared_physical, 2); assert.equal(p.declared_logical, 1);
  assert.equal(p.shared_wallet_buckets, 1); assert.equal(p.unassigned_buckets, 1); assert.equal(p.wallet_count, 2);
  assert.match(s.provenance, /No market-price/);
  const other = (await call('GET', `/v1/portfolios/summary?workspace=${W}`, 'b')).json();
  assert.deepEqual(other.portfolios, []); assert.deepEqual(other.balances, []);
  assert.deepEqual((await call('GET', `/v1/baskets?workspace=${W}`, 'b')).json().baskets, []);
});

test('baskets list: members, holdings; weights must total 100%', async () => {
  assert.equal((await cmd('createBasket', 'a', { bucket: B1, name: 'bad', members: [{ asset: USDC, weight_bps: 5000 }, { asset: ETH, weight_bps: 4000 }] })).statusCode, 422);
  const ok = await cmd('createBasket', 'a', { bucket: B1, name: 'Core', members: [{ asset: USDC, weight_bps: 6000 }, { asset: ETH, weight_bps: 4000 }] }); assert.equal(ok.statusCode, 200, ok.body);
  const wca2 = (await db.pool.query(`select id from wallet_chain_accounts where wallet_id=$1`, [WAL2])).rows[0].id;
  await cmd('paperDeposit', 'a', { workspace: W, walletChainAccount: wca2, asset: USDC, amount: '700' }); await cmd('allocate', 'a', { workspace: W, bucket: B1, walletChainAccount: wca2, asset: USDC, amount: '700' });
  const r = (await call('GET', `/v1/baskets?workspace=${W}`, 'a')).json();
  assert.equal(r.baskets.length, 1); assert.equal(r.baskets[0].members.length, 2);
  assert.equal(r.holdings.find((h: any) => h.symbol === 'USDC').amount, '700');
  assert.equal((await call('GET', `/v1/baskets?workspace=${W}`, 'b')).json().baskets.length, 0);
});

test('move wallet: refused while the old bucket holds ledger balance; allowed after funds leave; audited', async () => {
  const bad = await cmd('moveWalletBucket', 'a', { wallet: WAL2, fromBucket: B1, toBucket: B2 });
  assert.equal(bad.statusCode, 422); assert.match(bad.json().message, /ledger balance/);
  // wallet with no balance can move
  const mv = await cmd('moveWalletBucket', 'a', { wallet: WAL, fromBucket: BSH, toBucket: B2 }); assert.equal(mv.statusCode, 200, mv.body);
  const w = (await call('GET', `/v1/wallets/${WAL}`, 'a')).json(); assert.deepEqual(w.allocations.map((a: any) => a.bucket_id), [B2]);
  const aud = (await call('GET', `/v1/audit?workspace=${W}`, 'a')).json().items; assert.ok(aud.some((e: any) => e.action === 'wallet.move'));
  assert.equal((await cmd('moveWalletBucket', 'b', { wallet: WAL, fromBucket: B2, toBucket: B1 })).statusCode, 403, 'cross-tenant: not a member -> permission denied');
});

test('lifecycle: roles, reasons, pause blocks funding, revoke refused with open reservations, terminal states', async () => {
  assert.equal((await cmd('pauseWallet', 't', { wallet: WAL, reason: 'maintenance' })).statusCode, 403, 'trader cannot change wallet state');
  assert.equal((await cmd('pauseWallet', 'b', { wallet: WAL, reason: 'maintenance' })).statusCode, 403, 'outsider (other tenant) is denied');
  assert.equal((await cmd('pauseWallet', 'a', { wallet: WAL, reason: 'x' })).statusCode, 400, 'reason too short');
  assert.equal((await cmd('pauseWallet', 'a', { wallet: WAL, reason: 'maintenance window' })).statusCode, 200);
  const dep = await cmd('paperDeposit', 'a', { workspace: W, walletChainAccount: WCA, asset: USDC, amount: '1' }); assert.equal(dep.statusCode, 422); assert.match(dep.json().message, /paused/);
  assert.equal((await cmd('resumeWallet', 'a', { wallet: WAL, reason: 'window over' })).statusCode, 200);
  // open reservation on WAL2 blocks revoke
  const wca2 = (await db.pool.query(`select id from wallet_chain_accounts where wallet_id=$1`, [WAL2])).rows[0].id;
  await db.asService((c: any) => c.query(`select reserve_capital($1,'paper',$2,$3,$4,100,'ui-capital-intent')`, [W, B1, wca2, USDC]));
  const ob = (await call('GET', `/v1/wallets/${WAL2}/obligations`, 'a')).json().obligations; assert.equal(ob.reservations, 1);
  const rev = await cmd('revokeWallet', 'a', { wallet: WAL2, reason: 'compromised' }); assert.equal(rev.statusCode, 422); assert.match(rev.json().message, /open reservation/);
  assert.equal((await cmd('archiveWallet', 'a', { wallet: WAL2, reason: 'cleanup' })).statusCode, 422);
  await db.asService((c: any) => c.query(`select release_reservation(id, 0) from capital_reservations where intent_key='ui-capital-intent'`));
  // still holds available balance but no obligations -> revoke allowed; then terminal
  const rev2 = await cmd('revokeWallet', 'a', { wallet: WAL2, reason: 'compromised' }); assert.equal(rev2.statusCode, 200, rev2.body);
  assert.equal((await cmd('resumeWallet', 'a', { wallet: WAL2, reason: 'oops' })).statusCode, 422, 'revoked is terminal');
  const al = await cmd('allocate', 'a', { workspace: W, bucket: B1, walletChainAccount: wca2, asset: USDC, amount: '1' }); assert.equal(al.statusCode, 422);
  const aud = (await call('GET', `/v1/audit?workspace=${W}`, 'a')).json().items.map((e: any) => e.action);
  for (const a of ['wallet.pause', 'wallet.resume', 'wallet.revoked']) assert.ok(aud.includes(a), a);
});

test('activity + fees endpoints: ledger-derived, RLS-scoped', async () => {
  const act = (await call('GET', `/v1/wallets/${WAL2}/activity`, 'a')).json();
  assert.ok(act.entries.some((e: any) => e.kind === 'deposit')); assert.ok(act.audit.length >= 1);
  assert.equal((await call('GET', `/v1/wallets/${WAL2}/activity`, 'b')).statusCode, 404);
  assert.equal((await call('GET', `/v1/wallets/${WAL2}/fees`, 'b')).statusCode, 404);
  const fees = (await call('GET', `/v1/wallets/${WAL2}/fees`, 'a')).json(); assert.ok(Array.isArray(fees.reserves));
  assert.equal((await call('GET', `/v1/wallets/not-a-uuid/activity`, 'a')).statusCode, 400);
});

test('concurrent identical allocate with one idempotency key does not double-fund', async () => {
  const wal = (await cmd('connectWallet', 'a', { workspace: W, nickname: 'W3', family: 'evm', address: '0x7777777777777777777777777777777777777777', chains: ['eip155:1'] })).json().result.id;
  const wca = (await db.pool.query(`select id from wallet_chain_accounts where wallet_id=$1`, [wal])).rows[0].id;
  const b = (await cmd('createBucket', 'a', { portfolio: PF, name: 'Race' })).json().result.id;
  await cmd('assignWalletToBucket', 'a', { wallet: wal, bucket: b });
  await cmd('paperDeposit', 'a', { workspace: W, walletChainAccount: wca, asset: USDC, amount: '1000' });
  const key = 'race-allocate-0001';
  const rs = await Promise.all(Array.from({ length: 8 }, () => cmd('allocate', 'a', { workspace: W, bucket: b, walletChainAccount: wca, asset: USDC, amount: '600' }, key)));
  assert.ok(rs.every((r) => r.statusCode === 200), rs.map((r) => r.body).join('|'));
  const bal = (await call('GET', `/v1/buckets/${b}`, 'a')).json().balances.find((x: any) => x.state === 'available' && x.symbol === 'USDC');
  assert.equal(bal.amount, '600');
});

test('wallet accounts + bucket waterfall endpoints: auth, RLS isolation, shape', async () => {
  assert.equal((await call('GET', `/v1/wallets/accounts?workspace=${W}`, null)).statusCode, 401);
  assert.equal((await call('GET', `/v1/buckets/${B1}/waterfall`, null)).statusCode, 401);
  const a = (await call('GET', `/v1/wallets/accounts?workspace=${W}`, 'a')).json();
  assert.ok(a.accounts.length >= 3); assert.ok(a.accounts.every((x: any) => x.chain_id && x.address && x.family));
  assert.ok(a.balances.some((x: any) => x.symbol === 'USDC' && x.state === 'available'));
  assert.match(a.note, /not available until a certified read adapter/);
  const other = (await call('GET', `/v1/wallets/accounts?workspace=${W}`, 'b')).json(); assert.deepEqual(other.accounts, []); assert.deepEqual(other.balances, []);
  const wf = (await call('GET', `/v1/buckets/${B1}/waterfall`, 'a')).json(); assert.deepEqual(wf.executions, []);
  assert.equal((await call('GET', `/v1/buckets/${B1}/waterfall`, 'b')).statusCode, 404);
  assert.equal((await call('GET', `/v1/buckets/nope/waterfall`, 'a')).statusCode, 400);
  assert.equal((await call('GET', `/v1/wallets/accounts`, 'a')).statusCode, 400, 'workspace is required');
});

test('validation: lifecycle and move commands reject unknown fields and bad ids', async () => {
  assert.equal((await cmd('pauseWallet', 'a', { wallet: 'x', reason: 'abc' })).statusCode, 400);
  assert.equal((await cmd('pauseWallet', 'a', { wallet: WAL, reason: 'abc', extra: 1 })).statusCode, 400);
  assert.equal((await cmd('moveWalletBucket', 'a', { wallet: WAL, fromBucket: B1, toBucket: B2, maxAllocationBps: 0 })).statusCode, 400);
  assert.equal((await call('POST', '/v1/commands/revokeWallet', 'a', { wallet: WAL, reason: 'abc' })).statusCode, 400, 'idempotency key required');
  assert.equal((await cmd('revokeWallet', 'a', { wallet: WAL, reason: 'abc', privateKey: '0x1' })).json().error, 'secret_field_rejected');
});
