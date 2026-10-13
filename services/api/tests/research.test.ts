// Tests for the research / markets / intelligence gateway.
// PROTOCOL TESTS use a local fake HTTP server standing in for the researcher: they prove our wire handling, NOT researcher behaviour.
// The "REAL researcher" tests below call the actual FastAPI service when it is running (skipped, and reported as skipped, when it is not).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
// @ts-expect-error plain ESM helper shared with the DB test-suite
import { freshDb } from '../../../packages/db/tests/helpers.mjs';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { makePool } from '../src/db.ts';
import { signDevToken } from '../src/auth.ts';
import { backtestSchema, tokenSafetySchema } from '../src/routes/research.ts';
import { resolveResearcherBase } from '../src/routes/researcher-client.ts';

const secret = 'test-secret-test-secret-test-secret-123456';
const REAL_URL = process.env.APEX_REAL_RESEARCHER_URL ?? 'http://127.0.0.1:8100';
let db: any, pool: any; const apps: any[] = [];
const users = { a: randomUUID(), b: randomUUID(), v: randomUUID() };
let tok: Record<string, string> = {};
let W: string;

// ---------------------------------------------------------------- fake researcher (PROTOCOL TEST)
const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
let mode: 'ok' | 'unlabelled' | 'boom' | 'redirect' = 'ok'; let advertiseExtras = false;
const fake = http.createServer((req, res) => {
  let raw = ''; req.on('data', (d) => (raw += d)); req.on('end', () => {
    let body: any = null; try { body = raw ? JSON.parse(raw) : null; } catch { /* ignore */ }
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    const send = (code: number, j: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    const path = req.url!.split('?')[0];
    if (path === '/health') return send(200, { status: 'ok', service: 'researcher', version: 'FAKE-0', mode: 'research_paper_only', database_configured: false, llm: { provider: 'disabled', enabled: false }, strategies: ['trend_momentum', 'risk_off'] });
    if (path === '/openapi.json') return send(200, { components: { schemas: { BacktestReq: { properties: { seed: {}, n_bars: {}, venue: {}, sleeves: {}, ...(advertiseExtras ? { train_fraction: {} } : {}) } } } } });
    if (path === '/backtests') {
      if (mode === 'boom') return send(500, { detail: 'kaboom internal /secret/path' });
      if (mode === 'redirect') { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); return res.end(); }
      if (mode === 'unlabelled') return send(200, { report: { point_metrics: { sharpe: 1 } } });
      return send(200, { data_provenance: 'SYNTHETIC', report: { data_provenance: 'SYNTHETIC', provenance_banner: 'PROTOCOL TEST FAKE - SYNTHETIC', point_metrics: { sharpe: 0.5, total_return: 0.01 }, metric_uncertainty: { status: 'OK' } }, recorded: false, simulation_run_id: null });
    }
    if (path === '/token-safety/evaluate') return send(200, { data_provenance: 'N/A_STRUCTURED_FINDINGS_INPUT', stage1_passed: false, vetoes: [{ code: 'FAKE_VETO', severity: 'veto', detail: 'protocol test' }], warnings: [], score_informational: 1, confidence: 1, vendor_notes: [], admitted_by_strategy: false, admission_reasons: ['stage1 gate rejected'] });
    send(404, { detail: 'nope' });
  });
});
let fakeUrl = '';

async function mkApp(researcherUrl: string) {
  process.env.APEX_RESEARCHER_URL = researcherUrl;
  const url = db.url.replace('postgres@', 'apex_app:apex_app@');
  const p = makePool(url);
  const cfg = { ...loadConfig({ SUPABASE_JWT_SECRET: secret, DATABASE_URL: url } as any), devAuth: true, devAdminDatabaseUrl: db.url, rateLimitMax: 100000 };
  const a = await buildApp(p, cfg); apps.push({ a, p }); return a;
}
let app: Awaited<ReturnType<typeof buildApp>>; let appDown: typeof app; let appReal: typeof app;
const call = (a: typeof app, method: 'GET' | 'POST', url: string, who: 'a' | 'b' | 'v' | null, payload?: unknown, key?: string) =>
  a.inject({ method, url, payload: payload as any, headers: { ...(who ? { authorization: `Bearer ${tok[who]}` } : {}), ...(key ? { 'idempotency-key': key } : {}) } });
