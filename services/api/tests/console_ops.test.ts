import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// @ts-expect-error plain ESM helper shared with the DB test-suite
import { freshDb } from '../../../packages/db/tests/helpers.mjs';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { makePool } from '../src/db.ts';
import { signDevToken } from '../src/auth.ts';
import { previewWaterfall } from '../../../apps/console/lib/waterfall.ts';

const secret = 'test-secret-test-secret-test-secret-123456';
let db: any, app: Awaited<ReturnType<typeof buildApp>>, pool: any;
const U: Record<string, string> = { owner: randomUUID(), owner2: randomUUID(), admin: randomUUID(), trader: randomUUID(), viewer: randomUUID(), other: randomUUID() };
const tok: Record<string, string> = {};
let USDC: string, ETH: string;
const W: any = {};

const call = (method: 'GET' | 'POST', url: string, who: string | null, payload?: unknown, key?: string) =>
  app.inject({ method, url, payload: payload as any, headers: { ...(who ? { authorization: `Bearer ${tok[who]}` } : {}), ...(key ? { 'idempotency-key': key } : {}) } });
const cmd = (name: string, who: string, body: unknown, key: string = randomUUID()) => call('POST', `/v1/commands/${name}`, who, body, key);
const get = async (url: string, who = 'owner') => { const r = await call('GET', url, who); assert.equal(r.statusCode, 200, url + ' ' + r.body); return r.json(); };
const sqlOne = async (q: string, p: unknown[] = []) => (await db.pool.query(q, p)).rows[0];

before(async () => {
  db = await freshDb();
  for (const [k, id] of Object.entries(U)) await db.pool.query(`insert into auth.users(id,email) values ($1,$2)`, [id, `${k}@t.test`]);
  await db.pool.query(`insert into chain_registry(id,namespace,chain_ref,family,name,native_symbol,native_decimals,finality_model,address_format) values ('eip155:1','eip155','1','evm','Ethereum','ETH',18,'probabilistic','0x-hex20') on conflict do nothing`);
  await db.pool.query(`insert into assets(chain_id,contract,symbol,decimals) values ('eip155:1','native','ETH',18),('eip155:1','0xusdc','USDC',6) on conflict do nothing`);
  const r = await db.pool.query(`select id,symbol from assets where chain_id='eip155:1' and symbol in ('ETH','USDC')`);
  USDC = r.rows.find((x: any) => x.symbol === 'USDC').id; ETH = r.rows.find((x: any) => x.symbol === 'ETH').id;
  const url = db.url.replace('postgres@', 'apex_app:apex_app@'); pool = makePool(url);
  app = await buildApp(pool, { ...loadConfig({ SUPABASE_JWT_SECRET: secret, DATABASE_URL: url } as any), devAuth: true, devAdminDatabaseUrl: db.url, rateLimitMax: 100000 });
  for (const k of Object.keys(U)) tok[k] = await signDevToken(U[k], secret);
  W.ws = (await cmd('createWorkspace', 'owner', { name: 'Ops' })).json().result.id;
  for (const k of ['owner2:owner', 'admin:admin', 'trader:trader', 'viewer:viewer']) { const [u, role] = k.split(':'); await db.pool.query(`insert into memberships(workspace_id,user_id,role) values ($1,$2,$3)`, [W.ws, U[u], role]); }
  W.pf = (await cmd('createPortfolio', 'owner', { workspace: W.ws, name: 'Core' })).json().result.id;
  const mkB = async (name: string, extra: any = {}) => (await cmd('createBucket', 'owner', { portfolio: W.pf, name, ...extra })).json().result.id;
  W.A = await mkB('A'); W.B = await mkB('B'); W.V = await mkB('V', { kind: 'protected_vault' });
  const mkW = async (n: string, a: string) => (await cmd('connectWallet', 'owner', { workspace: W.ws, nickname: n, family: 'evm', address: a, chains: ['eip155:1'] })).json().result.id;
  W.w1 = await mkW('w1', '0x9a4Fc2bC7897dd21305B92C0e5cb86DFFc984362'); W.w2 = await mkW('w2', '0x44f9830d8f779C62ba1C3B98ecbB17C260A69aC4'); W.w3 = await mkW('w3', '0x5555555555555555555555555555555555555555');
  await cmd('assignWalletToBucket', 'owner', { wallet: W.w1, bucket: W.A }); await cmd('assignWalletToBucket', 'owner', { wallet: W.w2, bucket: W.B }); await cmd('assignWalletToBucket', 'owner', { wallet: W.w3, bucket: W.V });
  for (const k of ['w1', 'w2', 'w3']) W['x' + k] = (await sqlOne(`select id from wallet_chain_accounts where wallet_id=$1`, [W[k]])).id;
  assert.equal((await cmd('paperDeposit', 'owner', { workspace: W.ws, walletChainAccount: W.xw1, asset: USDC, amount: '100000' })).statusCode, 200);
  assert.equal((await cmd('allocate', 'owner', { workspace: W.ws, bucket: W.A, walletChainAccount: W.xw1, asset: USDC, amount: '100000' })).statusCode, 200);
});
after(async () => { await app.close(); await pool.end(); await db.close(); });

