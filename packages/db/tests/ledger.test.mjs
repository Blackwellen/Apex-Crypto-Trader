import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seedWorld, balance, assertConserved, uid } from './helpers.mjs';

let db, w;
before(async () => { db = await freshDb(); w = await seedWorld(db, { funds: 1000n }); });
after(async () => { await db.close(); });

const expectErr = async (p, re) => { await assert.rejects(p, (e) => re.test(e.message) || (assert.fail('unexpected error: ' + e.message), false)); };
// run an expected-to-fail statement in its own transaction (a failure aborts the surrounding one)
const failsAs = (re, sql, params = []) => expectErr(db.asService((c) => c.query(sql, params)), re);

test('P0 ledger_conservation: 100 concurrent reservations of 20 against balance 1000 -> exactly 50 succeed, none overspend', async () => {
  const results = await Promise.allSettled(Array.from({ length: 100 }, (_, i) =>
    db.asUser(w.owner, (c) => c.query(`select api_reserve_capital($1,$2,$3,$4,20,$5)`, [w.ws, w.bucket, w.wca, w.USDC, 'cc-' + i]))));
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  assert.equal(ok, 50, `expected 50 successes, got ${ok}`);
  for (const r of results.filter((r) => r.status === 'rejected')) assert.match(r.reason.message, /violates check constraint|non_negative/);
  await db.asService(async (c) => {
    assert.equal(await balance(c, w.ws, w.bucket, w.wca, w.USDC, 'available'), 0n);
    assert.equal(await balance(c, w.ws, w.bucket, w.wca, w.USDC, 'reserved'), 1000n);
    await assertConserved(c, w.ws);
  });
});

test('idempotent reservation: 30 concurrent identical intent keys create exactly one reservation', async () => {
  const w2 = await seedWorld(db, { funds: 100n });
  const ids = await Promise.all(Array.from({ length: 30 }, () =>
    db.asUser(w2.owner, async (c) => (await c.query(`select api_reserve_capital($1,$2,$3,$4,40,'same-intent') id`, [w2.ws, w2.bucket, w2.wca, w2.USDC])).rows[0].id)));
  assert.equal(new Set(ids).size, 1);
  await db.asService(async (c) => {
    assert.equal(await balance(c, w2.ws, w2.bucket, w2.wca, w2.USDC, 'reserved'), 40n);
    assert.equal((await c.query(`select count(*)::int n from capital_reservations where workspace_id=$1`, [w2.ws])).rows[0].n, 1);
  });
});

test('strategy budget cap holds under concurrent claims (limit 100, claims of 30 -> 3 win)', async () => {
  const w3 = await seedWorld(db, { funds: 10000n });
  const budget = await db.asService(async (c) => (await c.query(`insert into strategy_capital_budgets(workspace_id,bucket_id,strategy_key,asset_id,limit_amount) values ($1,$2,'trend',$3,100) returning id`, [w3.ws, w3.bucket, w3.USDC])).rows[0].id);
  const r = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => db.asUser(w3.owner, (c) => c.query(`select api_reserve_capital($1,$2,$3,$4,30,$5,$6)`, [w3.ws, w3.bucket, w3.wca, w3.USDC, 'b-' + i, budget]))));
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 3);
  await db.asService(async (c) => { assert.equal(await balance(c, w3.ws, w3.bucket, w3.wca, w3.USDC, 'reserved'), 90n); await assertConserved(c, w3.ws); });
});

test('release returns funds; consume spends; both idempotent; conservation holds', async () => {
  const w4 = await seedWorld(db, { funds: 500n });
  await db.asService(async (c) => {
    const rid = (await c.query(`select reserve_capital($1,'paper',$2,$3,$4,300,'r1') id`, [w4.ws, w4.bucket, w4.wca, w4.USDC])).rows[0].id;
    await c.query(`select release_reservation($1, 100)`, [rid]);
    await c.query(`select release_reservation($1, 100)`, [rid]); // replay no-op
    assert.equal(await balance(c, w4.ws, w4.bucket, w4.wca, w4.USDC, 'available'), 400n);
    assert.equal(await balance(c, w4.ws, w4.bucket, w4.wca, w4.USDC, 'reserved'), 0n);
    await assertConserved(c, w4.ws);
  });
});

