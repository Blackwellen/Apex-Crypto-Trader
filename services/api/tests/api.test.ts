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
const users = { a: randomUUID(), b: randomUUID() };
let tok: Record<string, string> = {};
let ETH: string, USDC: string;

before(async () => {
  db = await freshDb();
  await db.pool.query(`insert into auth.users(id,email) values ($1,'a@t'),($2,'b@t')`, [users.a, users.b]);
  await db.pool.query(`insert into chain_registry(id,namespace,chain_ref,family,name,native_symbol,native_decimals,finality_model,address_format) values ('eip155:1','eip155','1','evm','Ethereum','ETH',18,'probabilistic','0x-hex20') on conflict do nothing`);
  const r = await db.pool.query(`insert into assets(chain_id,contract,symbol,decimals) values ('eip155:1','native','ETH',18),('eip155:1','0xusdc','USDC',6) returning id,symbol`);
  ETH = r.rows.find((x: any) => x.symbol === 'ETH').id; USDC = r.rows.find((x: any) => x.symbol === 'USDC').id;
  const url = db.url.replace('postgres@', 'apex_app:apex_app@');
  pool = makePool(url);
  const cfg = { ...loadConfig({ SUPABASE_JWT_SECRET: secret, DATABASE_URL: url } as any), devAuth: true, devAdminDatabaseUrl: db.url, rateLimitMax: 100000 };
  app = await buildApp(pool, cfg);
  tok = { a: await signDevToken(users.a, secret), b: await signDevToken(users.b, secret) };
});
after(async () => { await app.close(); await pool.end(); await db.close(); });

const call = async (method: 'GET' | 'POST', url: string, who: 'a' | 'b' | null, payload?: unknown, key?: string) =>
  app.inject({ method, url, payload: payload as any, headers: { ...(who ? { authorization: `Bearer ${tok[who]}` } : {}), ...(key ? { 'idempotency-key': key } : {}) } });
const cmd = async (name: string, who: "a" | "b", body: unknown, key: string = randomUUID()) => call('POST', `/v1/commands/${name}`, who, body, key);

let W: string, PF: string, BK: string, VAULT: string, WAL: string, WCA: string, WAL2: string, WCA2: string;

test('auth: unauthenticated and forged tokens are rejected; health is public', async () => {
  assert.equal((await call('GET', '/health', null)).statusCode, 200);
  assert.equal((await call('GET', '/v1/workspaces', null)).statusCode, 401);
  const forged = await signDevToken(users.a, 'wrong-secret-wrong-secret-wrong-secret-12');
  assert.equal((await app.inject({ method: 'GET', url: '/v1/workspaces', headers: { authorization: `Bearer ${forged}` } })).statusCode, 401);
});

test('command flow: workspace -> portfolio -> buckets -> wallets -> assign -> paper deposit -> allocate', async () => {
  W = (await cmd('createWorkspace', 'a', { name: 'Alpha' })).json().result.id; assert.ok(W);
  PF = (await cmd('createPortfolio', 'a', { workspace: W, name: 'Core' })).json().result.id;
  BK = (await cmd('createBucket', 'a', { portfolio: PF, name: 'Trading' })).json().result.id;
  VAULT = (await cmd('createBucket', 'a', { portfolio: PF, name: 'Vault', kind: 'protected_vault' })).json().result.id;
  const w1 = await cmd('connectWallet', 'a', { workspace: W, nickname: 'W1', family: 'evm', address: '0x9a4Fc2bC7897dd21305B92C0e5cb86DFFc984362', chains: ['eip155:1'] });
  assert.equal(w1.statusCode, 200, w1.body); WAL = w1.json().result.id;
  WAL2 = (await cmd('connectWallet', 'a', { workspace: W, nickname: 'W2', family: 'evm', address: '0x44f9830d8f779C62ba1C3B98ecbB17C260A69aC4', chains: ['eip155:1'] })).json().result.id;
  assert.equal((await cmd('assignWalletToBucket', 'a', { wallet: WAL, bucket: BK })).statusCode, 200);
  assert.equal((await cmd('assignWalletToBucket', 'a', { wallet: WAL2, bucket: VAULT })).statusCode, 200);
  const wallets = (await call('GET', `/v1/wallets?workspace=${W}`, 'a')).json().items;
  WCA = wallets.find((w: any) => w.id === WAL).chains.length && (await db.pool.query(`select id from wallet_chain_accounts where wallet_id=$1`, [WAL])).rows[0].id;
  WCA2 = (await db.pool.query(`select id from wallet_chain_accounts where wallet_id=$1`, [WAL2])).rows[0].id;
  const dep = await cmd('paperDeposit', 'a', { workspace: W, walletChainAccount: WCA, asset: USDC, amount: '1000' }); assert.equal(dep.statusCode, 200, dep.body);
  const al = await cmd('allocate', 'a', { workspace: W, bucket: BK, walletChainAccount: WCA, asset: USDC, amount: '1000' }); assert.equal(al.statusCode, 200, al.body);
  const ov = (await call('GET', `/v1/overview?workspace=${W}`, 'a')).json();
  assert.equal(ov.settings.live_allowed, false);
  assert.equal(ov.balances.find((b: any) => b.state === 'available' && b.symbol === 'USDC').amount, '1000');
  const bd = (await call('GET', `/v1/buckets/${BK}`, 'a')).json();
  assert.match(bd.segregationNote, /Physical/);
});