const cmd = (a: typeof app, name: string, who: 'a' | 'b' | 'v', body: unknown, key: string = randomUUID()) => call(a, 'POST', `/v1/commands/${name}`, who, body, key);
const sleeves = [{ name: 'trend_momentum', allocation: 0.5 }, { name: 'risk_off', allocation: 0 }];

before(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r)); fakeUrl = `http://127.0.0.1:${(fake.address() as any).port}`;
  db = await freshDb();
  await db.pool.query(`insert into auth.users(id,email) values ($1,'a@t'),($2,'b@t'),($3,'v@t')`, [users.a, users.b, users.v]);
  await db.pool.query(`insert into chain_registry(id,namespace,chain_ref,family,name,native_symbol,native_decimals,finality_model,address_format) values
    ('eip155:1','eip155','1','evm','Ethereum','ETH',18,'probabilistic','0x-hex20'),('solana:mainnet','solana','mainnet','svm','Solana','SOL',9,'confirmed','base58'),('coinbase:spot','coinbase','spot','cex','Coinbase Exchange','USD',2,'n/a','n/a') on conflict (id) do nothing`);
  await db.pool.query(`insert into assets(chain_id,contract,symbol,decimals) values ('eip155:1','native','ETH',18),('eip155:1','0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48','USDC',6),('eip155:1','0xdAC17F958D2ee523a2206206994597C13D831ec7','USDT',6),('coinbase:spot','BTC-USD','BTC',8) on conflict (chain_id,contract) do nothing`);
  tok = { a: await signDevToken(users.a, secret), b: await signDevToken(users.b, secret), v: await signDevToken(users.v, secret) };
  app = await mkApp(fakeUrl); appDown = await mkApp('http://127.0.0.1:1'); appReal = await mkApp(REAL_URL);
  W = (await cmd(app, 'createWorkspace', 'a', { name: 'Alpha' })).json().result.id;
  await db.pool.query(`insert into memberships(workspace_id,user_id,role) values ($1,$2,'viewer')`, [W, users.v]);
});
after(async () => { for (const { a, p } of apps) { await a.close(); await p.end(); } fake.close(); await db.close(); });

// ---------------------------------------------------------------- pure validators
test('unit: backtest schema bounds, allocation cap, strictness (no URL/host fields), researcher URL resolution', () => {
  const base = { workspace: randomUUID(), sleeves };
  assert.ok(backtestSchema.safeParse(base).success);
  assert.ok(!backtestSchema.safeParse({ ...base, nBars: 10 }).success);
  assert.ok(!backtestSchema.safeParse({ ...base, nBars: 999_999 }).success);
  assert.ok(!backtestSchema.safeParse({ ...base, sleeves: [{ name: 'a_b', allocation: 0.7 }, { name: 'c_d', allocation: 0.6 }] }).success);
  assert.ok(!backtestSchema.safeParse({ ...base, sleeves: [] }).success);
  assert.ok(!backtestSchema.safeParse({ ...base, researcherUrl: 'http://evil' }).success);
  assert.ok(!backtestSchema.safeParse({ ...base, sleeves: [{ name: '../x', allocation: 0.1 }] }).success);
  assert.ok(!tokenSafetySchema.safeParse({ positionUsd: 1, expectedGrossEdgeBps: 0, estSlippageBps: 0, findings: { chain_family: 'evm' } }).success, 'age_hours is required');
  assert.equal(resolveResearcherBase(undefined).origin, 'http://127.0.0.1:8100');
  for (const bad of ['file:///etc/passwd', 'ftp://x', 'http://user:pw@h:1', 'http://h:1/path', 'http://h:1/?x=1']) assert.throws(() => resolveResearcherBase(bad), bad);
});

test('auth: every research/market/intelligence route requires a valid token', async () => {
  for (const [m, u] of [['GET', '/v1/research/health'], ['GET', `/v1/research/backtests?workspace=${W}`], ['POST', '/v1/commands/startBacktest'], ['POST', '/v1/research/token-safety/evaluate'],
    ['GET', `/v1/market/list?workspace=${W}`], ['GET', `/v1/intelligence/overview?workspace=${W}`], ['POST', '/v1/commands/watchAsset'], ['POST', '/v1/commands/addNewsItem']] as const)
    assert.equal((await call(app, m, u, null, {})).statusCode, 401, u);
});

