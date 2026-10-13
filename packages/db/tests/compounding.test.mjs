import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seedWorld, balance, assertConserved, uid } from './helpers.mjs';

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.close(); });

async function profitableTrade(w, { buyQuote = 1000n, sellQuote = 1500n } = {}) {
  const mk = async (side, qty, notional) => db.asService(async (c) => (await c.query(
    `insert into trade_intents(workspace_id,environment,bucket_id,strategy_key,wallet_chain_account_id,base_asset,quote_asset,side,quantity,notional,idempotency_key)
     values ($1,'paper',$2,'trend',$3,$4,$5,$6,$7,$8,$9) returning id`, [w.ws, w.bucket, w.wca, w.ETH, w.USDC, side, qty, notional, uid()])).rows[0].id);
  const adv = (id, to) => db.asService((c) => c.query(`select advance_intent($1,$2,$2)`, [id, to]));
  async function run(id, resAsset, resAmt) {
    await adv(id, 'CANDIDATE'); await adv(id, 'RISK_EVALUATING');
    await db.asService((c) => c.query(`insert into risk_decisions(intent_id,workspace_id,decision,policy_version) values ($1,$2,'ADMIT',1)`, [id, w.ws]));
    await adv(id, 'ADMITTED');
    const rid = await db.asService(async (c) => (await c.query(`select reserve_capital($1,'paper',$2,$3,$4,$5,$6) id`, [w.ws, w.bucket, w.wca, resAsset, resAmt.toString(), 'r' + id])).rows[0].id);
    await db.asService((c) => c.query(`update trade_intents set reservation_id=$2 where id=$1`, [id, rid]));
    for (const s of ['CAPITAL_RESERVED', 'QUOTED', 'PREPARED', 'SUBMITTING', 'ACKNOWLEDGED']) await adv(id, s);
  }
  const b = await mk('buy', '10', buyQuote.toString()); await run(b, w.USDC, buyQuote);
  await db.asService((c) => c.query(`select apply_fill($1,'b',10,$2,0)`, [b, buyQuote.toString()]));
  const s = await mk('sell', '10', '10'); await run(s, w.ETH, 10n);
  await db.asService((c) => c.query(`select apply_fill($1,'s',10,$2,0)`, [s, sellQuote.toString()]));
  return s;
}
async function mkPolicy(w, v, { rv, vt, cx = 0, rs, tax = 0, crossB = null, crossW = null }) {
  return db.asService(async (c) => (await c.query(
    `insert into compounding_policies(workspace_id,bucket_id,version,reinvest_bps,vault_bps,cross_bucket_bps,reserve_bps,tax_provision_bps,vault_bucket_id,vault_wca,cross_bucket_id,cross_wca)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
    [w.ws, w.bucket, v, rv, vt, cx, rs, tax, vt ? w.vault : null, vt ? w.wca2 : null, crossB, crossW])).rows[0].id);
}
const evFor = (intent) => db.asService(async (c) => (await c.query(`select id from profit_eligibility_events where intent_id=$1`, [intent])).rows[0].id);

test('waterfall policy must total exactly 100% (DB constraint)', async () => {
  const w = await seedWorld(db);
  await assert.rejects(mkPolicy(w, 1, { rv: 4000, vt: 3500, rs: 2000 }), /waterfall_sums_to_100/);
  await mkPolicy(w, 1, { rv: 4000, vt: 3500, rs: 2500 });
});

test('policies are immutable versions', async () => {
  const w = await seedWorld(db); const p = await mkPolicy(w, 1, { rv: 10000, vt: 0, rs: 0 });
  await assert.rejects(db.asService((c) => c.query(`update compounding_policies set reinvest_bps=0 where id=$1`, [p])), /append-only/);
});

test('P0 profit sweep: unreconciled profit is rejected; eligible profit splits exactly and is applied once', async () => {
  const w = await seedWorld(db, { funds: 5000n });
  const intent = await profitableTrade(w, { buyQuote: 1000n, sellQuote: 1500n }); // net +500
  const pol = await mkPolicy(w, 1, { rv: 4000, vt: 3500, rs: 2500, tax: 1000 });
  const ev = await evFor(intent);
  await assert.rejects(db.asService((c) => c.query(`select apply_waterfall($1,$2)`, [ev, pol])), /not eligible: intent in state ACKNOWLEDGED|needs RECONCILED/);
  // settle and reconcile, then apply
  for (const s of ['FILLED', 'SETTLING', 'FINAL', 'RECONCILED']) await db.asService((c) => c.query(`select advance_intent($1,$2,$2)`, [intent, s]));
  const xs = await Promise.all(Array.from({ length: 10 }, () => db.asService(async (c) => (await c.query(`select apply_waterfall($1,$2) id`, [ev, pol])).rows[0].id).catch((e) => e.message)));
  const ok = xs.filter((x) => /^[0-9a-f-]{36}$/.test(x));
  assert.equal(new Set(ok).size, 1, 'all successful concurrent applications resolve to one execution: ' + JSON.stringify(xs));
  await db.asService(async (c) => {
    const e = (await c.query(`select * from waterfall_executions where profit_event_id=$1`, [ev])).rows;
    assert.equal(e.length, 1);
    const x = e[0];
    assert.equal(BigInt(x.gross), 500n);
    assert.equal(BigInt(x.tax_provision), 50n);                 // 10% of 500
    assert.equal(BigInt(x.to_vault), 157n);                      // 35% of 450 = 157.5 -> 157 (floor)
    assert.equal(BigInt(x.to_reserve), 112n);                    // 25% of 450 = 112.5 -> 112
    assert.equal(BigInt(x.to_reinvest), 450n - 157n - 112n);     // remainder stays in bucket
    assert.equal(BigInt(x.tax_provision) + BigInt(x.to_reinvest) + BigInt(x.to_vault) + BigInt(x.to_cross) + BigInt(x.to_reserve), BigInt(x.eligible));
    // vault share is a PENDING physical transfer (different wallet): not yet credited to the vault bucket
    assert.equal(await balance(c, w.ws, w.vault, w.wca2, w.USDC, 'available'), 0n);
    assert.equal(await balance(c, w.ws, w.bucket, w.wca, w.USDC, 'pending_out'), 157n);
    assert.equal(await balance(c, w.ws, w.bucket, w.wca, w.USDC, 'restricted'), 50n);
    assert.equal(await balance(c, w.ws, w.bucket, w.wca, w.USDC, 'fee_reserve'), 112n);
    await assertConserved(c, w.ws);
  });
});

test('losses create a deficit that is recovered before any profit is distributed', async () => {
  const w = await seedWorld(db, { funds: 5000n });
  const lossIntent = await profitableTrade(w, { buyQuote: 1000n, sellQuote: 700n }); // -300
  const lossEv = await evFor(lossIntent);
  await db.asService((c) => c.query(`select record_realized_result($1)`, [lossEv]));
  const win = await profitableTrade(w, { buyQuote: 1000n, sellQuote: 1400n }); // +400
  for (const i of [win]) for (const s of ['FILLED', 'SETTLING', 'FINAL', 'RECONCILED']) await db.asService((c) => c.query(`select advance_intent($1,$2,$2)`, [i, s]));
  const pol = await mkPolicy(w, 1, { rv: 10000, vt: 0, rs: 0 });
  const x = await db.asService(async (c) => { const id = (await c.query(`select apply_waterfall($1,$2) id`, [await evFor(win), pol])).rows[0].id; return (await c.query(`select * from waterfall_executions where id=$1`, [id])).rows[0]; });
  assert.equal(BigInt(x.deficit_recovered), 300n);
  assert.equal(BigInt(x.eligible), 100n);
});

test('high-water mark only ever ratchets upward', async () => {
  const w = await seedWorld(db);
  const q = (v) => db.asService(async (c) => (await c.query(`select update_high_water_mark($1,$2) h`, [w.bucket, v])).rows[0].h);
  assert.equal(await q(100), '100'); assert.equal(await q(80), '100'); assert.equal(await q(130), '130');
});

test('targets are monitoring-only and can never be forced to trade', async () => {
  const w = await seedWorld(db);
  await assert.rejects(db.asService((c) => c.query(`insert into target_plans(workspace_id,bucket_id,period,target_amount,monitoring_only) values ($1,$2,'month',100,false)`, [w.ws, w.bucket])), /monitoring_only/);
});