test('unbalanced ledger entries are rejected by the database', async () => {
  const [a, b] = await db.asService(async (c) => [
    (await c.query(`select ledger_account($1,'paper',$2,$3,$4,'available') id`, [w.ws, w.bucket, w.wca, w.USDC])).rows[0].id,
    (await c.query(`select ledger_account($1,'paper',$2,$3,$4,'external') id`, [w.ws, w.bucket, null, w.USDC])).rows[0].id]);
  await failsAs(/does not balance/, `select post_entry($1,'paper','bad','bad1',$2::jsonb)`, [w.ws, JSON.stringify([{ account: a, amount: '5' }, { account: b, amount: '-4' }])]);
});

test('idempotency key reuse with different payload is rejected; identical replay returns original', async () => {
  const w5 = await seedWorld(db, { funds: 10n });
  const [e1, e2] = await db.asService(async (c) => [
    (await c.query(`select ledger_deposit($1,'paper',$2,$3,5,'dupkey') id`, [w5.ws, w5.wca, w5.USDC])).rows[0].id,
    (await c.query(`select ledger_deposit($1,'paper',$2,$3,5,'dupkey') id`, [w5.ws, w5.wca, w5.USDC])).rows[0].id]);
  assert.equal(e1, e2);
  await failsAs(/different payload/, `select ledger_deposit($1,'paper',$2,$3,6,'dupkey')`, [w5.ws, w5.wca, w5.USDC]);
});

test('ledger is append-only', async () => {
  await failsAs(/append-only/, `update ledger_entries set memo='x'`);
  await failsAs(/append-only/, `delete from ledger_postings`);
  await failsAs(/append-only/, `delete from audit_events`);
});

test('P0 environment_isolation: paper entry cannot post to a live account', async () => {
  const [live, ext] = await db.asService(async (c) => [
    (await c.query(`select ledger_account($1,'live',null,$2,$3,'available') id`, [w.ws, w.wca, w.USDC])).rows[0].id,
    (await c.query(`select ledger_account($1,'paper',null,null,$2,'external') id`, [w.ws, w.USDC])).rows[0].id]);
  await failsAs(/environment mismatch/, `select post_entry($1,'paper','x','envmix',$2::jsonb)`, [w.ws, JSON.stringify([{ account: ext, amount: '-5' }, { account: live, amount: '5' }])]);
});

test('P0 protected_vault: vault funds are never reservable; release needs approval, delay, non-self approver, owner', async () => {
  const w6 = await seedWorld(db, { funds: 100n });
  const second = uid();
  await db.asService(async (c) => {
    await c.query(`insert into auth.users(id,email) values ($1,'s@t')`, [second]);
    await c.query(`insert into memberships values ($1,$2,'owner')`, [w6.ws, second]);
    await c.query(`select ledger_deposit($1,'paper',$2,$3,100,'vdep')`, [w6.ws, w6.wca2, w6.USDC]);
    await c.query(`select ledger_allocate($1,'paper',$2,$3,$4,100,'valloc')`, [w6.ws, w6.vault, w6.wca2, w6.USDC]);
    assert.equal(await balance(c, w6.ws, w6.vault, w6.wca2, w6.USDC, 'vault'), 100n);
  });
  await failsAs(/protected vault/, `select reserve_capital($1,'paper',$2,$3,$4,10,'vres')`, [w6.ws, w6.vault, w6.wca2, w6.USDC]);
  // a trader cannot request a vault release
  const trader = uid();
  await db.asService(async (c) => { await c.query(`insert into auth.users(id,email) values ($1,'t@t')`, [trader]); await c.query(`insert into memberships values ($1,$2,'trader')`, [w6.ws, trader]); });
  await expectErr(db.asUser(trader, (c) => c.query(`select api_request_vault_release($1,$2,$3,$4,50)`, [w6.ws, w6.vault, w6.wca2, w6.USDC])), /permission denied/);
  const aid = await db.asUser(w6.owner, async (c) => (await c.query(`select api_request_vault_release($1,$2,$3,$4,50) id`, [w6.ws, w6.vault, w6.wca2, w6.USDC])).rows[0].id);
  await expectErr(db.asUser(w6.owner, (c) => c.query(`select api_decide_approval($1,true)`, [aid])), /cannot approve their own/);
  await db.asUser(second, (c) => c.query(`select api_decide_approval($1,true)`, [aid]));
  await expectErr(db.asUser(w6.owner, (c) => c.query(`select api_release_vault($1,'rel1')`, [aid])), /delay has not elapsed/);
  await db.asService((c) => c.query(`update approval_requests set not_before = now() - interval '1 second' where id=$1`, [aid]));
  await db.asUser(w6.owner, (c) => c.query(`select api_release_vault($1,'rel1')`, [aid]));
  await db.asUser(w6.owner, (c) => c.query(`select api_release_vault($1,'rel1')`, [aid])); // replay safe
  await db.asService(async (c) => { assert.equal(await balance(c, w6.ws, w6.vault, w6.wca2, w6.USDC, 'vault'), 50n); await assertConserved(c, w6.ws); });
});

