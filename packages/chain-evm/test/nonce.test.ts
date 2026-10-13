import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { NonceAllocator, NonceError, isValidReplacement, bumpedFees, minReplacementFee } from '../src/index.ts';
import { freshDb } from './db.ts';
import type { TestDb } from './db.ts';

const A = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', B = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
let db: TestDb;
before(async () => { db = await freshDb(); });
after(async () => { await db.close(); });

test('pure replacement rule: both fields need >= 10% (ceil)', () => {
  assert.equal(minReplacementFee(100n), 110n); assert.equal(minReplacementFee(101n), 112n);
  assert.equal(isValidReplacement({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }, { maxFeePerGas: 110n, maxPriorityFeePerGas: 11n }), true);
  assert.equal(isValidReplacement({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }, { maxFeePerGas: 109n, maxPriorityFeePerGas: 11n }), false);
  assert.equal(isValidReplacement({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }, { maxFeePerGas: 200n, maxPriorityFeePerGas: 10n }), false);
  assert.deepEqual(bumpedFees({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }), { maxFeePerGas: 110n, maxPriorityFeePerGas: 11n });
});

test('100 concurrent reservations for one (chain, signer) => unique, contiguous nonces', async () => {
  const al = new NonceAllocator(db.pool, { maxInflight: 1000 });
  const res = await Promise.all(Array.from({ length: 100 }, (_, i) => al.reserve('eip155:1', A, `intent-${i}`, 7n)));
  const nonces = res.map((r) => r.nonce).sort((a, b) => (a < b ? -1 : 1));
  assert.equal(new Set(nonces.map(String)).size, 100, 'no duplicates');
  for (let i = 0; i < 100; i++) assert.equal(nonces[i], 7n + BigInt(i), `contiguous at ${i}`);
  const dup = await db.pool.query(`select count(*)::int c from (select nonce from evm_nonce_reservations where chain_id='eip155:1' and signer=lower($1) group by nonce having count(*)>1) x`, [A]);
  assert.equal(dup.rows[0].c, 0);
  const st = await db.pool.query(`select next_nonce::text n from evm_nonce_state where chain_id='eip155:1' and signer=lower($1)`, [A]);
  assert.equal(st.rows[0].n, '107');
});

test('same intent is idempotent; separate chains and signers do not collide', async () => {
  const al = new NonceAllocator(db.pool);
  const a1 = await al.reserve('eip155:8453', B, 'x', 0n); const a2 = await al.reserve('eip155:8453', B, 'x', 0n);
  assert.equal(a1.id, a2.id); assert.equal(a1.nonce, 0n);
  const other = await al.reserve('eip155:10', B, 'x', 0n); assert.equal(other.nonce, 0n); assert.notEqual(other.id, a1.id);
  const sig2 = await al.reserve('eip155:8453', A, 'x', 0n); assert.equal(sig2.nonce, 0n);
});

test('chain nonce ahead of local state is adopted (external txs)', async () => {
  const al = new NonceAllocator(db.pool);
  const r1 = await al.reserve('eip155:56', A, 'a', 5n); assert.equal(r1.nonce, 5n);
  const r2 = await al.reserve('eip155:56', A, 'b', 20n); assert.equal(r2.nonce, 20n);
});

test('lifecycle: broadcast -> replace (>=10%) same nonce -> confirm with either hash; release only before broadcast', async () => {
  const al = new NonceAllocator(db.pool);
  const r = await al.reserve('eip155:42161', A, 'life', 0n);
  await assert.rejects(() => al.replace(r.id, '0xh2', { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }), (e: unknown) => e instanceof NonceError && e.code === 'bad_state');
  const b = await al.markBroadcast(r.id, '0xh1', { maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n });
  assert.equal(b.state, 'broadcast');
  await assert.rejects(() => al.release(r.id), (e: unknown) => e instanceof NonceError && e.code === 'bad_state');
  await assert.rejects(() => al.replace(r.id, '0xh2', { maxFeePerGas: 1099n, maxPriorityFeePerGas: 110n }), (e: unknown) => e instanceof NonceError && e.code === 'underpriced');
  await assert.rejects(() => al.replace(r.id, '0xh2', { maxFeePerGas: 2000n, maxPriorityFeePerGas: 109n }), (e: unknown) => e instanceof NonceError && e.code === 'underpriced');
  const rep = await al.replace(r.id, '0xh2', { maxFeePerGas: 1100n, maxPriorityFeePerGas: 110n });
  assert.equal(rep.nonce, r.nonce); assert.equal(rep.replacementCount, 1); assert.equal(rep.txHash, '0xh2');
  const conf = await al.confirm(r.id, '0xh1'); // the ORIGINAL hash may be the one that mined
  assert.equal(conf.state, 'confirmed'); assert.equal(conf.txHash, '0xh1');
  await assert.rejects(() => al.confirm(r.id, '0xnotanattempt'), /requires state|attempt/);
  const att = await db.pool.query(`select count(*)::int c from evm_nonce_attempts where reservation_id=$1`, [r.id]); assert.equal(att.rows[0].c, 2);
});

test('release of a never-broadcast nonce is reused first (contiguity) and respects chain floor', async () => {
  const al = new NonceAllocator(db.pool);
  const n0 = await al.reserve('eip155:137', A, 'g0', 0n), n1 = await al.reserve('eip155:137', A, 'g1', 0n), n2 = await al.reserve('eip155:137', A, 'g2', 0n);
  assert.deepEqual([n0.nonce, n1.nonce, n2.nonce], [0n, 1n, 2n]);
  await al.release(n1.id);
  const again = await al.reserve('eip155:137', A, 'g3', 0n); assert.equal(again.nonce, 1n, 'gap filled before next_nonce');
  const next = await al.reserve('eip155:137', A, 'g4', 0n); assert.equal(next.nonce, 3n);
  // chain advanced past nonce 0 and 1: reserved ones below the floor are released and NEVER reused
  await al.markBroadcast(n0.id, '0xa', { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
  const confirmed = await al.reconcile('eip155:137', A, 2n); assert.ok(confirmed >= 1);
  const after = await al.reserve('eip155:137', A, 'g5', 2n); assert.ok(after.nonce >= 2n);
  const rows = await db.pool.query(`select nonce::text, state from evm_nonce_reservations where chain_id='eip155:137' and signer=lower($1) and state<>'released' order by nonce`, [A]);
  const seen = new Set(rows.rows.map((r) => r.nonce)); assert.equal(seen.size, rows.rows.length);
});

test('in-flight limit enforced', async () => {
  const al = new NonceAllocator(db.pool, { maxInflight: 3 });
  for (let i = 0; i < 3; i++) await al.reserve('eip155:59144', A, `l${i}`, 0n);
  await assert.rejects(() => al.reserve('eip155:59144', A, 'l3', 0n), (e: unknown) => e instanceof NonceError && e.code === 'inflight_limit');
});

test('DB-level guarantee: duplicate active nonce cannot be inserted even bypassing the function', async () => {
  const al = new NonceAllocator(db.pool);
  const r = await al.reserve('eip155:324', A, 'raw', 0n);
  await assert.rejects(() => db.pool.query(`insert into evm_nonce_reservations(chain_id,signer,nonce,intent_id) values ('eip155:324',lower($1),$2,'sneaky')`, [A, r.nonce.toString()]), /evm_nonce_active_uq|duplicate/);
});