// ---------------------------------------------------------------- PROTOCOL TESTS (fake researcher)
test('[protocol/fake] health reports reachable with advertised fields; NOT REACHABLE is reported honestly', async () => {
  const h = (await call(app, 'GET', '/v1/research/health', 'a')).json();
  assert.equal(h.reachable, true); assert.equal(h.version, 'FAKE-0'); assert.deepEqual(h.backtestFields.sort(), ['n_bars', 'seed', 'sleeves', 'venue']);
  const d = (await call(appDown, 'GET', '/v1/research/health', 'a')).json();
  assert.equal(d.reachable, false); assert.match(d.error, /not reachable/); assert.equal(d.version, undefined);
});

let runId: string; const K1 = 'bt-key-000001';
test('[protocol/fake] startBacktest: queued->running->done, metrics+provenance stored, audited; request is SSRF-clean', async () => {
  seen.length = 0;
  const r = await cmd(app, 'startBacktest', 'a', { workspace: W, label: 'first', sleeves, nBars: 500 }, K1); assert.equal(r.statusCode, 200, r.body);
  runId = r.json().result.id; assert.equal(r.json().result.status, 'done'); assert.equal(r.json().result.dataProvenance, 'SYNTHETIC');
  const bt = seen.filter((s) => s.url === '/backtests'); assert.equal(bt.length, 1);
  assert.equal(bt[0].headers.authorization, undefined, 'no bearer token forwarded'); assert.equal(bt[0].headers.cookie, undefined);
  assert.equal(bt[0].body.workspace_id, undefined, 'workspace id is not handed to the researcher'); assert.equal(bt[0].body.n_bars, 500);
  assert.ok(seen.every((s) => ['/health', '/openapi.json', '/backtests'].includes(s.url)), 'only fixed paths were requested');
  const d = (await call(app, 'GET', `/v1/research/backtests/${runId}`, 'a')).json();
  assert.equal(d.status, 'done'); assert.equal(d.data_provenance, 'SYNTHETIC'); assert.match(d.metrics.report.provenance_banner, /PROTOCOL TEST FAKE/); assert.ok(d.finished_at);
  const list = (await call(app, 'GET', `/v1/research/backtests?workspace=${W}`, 'a')).json().items;
  assert.equal(list[0].id, runId); assert.equal(list[0].point_metrics.sharpe, 0.5);
  const au = await db.pool.query(`select action from audit_events where entity='simulation_runs' and entity_id=$1 order by id`, [runId]);
  assert.deepEqual(au.rows.map((x: any) => x.action), ['research.backtest.queued', 'research.backtest.running', 'research.backtest.done']);
});

test('[protocol/fake] idempotency: same key replays without a second upstream call; same key + different params is rejected; key is mandatory', async () => {
  seen.length = 0;
  const r = await cmd(app, 'startBacktest', 'a', { workspace: W, label: 'first', sleeves, nBars: 500 }, K1);
  assert.equal(r.statusCode, 200); assert.equal(r.json().result.id, runId); assert.equal(r.json().result.replayed, true);
  assert.equal(seen.filter((s) => s.url === '/backtests').length, 0);
  const diff = await cmd(app, 'startBacktest', 'a', { workspace: W, sleeves, nBars: 600 }, K1); assert.equal(diff.statusCode, 422); assert.match(diff.json().message, /different parameters/);
  assert.equal((await call(app, 'POST', '/v1/commands/startBacktest', 'a', { workspace: W, sleeves })).statusCode, 400);
  const n = await db.pool.query(`select count(*)::int n from simulation_runs where workspace_id=$1`, [W]); assert.equal(n.rows[0].n, 1);
});