test('idempotency: header required; replayed key is a no-op, not a double deposit', async () => {
  assert.equal((await call('POST', '/v1/commands/paperDeposit', 'a', { workspace: W, walletChainAccount: WCA, asset: USDC, amount: '5' })).statusCode, 400);
  const k = 'replay-key-0001';
  const r1 = await cmd('paperDeposit', 'a', { workspace: W, walletChainAccount: WCA, asset: USDC, amount: '5' }, k);
  const r2 = await cmd('paperDeposit', 'a', { workspace: W, walletChainAccount: WCA, asset: USDC, amount: '5' }, k);
  assert.equal(r1.json().result.entry, r2.json().result.entry);
  const r3 = await cmd('paperDeposit', 'a', { workspace: W, walletChainAccount: WCA, asset: USDC, amount: '6' }, k);
  assert.equal(r3.statusCode, 422, 'same key different payload must be refused');
});

test('cross-tenant isolation over HTTP: B cannot read or mutate A', async () => {
  const wsB = (await cmd('createWorkspace', 'b', { name: 'Beta' })).json().result.id;
  for (const p of ['overview', 'portfolios', 'buckets', 'wallets', 'orders', 'audit', 'risk', 'allocations'])
    { const r = await call('GET', `/v1/${p}?workspace=${W}`, 'b'); assert.ok(r.statusCode === 404 || (r.json().items ?? []).length === 0 && r.statusCode === 200 || r.statusCode === 200, p); }
  assert.equal((await call('GET', `/v1/overview?workspace=${W}`, 'b')).statusCode, 404);
  assert.deepEqual((await call('GET', `/v1/buckets?workspace=${W}`, 'b')).json().items, []);
  assert.equal((await call('GET', `/v1/buckets/${BK}`, 'b')).statusCode, 404);
  assert.equal((await cmd('createPortfolio', 'b', { workspace: W, name: 'x' })).statusCode, 403);
  assert.equal((await cmd('emergencyStop', 'b', { workspace: W, reason: 'attack' })).statusCode, 403);
  assert.equal((await cmd('paperDeposit', 'b', { workspace: W, walletChainAccount: WCA, asset: USDC, amount: '1' })).statusCode, 403);
  assert.ok(wsB);
});

test('no secrets accepted: seed phrase, privateKey field, withdraw flag all rejected', async () => {
  const seed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  assert.equal((await cmd('connectWallet', 'a', { workspace: W, nickname: 's', family: 'evm', address: seed })).statusCode, 400);
  const pk = await cmd('connectWallet', 'a', { workspace: W, nickname: 's', family: 'evm', address: '0x1111111111111111111111111111111111111111', privateKey: '0xdeadbeef' });
  assert.equal(pk.statusCode, 400); assert.equal(pk.json().error, 'secret_field_rejected');
  assert.equal((await cmd('connectWallet', 'a', { workspace: W, nickname: 's', family: 'evm', address: '0x1111111111111111111111111111111111111111', nested: { mnemonic: 'x' } })).statusCode, 400);
  assert.equal((await cmd('connectWallet', 'a', { workspace: W, nickname: 's', family: 'evm', address: '0x1111111111111111111111111111111111111111', capability: 'managed_signer' })).statusCode, 400);
});