test('auth + cross-tenant: every new read is 401 unauthenticated and invisible/404 to a non-member', async () => {
  const reads = ['capital/accounts', 'risk/exposure', 'risk/violations', 'risk/incidents', 'settings/members', 'settings/overview', 'settings/integrations', 'jobs/summary', 'audit/search', 'compounding/overview', 'treasury/cashflow', 'treasury/exceptions'];
  for (const p of reads) {
    assert.equal((await call('GET', `/v1/${p}?workspace=${W.ws}`, null)).statusCode, 401, p);
    const o = await call('GET', `/v1/${p}?workspace=${W.ws}`, 'other');
    assert.ok([403, 404].includes(o.statusCode) || JSON.stringify(o.json()).indexOf(W.A) === -1, `${p} leaked to non-member: ${o.body.slice(0, 200)}`);
  }
  const acc = (await call('GET', `/v1/capital/accounts?workspace=${W.ws}`, 'other')).json(); assert.deepEqual(acc.buckets, []); assert.deepEqual(acc.accounts, []);
  assert.equal((await call('GET', `/v1/risk/violations?workspace=${W.ws}`, 'other')).statusCode, 404);
  assert.equal((await call('GET', `/v1/settings/members?workspace=${W.ws}`, 'other')).statusCode, 403);
  for (const [n, b] of [['pauseNonEssentialJobs', { workspace: W.ws, reason: 'attack' }], ['recordIncident', { workspace: W.ws, class: 'x', severity: 'info', message: 'abc' }], ['tightenGlobalLimits', { workspace: W.ws, limits: { max_slippage_bps: 1 }, reason: 'abc' }],
    ['setCompoundingTarget', { workspace: W.ws, period: 'day', asset: USDC, targetAmount: '1' }], ['addReconciliationException', { workspace: W.ws, asset: USDC, expected: '1', observed: '2', source: 's' }]] as const)
    assert.equal((await cmd(n, 'other', b)).statusCode, 403, n);
});

test('validation: missing idempotency key, strict schemas, secrets, bad enums', async () => {
  assert.equal((await call('POST', '/v1/commands/recordIncident', 'owner', { workspace: W.ws, class: 'x', severity: 'info', message: 'abc' })).statusCode, 400);
  assert.equal((await cmd('recordIncident', 'owner', { workspace: W.ws, class: 'x', severity: 'fatal', message: 'abc' })).statusCode, 400);
  assert.equal((await cmd('recordIncident', 'owner', { workspace: W.ws, class: 'x', severity: 'info', message: 'abc', extra: 1 })).statusCode, 400);
  assert.equal((await cmd('recordIncident', 'owner', { workspace: W.ws, class: 'x', severity: 'info', message: 'abc', apiSecret: 'x' })).statusCode, 400);
  assert.equal((await cmd('tightenGlobalLimits', 'owner', { workspace: W.ws, limits: {}, reason: 'abc' })).statusCode, 400);
  assert.equal((await cmd('tightenGlobalLimits', 'owner', { workspace: W.ws, limits: { max_slippage_bps: 1.5 }, reason: 'abc' })).statusCode, 400);
  assert.equal((await cmd('setCompoundingTarget', 'owner', { workspace: W.ws, period: 'day', asset: USDC })).statusCode, 400, 'amount or pct required');
  assert.equal((await cmd('setCompoundingTarget', 'owner', { workspace: W.ws, period: 'day', asset: USDC, targetAmount: '12.5' })).statusCode, 400, 'amounts are integer strings');
  assert.equal((await cmd('retryJob', 'owner', { job: 'not-a-uuid' })).statusCode, 400);
});

test('gate sign-off requires evidence reference AND commit SHA (API) and only owners may sign', async () => {
  const gate = 'ledger_conservation';
  assert.equal((await cmd('approveDeploymentGate', 'owner', { workspace: W.ws, gate, status: 'PASS' })).statusCode, 400);
  assert.equal((await cmd('approveDeploymentGate', 'owner', { workspace: W.ws, gate, status: 'PASS', evidenceRef: 'docs/evidence/x.log' })).statusCode, 400);
  assert.equal((await cmd('approveDeploymentGate', 'owner', { workspace: W.ws, gate, status: 'PASS', evidenceRef: 'docs/evidence/x.log', commitSha: 'zzzzzzz' })).statusCode, 400);
  assert.equal((await cmd('approveDeploymentGate', 'admin', { workspace: W.ws, gate, status: 'PASS', evidenceRef: 'docs/evidence/x.log', commitSha: 'abc1234' })).statusCode, 403);
  assert.equal((await cmd('approveDeploymentGate', 'trader', { workspace: W.ws, gate, status: 'PASS', evidenceRef: 'docs/evidence/x.log', commitSha: 'abc1234' })).statusCode, 403);
  // database refuses as well when the API schema is bypassed
  await assert.rejects(db.pool.query(`update deployment_gates set status='PASS' where workspace_id=$1 and gate_key=$2`, [W.ws, gate]), /pass_needs_evidence/);
  assert.equal((await cmd('approveDeploymentGate', 'owner', { workspace: W.ws, gate, status: 'PASS', evidenceRef: 'docs/evidence/x.log', commitSha: 'abc1234' })).statusCode, 200);
  const g = (await get(`/v1/risk?workspace=${W.ws}`)).gates.find((x: any) => x.gate_key === gate); assert.equal(g.status, 'PASS'); assert.equal(g.commit_sha, 'abc1234');
  assert.equal((await get(`/v1/overview?workspace=${W.ws}`)).settings.live_allowed, false, 'one PASS never unlocks live');
  assert.equal((await cmd('approveDeploymentGate', 'owner', { workspace: W.ws, gate, status: 'NOT_RUN' })).statusCode, 200);
  assert.equal((await cmd('setLiveOptIn', 'owner', { workspace: W.ws, on: true })).statusCode, 200);
  assert.equal((await get(`/v1/overview?workspace=${W.ws}`)).settings.live_allowed, false, 'opt-in alone never unlocks live');
  await cmd('setLiveOptIn', 'owner', { workspace: W.ws, on: false });
});