test('validation + secret rejection + unsupported extras + unknown strategy', async () => {
  const v = (b: unknown) => cmd(app, 'startBacktest', 'a', b);
  assert.equal((await v({ workspace: W, sleeves, nBars: 5 })).statusCode, 400);
  assert.equal((await v({ workspace: W, sleeves: [{ name: 'trend_momentum', allocation: 0.9 }, { name: 'risk_off', allocation: 0.9 }] })).statusCode, 400);
  assert.equal((await v({ workspace: W, sleeves, researcherUrl: 'http://169.254.169.254/' })).statusCode, 400, 'URL fields are not accepted');
  assert.equal((await v({ workspace: W, sleeves, privateKey: 'x' })).statusCode, 400);
  const ex = await v({ workspace: W, sleeves, extras: { trainFraction: 0.7 } }); assert.equal(ex.statusCode, 422); assert.equal(ex.json().error, 'unsupported_by_researcher');
  const us = await v({ workspace: W, sleeves: [{ name: 'does_not_exist', allocation: 0.1 }] }); assert.equal(us.statusCode, 422); assert.equal(us.json().error, 'unknown_strategy');
  advertiseExtras = true; await call(app, 'GET', '/v1/research/health', 'a');                      // refresh capability cache below
  await new Promise((r) => setTimeout(r, 5100));                                                       // capability cache is 5s
  seen.length = 0; const ok = await v({ workspace: W, sleeves, extras: { trainFraction: 0.7 } }); assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(seen.find((s) => s.url === '/backtests')!.body.train_fraction, 0.7); advertiseExtras = false;
});

test('failure modes: unlabelled output is rejected, upstream 500 hides internals, redirects are refused, unreachable researcher -> failed run (never fabricated)', async () => {
  mode = 'unlabelled'; let r = await cmd(app, 'startBacktest', 'a', { workspace: W, sleeves, seed: 1 }); assert.equal(r.statusCode, 502); assert.match(r.json().message, /unlabelled/);
  let row = (await call(app, 'GET', `/v1/research/backtests/${r.json().runId}`, 'a')).json(); assert.equal(row.status, 'failed'); assert.equal(row.metrics, null);
  mode = 'boom'; r = await cmd(app, 'startBacktest', 'a', { workspace: W, sleeves, seed: 2 }); assert.equal(r.statusCode, 502); assert.ok(!/secret|kaboom/.test(r.body), 'upstream detail is not leaked');
  mode = 'redirect'; r = await cmd(app, 'startBacktest', 'a', { workspace: W, sleeves, seed: 3 }); assert.equal(r.statusCode, 502);
  assert.ok(seen.every((s) => !s.url.includes('127.0.0.1:1')));
  mode = 'ok';
  r = await cmd(appDown, 'startBacktest', 'a', { workspace: W, sleeves, seed: 4 }); assert.equal(r.statusCode, 502); assert.equal(r.json().error, 'researcher_unreachable');
  row = (await call(appDown, 'GET', `/v1/research/backtests/${r.json().runId}`, 'a')).json(); assert.equal(row.status, 'failed'); assert.match(row.error, /not reachable/);
  const tr = await call(appDown, 'POST', '/v1/research/token-safety/evaluate', 'a', { positionUsd: 1, expectedGrossEdgeBps: 0, estSlippageBps: 0, findings: { chain_family: 'evm', age_hours: 1 } });
  assert.equal(tr.statusCode, 503);
});

test('DB: run state machine is enforced and terminal rows are immutable', async () => {
  await assert.rejects(db.asUser(users.a, (c: any) => c.query(`select api_advance_backtest($1,'running')`, [runId])), /illegal run transition/);
  await assert.rejects(db.asUser(users.a, (c: any) => c.query(`update simulation_runs set status='queued' where id=$1`, [runId])), /permission denied/);
  await assert.rejects(db.asUser(users.a, (c: any) => c.query(`select api_advance_backtest($1,'done','SYNTHETIC',null)`, [runId])), /illegal run transition/);
});

test('RLS + roles: another tenant cannot read, list or start; viewer cannot start', async () => {
  assert.equal((await call(app, 'GET', `/v1/research/backtests/${runId}`, 'b')).statusCode, 404);
  assert.deepEqual((await call(app, 'GET', `/v1/research/backtests?workspace=${W}`, 'b')).json().items, []);
  assert.equal((await cmd(app, 'startBacktest', 'b', { workspace: W, sleeves })).statusCode, 403);
  assert.equal((await cmd(app, 'startBacktest', 'v', { workspace: W, sleeves })).statusCode, 403);
  assert.equal((await call(app, 'GET', `/v1/research/backtests/${runId}`, 'v')).statusCode, 200, 'viewers may read');
});