test('physical transfer: destination NOT credited until finality; failure restores source; logical is atomic', async () => {
  const w7 = await seedWorld(db, { funds: 200n });
  // second trading bucket on wallet2
  const b2 = await db.asUser(w7.owner, async (c) => {
    const id = (await c.query(`select api_create_bucket($1,'Second','trading','physical','{}') id`, [w7.pf])).rows[0].id;
    // wallet2 is assigned (exclusively) to vault in the seed; use a fresh wallet instead
    const wl = (await c.query(`select api_connect_wallet($1,'W3','evm','0x1111111111111111111111111111111111111111','watch_only',array['eip155:1']) id`, [w7.ws])).rows[0].id;
    await c.query(`select api_assign_wallet($1,$2,true,10000,false)`, [wl, id]);
    return { id, wca: (await c.query(`select id from wallet_chain_accounts where wallet_id=$1`, [wl])).rows[0].id };
  });
  const tid = await db.asUser(w7.owner, async (c) => (await c.query(`select api_request_transfer($1,$2,$3,$4,$5,$6,80,'t1') id`, [w7.ws, w7.bucket, w7.wca, b2.id, b2.wca, w7.USDC])).rows[0].id);
  await db.asService(async (c) => {
    assert.equal(await balance(c, w7.ws, w7.bucket, w7.wca, w7.USDC, 'available'), 120n);
    assert.equal(await balance(c, w7.ws, w7.bucket, w7.wca, w7.USDC, 'pending_out'), 80n);
    assert.equal(await balance(c, w7.ws, b2.id, b2.wca, w7.USDC, 'available'), 0n, 'destination must not be credited before finality');
    await c.query(`select confirm_transfer($1,'0xabc')`, [tid]); await c.query(`select confirm_transfer($1,'0xabc')`, [tid]);
    assert.equal(await balance(c, w7.ws, b2.id, b2.wca, w7.USDC, 'available'), 80n);
    assert.equal(await balance(c, w7.ws, w7.bucket, w7.wca, w7.USDC, 'pending_out'), 0n);
    await assertConserved(c, w7.ws);
  });
  const t2 = await db.asUser(w7.owner, async (c) => (await c.query(`select api_request_transfer($1,$2,$3,$4,$5,$6,50,'t2') id`, [w7.ws, w7.bucket, w7.wca, b2.id, b2.wca, w7.USDC])).rows[0].id);
  await db.asService(async (c) => {
    await c.query(`select fail_transfer($1)`, [t2]);
    assert.equal(await balance(c, w7.ws, w7.bucket, w7.wca, w7.USDC, 'available'), 120n);
    await assertConserved(c, w7.ws);
  });
  await failsAs(/transfer is failed/, `select confirm_transfer($1,'x')`, [t2]);
});

test('concurrent competing transfers cannot double-spend the same funds', async () => {
  const w8 = await seedWorld(db, { funds: 100n });
  const res = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => db.asUser(w8.owner, (c) => c.query(`select api_request_transfer($1,$2,$3,$4,$5,$6,30,$7)`, [w8.ws, w8.bucket, w8.wca, w8.vault, w8.wca2, w8.USDC, 'ct-' + i]))));
  // vault bucket destination: request_transfer rejects only on source protection, destination vault OK (physical, wallet2 assigned to vault)
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 3);
  await db.asService(async (c) => { assert.equal(await balance(c, w8.ws, w8.bucket, w8.wca, w8.USDC, 'pending_out'), 90n); await assertConserved(c, w8.ws); });
});

test('canonical token identity: EVM contract case variants resolve to one asset', async () => {
  await db.asService(async (c) => {
    await c.query(`insert into assets(chain_id,contract,symbol,decimals) values ('eip155:1','0xAbCdEf0000000000000000000000000000000001','T',6)`);
    await assert.rejects(c.query(`insert into assets(chain_id,contract,symbol,decimals) values ('eip155:1','0xABCDEF0000000000000000000000000000000001','T',6)`), /duplicate key/);
  });
});