test('paper transfer lifecycle: physical pending -> confirm credits destination; fail returns source; role + environment enforcement', async () => {
  const req = async (amount: string) => (await cmd('requestCapitalTransfer', 'owner', { workspace: W.ws, srcBucket: W.A, srcWalletChainAccount: W.xw1, dstBucket: W.B, dstWalletChainAccount: W.xw2, asset: USDC, amount })).json().result.id;
  const bal = async (bucket: string, state: string) => BigInt((await sqlOne(`select coalesce(sum(balance),0)::text s from ledger_accounts where bucket_id=$1 and state=$2 and asset_id=$3`, [bucket, state, USDC])).s);
  const t1 = await req('1000');
  let tr = (await get(`/v1/allocations?workspace=${W.ws}`)).transfers.find((t: any) => t.id === t1); assert.equal(tr.kind, 'physical'); assert.equal(tr.status, 'pending_finality');
  assert.equal(await bal(W.B, 'available'), 0n, 'destination not credited before finality'); assert.equal(await bal(W.A, 'pending_out'), 1000n);
  for (const who of ['other', 'viewer', 'trader']) assert.equal((await cmd('confirmPaperTransfer', who, { transfer: t1 })).statusCode, 403, who);
  assert.equal(await bal(W.B, 'available'), 0n);
  assert.equal((await cmd('confirmPaperTransfer', 'admin', { transfer: t1 })).statusCode, 200);
  assert.equal(await bal(W.B, 'available'), 1000n); assert.equal(await bal(W.A, 'pending_out'), 0n);
  assert.equal((await cmd('confirmPaperTransfer', 'owner', { transfer: t1 })).statusCode, 200, 'confirming twice is a no-op');
  assert.equal(await bal(W.B, 'available'), 1000n);
  const t2 = await req('2500'); const before = await bal(W.A, 'available');
  assert.equal((await cmd('failPaperTransfer', 'viewer', { transfer: t2 })).statusCode, 403);
  assert.equal((await cmd('failPaperTransfer', 'owner', { transfer: t2 })).statusCode, 200);
  assert.equal(await bal(W.A, 'available'), before + 2500n, 'failure returns funds to source'); assert.equal(await bal(W.B, 'available'), 1000n, 'destination still never credited');
  assert.equal((await cmd('confirmPaperTransfer', 'owner', { transfer: t2 })).statusCode, 422, 'cannot confirm a failed transfer');
  // LIVE transfers can never be confirmed/failed through the console
  await db.pool.query(`insert into portfolios(workspace_id,name,environment) values ($1,'LivePF','live')`, [W.ws]);
  const lp = (await sqlOne(`select id from portfolios where name='LivePF'`)).id;
  const lb = (await sqlOne(`insert into buckets(workspace_id,portfolio_id,environment,name) values ($1,$2,'live','LB1') returning id`, [W.ws, lp])).id;
  const lb2 = (await sqlOne(`insert into buckets(workspace_id,portfolio_id,environment,name) values ($1,$2,'live','LB2') returning id`, [W.ws, lp])).id;
  const lt = (await sqlOne(`insert into internal_transfers(workspace_id,environment,kind,src_bucket,src_wca,dst_bucket,dst_wca,asset_id,amount,idempotency_key,status) values ($1,'live','physical',$2,$4,$3,$5,$6,10,'live-x','pending_finality') returning id`, [W.ws, lb, lb2, W.xw1, W.xw2, USDC])).id;
  for (const who of ['owner', 'admin']) { const c = await cmd('confirmPaperTransfer', who, { transfer: lt }); assert.equal(c.statusCode, 403, who + ' ' + c.body); assert.match(c.body, /permission denied/); assert.equal((await cmd('failPaperTransfer', who, { transfer: lt })).statusCode, 403); }
  assert.equal((await sqlOne(`select status from internal_transfers where id=$1`, [lt])).status, 'pending_finality');
  assert.equal((await cmd('requestCapitalTransfer', 'owner', { workspace: W.ws, srcBucket: lb, srcWalletChainAccount: W.xw1, dstBucket: lb2, dstWalletChainAccount: W.xw2, asset: USDC, amount: '1' })).statusCode, 403, 'live ledger mutation refused');
});

