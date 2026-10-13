import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
// @ts-expect-error plain ESM helper shared with the DB test-suite
import { freshDb } from '../../../packages/db/tests/helpers.mjs';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { makePool } from '../src/db.ts';
import { signDevToken } from '../src/auth.ts';

/** GET /v1/paper/status (migration 0300): the engine verdict comes from PROCESS HEARTBEATS, never from the persisted flag alone. */
const secret = 'test-secret-test-secret-test-secret-123456';
let db: any, app: Awaited<ReturnType<typeof buildApp>>, pool: any, W: string;
const U = { a: randomUUID(), outsider: randomUUID() };
let tok: Record<string, string> = {};

before(async () => {
  db = await freshDb();
  await db.pool.query(`insert into auth.users(id,email) values ($1,'a@t'),($2,'x@t')`, [U.a, U.outsider]);
  const url = db.url.replace('postgres@', 'apex_app:apex_app@');
  pool = makePool(url);
  app = await buildApp(pool, { ...loadConfig({ SUPABASE_JWT_SECRET: secret, DATABASE_URL: url } as any), devAuth: true, devAdminDatabaseUrl: db.url, rateLimitMax: 100000 });
  tok = { a: await signDevToken(U.a, secret), outsider: await signDevToken(U.outsider, secret) };
});
after(async () => { await app.close(); await pool.end(); await db.close(); });
const get = (url: string, who: keyof typeof U | null) => app.inject({ method: 'GET', url, headers: who ? { authorization: `Bearer ${tok[who]}` } : {} });
const hb = (component: string, ageSeconds: number, stopped = false) => db.pool.query(
  `insert into engine_heartbeats(component, instance_id, pid, host, last_seen, stopped_at, counters) values ($1, $2, 1, 'h', now() - make_interval(secs => $3), case when $4 then now() end, '{"driven": 3}')`,
  [component, `t-${randomUUID()}`, ageSeconds, stopped]);

test('paper status: auth, membership, provenance, and an honest verdict from heartbeats', async () => {
  assert.equal((await get('/v1/paper/status?workspace=' + randomUUID(), null)).statusCode, 401);
  const r = await app.inject({ method: 'POST', url: '/v1/commands/createWorkspace', payload: { name: 'P' }, headers: { authorization: `Bearer ${tok.a}`, 'idempotency-key': randomUUID() } });
  W = r.json().result.id;
  assert.notEqual((await get(`/v1/paper/status?workspace=${W}`, 'outsider')).statusCode, 200, 'a non-member must not read engine status');

  let s = (await get(`/v1/paper/status?workspace=${W}`, 'a')).json();
  assert.equal(s.verdict, 'stopped'); assert.equal(s.data_provenance, 'SYNTHETIC'); assert.match(s.provenance_note, /meaningless as evidence of any edge/);

  await db.pool.query(`update workspace_settings set paper_running = true where workspace_id = $1`, [W]);
  s = (await get(`/v1/paper/status?workspace=${W}`, 'a')).json();
  assert.equal(s.paper_running, true);
  assert.equal(s.verdict, 'engine_not_running', 'flag on but no process: must NOT claim running'); assert.match(s.headline, /NOT RUNNING/);

  await hb('execution', 30);                                  // stale heartbeat (30s) is not alive
  assert.equal((await get(`/v1/paper/status?workspace=${W}`, 'a')).json().verdict, 'engine_not_running');
  await hb('execution', 1);
  s = (await get(`/v1/paper/status?workspace=${W}`, 'a')).json();
  assert.equal(s.verdict, 'partial_feed_not_running'); assert.equal(s.execution_engine_running, true);
  await hb('paper_feed', 1);
  s = (await get(`/v1/paper/status?workspace=${W}`, 'a')).json();
  assert.equal(s.verdict, 'running'); assert.equal(s.feed_running, true);
  assert.ok(s.engines.some((e: any) => e.component === 'execution' && e.running && e.counters.driven === 3));

  await db.pool.query(`delete from engine_heartbeats`);
  await hb('execution', 1, true); await hb('paper_feed', 1, true);   // cleanly stopped processes are not "running"
  assert.equal((await get(`/v1/paper/status?workspace=${W}`, 'a')).json().verdict, 'engine_not_running');

  await db.pool.query(`select set_config('apex.service','on',false); select set_global_state($1,'emergency_stopped','t')`, [W]).catch(async () => {
    await db.pool.query(`update workspace_settings set global_state='emergency_stopped', paper_running=false where workspace_id=$1`, [W]);
  });
  s = (await get(`/v1/paper/status?workspace=${W}`, 'a')).json();
  assert.equal(s.verdict, 'halted'); assert.equal(s.conservation_ok, true);
});
