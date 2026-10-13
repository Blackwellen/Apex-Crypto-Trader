import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
// @ts-expect-error plain ESM helper shared with the DB test-suite
import { freshDb } from '../../../packages/db/tests/helpers.mjs';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { makePool, withUser } from '../src/db.ts';
import { signDevToken } from '../src/auth.ts';
import { deriveHealth, endpointHealth, rpcCandidates, sanitizeEndpoint } from '../src/probes/health.ts';
import { probeEvm, runProbeCycle, startProbes } from '../src/probes/prober.ts';
import { z } from 'zod';
import { createStrategySchema } from '../src/routes/strategies.ts';

const secret = 'test-secret-test-secret-test-secret-123456';
let db: any, app: Awaited<ReturnType<typeof buildApp>>, pool: any;
const U = { a: randomUUID(), b: randomUUID(), viewer: randomUUID(), owner2: randomUUID() };
let tok: Record<string, string> = {};
let W: string, BK: string, WCA: string, ETH: string, USDC: string, PF: string;
const servers: http.Server[] = [];

/** local fake JSON-RPC server: per-instance chain id, block age and failure mode */
function fakeRpc(opts: { chainId: number; blockAgeSec?: number; mode?: 'ok' | 'http500' | 'hang' | 'garbage' }) {
  return new Promise<{ url: string; hits: string[] }>((resolve) => {
    const hits: string[] = [];
    const s = http.createServer((req, res) => {
      let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
        const j = JSON.parse(b || '{}'); hits.push(j.method);
        if (opts.mode === 'hang') return;                        // never answers: exercises the timeout
        if (opts.mode === 'http500') { res.statusCode = 500; return res.end('boom'); }
        if (opts.mode === 'garbage') return res.end('not json');
        const result = j.method === 'eth_chainId' ? '0x' + opts.chainId.toString(16)
          : j.method === 'eth_getBlockByNumber' ? { number: '0x10', timestamp: '0x' + Math.floor(Date.now() / 1000 - (opts.blockAgeSec ?? 1)).toString(16) } : null;
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result }));
      });
    });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/v2/SECRET-API-KEY?token=abc`, hits }));
  });
}

before(async () => {
  db = await freshDb();
  await db.pool.query(`insert into auth.users(id,email) values ($1,'a@t'),($2,'b@t'),($3,'v@t'),($4,'o2@t')`, [U.a, U.b, U.viewer, U.owner2]);
  const url = db.url.replace('postgres@', 'apex_app:apex_app@');
  pool = makePool(url);
  const cfg = { ...loadConfig({ SUPABASE_JWT_SECRET: secret, DATABASE_URL: url } as any), devAuth: true, devAdminDatabaseUrl: db.url, rateLimitMax: 100000 };
  app = await buildApp(pool, cfg);
  tok = { a: await signDevToken(U.a, secret), b: await signDevToken(U.b, secret), viewer: await signDevToken(U.viewer, secret), owner2: await signDevToken(U.owner2, secret) };
  // fixture chain (test-only ids; the real registry is seeded by the chain-registry agent)
  await db.pool.query(`insert into chain_registry(id,namespace,chain_ref,family,name,native_symbol,native_decimals,finality_model,address_format,details) values
    ('eip155:31337','eip155','31337','evm','Fixture EVM','ETH',18,'probabilistic','0x-hex20','{"rpcCandidates":[]}'),
    ('solana:fixture','solana','fixture','svm','Fixture SVM','SOL',9,'commitment','base58','{}')`);
  await db.pool.query(`insert into chain_capabilities(chain_id,capability,status,evidence_ref) values
    ('eip155:31337','getBalances','READ_ONLY',null),('eip155:31337','swap','PENDING',null),('eip155:31337','submit','UNSUPPORTED',null)`);
  const a = await db.pool.query(`insert into assets(chain_id,contract,symbol,decimals) values ('eip155:31337','native','ETH',18),('eip155:31337','0xusdc','USDC',6),('solana:fixture','native','SOL',9) returning id,symbol`);
  ETH = a.rows.find((x: any) => x.symbol === 'ETH').id; USDC = a.rows.find((x: any) => x.symbol === 'USDC').id;
});
after(async () => { for (const s of servers) s.close(); await app.close(); await pool.end(); await db.close(); });

const call = (method: 'GET' | 'POST', url: string, who: keyof typeof U | null, payload?: unknown, key?: string) =>
  app.inject({ method, url, payload: payload as any, headers: { ...(who ? { authorization: `Bearer ${tok[who]}` } : {}), ...(key ? { 'idempotency-key': key } : {}) } });
const cmd = (name: string, who: keyof typeof U, body: unknown, key: string = randomUUID()) => call('POST', `/v1/commands/${name}`, who, body, key);
const get = async (url: string, who: keyof typeof U = 'a') => { const r = await call('GET', url, who); assert.equal(r.statusCode, 200, r.body); return r.json(); };

// ------------------------------------------------------------------ setup
test('setup: workspace, bucket, wallet, funded paper balance; extra members', async () => {
  W = (await cmd('createWorkspace', 'a', { name: 'Alpha' })).json().result.id;
  PF = (await cmd('createPortfolio', 'a', { workspace: W, name: 'Core' })).json().result.id;
  BK = (await cmd('createBucket', 'a', { portfolio: PF, name: 'Trading' })).json().result.id;
  const w = (await cmd('connectWallet', 'a', { workspace: W, nickname: 'W1', family: 'evm', address: '0x9a4Fc2bC7897dd21305B92C0e5cb86DFFc984362', chains: ['eip155:31337'] })).json().result.id;
  assert.equal((await cmd('assignWalletToBucket', 'a', { wallet: w, bucket: BK })).statusCode, 200);
  WCA = (await db.pool.query(`select id from wallet_chain_accounts where wallet_id=$1`, [w])).rows[0].id;
  assert.equal((await cmd('paperDeposit', 'a', { workspace: W, walletChainAccount: WCA, asset: USDC, amount: '1000000' })).statusCode, 200);
  assert.equal((await cmd('allocate', 'a', { workspace: W, bucket: BK, walletChainAccount: WCA, asset: USDC, amount: '1000000' })).statusCode, 200);
  await db.pool.query(`insert into memberships values ($1,$2,'viewer'),($1,$3,'owner')`, [W, U.viewer, U.owner2]);
});

// ------------------------------------------------------------------ pure health derivation
test('health: no samples => NOT_MEASURED; stale => NOT_MEASURED; never healthy without a verified fresh sample', () => {
  const now = new Date('2026-01-01T00:10:00Z');
  assert.equal(deriveHealth([], { now }).status, 'NOT_MEASURED');
  const stale = { endpoint: 'http://x', observed_at: '2026-01-01T00:00:00Z', ok: true, latency_ms: 10, chain_id_match: true, block_time: '2026-01-01T00:00:00Z' };
  assert.equal(deriveHealth([stale], { now, freshMs: 60_000 }).status, 'NOT_MEASURED');
  const fresh = { ...stale, observed_at: '2026-01-01T00:09:59Z', block_time: '2026-01-01T00:09:58Z' };
  assert.equal(deriveHealth([fresh], { now }).status, 'HEALTHY');
  assert.equal(deriveHealth([{ ...fresh, chain_id_match: null }], { now }).status, 'DEGRADED', 'unverified identity is never healthy');
  assert.equal(deriveHealth([{ ...fresh, chain_id_match: false, ok: false, reported_chain_id: '5', error: 'x' }], { now }).status, 'UNHEALTHY');
  assert.equal(deriveHealth([{ ...fresh, block_time: '2026-01-01T00:00:00Z' }], { now, maxBlockAgeMs: 60_000 }).status, 'DEGRADED', 'old block');
  assert.equal(deriveHealth([fresh, { ...fresh, endpoint: 'http://y', ok: false, error: 'down' }], { now }).status, 'DEGRADED');
  assert.equal(endpointHealth({ ...fresh, chain_id_match: false, ok: false }, 1e9).status, 'UNHEALTHY');
});
test('registry helpers: sanitize drops path/query/userinfo; candidates tolerate shapes', () => {
  assert.equal(sanitizeEndpoint('https://user:pw@rpc.example.org:8545/v2/KEY?x=1'), 'https://rpc.example.org:8545');
  assert.equal(sanitizeEndpoint('file:///etc/passwd'), null);
  assert.deepEqual(rpcCandidates({ rpcCandidates: ['https://a', 'ftp://b', { url: 'http://c' }, 'https://a'] }), ['https://a', 'http://c']);
  assert.deepEqual(rpcCandidates(null), []);
});

// ------------------------------------------------------------------ chains API
test('chains: overview is auth-gated; capabilities are returned exactly as stored; nothing is invented', async () => {
  assert.equal((await call('GET', `/v1/chains/overview?workspace=${W}`, null)).statusCode, 401);
  const ov = await get(`/v1/chains/overview?workspace=${W}`);
  const c = ov.items.find((x: any) => x.id === 'eip155:31337');
  assert.equal(c.capabilities.getBalances.status, 'READ_ONLY');
  assert.equal(c.capabilities.swap.status, 'PENDING');
  assert.equal(c.capabilities.submit.status, 'UNSUPPORTED');
  assert.equal(c.capabilities.simulate, undefined, 'unrecorded capability is absent, not defaulted');
  assert.equal(c.health.status, 'NOT_MEASURED');
  assert.equal(c.enabled, false);
  assert.ok(!JSON.stringify(ov).includes('SECRET-API-KEY'));
});
test('chains: CERTIFIED without evidence is impossible at the DB level', async () => {
  await assert.rejects(db.pool.query(`insert into chain_capabilities(chain_id,capability,status) values ('eip155:31337','simulate','CERTIFIED')`), /certified_needs_evidence/);
});
test('chains: enable/disable are audited, role-checked, idempotent and tenant-isolated', async () => {
  const body = { workspace: W, chain: 'eip155:31337', reason: 'planned maintenance' };
  assert.equal((await cmd('disableChain', 'viewer', body)).statusCode, 403, 'viewer denied by the database');
  assert.equal((await cmd('disableChain', 'b', body)).statusCode, 403, 'other tenant denied');
  assert.equal((await cmd('disableChain', 'a', { workspace: W, chain: 'eip155:31337' })).statusCode, 400, 'reason required');
  assert.equal((await cmd('enableChain', 'a', { workspace: W, chain: 'eip155:99999999' })).statusCode, 422, 'unknown chain');
  assert.equal((await cmd('enableChain', 'a', { workspace: W, chain: 'eip155:31337', extra: 1 })).statusCode, 400, 'strict schema');
  const k = 'enable-key-0001';
  assert.equal((await cmd('enableChain', 'a', { workspace: W, chain: 'eip155:31337' }, k)).statusCode, 200);
  assert.equal((await cmd('enableChain', 'a', { workspace: W, chain: 'eip155:31337' }, k)).statusCode, 200);
  const audits = (await db.pool.query(`select count(*)::int n from audit_events where workspace_id=$1 and action='chain.enable'`, [W])).rows[0].n;
  assert.equal(audits, 1, 'replay produces no second audit row');
  let c = (await get(`/v1/chains/overview?workspace=${W}`)).items.find((x: any) => x.id === 'eip155:31337');
  assert.equal(c.enabled, true);
  assert.equal(c.capabilities.swap.status, 'PENDING', 'enabling a chain does not change any capability');
  assert.equal((await cmd('disableChain', 'a', body)).statusCode, 200);
  c = (await get(`/v1/chains/overview?workspace=${W}`)).items.find((x: any) => x.id === 'eip155:31337');
  assert.equal(c.enabled, false);
  assert.equal((await db.pool.query(`select count(*)::int n from emergency_actions where workspace_id=$1 and action='DISABLE_CHAIN' and scope_id='eip155:31337'`, [W])).rows[0].n, 1);
  // B's workspace policy is independent
  const wsB = (await cmd('createWorkspace', 'b', { name: 'Beta' })).json().result.id;
  assert.equal((await get(`/v1/chains/overview?workspace=${wsB}`, 'b')).items.find((x: any) => x.id === 'eip155:31337').enabled, false);
  assert.equal((await cmd('enableChain', 'a', { workspace: wsB, chain: 'eip155:31337' })).statusCode, 403);
});
test('chains: detail returns sanitized data only and honest empties', async () => {
  const d = await get(`/v1/chains/eip155:31337/detail?workspace=${W}`);
  assert.equal(d.health.status, 'NOT_MEASURED');
  assert.equal(d.wallets.length, 1);
  assert.equal(d.markets.length, 2);
  assert.ok(Array.isArray(d.incidents) && d.incidents.length >= 1, 'policy changes appear as incidents/audit');
  assert.equal(d.chain.details, undefined, 'raw registry details (may hold RPC URLs with keys) are not returned');
  assert.equal((await call('GET', `/v1/chains/nope:1/detail?workspace=${W}`, 'a')).statusCode, 404);
  assert.equal((await call('GET', `/v1/chains/eip155:31337/health`, 'a')).json().health.status, 'NOT_MEASURED');
});

// ------------------------------------------------------------------ prober against a local fake RPC server
test('prober: healthy endpoint is recorded; stored endpoint is a sanitized origin; health becomes HEALTHY only from a verified sample', async () => {
  const ok = await fakeRpc({ chainId: 31337 });
  await db.pool.query(`update chain_registry set enabled=true, details=jsonb_build_object('rpcCandidates', jsonb_build_array($1::text)) where id='eip155:31337'`, [ok.url]);
  const r = await runProbeCycle(db.pool, { timeoutMs: 2000 });
  assert.equal(r.probed, 1); assert.equal(r.failed, 0);
  assert.ok(r.skipped.some((s) => s.chain === 'solana:fixture') === false, 'unmonitored chains are not probed');
  const row = (await db.pool.query(`select * from rpc_health_samples where chain_id='eip155:31337'`)).rows[0];
  assert.match(row.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/); assert.ok(!row.endpoint.includes('SECRET'));
  assert.equal(row.ok, true); assert.equal(row.chain_id_match, true); assert.equal(row.reported_chain_id, '31337');
  const h = (await call('GET', `/v1/chains/eip155:31337/health`, 'a')).json().health;
  assert.equal(h.status, 'HEALTHY'); assert.ok(h.rpcLatencyMs !== null); assert.ok(h.blockAgeMs !== null);
  assert.deepEqual(ok.hits.slice(0, 2), ['eth_chainId', 'eth_getBlockByNumber'], 'only read-only methods are called');
});
test('prober: chain id mismatch => UNHEALTHY and recorded as a mismatch', async () => {
  const bad = await fakeRpc({ chainId: 1 });
  await db.pool.query(`delete from rpc_health_samples`); await db.pool.query(`update chain_registry set details=jsonb_build_object('rpcCandidates', jsonb_build_array($1::text)) where id='eip155:31337'`, [bad.url]);
  const r = await runProbeCycle(db.pool, { timeoutMs: 2000 }); assert.equal(r.failed, 1);
  const s = (await db.pool.query(`select ok, chain_id_match, reported_chain_id, error from rpc_health_samples`)).rows[0];
  assert.equal(s.ok, false); assert.equal(s.chain_id_match, false); assert.equal(s.reported_chain_id, '1'); assert.match(s.error, /mismatch/);
  const h = (await call('GET', `/v1/chains/eip155:31337/health`, 'a')).json().health;
  assert.equal(h.status, 'UNHEALTHY'); assert.match(h.reason, /mismatch/i);
});
test('prober: unreachable / 500 / garbage / hang are failures (never green); old block is DEGRADED; mixed endpoints DEGRADED', async () => {
  const dead = 'http://127.0.0.1:9'; const e500 = await fakeRpc({ chainId: 31337, mode: 'http500' }); const junk = await fakeRpc({ chainId: 31337, mode: 'garbage' });
  const hang = await fakeRpc({ chainId: 31337, mode: 'hang' });
  for (const u of [dead, e500.url, junk.url, hang.url]) {
    const r = await probeEvm(u, '31337', { timeoutMs: 400 });
    assert.equal(r.ok, false, u); assert.ok(r.error);
  }
  assert.match((await probeEvm(hang.url, '31337', { timeoutMs: 300 })).error!, /timeout/);
  const old = await fakeRpc({ chainId: 31337, blockAgeSec: 3600 }); const good = await fakeRpc({ chainId: 31337 });
  await db.pool.query(`delete from rpc_health_samples`); await db.pool.query(`update chain_registry set details=jsonb_build_object('rpcCandidates', jsonb_build_array($1::text)) where id='eip155:31337'`, [old.url]);
  await runProbeCycle(db.pool, { timeoutMs: 2000 });
  assert.equal((await call('GET', `/v1/chains/eip155:31337/health`, 'a')).json().health.status, 'DEGRADED');
  await db.pool.query(`delete from rpc_health_samples`); await db.pool.query(`update chain_registry set details=jsonb_build_object('rpcCandidates', jsonb_build_array($1::text,$2::text)) where id='eip155:31337'`, [good.url, e500.url]);
  await runProbeCycle(db.pool, { timeoutMs: 2000 });
  const h = (await call('GET', `/v1/chains/eip155:31337/health`, 'a')).json().health;
  assert.equal(h.status, 'DEGRADED'); assert.equal(h.endpoints.length, 2);
});
test('prober: off by default; unreachable network leaves NOT_MEASURED when nothing was ever recorded', async () => {
  assert.equal(startProbes({}, makePool), null);
  assert.equal(startProbes({ APEX_PROBES: '1' }, makePool, () => {}), null, 'flag without a service DB url refuses to start');
  await db.pool.query(`delete from rpc_health_samples`);
  assert.equal((await call('GET', `/v1/chains/eip155:31337/health`, 'a')).json().health.status, 'NOT_MEASURED');
  await db.pool.query(`update chain_registry set enabled=false where id='eip155:31337'`);
  const r = await runProbeCycle(db.pool); assert.equal(r.probed, 0, 'a chain that is not enabled anywhere is not probed');
});
test('prober: clients cannot write samples (RLS / grants)', async () => {
  await assert.rejects(withUser(pool, U.a, (c) => c.query(`select record_rpc_health_sample('eip155:31337','http://x',true,1,'1',true,1,now(),null)`)), /permission denied/);
  await assert.rejects(withUser(pool, U.a, (c) => c.query(`insert into rpc_health_samples(chain_id,endpoint,ok) values ('eip155:31337','http://x',true)`)), /permission denied/);
});

// ------------------------------------------------------------------ strategies
test('strategies: the 20 spec strategies are seeded as research with EMPTY evidence; spot-only is a DB constraint', async () => {
  const cat = await get(`/v1/strategies/catalog?workspace=${W}`);
  const plat = cat.items.filter((s: any) => s.workspace_id === null);
  assert.equal(plat.length, 20);
  for (const s of plat) { assert.equal(s.stage, 'research'); assert.deepEqual(s.evidence, {}); assert.equal(s.has_evidence, false); assert.equal(s.spot_only, true); assert.deepEqual(s.instances, []); }
  await assert.rejects(db.pool.query(`insert into strategy_definitions(key,version,name,spot_only) values ('perp_x',1,'perp',false)`), /spot_only/);
  assert.equal((await call('GET', `/v1/strategies/catalog?workspace=${W}`, null)).statusCode, 401);
});
test('strategies: research strategy cannot be enabled; promotion needs a second owner; stage steps one at a time; live_candidate needs evidence', async () => {
  const key = 'cex_trend_momentum';
  assert.equal((await cmd('setStrategyEnabled', 'a', { bucket: BK, strategy: key, enabled: true })).statusCode, 422, 'research stage');
  assert.equal((await cmd('requestStrategyStage', 'a', { workspace: W, strategy: key, version: 1, to: 'live_candidate' })).statusCode, 422, 'cannot skip paper');
  assert.equal((await cmd('requestStrategyStage', 'viewer', { workspace: W, strategy: key, version: 1, to: 'paper' })).statusCode, 403);
  const req = await cmd('requestStrategyStage', 'a', { workspace: W, strategy: key, version: 1, to: 'paper' }); assert.equal(req.statusCode, 200, req.body);
  const aid = req.json().result.approval;
  assert.equal((await cmd('requestStrategyStage', 'a', { workspace: W, strategy: key, version: 1, to: 'paper' })).statusCode, 422, 'duplicate pending request');
  assert.equal((await cmd('applyStrategyStage', 'a', { approval: aid })).statusCode, 422, 'not approved yet');
  assert.equal((await cmd('decideApproval', 'a', { approval: aid, approve: true })).statusCode, 403, 'requester cannot approve their own request');
  assert.equal((await cmd('decideApproval', 'owner2', { approval: aid, approve: true })).statusCode, 200);
  assert.equal((await cmd('applyStrategyStage', 'a', { approval: aid })).json().result.stage, 'paper');
  const cat = await get(`/v1/strategies/catalog?workspace=${W}`);
  assert.equal(cat.items.find((s: any) => s.key === key).stage, 'paper');
  assert.equal((await get(`/v1/strategies/catalog?workspace=${(await cmd('createWorkspace', 'b', { name: 'B2' })).json().result.id}`, 'b')).items.find((s: any) => s.key === key).stage, 'research', 'stage is per workspace');
  assert.equal((await cmd('requestStrategyStage', 'a', { workspace: W, strategy: key, version: 1, to: 'live_candidate' })).statusCode, 422, 'no evidence recorded => cannot become live_candidate');
});
test('strategies: enabling needs a budget; per-bucket switch persists; disable resets stage and instances (audited)', async () => {
  const key = 'cex_trend_momentum';
  const noBudget = await cmd('setStrategyEnabled', 'a', { bucket: BK, strategy: key, enabled: true }); assert.equal(noBudget.statusCode, 422); assert.match(noBudget.json().message, /budget/);
  assert.equal((await cmd('setStrategyBudget', 'a', { bucket: BK, strategy: key, asset: USDC, limit: '500000' })).statusCode, 200);
  assert.equal((await cmd('setStrategyEnabled', 'viewer', { bucket: BK, strategy: key, enabled: true })).statusCode, 403);
  assert.equal((await cmd('setStrategyEnabled', 'a', { bucket: BK, strategy: key, enabled: true })).statusCode, 200);
  let d = await get(`/v1/strategies/${key}/detail?workspace=${W}`);
  assert.equal(d.instances.length, 1); assert.equal(d.instances[0].enabled, true); assert.equal(d.budgets[0].limit_amount, '500000'); assert.equal(d.stage, 'paper');
  assert.equal((await cmd('configureStrategyInstance', 'a', { bucket: BK, strategy: key, params: { order_type: 'limit', stop_loss_bps: 150, tuned: { lookback_bars: 80 } } })).statusCode, 200);
  assert.equal((await cmd('configureStrategyInstance', 'a', { bucket: BK, strategy: key, params: { tuned: { lookback_bars: 5000 } } })).statusCode, 422, 'outside declared bounds');
  assert.equal((await cmd('configureStrategyInstance', 'a', { bucket: BK, strategy: key, params: { tuned: { nope: 1 } } })).statusCode, 422, 'unknown parameter');
  assert.equal((await cmd('configureStrategyInstance', 'a', { bucket: BK, strategy: key, params: { max_order_bps_of_budget: 9999 } })).statusCode, 422, 'cannot exceed the definition cap');
  d = await get(`/v1/strategies/${key}/detail?workspace=${W}`); assert.equal(d.instances[0].params.stop_loss_bps, 150);
  assert.equal((await cmd('disableStrategy', 'a', { workspace: W, strategy: key })).statusCode, 400, 'reason required');
  assert.equal((await cmd('disableStrategy', 'a', { workspace: W, strategy: key, reason: 'operator review' })).json().result.instancesDisabled, 1);
  d = await get(`/v1/strategies/${key}/detail?workspace=${W}`);
  assert.equal(d.instances[0].enabled, false); assert.equal(d.stage, 'research');
  assert.ok(d.audit.some((e: any) => e.action === 'strategy.disable'));
  assert.ok(d.audit.some((e: any) => e.action === 'strategy.stage_applied'));
  assert.deepEqual([d.runs, d.jobs, d.signals, d.execution], [[], [], [], []], 'no metrics are invented');
});
test('strategies: create/clone wizard persists research-only, evidence empty, validated bounds, tenant-private', async () => {
  const base = { workspace: W, slug: 'my_trend', name: 'My trend', category: 'cex_directional', summary: 'test', families: ['cex'], dataSources: ['ohlcv'], regimes: ['trending'],
    paramBounds: { lookback_bars: { min: 10, max: 100, default: 20 } }, riskBudget: { maxOrderBpsOfBudget: 1000, maxDailyLossBps: 100 }, validationPlan: { paperDays: 14, minTrades: 30, notes: '' }, clonedFrom: 'cex_trend_momentum' };
  assert.equal((await cmd('createStrategy', 'viewer', base)).statusCode, 403);
  assert.equal((await cmd('createStrategy', 'a', { ...base, paramBounds: { lookback_bars: { min: 10, max: 100, default: 500 } } })).statusCode, 400, 'default outside bounds');
  assert.equal((await cmd('createStrategy', 'a', { ...base, families: [] })).statusCode, 400);
  assert.equal((await cmd('createStrategy', 'a', { ...base, paramBounds: { api_secret: { min: 1, max: 2, default: 1 } } })).statusCode, 400, 'secret-looking field rejected');
  assert.equal((await cmd('createStrategy', 'a', { ...base, clonedFrom: 'does_not_exist' })).statusCode, 422);
  assert.equal(createStrategySchema(z.string().uuid()).safeParse({ ...base, riskBudget: { maxOrderBpsOfBudget: 20000 } }).success, false);
  const r = await cmd('createStrategy', 'a', base); assert.equal(r.statusCode, 200, r.body);
  const key = r.json().result.key; assert.match(key, /^ws\.[0-9a-f]{8}\.my_trend$/);
  assert.equal((await cmd('createStrategy', 'a', base)).statusCode, 422, 'duplicate slug');
  const mine = (await get(`/v1/strategies/catalog?workspace=${W}`)).items.find((s: any) => s.key === key);
  assert.equal(mine.stage, 'research'); assert.deepEqual(mine.evidence, {}); assert.equal(mine.cloned_from, 'cex_trend_momentum'); assert.equal(mine.spot_only, true);
  const b = await call('GET', `/v1/strategies/catalog?workspace=${W}`, 'b');
  assert.ok(!b.json().items.some((s: any) => s.key === key), 'other tenants cannot see it (RLS)');
  assert.equal((await call('GET', `/v1/strategies/${key}/detail?workspace=${W}`, 'b')).statusCode, 404);
});

// ------------------------------------------------------------------ trading
const ticket = (o: Record<string, unknown> = {}) => ({ workspace: W, bucket: BK, walletChainAccount: WCA, baseAsset: ETH, quoteAsset: USDC, side: 'buy', quantity: '1000000000000000', notional: '100000', ...o });
let INTENT: string;
test('paper ticket: lands in RISK_EVALUATING and CANNOT bypass risk; validations; role; idempotency', async () => {
  assert.equal((await cmd('createPaperIntent', 'viewer', ticket())).statusCode, 403);
  assert.equal((await cmd('createPaperIntent', 'b', ticket())).statusCode, 403, 'other tenant');
  assert.equal((await cmd('createPaperIntent', 'a', ticket({ notional: '99999999999' }))).statusCode, 422, 'insufficient balance');
  assert.equal((await cmd('createPaperIntent', 'a', ticket({ quantity: '0' }))).statusCode, 400);
  assert.equal((await cmd('createPaperIntent', 'a', ticket({ baseAsset: USDC }))).statusCode, 422, 'base = quote');
  assert.equal((await cmd('createPaperIntent', 'a', ticket({ baseAsset: (await db.pool.query(`select id from assets where chain_id='solana:fixture'`)).rows[0].id }))).statusCode, 422, 'asset on another chain');
  assert.equal((await cmd('createPaperIntent', 'a', { ...ticket(), environment: 'live' })).statusCode, 400, 'no environment field exists: paper only');
  assert.equal((await cmd('createPaperIntent', 'a', { ...ticket(), private_key: 'x' })).statusCode, 400);
  const k = 'ticket-key-0001';
  const r1 = await cmd('createPaperIntent', 'a', ticket(), k); assert.equal(r1.statusCode, 200, r1.body);
  const r2 = await cmd('createPaperIntent', 'a', ticket(), k);
  INTENT = r1.json().result.id; assert.equal(r2.json().result.id, INTENT);
  assert.equal((await db.pool.query(`select count(*)::int n from trade_intents where workspace_id=$1`, [W])).rows[0].n, 1, 'exactly one intent for a replayed key');
  const row = (await db.pool.query(`select state, environment from trade_intents where id=$1`, [INTENT])).rows[0];
  assert.deepEqual(row, { state: 'RISK_EVALUATING', environment: 'paper' });
  assert.equal((await db.pool.query(`select count(*)::int n from risk_decisions where intent_id=$1`, [INTENT])).rows[0].n, 0, 'no risk decision was fabricated');
  await assert.rejects(db.asService((c: any) => c.query(`select advance_intent($1,'ADMITTED','x1')`, [INTENT])), /risk gate/);
  const ev = (await db.pool.query(`select to_state from order_events where intent_id=$1 order by id`, [INTENT])).rows.map((x: any) => x.to_state);
  assert.deepEqual(ev, ['CANDIDATE', 'RISK_EVALUATING']);
  assert.ok((await db.pool.query(`select 1 from audit_events where action='intent.paper_create' and entity_id=$1`, [INTENT])).rowCount);
});
test('paper ticket: halted workspace refuses buys', async () => {
  assert.equal((await cmd('pauseNewEntries', 'a', { workspace: W, reason: 'test halt' })).statusCode, 200);
  assert.equal((await cmd('createPaperIntent', 'a', ticket({ notional: '5' }))).statusCode, 422);
  assert.equal((await cmd('resumeApproved', 'a', { workspace: W, reason: 'test resume' })).statusCode, 200);
});
test('order board / detail expose the timeline and null for unrecorded economics', async () => {
  const board = await get(`/v1/orders/board?workspace=${W}`);
  const o = board.items.find((x: any) => x.id === INTENT);
  assert.equal(o.state, 'RISK_EVALUATING'); assert.equal(o.risk_decision, null); assert.equal(o.base_symbol, 'ETH'); assert.equal(o.expected_slippage_bps, null); assert.equal(o.gas_native, null);
  assert.deepEqual(o.timeline.map((t: any) => t.to), ['CANDIDATE', 'RISK_EVALUATING']);
  const det = await get(`/v1/orders/${INTENT}`); assert.equal(det.events.length, 2); assert.deepEqual(det.fills, []);
  assert.equal((await call('GET', `/v1/orders/${INTENT}`, 'b')).statusCode, 404, 'RLS: other tenant sees nothing');
  assert.equal((await get(`/v1/orders/board?workspace=${W}`, 'b').catch(() => ({ items: [] }))).items?.length ?? 0, 0);
});
test('cancel: before SUBMITTING only; role + tenant checked; idempotent; releases a held reservation', async () => {
  assert.equal((await cmd('cancelIntent', 'viewer', { intent: INTENT })).statusCode, 403);
  assert.equal((await cmd('cancelIntent', 'b', { intent: INTENT })).statusCode, 403);
  assert.equal((await cmd('cancelIntent', 'a', { intent: randomUUID() })).statusCode, 422);
  // second intent: drive through admit + reserve like the engine would, then cancel
  const r = await cmd('createPaperIntent', 'a', ticket({ notional: '200000' })); const id2 = r.json().result.id;
  await db.asService(async (c: any) => {
    await c.query(`insert into risk_decisions(intent_id,workspace_id,decision,reasons,policy_version,evaluator) values ($1,$2,'ADMIT','[]',1,'test-risk')`, [id2, W]);
    await c.query(`select advance_intent($1,'ADMITTED','t:admit')`, [id2]); await c.query(`select reserve_for_intent($1)`, [id2]); await c.query(`select advance_intent($1,'CAPITAL_RESERVED','t:res')`, [id2]);
  });
  const avail = async () => (await db.pool.query(`select coalesce(sum(balance),0)::text b from ledger_accounts where workspace_id=$1 and state='available' and asset_id=$2 and bucket_id=$3`, [W, USDC, BK])).rows[0].b;
  const before = BigInt(await avail());
  assert.equal((await cmd('cancelIntent', 'a', { intent: id2, reason: 'changed my mind' })).json().result.state, 'CANCELLED');
  assert.equal(BigInt(await avail()) - before, 200000n, 'reserved capital returned to available');
  assert.equal((await cmd('cancelIntent', 'a', { intent: id2 })).json().result.state, 'CANCELLED', 'idempotent');
  assert.equal((await db.pool.query(`select count(*)::int n from order_events where intent_id=$1 and to_state='CANCELLED'`, [id2])).rows[0].n, 1);
  assert.equal((await cmd('cancelIntent', 'a', { intent: INTENT })).statusCode, 200);
  // after submission: refused
  for (const st of ['SUBMITTING', 'UNKNOWN', 'ACKNOWLEDGED', 'FILLED']) {
    const x = (await cmd('createPaperIntent', 'a', ticket({ notional: '10' }))).json().result.id;
    await db.pool.query(`update trade_intents set state=$2 where id=$1`, [x, st]);
    const rr = await cmd('cancelIntent', 'a', { intent: x }); assert.equal(rr.statusCode, 422, st); assert.match(rr.json().message, /cannot cancel/);
  }
});
test('execution analytics: waterfall/latency come from recorded rows; unrecorded gas/slippage stay null', async () => {
  const empty = await get(`/v1/analytics/execution?workspace=${W}`);
  assert.deepEqual(empty.waterfall, []);
  // drive one intent to a fill the way the engine would
  const id = (await cmd('createPaperIntent', 'a', ticket({ notional: '300000', quantity: '2000000000000000' }))).json().result.id;
  await db.asService(async (c: any) => {
    await c.query(`insert into risk_decisions(intent_id,workspace_id,decision,reasons,policy_version,evaluator) values ($1,$2,'ADMIT','[]',1,'test-risk')`, [id, W]);
    for (const [s, k] of [['ADMITTED', 'a'], ['CAPITAL_RESERVED', 'r'], ['QUOTED', 'q'], ['PREPARED', 'p'], ['SUBMITTING', 's'], ['ACKNOWLEDGED', 'k']] as const) {
      if (s === 'CAPITAL_RESERVED') await c.query(`select reserve_for_intent($1)`, [id]);
      await c.query(`select advance_intent($1,$2,$3)`, [id, s, 'e:' + k]);
    }
    await c.query(`select apply_fill_checked($1,'v1',2000000000000000,290000,500)`, [id]);
  });
  const ex = await get(`/v1/analytics/execution?workspace=${W}`);
  const w = ex.waterfall.find((x: any) => x.symbol === 'USDC');
  assert.equal(w.gross, '290000'); assert.equal(w.fees, '500'); assert.equal(w.gas_native, null); assert.equal(w.gas_recorded, 0); assert.equal(w.expected_slippage_bps, null);
  assert.ok(ex.latency.length > 0 && ex.latency.every((l: any) => l.n >= 1));
  assert.ok(ex.byStrategy.some((s: any) => s.strategy_key === 'manual_paper'));
  const tr = await get(`/v1/trades/board?workspace=${W}`); assert.equal(tr.items[0].gas_native, null); assert.equal(tr.items[0].base_symbol, 'ETH');
  await db.pool.query(`update fills set gas_native=1234, expected_slippage_bps=5, realised_slippage_bps=7 where intent_id=$1`, [id]);
  const ex2 = await get(`/v1/analytics/execution?workspace=${W}`).then((x) => x.waterfall.find((r: any) => r.symbol === 'USDC'));
  assert.equal(ex2.gas_native, '1234'); assert.equal(ex2.realised_slippage_bps, 7);
  assert.equal((await call('GET', `/v1/analytics/execution?workspace=${W}`, 'b')).json().waterfall.length, 0, 'other tenant sees none of it');
  const pos = await get(`/v1/positions?workspace=${W}`); assert.equal(pos.items.length, 1);
});