test('[protocol/fake] token-safety proxy passes structured findings and flags provenance as manual input', async () => {
  seen.length = 0;
  const r = await call(app, 'POST', '/v1/research/token-safety/evaluate', 'a', { strategy: 'meme_scalp', positionUsd: 500, expectedGrossEdgeBps: 300, estSlippageBps: 40, findings: { chain_family: 'evm', age_hours: 2, sell_tax_bps: null, vendors: [{ vendor: 'goplus', risk_score: 5 }] } });
  assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().stage1_passed, false); assert.match(r.json().inputNote, /entered by hand/);
  const s = seen.find((x) => x.url.startsWith('/token-safety'))!; assert.match(s.url, /strategy=meme_scalp/); assert.equal(s.body.sell_tax_bps, null); assert.equal(s.headers.authorization, undefined);
  assert.equal((await call(app, 'POST', '/v1/research/token-safety/evaluate', 'a', { positionUsd: 1, expectedGrossEdgeBps: 0, estSlippageBps: 0, findings: { chain_family: 'evm', age_hours: 1, evil: 1 } })).statusCode, 400);
});

// ---------------------------------------------------------------- markets (real DB)
test('watchlist + saved views persist, are audited, idempotent, role- and tenant-gated', async () => {
  const w = await cmd(app, 'watchAsset', 'a', { workspace: W, chain: 'eip155:1', contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC' }); assert.equal(w.statusCode, 200, w.body);
  await cmd(app, 'watchAsset', 'a', { workspace: W, chain: 'eip155:1', contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' });          // re-watch is a no-op upsert
  let wl = (await call(app, 'GET', `/v1/market/list?workspace=${W}&tab=watchlist`, 'a')).json().items; assert.equal(wl.length, 1); assert.equal(wl[0].watched, true);
  assert.equal((await call(app, 'GET', `/v1/market/list?workspace=${W}&tab=watchlist`, 'b')).json().items.length, 0, 'tenant isolation');
  assert.equal((await cmd(app, 'watchAsset', 'v', { workspace: W, chain: 'eip155:1', contract: 'native' })).statusCode, 403);
  assert.equal((await cmd(app, 'watchAsset', 'a', { workspace: W, chain: 'nope:1', contract: 'native' })).statusCode, 422);
  assert.equal((await cmd(app, 'watchAsset', 'a', { workspace: W, chain: 'eip155:1', contract: 'bad contract!' })).statusCode, 400);
  const sv = await cmd(app, 'saveMarketView', 'a', { workspace: W, name: 'ETH stables', filters: { tab: 'dex', q: 'usd', chain: 'eip155:1' } }); assert.equal(sv.statusCode, 200, sv.body);
  const views = (await call(app, 'GET', `/v1/market/views?workspace=${W}`, 'a')).json().items; assert.equal(views.length, 1); assert.deepEqual(views[0].filters, { tab: 'dex', q: 'usd', chain: 'eip155:1' });
  assert.equal((await call(app, 'GET', `/v1/market/views?workspace=${W}`, 'b')).json().items.length, 0);
  assert.equal((await cmd(app, 'saveMarketView', 'a', { workspace: W, name: 'x', filters: { evil: 1 } })).statusCode, 400);
  assert.equal((await cmd(app, 'deleteMarketView', 'b', { view: views[0].id })).statusCode, 403);
  assert.equal((await cmd(app, 'deleteMarketView', 'a', { view: views[0].id })).statusCode, 200);
  assert.equal((await call(app, 'GET', `/v1/market/views?workspace=${W}`, 'a')).json().items.length, 0);
  assert.equal((await cmd(app, 'unwatchAsset', 'a', { workspace: W, chain: 'eip155:1', contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' })).statusCode, 200);
  wl = (await call(app, 'GET', `/v1/market/list?workspace=${W}&tab=watchlist`, 'a')).json().items; assert.equal(wl.length, 0);
  const au = await db.pool.query(`select action from audit_events where workspace_id=$1 and action like 'watchlist.%' or action like 'market_view.%' order by id`, [W]);
  assert.ok(au.rows.length >= 5);
});

test('markets search: symbol, chain, contract fragment and BASE/QUOTE pair; tabs derive from registry + lifecycle facts; no prices', async () => {
  const L = async (qs: string) => (await call(app, 'GET', `/v1/market/list?workspace=${W}&${qs}`, 'a')).json();
  const all = await L('tab=all'); assert.equal(all.total, 4); assert.equal(all.feed.connected, false); assert.ok(all.items.every((i: any) => !('price' in i)));
  assert.deepEqual((await L('q=usdc')).items.map((i: any) => i.symbol), ['USDC']);
  assert.equal((await L('q=solana')).items.length, 0);
  assert.equal((await L('q=eip155:1')).items.length, 3);
  assert.deepEqual((await L('q=c6218b36')).items.map((i: any) => i.symbol), ['USDC']);
  assert.deepEqual((await L('q=USDC/ETH')).items.map((i: any) => i.symbol), ['USDC']);          // quote = chain native symbol
  assert.deepEqual((await L('q=USDT/USDC')).items.map((i: any) => i.symbol), ['USDT']);          // quote asset present on same chain
  assert.equal((await L('q=USDT/XYZ')).items.length, 0);
  assert.equal((await L(`q=${encodeURIComponent('%')}`)).items.length, 0, 'LIKE wildcards are escaped');
  assert.deepEqual((await L('tab=cex')).items.map((i: any) => i.symbol), ['BTC']);
  assert.equal((await L('tab=dex')).items.length, 3);
  assert.equal((await call(app, 'GET', `/v1/market/list?workspace=${W}&tab=bogus`, 'a')).statusCode, 400);
});

test('token identity: canonical chain+contract from assets; unknown identity 404', async () => {
  const g = (qs: string) => call(app, 'GET', `/v1/market/asset?workspace=${W}&${qs}`, 'a');
  const r = await g('chain=eip155:1&contract=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'); assert.equal(r.statusCode, 200);
  assert.equal(r.json().asset.symbol, 'USDC'); assert.equal(r.json().identity.inRegistry, true); assert.equal(r.json().chain.name, 'Ethereum');
  assert.equal((await g('chain=eip155:1&contract=0xdead')).statusCode, 404);
  assert.equal((await g('chain=bad&contract=x')).statusCode, 400);
});

test('lifecycle: observations create/advance, late ones keep history without rewinding, future/invalid rejected, viewer blocked, history append-only, audited', async () => {
  const base = { workspace: W, chain: 'solana:mainnet', contract: 'MemeMint1111111111111111111111111111111111', symbol: 'MEME', source: 'manual: launchpad UI' };
  const t0 = new Date(Date.now() - 3600_000).toISOString(), t1 = new Date(Date.now() - 1800_000).toISOString(), tOld = new Date(Date.now() - 7200_000).toISOString();
  let r = await cmd(app, 'logTokenObservation', 'a', { ...base, stage: 'launchpad', observedAt: t0 }); assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().result.appliedAsCurrent, true);
  r = await cmd(app, 'logTokenObservation', 'a', { ...base, stage: 'bonding_curve', observedAt: t1 }); assert.equal(r.json().result.appliedAsCurrent, true);
  r = await cmd(app, 'logTokenObservation', 'a', { ...base, stage: 'observed', observedAt: tOld }); assert.equal(r.json().result.appliedAsCurrent, false);
  const lc = (await call(app, 'GET', `/v1/market/lifecycles?workspace=${W}`, 'a')).json();
  await db.pool.query(`insert into strategy_definitions(key,version,name,allowed_families) values ('meme_scalp',1,'Meme scalp','{evm,svm}')`);
  const lc2 = (await call(app, 'GET', `/v1/market/lifecycles?workspace=${W}`, 'a')).json(); assert.deepEqual(lc2.strategies.find((x: any) => x.key === 'meme_scalp').allowed_families, ['evm', 'svm']);
  assert.equal(lc.items.length, 1); assert.equal(lc.items[0].stage, 'bonding_curve'); assert.ok(lc.stages.includes('graduating'));
  const asset = (await call(app, 'GET', `/v1/market/asset?workspace=${W}&chain=solana:mainnet&contract=${base.contract}`, 'a')).json();
  assert.equal(asset.events.length, 3); assert.equal(asset.identity.inRegistry, false); assert.equal(asset.lifecycle.stage, 'bonding_curve');
  assert.equal((await cmd(app, 'logTokenObservation', 'a', { ...base, stage: 'mature_dex', observedAt: new Date(Date.now() + 3600_000).toISOString() })).statusCode, 422);
  assert.equal((await cmd(app, 'logTokenObservation', 'a', { ...base, stage: 'moon', observedAt: t1 })).statusCode, 400);
  assert.equal((await cmd(app, 'logTokenObservation', 'v', { ...base, stage: 'graduating', observedAt: t1 })).statusCode, 403);
  assert.equal((await call(app, 'GET', `/v1/market/lifecycles?workspace=${W}`, 'b')).json().items.length, 0);
  await assert.rejects(db.pool.query(`delete from token_lifecycle_events where lifecycle_id=$1`, [lc.items[0].id]), /append-only/);
  await assert.rejects(db.pool.query(`update token_lifecycle_events set stage='dormant' where lifecycle_id=$1`, [lc.items[0].id]), /append-only/);
  const tabs = async (t: string) => (await call(app, 'GET', `/v1/market/list?workspace=${W}&tab=${t}`, 'a')).json().items.map((i: any) => i.symbol);
  assert.deepEqual(await tabs('launches'), ['MEME']); assert.deepEqual(await tabs('graduated'), []);
});

test('news: unverified by default; verification needs the full checklist + note + URL; unverified items cannot be catalysts (API and database); verified can; cannot unverify linked', async () => {
  const lcId = (await call(app, 'GET', `/v1/market/lifecycles?workspace=${W}`, 'a')).json().items[0].id;
  const pub = new Date(Date.now() - 600_000).toISOString();
  const n = await cmd(app, 'addNewsItem', 'a', { workspace: W, headline: 'MEME announced on launchpad', kind: 'social_post', sourceName: 'x.com/someone', sourceUrl: 'https://x.com/someone/status/1', publishedAt: pub }); assert.equal(n.statusCode, 200, n.body);
  const id = n.json().result.id;
  let items = (await call(app, 'GET', `/v1/intelligence/news?workspace=${W}`, 'a')).json().items; assert.equal(items[0].verified, false);
  const link = await cmd(app, 'linkCatalyst', 'a', { item: id, lifecycle: lcId }); assert.equal(link.statusCode, 422); assert.match(link.json().message, /unverified/);
  await assert.rejects(db.pool.query(`insert into news_catalyst_links(workspace_id,news_id,lifecycle_id,linked_by) values ($1,$2,$3,$4)`, [W, id, lcId, users.a]), /unverified news items cannot be linked/);
  await assert.rejects(db.pool.query(`update news_items set verified=true where id=$1`, [id]), /verified_has_evidence/);
  const full = { source_identified: true, timestamp_confirmed: true, primary_source_corroborated: true, not_promotional_or_paid: true };
  const partial = await cmd(app, 'verifyNewsItem', 'a', { item: id, checklist: { ...full, primary_source_corroborated: false }, note: 'only a tweet' }); assert.equal(partial.statusCode, 422); assert.match(partial.json().message, /primary_source_corroborated/);
  assert.equal((await cmd(app, 'verifyNewsItem', 'v', { item: id, checklist: full, note: 'viewer attempt' })).statusCode, 403);
  assert.equal((await cmd(app, 'verifyNewsItem', 'a', { item: id, checklist: full, note: 'x' })).statusCode, 400);
  assert.equal((await cmd(app, 'verifyNewsItem', 'a', { item: id, checklist: full, note: 'Corroborated by launchpad page and on-chain create tx' })).statusCode, 200);
  assert.equal((await cmd(app, 'linkCatalyst', 'a', { item: id, lifecycle: lcId })).statusCode, 200);
  items = (await call(app, 'GET', `/v1/intelligence/news?workspace=${W}`, 'a')).json().items; assert.equal(items[0].verified, true); assert.equal(items[0].catalysts.length, 1);
  await assert.rejects(db.pool.query(`update news_items set verified=false, verified_by=null, verified_at=null, verification_checklist=null, verification_note=null where id=$1`, [id]), /cannot unverify/);
  assert.equal((await cmd(app, 'addNewsItem', 'a', { workspace: W, headline: 'future', sourceName: 'xx', publishedAt: new Date(Date.now() + 86400_000).toISOString() })).statusCode, 422);
  assert.equal((await cmd(app, 'addNewsItem', 'a', { workspace: W, headline: 'bad url', sourceName: 'xx', sourceUrl: 'javascript:alert(1)', publishedAt: pub })).statusCode, 400);
  assert.equal((await call(app, 'GET', `/v1/intelligence/news?workspace=${W}`, 'b')).json().items.length, 0);
});

test('intelligence overview: model Disabled is reported from the researcher (never assumed); not-reachable -> UNKNOWN; budget is not invented', async () => {
  const o = (await call(app, 'GET', `/v1/intelligence/overview?workspace=${W}`, 'a')).json();
  assert.equal(o.model.state, 'DISABLED'); assert.equal(o.model.budget, null); assert.equal(o.news.total, 1); assert.equal(o.news.verified, 1);
  const d = (await call(appDown, 'GET', `/v1/intelligence/overview?workspace=${W}`, 'a')).json(); assert.equal(d.model.state, 'UNKNOWN_RESEARCHER_NOT_REACHABLE'); assert.equal(d.researcher.reachable, false);
  assert.deepEqual((await call(app, 'GET', `/v1/intelligence/overview?workspace=${W}`, 'b')).json().news, { total: 0, verified: 0 });
});

// ---------------------------------------------------------------- REAL researcher (skipped when the service is not running)
const realUp = await fetch(`${REAL_URL}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);
test('[REAL researcher] real health + real backtest end-to-end through the gateway (SYNTHETIC data, real statistics code)', { skip: realUp ? false : `real researcher not running at ${REAL_URL}`, timeout: 120_000 }, async () => {
  const h = (await call(appReal, 'GET', '/v1/research/health', 'a')).json(); assert.equal(h.reachable, true); assert.equal(h.mode, 'research_paper_only'); assert.ok(h.strategies.includes('trend_momentum'));
  const r = await cmd(appReal, 'startBacktest', 'a', { workspace: W, label: 'real researcher', sleeves, nBars: 600, nBoot: 50, nPaths: 50 }); assert.equal(r.statusCode, 200, r.body);
  const d = (await call(appReal, 'GET', `/v1/research/backtests/${r.json().result.id}`, 'a')).json();
  assert.equal(d.status, 'done'); assert.equal(d.data_provenance, 'SYNTHETIC'); assert.match(d.metrics.report.provenance_banner, /SYNTHETIC/); assert.equal(d.metrics.report.metric_uncertainty.status, 'OK');
  assert.ok(d.metrics.report.survivorship && d.metrics.report.no_lookahead && d.metrics.report.monte_carlo_stress.scenarios.baseline);
});
test('[REAL researcher] real token-safety gate rejects a honeypot with reasons and keeps vendor scores additive', { skip: realUp ? false : `real researcher not running at ${REAL_URL}` }, async () => {
  const good = { chain_family: 'evm', sell_simulation_ok: true, sell_simulation_slippage_bps: 80, buy_tax_bps: 0, sell_tax_bps: 0, owner_can_mint: false, is_upgradeable_proxy: false, ownership_renounced: true, can_pause_transfers: false, has_blacklist: false, can_change_tax: false,
    liquidity_usd: 400_000, exit_depth_usd: 200_000, lp_locked_pct: 100, lp_lock_verified: true, lp_lock_remaining_days: 365, lp_controlled_by_deployer: false, top1_holder_pct: 4, top10_holder_pct: 25, deployer_holder_pct: 1, sybil_cluster_pct: 3, age_hours: 500, deployer_prior_rugs: 0 };
  const body = (f: any) => ({ strategy: 'default', positionUsd: 1000, expectedGrossEdgeBps: 400, estSlippageBps: 30, findings: f });
  const ok = (await call(appReal, 'POST', '/v1/research/token-safety/evaluate', 'a', body({ ...good, vendors: [{ vendor: 'goplus', risk_score: 1 }] }))).json();
  assert.equal(ok.stage1_passed, true, JSON.stringify(ok));
  const bad = (await call(appReal, 'POST', '/v1/research/token-safety/evaluate', 'a', body({ ...good, sell_simulation_ok: false, has_blacklist: true, vendors: [{ vendor: 'goplus', risk_score: 0 }] }))).json();
  assert.equal(bad.stage1_passed, false); assert.ok(bad.vetoes.map((v: any) => v.code).includes('HONEYPOT_SELL_FAILS')); assert.equal(bad.admitted_by_strategy, false);
  const unknown = (await call(appReal, 'POST', '/v1/research/token-safety/evaluate', 'a', body({ ...good, liquidity_usd: null }))).json();
  assert.equal(unknown.stage1_passed, false); assert.ok(unknown.vetoes.some((v: any) => v.code === 'UNKNOWN_CRITICAL_FIELD'), 'unknown fails closed');
});