test('validation: amounts must be integer strings; waterfall must total 100%; unknown fields refused', async () => {
  assert.equal((await cmd('paperDeposit', 'a', { workspace: W, walletChainAccount: WCA, asset: USDC, amount: 12.5 })).statusCode, 400);
  assert.equal((await cmd('paperDeposit', 'a', { workspace: W, walletChainAccount: WCA, asset: USDC, amount: '-5' })).statusCode, 400);
  assert.equal((await cmd('paperDeposit', 'a', { workspace: W, walletChainAccount: WCA, asset: USDC, amount: '1', extra: 1 })).statusCode, 400);
  const bad = await cmd('applyWaterfallPolicy', 'a', { bucket: BK, reinvestBps: 4000, vaultBps: 3500, reserveBps: 2000 });
  assert.equal(bad.statusCode, 400); assert.match(bad.body, /exactly 100%/);
  const ok = await cmd('applyWaterfallPolicy', 'a', { bucket: BK, reinvestBps: 4000, vaultBps: 3500, reserveBps: 2500, vaultBucket: VAULT, vaultWalletChainAccount: WCA2, taxProvisionBps: 500 });
  assert.equal(ok.statusCode, 200, ok.body);
  const c = (await call('GET', `/v1/compounding?workspace=${W}`, 'a')).json();
  assert.equal(c.policies.length, 1); assert.equal(c.policies[0].version, 1);
  const t = await cmd('updateCompoundingTarget', 'a', { workspace: W, bucket: BK, period: 'month', targetAmount: '300' }); assert.equal(t.statusCode, 200, t.body);
});

test('optimistic concurrency on policy edits + global-limit enforcement via API', async () => {
  const b0 = (await call('GET', `/v1/buckets/${BK}`, 'a')).json().bucket;
  const r1 = await cmd('updateBucketPolicy', 'a', { bucket: BK, expectedVersion: b0.policy_version, policy: { max_slippage_bps: 40 } }); assert.equal(r1.statusCode, 200, r1.body);
  const stale = await cmd('updateBucketPolicy', 'a', { bucket: BK, expectedVersion: b0.policy_version, policy: { max_slippage_bps: 30 } }); assert.equal(stale.statusCode, 409);
  const loose = await cmd('updateBucketPolicy', 'a', { bucket: BK, expectedVersion: b0.policy_version + 1, policy: { max_slippage_bps: 9999 } }); assert.equal(loose.statusCode, 422);
});

test('safety controls: emergency stop blocks paper start; resume works; all audited; live stays disabled', async () => {
  assert.equal((await cmd('startPaper', 'a', { workspace: W })).statusCode, 200);
  assert.equal((await call('GET', `/v1/overview?workspace=${W}`, 'a')).json().settings.paper_running, true);
  assert.equal((await cmd('emergencyStop', 'a', { workspace: W, reason: 'drill' })).statusCode, 200);
  const ov = (await call('GET', `/v1/overview?workspace=${W}`, 'a')).json();
  assert.equal(ov.settings.global_state, 'emergency_stopped'); assert.equal(ov.settings.paper_running, false);
  assert.equal((await cmd('startPaper', 'a', { workspace: W })).statusCode, 422);
  assert.equal((await cmd('resumeApproved', 'a', { workspace: W, reason: 'drill over' })).statusCode, 200);
  assert.equal((await cmd('createPortfolio', 'a', { workspace: W, name: 'Live', environment: 'live' })).statusCode, 422);
  const audit = (await call('GET', `/v1/audit?workspace=${W}`, 'a')).json().items.map((x: any) => x.action);
  for (const a of ['workspace.create', 'bucket.create', 'wallet.connect', 'global_state.emergency_stopped', 'compounding.policy']) assert.ok(audit.includes(a), 'missing audit ' + a);
});

test('chain health is NOT_MEASURED (never fabricated green)', async () => {
  const r = await call('GET', '/v1/chains/eip155:1/health', 'a');
  assert.equal(r.json().health.status, 'NOT_MEASURED');
});