test('same-wallet transfer is LOGICAL and atomic (preview rule == SQL rule)', async () => {
  const L1 = (await cmd('createBucket', 'owner', { portfolio: W.pf, name: 'L1', segregation: 'logical' })).json().result.id;
  const L2 = (await cmd('createBucket', 'owner', { portfolio: W.pf, name: 'L2', segregation: 'logical' })).json().result.id;
  const sh = (await cmd('connectWallet', 'owner', { workspace: W.ws, nickname: 'shared', family: 'evm', address: '0x7777777777777777777777777777777777777777', chains: ['eip155:1'] })).json().result.id;
  for (const b of [L1, L2]) assert.equal((await cmd('assignWalletToBucket', 'owner', { wallet: sh, bucket: b, exclusive: false, maxAllocationBps: 5000, logicalAck: true })).statusCode, 200);
  const x = (await sqlOne(`select id from wallet_chain_accounts where wallet_id=$1`, [sh])).id;
  await cmd('paperDeposit', 'owner', { workspace: W.ws, walletChainAccount: x, asset: USDC, amount: '500' }); await cmd('allocate', 'owner', { workspace: W.ws, bucket: L1, walletChainAccount: x, asset: USDC, amount: '500' });
  const r = await cmd('requestCapitalTransfer', 'owner', { workspace: W.ws, srcBucket: L1, srcWalletChainAccount: x, dstBucket: L2, dstWalletChainAccount: x, asset: USDC, amount: '200' }); assert.equal(r.statusCode, 200, r.body);
  const tr = (await get(`/v1/allocations?workspace=${W.ws}`)).transfers.find((t: any) => t.id === r.json().result.id);
  const { transferKind, initialStatus } = await import('../../../apps/console/lib/transfer.ts');
  assert.equal(tr.kind, transferKind(x, x)); assert.equal(tr.status, initialStatus('logical')); assert.equal(tr.status, 'confirmed');
  const acc = await get(`/v1/capital/accounts?workspace=${W.ws}`); assert.equal(acc.balances.find((b: any) => b.bucket_id === L2 && b.state === 'available').amount, '200');
  assert.equal(transferKind(W.xw1, W.xw2), (await get(`/v1/allocations?workspace=${W.ws}`)).transfers.find((t: any) => t.kind === 'physical').kind);
});

test('vault release: owner-only request, four-eyes, delay, execute once', async () => {
  await cmd('paperDeposit', 'owner', { workspace: W.ws, walletChainAccount: W.xw3, asset: USDC, amount: '700' }); await cmd('allocate', 'owner', { workspace: W.ws, bucket: W.V, walletChainAccount: W.xw3, asset: USDC, amount: '700' });
  const body = { workspace: W.ws, vaultBucket: W.V, walletChainAccount: W.xw3, asset: USDC, amount: '300' };
  assert.equal((await cmd('requestVaultRelease', 'admin', body)).statusCode, 403);
  const a = (await cmd('requestVaultRelease', 'owner', body)).json().result.id;
  assert.equal((await cmd('decideApproval', 'owner', { approval: a, approve: true })).statusCode, 403, 'requester cannot approve own request');
  assert.equal((await cmd('decideApproval', 'admin', { approval: a, approve: true })).statusCode, 403);
  assert.equal((await cmd('decideApproval', 'owner2', { approval: a, approve: true })).statusCode, 200);
  const r = await cmd('releaseVault', 'owner', { approval: a }); assert.equal(r.statusCode, 422); assert.match(r.body, /delay/);
  await db.pool.query(`update approval_requests set not_before = now() - interval '1 minute' where id=$1`, [a]);
  const k = randomUUID(); assert.equal((await cmd('releaseVault', 'owner', { approval: a }, k)).statusCode, 200);
  assert.equal((await sqlOne(`select status from approval_requests where id=$1`, [a])).status, 'executed');
  const v = (await sqlOne(`select balance::text b from ledger_accounts where bucket_id=$1 and state='vault'`, [W.V])).b; assert.equal(v, '400');
});

test('idempotency: same key replays (one effect), same key + other payload refused, concurrent double submit = one row', async () => {
  const body = { workspace: W.ws, class: 'dup', severity: 'warn', message: 'double' }; const k = 'incident-key-0001';
  const [r1, r2] = await Promise.all([cmd('recordIncident', 'owner', body, k), cmd('recordIncident', 'owner', body, k)]);
  assert.equal(r1.statusCode, 200); assert.equal(r2.statusCode, 200); assert.equal(r1.json().result.id, r2.json().result.id);
  assert.equal((await sqlOne(`select count(*)::int n from alerts where workspace_id=$1 and class='dup'`, [W.ws])).n, 1);
  assert.equal((await cmd('recordIncident', 'owner', { ...body, message: 'different' }, k)).statusCode, 422);
  assert.equal((await cmd('recordIncident', 'owner', body)).statusCode, 200); assert.equal((await sqlOne(`select count(*)::int n from alerts where workspace_id=$1 and class='dup'`, [W.ws])).n, 2, 'a NEW key is a new action');
  const t = { workspace: W.ws, bucket: W.A, period: 'month', asset: USDC, targetAmount: '999' }; const tk = 'target-key-0001';
  await Promise.all([cmd('setCompoundingTarget', 'owner', t, tk), cmd('setCompoundingTarget', 'owner', t, tk), cmd('setCompoundingTarget', 'owner', t, tk)]);
  assert.equal((await sqlOne(`select count(*)::int n from target_plans where workspace_id=$1 and target_amount=999`, [W.ws])).n, 1);
});

