import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { CAPABILITIES } from '@apex/contracts';
import { buildRegistry, renderSeedSql, emptyForTest } from './helpers.ts';
import { freshDb } from './db.ts';
import type { TestDb } from './db.ts';

const SEED = fileURLToPath(new URL('../../db/migrations/0100_seed_chain_registry.sql', import.meta.url));

test('committed 0100_seed_chain_registry.sql is IN SYNC with the TypeScript registry (regenerate: pnpm --filter @apex/chain-registry gen:sql)', () => {
  assert.equal(readFileSync(SEED, 'utf8'), renderSeedSql(buildRegistry().records));
});
test('renderSeedSql escapes quotes and refuses CERTIFIED without evidence', () => {
  const r = { ...buildRegistry().records[0]!, name: "O'Brien chain" };
  assert.ok(renderSeedSql([r]).includes("'O''Brien chain'"));
  const bad = { ...r, capabilities: { ...r.capabilities, swap: { status: 'CERTIFIED' as const } } };
  assert.throws(() => renderSeedSql([bad]), /CERTIFIED without evidenceRef/);
  assert.equal(renderSeedSql([r]), renderSeedSql([r]), 'deterministic');
});

let db: TestDb;
before(async () => { db = await freshDb(); });
after(async () => { await db.close(); });

test('migration applies: all chains + 26 capabilities each; none CERTIFIED; all disabled; READ_ONLY rows match the TS registry', async () => {
  const reg = buildRegistry();
  const chains = await db.pool.query('select count(*)::int c from chain_registry'); assert.equal(chains.rows[0].c, reg.records.length);
  const caps = await db.pool.query('select count(*)::int c from chain_capabilities'); assert.equal(caps.rows[0].c, reg.records.length * CAPABILITIES.length);
  assert.equal((await db.pool.query(`select count(*)::int c from chain_capabilities where status='CERTIFIED'`)).rows[0].c, 0);
  assert.equal((await db.pool.query(`select count(*)::int c from chain_registry where enabled`)).rows[0].c, 0);
  const expectedRo = reg.records.flatMap((r) => CAPABILITIES.filter((c) => r.capabilities[c].status === 'READ_ONLY').map((c) => `${r.id}/${c}`)).sort();
  const gotRo = (await db.pool.query(`select chain_id||'/'||capability k from chain_capabilities where status='READ_ONLY'`)).rows.map((r) => r.k as string).sort();
  assert.deepEqual(gotRo, expectedRo);
  const sample = (await db.pool.query(`select name, native_symbol, native_decimals, family::text f, details from chain_registry where id='eip155:8453'`)).rows[0];
  assert.equal(sample.name, 'Base'); assert.equal(sample.native_symbol, 'ETH'); assert.equal(sample.f, 'evm'); assert.ok(sample.details.verifiedFrom.length >= 1); assert.equal(sample.details.meta.stack, 'op-stack');
  const ro = (await db.pool.query(`select evidence_ref from chain_capabilities where status='READ_ONLY' limit 1`)).rows[0]; if (expectedRo.length) assert.match(ro.evidence_ref, /^docs\/evidence\/chains-a-live-reads\.md#/);
});
test('re-running the seed is idempotent, keeps operator-enabled flag, and never downgrades a CERTIFIED row', async () => {
  await db.pool.query(`update chain_registry set enabled = true where id = 'eip155:1'`);
  await db.pool.query(`update chain_capabilities set status = 'CERTIFIED', evidence_ref = 'cert/eip155-1-swap.md' where chain_id = 'eip155:1' and capability = 'swap'`);
  execFileSync('psql', [db.url, '-q', '-v', 'ON_ERROR_STOP=1', '-f', SEED], { stdio: 'pipe' });
  const reg = buildRegistry();
  assert.equal((await db.pool.query('select count(*)::int c from chain_registry')).rows[0].c, reg.records.length);
  assert.equal((await db.pool.query(`select enabled from chain_registry where id='eip155:1'`)).rows[0].enabled, true);
  assert.equal((await db.pool.query(`select status::text s from chain_capabilities where chain_id='eip155:1' and capability='swap'`)).rows[0].s, 'CERTIFIED');
});
test('schema guard still holds for seeded rows: CERTIFIED without evidence is rejected by the table', async () => {
  await assert.rejects(() => db.pool.query(`update chain_capabilities set status='CERTIFIED', evidence_ref=null where chain_id='eip155:8453' and capability='swap'`), /certified_needs_evidence/);
});