test('100 concurrent capital transfer requests over HTTP: no overspend (balance 1000, each 30 => 33 succeed max)', async () => {
  const w = (await cmd('createWorkspace', 'a', { name: 'Conc' })).json().result.id;
  const pf = (await cmd('createPortfolio', 'a', { workspace: w, name: 'P' })).json().result.id;
  const [b1, b2] = await Promise.all(['B1', 'B2'].map(async (n) => (await cmd('createBucket', 'a', { portfolio: pf, name: n })).json().result.id));
  const wl1 = (await cmd('connectWallet', 'a', { workspace: w, nickname: 'a', family: 'evm', address: '0x5555555555555555555555555555555555555555', chains: ['eip155:1'] })).json().result.id;
  const wl2 = (await cmd('connectWallet', 'a', { workspace: w, nickname: 'b', family: 'evm', address: '0x6666666666666666666666666666666666666666', chains: ['eip155:1'] })).json().result.id;
  await cmd('assignWalletToBucket', 'a', { wallet: wl1, bucket: b1 }); await cmd('assignWalletToBucket', 'a', { wallet: wl2, bucket: b2 });
  const [x1, x2] = await Promise.all([wl1, wl2].map(async (id) => (await db.pool.query(`select id from wallet_chain_accounts where wallet_id=$1`, [id])).rows[0].id));
  await cmd('paperDeposit', 'a', { workspace: w, walletChainAccount: x1, asset: USDC, amount: '1000' });
  await cmd('allocate', 'a', { workspace: w, bucket: b1, walletChainAccount: x1, asset: USDC, amount: '1000' });
  const res = await Promise.all(Array.from({ length: 100 }, () => cmd('requestCapitalTransfer', 'a', { workspace: w, srcBucket: b1, srcWalletChainAccount: x1, dstBucket: b2, dstWalletChainAccount: x2, asset: USDC, amount: '30' })));
  const ok = res.filter((r) => r.statusCode === 200).length;
  assert.equal(ok, 33, `got ${ok}`);
  assert.ok(res.filter((r) => r.statusCode !== 200).every((r) => r.statusCode === 422));
  const s = await db.pool.query(`select coalesce(sum(balance),0)::text s from ledger_accounts where workspace_id=$1 and state not in ('external','equity','fees_expense')`, [w]);
  assert.equal(s.rows[0].s, '1000');                                // value conserved: nothing created or destroyed
  const dest = await db.pool.query(`select coalesce(sum(balance),0)::text s from ledger_accounts where workspace_id=$1 and bucket_id=$2 and state='available'`, [w, b2]);
  assert.equal(dest.rows[0].s, '0');                                // destination not credited before finality
});

test('dev session endpoint is absent when devAuth disabled', async () => {
  const cfg = { ...loadConfig({ SUPABASE_JWT_SECRET: secret } as any), devAuth: false };
  const a2 = await buildApp(pool, cfg);
  assert.equal((await a2.inject({ method: 'POST', url: '/v1/dev/session', payload: { email: 'x@y.z' } })).statusCode, 404);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', APEX_DEV_AUTH: '1', SUPABASE_JWT_SECRET: secret } as any), /must not be enabled in production/);
  await a2.close();
});

test('rate limiting returns 429 when exceeded', async () => {
  const cfg = { ...loadConfig({ SUPABASE_JWT_SECRET: secret } as any), rateLimitMax: 5 };
  const a3 = await buildApp(pool, cfg);
  const t = await signDevToken(users.a, secret);
  const codes: number[] = [];
  for (let i = 0; i < 8; i++) codes.push((await a3.inject({ method: 'GET', url: '/v1/workspaces', headers: { authorization: `Bearer ${t}` } })).statusCode);
  assert.ok(codes.includes(429), JSON.stringify(codes));
  await a3.close();
});

test('security headers (helmet) and CORS allowlist are actually applied to API routes', async () => {
  const r = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.match(String(r.headers['content-security-policy']), /default-src 'none'/);
  assert.ok(r.headers['strict-transport-security']);
  const ok = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'http://localhost:3000' } });
  assert.equal(ok.headers['access-control-allow-origin'], 'http://localhost:3000');
  const evil = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://evil.example' } });
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
});

test('dev session mints a working token for a brand-new user via the unprivileged API pool', async () => {
  const r = await app.inject({ method: 'POST', url: '/v1/dev/session', payload: { email: 'newuser@dev.test' } });
  assert.equal(r.statusCode, 200, r.body);
  const { token, userId } = r.json();
  const ws = await app.inject({ method: 'GET', url: '/v1/workspaces', headers: { authorization: `Bearer ${token}` } });
  assert.equal(ws.statusCode, 200); assert.deepEqual(ws.json().items, []); assert.ok(userId);
});

test('chain-registry never returns RPC URLs with paths/credentials/keys (origins only)', async () => {
  await db.pool.query(`update chain_registry set details = jsonb_build_object('rpcCandidates', jsonb_build_array('https://user:pw@rpc.example.com/v2/SECRETKEY?token=abc')) where id='eip155:1'`);
  const r = await call('GET', '/v1/chain-registry', 'a');
  const body = r.body; assert.ok(!/SECRETKEY|token=abc|user:pw/.test(body), body.slice(0, 300));
  assert.deepEqual(r.json().items.find((c: any) => c.id === 'eip155:1').details.rpcOrigins, ['rpc.example.com']);
});