test('incidents: ack requires trader+, is audited, idempotent', async () => {
  const id = Number((await cmd('recordIncident', 'trader', { workspace: W.ws, class: 'ops', severity: 'critical', message: 'rpc down' })).json().result.id);
  assert.equal((await cmd('recordIncident', 'viewer', { workspace: W.ws, class: 'ops', severity: 'info', message: 'abc' })).statusCode, 403);
  assert.equal((await cmd('acknowledgeAlert', 'viewer', { alert: id })).statusCode, 403);
  const v = (await get(`/v1/risk/violations?workspace=${W.ws}`)).items; assert.ok(v.some((x: any) => x.key === 'alert:' + id && x.source === 'alerts'));
  assert.equal((await cmd('acknowledgeAlert', 'trader', { alert: id, note: 'restarted provider' })).statusCode, 200);
  const a = (await get(`/v1/risk/incidents?workspace=${W.ws}`)).alerts.find((x: any) => x.id === String(id)); assert.equal(a.acknowledged, true); assert.equal(a.ack_note, 'restarted provider');
  assert.ok(!(await get(`/v1/risk/violations?workspace=${W.ws}`)).items.some((x: any) => x.key === 'alert:' + id));
  const au = await get(`/v1/audit/search?workspace=${W.ws}&action=alert.ack`); assert.ok(au.total >= 1);
});

test('jobs: pausing non-essential NEVER touches essential jobs (DB-enforced); retry is idempotent and role-checked', async () => {
  const ins = async (queue: string, essential: boolean, status = 'queued') => (await sqlOne(`insert into jobs(workspace_id,queue,essential,status,last_error) values ($1,$2,$3,$4,$5) returning id`, [W.ws, queue, essential, status, status === 'dead' ? 'boom' : null])).id;
  const ess = await ins('settlement', true), ess2 = await ins('exit-supervisor', true, 'running'), r1 = await ins('research', false), r2 = await ins('llm-batch', false, 'running'), dead = await ins('token-scan', false, 'dead'), done = await ins('research', false, 'done');
  assert.equal((await cmd('pauseNonEssentialJobs', 'viewer', { workspace: W.ws, reason: 'nope' })).statusCode, 403);
  const p = await cmd('pauseNonEssentialJobs', 'trader', { workspace: W.ws, reason: 'cost spike' }); assert.equal(p.statusCode, 200, p.body); assert.equal(p.json().result.paused, 2);
  const rows = Object.fromEntries((await db.pool.query(`select id, essential, paused from jobs where workspace_id=$1`, [W.ws])).rows.map((r: any) => [r.id, r]));
  assert.equal(rows[ess].paused, false); assert.equal(rows[ess2].paused, false); assert.equal(rows[r1].paused, true); assert.equal(rows[r2].paused, true); assert.equal(rows[done].paused, false);
  const lateEss = await ins('settlement', true), lateRes = await ins('research', false);
  assert.equal((await sqlOne(`select paused from jobs where id=$1`, [lateEss])).paused, false, 'essential enqueued during pause is not paused');
  assert.equal((await sqlOne(`select paused from jobs where id=$1`, [lateRes])).paused, true, 'non-essential enqueued during pause starts paused');
  await assert.rejects(db.pool.query(`update jobs set paused=true where id=$1`, [ess]), /essential_never_paused/);
  const s = await get(`/v1/jobs/summary?workspace=${W.ws}`); assert.equal(s.paused, true); assert.match(s.note, /no job consumer|No worker|no worker/i); assert.equal(s.dead.length, 1);
  assert.equal((await cmd('resumeNonEssentialJobs', 'trader', { workspace: W.ws })).statusCode, 403);
  assert.equal((await cmd('resumeNonEssentialJobs', 'admin', { workspace: W.ws })).statusCode, 200);
  assert.equal((await sqlOne(`select count(*)::int n from jobs where workspace_id=$1 and paused`, [W.ws])).n, 0);
  // retry
  assert.equal((await cmd('retryJob', 'trader', { job: dead })).statusCode, 403);
  assert.equal((await cmd('retryJob', 'owner', { job: ess })).statusCode, 422, 'queued job cannot be retried');
  const k = 'retry-key-0001'; const [a, b] = await Promise.all([cmd('retryJob', 'owner', { job: dead }, k), cmd('retryJob', 'owner', { job: dead }, k)]);
  assert.equal(a.statusCode, 200); assert.equal(b.statusCode, 200);
  assert.equal((await sqlOne(`select status from jobs where id=$1`, [dead])).status, 'queued'); assert.equal((await sqlOne(`select count(*)::int n from job_retries where job_id=$1`, [dead])).n, 1);
});

test('global limits: tighten-only; loosening needs a second owner + delay; applied once', async () => {
  assert.equal((await cmd('tightenGlobalLimits', 'admin', { workspace: W.ws, limits: { max_slippage_bps: 50 }, reason: 'tighten' })).statusCode, 403);
  const up = await cmd('tightenGlobalLimits', 'owner', { workspace: W.ws, limits: { max_slippage_bps: 50 }, reason: 'tighten' }); assert.equal(up.statusCode, 200, up.body);
  assert.equal((await get(`/v1/settings/overview?workspace=${W.ws}`)).settings.global_limits.max_slippage_bps, 50);
  const loose = await cmd('tightenGlobalLimits', 'owner', { workspace: W.ws, limits: { max_slippage_bps: 80 }, reason: 'loosen' }); assert.equal(loose.statusCode, 422); assert.match(loose.body, /only be tightened/);
  const a = (await cmd('requestLimitIncrease', 'owner', { workspace: W.ws, limits: { max_slippage_bps: 80 }, reason: 'need more' })).json().result.approval;
  assert.equal((await get(`/v1/settings/overview?workspace=${W.ws}`)).settings.global_limits.max_slippage_bps, 50, 'request alone changes nothing');
  assert.equal((await cmd('decideApproval', 'owner', { approval: a, approve: true })).statusCode, 403);
  assert.equal((await cmd('applyLimitIncrease', 'owner', { approval: a })).statusCode, 422, 'pending cannot be applied');
  assert.equal((await cmd('decideApproval', 'owner2', { approval: a, approve: true })).statusCode, 200);
  const early = await cmd('applyLimitIncrease', 'owner', { approval: a }); assert.equal(early.statusCode, 422); assert.match(early.body, /delay/);
  await db.pool.query(`update approval_requests set not_before=now()-interval '1 second' where id=$1`, [a]);
  assert.equal((await cmd('applyLimitIncrease', 'admin', { approval: a })).statusCode, 403);
  assert.equal((await cmd('applyLimitIncrease', 'owner', { approval: a })).statusCode, 200);
  assert.equal((await get(`/v1/settings/overview?workspace=${W.ws}`)).settings.global_limits.max_slippage_bps, 80);
  assert.equal((await cmd('applyLimitIncrease', 'owner', { approval: a })).statusCode, 422, 'applies only once');
  // child limits cannot exceed global: API 422 message is the DB message verbatim
  const b0 = (await get(`/v1/buckets/${W.A}`)).bucket;
  const bad = await cmd('updateBucketPolicy', 'owner', { bucket: W.A, expectedVersion: b0.policy_version, policy: { max_slippage_bps: 9000 } }); assert.equal(bad.statusCode, 422); assert.match(bad.body, /cannot exceed the global hard limit/);
  // after tightening below an existing child policy, the violation list names the authoritative source
  assert.equal((await cmd('updateBucketPolicy', 'owner', { bucket: W.A, expectedVersion: b0.policy_version, policy: { max_slippage_bps: 70 } })).statusCode, 200);
  assert.equal((await cmd('tightenGlobalLimits', 'owner', { workspace: W.ws, limits: { max_slippage_bps: 60 }, reason: 'tighter' })).statusCode, 200);
  const v = (await get(`/v1/risk/violations?workspace=${W.ws}`)).items.find((x: any) => x.key === 'limit:' + W.A); assert.ok(v); assert.match(v.source, /workspace_settings\.global_limits/);
});

test('scoped emergency: trader may halt a bucket, only admin+ resumes; halted bucket refuses reservations', async () => {
  assert.equal((await cmd('setBucketState', 'viewer', { bucket: W.B, state: 'halt_new_entries', reason: 'no' })).statusCode, 403);
  assert.equal((await cmd('setBucketState', 'trader', { bucket: W.B, state: 'exit_only', reason: 'drill' })).statusCode, 200);
  assert.equal((await sqlOne(`select state from buckets where id=$1`, [W.B])).state, 'exit_only');
  assert.ok((await get(`/v1/risk/violations?workspace=${W.ws}`)).items.some((x: any) => x.key === 'bucket_state:' + W.B));
  assert.ok((await get(`/v1/risk/incidents?workspace=${W.ws}`)).emergencyActions.some((e: any) => e.scope === 'BUCKET' && e.action === 'EXIT_ONLY'));
  assert.equal((await cmd('setBucketState', 'trader', { bucket: W.B, state: 'active', reason: 'resume' })).statusCode, 403);
  assert.equal((await cmd('setBucketState', 'admin', { bucket: W.B, state: 'active', reason: 'resume' })).statusCode, 200);
});

test('compounding: targets compute progress from ledger profit events; waterfall preview == real SQL apply_waterfall', async () => {
  const intentFor = async (net: string, k: string) => {
    const i = (await sqlOne(`insert into trade_intents(workspace_id,environment,bucket_id,strategy_key,wallet_chain_account_id,base_asset,quote_asset,side,quantity,notional,idempotency_key,state) values ($1,'paper',$2,'t',$3,$4,$5,'sell',1,1,$6,'RECONCILED') returning id`, [W.ws, W.A, W.xw1, ETH, USDC, k])).id;
    const e = (await sqlOne(`insert into profit_eligibility_events(workspace_id,environment,bucket_id,intent_id,quote_asset,realized_net_quote) values ($1,'paper',$2,$3,$4,$5) returning id`, [W.ws, W.A, i, USDC, net])).id; return e as string;
  };
  const ev = await intentFor('250', 'prof-1');
  const o = await get(`/v1/compounding/overview?workspace=${W.ws}`);
  const t = o.targets.find((x: any) => x.target_amount === '999'); assert.equal(t.realised_in_period, '250'); assert.equal(t.monitoring_only, true);
  assert.match(o.note, /never force trades/);
  // exact comparison with the real SQL for many policies
  const pol = async (v: number, tax: number, rv: number, vt: number, rs: number, minT = 0) => (await sqlOne(`insert into compounding_policies(workspace_id,bucket_id,version,reinvest_bps,vault_bps,cross_bucket_bps,reserve_bps,tax_provision_bps,vault_bucket_id,vault_wca,min_ticket) values ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10) returning id`, [W.ws, W.A, v, rv, vt, rs, tax, vt ? W.V : null, vt ? W.xw3 : null, minT])).id;
  const cases: [number, number, number, number, number, number, string, string][] = [
    [1000, 4000, 3500, 2500, 0, 0, '777', '0'], [0, 10000, 0, 0, 0, 0, '1', '0'], [333, 3333, 3333, 3334, 0, 0, '10007', '0'], [1234, 5001, 4999, 0, 0, 0, '999', '0'], [9999, 1, 1, 9998, 0, 0, '1000', '0'],
    [500, 2500, 2500, 5000, 0, 0, '900', '400'], [0, 3000, 3000, 4000, 0, 3000, '20', '0']];
  let ver = 100;
  for (const [tax, rv, vt, rs, , minT, gross, deficit] of cases) {
    ver++; const p = await pol(ver, tax, rv, vt, rs, minT); const e = await intentFor(gross, 'prof-' + ver);
    await db.pool.query(`delete from bucket_deficits where bucket_id=$1`, [W.A]); if (deficit !== '0') await db.pool.query(`insert into bucket_deficits(bucket_id,quote_asset,amount) values ($1,$2,$3)`, [W.A, USDC, deficit]);
    const x = await db.asService(async (c: any) => { const id = (await c.query(`select apply_waterfall($1,$2) id`, [e, p])).rows[0].id; return (await c.query(`select deficit_recovered::text d, eligible::text el, tax_provision::text tx, to_reinvest::text rv, to_vault::text vt, to_cross::text cx, to_reserve::text rs from waterfall_executions where id=$1`, [id])).rows[0]; });
    const m = previewWaterfall(BigInt(gross), BigInt(deficit), { taxBps: tax, reinvestBps: rv, vaultBps: vt, crossBps: 0, reserveBps: rs, minTicket: BigInt(minT) });
    assert.deepEqual({ d: m.deficitRecovered.toString(), el: m.eligible.toString(), tx: m.tax.toString(), rv: m.reinvest.toString(), vt: m.vault.toString(), cx: m.cross.toString(), rs: m.reserve.toString() }, x, `case ${JSON.stringify(cases[ver - 101])}`);
  }
  // 300 random pure-SQL cases with huge numbers
  for (let i = 0; i < 300; i++) {
    const g = BigInt(Math.floor(Math.random() * 1e15)) * BigInt(Math.floor(Math.random() * 1e9) + 1) + 1n, tax = Math.floor(Math.random() * 10001), cuts = [Math.floor(Math.random() * 10001), Math.floor(Math.random() * 10001), Math.floor(Math.random() * 10001)].sort((a, b) => a - b);
    const vt = cuts[1] - cuts[0], cx = cuts[2] - cuts[1], rs = 10000 - cuts[2], rv = cuts[0];
    const s = await sqlOne(`select div($1::numeric*$2,10000)::text tax, div(($1::numeric - div($1::numeric*$2,10000))*$3,10000)::text vt, div(($1::numeric - div($1::numeric*$2,10000))*$4,10000)::text cx, div(($1::numeric - div($1::numeric*$2,10000))*$5,10000)::text rs`, [g.toString(), tax, vt, cx, rs]);
    const m = previewWaterfall(g, 0n, { taxBps: tax, reinvestBps: rv, vaultBps: vt, crossBps: cx, reserveBps: rs, minTicket: 0n });
    assert.deepEqual({ tax: m.tax.toString(), vt: m.vault.toString(), cx: m.cross.toString(), rs: m.reserve.toString() }, s);
  }
  // unreconciled profit is rejected by SQL (preview page copy depends on this rule)
  const bad = await intentFor('5', 'prof-unrec'); await db.pool.query(`update trade_intents set state='ACKNOWLEDGED' where id=(select intent_id from profit_eligibility_events where id=$1)`, [bad]);
  const anyPol = (await sqlOne(`select id from compounding_policies limit 1`)).id;
  await assert.rejects(db.asService((c: any) => c.query(`select apply_waterfall($1,$2)`, [bad, anyPol])), /not eligible/);
  assert.equal((await cmd('applyWaterfallPolicy', 'owner', { bucket: W.A, reinvestBps: 5000, vaultBps: 3000, reserveBps: 1000 })).statusCode, 400, 'server also rejects a waterfall that is not 100%');
});

test('treasury: ledger-derived reconciliation, exceptions with role checks, honest notes', async () => {
  const t = await get(`/v1/treasury/cashflow?workspace=${W.ws}`);
  const f = t.flows.find((x: any) => x.symbol === 'USDC' && x.environment === 'paper');
  const pool = BigInt(t.pool.find((p: any) => p.asset_id === USDC && p.environment === 'paper')?.balance ?? '0');
  assert.equal(BigInt(f.deposits) - BigInt(f.allocations) + BigInt(f.vault_releases), pool, 'deposits - allocations + vault releases == wallet pool');
  assert.match(t.notes.gbp, /FX/); assert.match(t.notes.tax, /not tax advice/);
  assert.ok(t.held.some((h: any) => h.state === 'vault'));
  const ex = { workspace: W.ws, bucket: W.A, asset: USDC, expected: '100', observed: '90', source: 'statement', note: 'x' };
  for (const who of ['trader', 'viewer']) assert.equal((await cmd('addReconciliationException', who, ex)).statusCode, 403);
  assert.equal((await cmd('addReconciliationException', 'owner', { ...ex, observed: '100' })).statusCode, 422, 'equal amounts rejected');
  const id = (await cmd('addReconciliationException', 'admin', ex)).json().result.id;
  assert.ok((await get(`/v1/risk/violations?workspace=${W.ws}`)).items.some((x: any) => x.key === 'recon'));
  assert.equal((await cmd('resolveReconciliationException', 'owner', { id, resolution: 'x' })).statusCode, 400);
  assert.equal((await cmd('resolveReconciliationException', 'trader', { id, resolution: 'matched statement' })).statusCode, 403);
  assert.equal((await cmd('resolveReconciliationException', 'owner', { id, resolution: 'matched statement' })).statusCode, 200);
  const list = (await get(`/v1/treasury/exceptions?workspace=${W.ws}`)).items; assert.equal(list[0].status, 'resolved'); assert.equal(list[0].expected, '100');
  await assert.rejects(db.pool.query(`update reconciliation_discrepancies set status='open' where id=$1`, [id]).then(() => db.pool.query(`update reconciliation_discrepancies set status='resolved', resolution=null where id=$1`, [id])), /resolved_has_reason/);
});

test('audit search: filters, pagination, total, immutability', async () => {
  const all = await get(`/v1/audit/search?workspace=${W.ws}&limit=5&offset=0`); assert.ok(all.total > 10); assert.equal(all.items.length, 5);
  const p2 = await get(`/v1/audit/search?workspace=${W.ws}&limit=5&offset=5`); assert.notEqual(p2.items[0].id, all.items[0].id);
  const f = await get(`/v1/audit/search?workspace=${W.ws}&action=bucket.`); assert.ok(f.items.length > 0 && f.items.every((x: any) => x.action.startsWith('bucket.')));
  const e = await get(`/v1/audit/search?workspace=${W.ws}&entity=wallets`); assert.ok(e.items.every((x: any) => x.entity === 'wallets'));
  const fut = await get(`/v1/audit/search?workspace=${W.ws}&from=${encodeURIComponent('2999-01-01T00:00:00Z')}`); assert.equal(fut.total, 0);
  assert.equal((await call('GET', `/v1/audit/search?workspace=${W.ws}&limit=9999`, 'owner')).statusCode, 400);
  assert.ok(all.facets.actions.includes('workspace.create'));
  await assert.rejects(db.pool.query(`delete from audit_events where workspace_id=$1`, [W.ws]), /append-only/);
});

test('settings: members hide emails from non-admins; integrations never claim to be connected; invites disabled', async () => {
  const own = await get(`/v1/settings/members?workspace=${W.ws}`); assert.equal(own.inviteAvailable, false); assert.ok(own.items.every((m: any) => m.email));
  const vw = await get(`/v1/settings/members?workspace=${W.ws}`, 'viewer'); assert.equal(vw.items.filter((m: any) => m.email).length, 1); assert.equal(vw.items.find((m: any) => m.is_you).role, 'viewer');
  const i = await get(`/v1/settings/integrations?workspace=${W.ws}`);
  for (const x of i.items) { assert.ok(x.setup.length > 0); assert.ok(!/^CONNECTED|HEALTHY|OK$/.test(x.status), x.key + ' ' + x.status); }
  assert.equal(i.items.find((x: any) => x.key === 'supabase_auth').status, 'NOT CONFIGURED'); assert.equal(i.items.find((x: any) => x.key === 'kms_signer').status, 'BLOCKED');
  assert.ok(!JSON.stringify(i).match(/sk-|secret-test/), 'no secret values are returned');
  const o = await get(`/v1/settings/overview?workspace=${W.ws}`, 'trader'); assert.equal(o.yourRole, 'trader'); assert.equal(o.settings.live_allowed, false);
});

test('risk reads: exposure is ledger-only and violations list names sources', async () => {
  const e = await get(`/v1/risk/exposure?workspace=${W.ws}`); assert.ok(e.ledger.length > 0); assert.match(e.provenance, /No market-price feed/);
  const v = await get(`/v1/risk/violations?workspace=${W.ws}`); assert.ok(v.items.every((x: any) => x.source && x.rule && x.action));
  assert.ok(v.items.some((x: any) => x.key === 'gates'), 'live lock reported with its authority');
  await cmd('emergencyStop', 'trader', { workspace: W.ws, reason: 'drill' });
  assert.ok((await get(`/v1/risk/violations?workspace=${W.ws}`)).items.some((x: any) => x.key === 'global_state' && x.source === 'workspace_settings.global_state'));
});
