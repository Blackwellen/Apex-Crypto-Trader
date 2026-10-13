import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seedWorld, balance, assertConserved, uid } from './helpers.mjs';

let db;
before(async () => { db = await freshDb(); });
after(async () => { await db.close(); });
const failsAs = async (re, fn) => assert.rejects(db.asService(fn), (e) => re.test(e.message) || assert.fail('unexpected: ' + e.message));

async function newIntent(w, { side = 'buy', key = uid(), notional = 100n, qty = 10n } = {}) {
  return db.asService(async (c) => (await c.query(
    `insert into trade_intents(workspace_id,environment,bucket_id,strategy_key,wallet_chain_account_id,base_asset,quote_asset,side,quantity,notional,idempotency_key)
     values ($1,'paper',$2,'trend',$3,$4,$5,$6,$7,$8,$9) returning id`, [w.ws, w.bucket, w.wca, w.ETH, w.USDC, side, qty.toString(), notional.toString(), key])).rows[0].id);
}
const adv = (id, to, key = to) => db.asService((c) => c.query(`select advance_intent($1,$2,$3)`, [id, to, key]));
async function driveToAck(w, id, reserve = 100n) {
  await adv(id, 'CANDIDATE'); await adv(id, 'RISK_EVALUATING');
  await db.asService((c) => c.query(`insert into risk_decisions(intent_id,workspace_id,decision,policy_version) values ($1,$2,'ADMIT',1)`, [id, w.ws]));
  await adv(id, 'ADMITTED');
  const rid = await db.asService(async (c) => (await c.query(`select reserve_capital($1,'paper',$2,$3,$4,$5,$6) id`, [w.ws, w.bucket, w.wca, w.USDC, reserve.toString(), 'res-' + id])).rows[0].id);
  await db.asService((c) => c.query(`update trade_intents set reservation_id=$2 where id=$1`, [id, rid]));
  await adv(id, 'CAPITAL_RESERVED'); await adv(id, 'QUOTED'); await adv(id, 'PREPARED'); await adv(id, 'SUBMITTING'); await adv(id, 'ACKNOWLEDGED');
}

test('state machine: illegal transitions rejected; duplicate event delivery is a no-op', async () => {
  const w = await seedWorld(db);
  const id = await newIntent(w);
  await failsAs(/illegal transition SIGNAL -> FILLED/, (c) => c.query(`select advance_intent($1,'FILLED','x')`, [id]));
  await adv(id, 'CANDIDATE', 'e1'); await adv(id, 'CANDIDATE', 'e1'); // replay of the same event
  const n = await db.asService(async (c) => (await c.query(`select count(*)::int n from order_events where intent_id=$1`, [id])).rows[0].n);
  assert.equal(n, 1);
});

test('P0 portfolio_risk_veto: ADMITTED impossible without ADMIT; a VETO cannot be overridden by a later ADMIT', async () => {
  const w = await seedWorld(db);
  const id = await newIntent(w);
  await adv(id, 'CANDIDATE'); await adv(id, 'RISK_EVALUATING');
  await failsAs(/risk gate: no ADMIT/, (c) => c.query(`select advance_intent($1,'ADMITTED','a')`, [id]));
  await db.asService((c) => c.query(`insert into risk_decisions(intent_id,workspace_id,decision,reasons,policy_version) values ($1,$2,'VETO','["stale quote"]',1)`, [id, w.ws]));
  await db.asService((c) => c.query(`insert into risk_decisions(intent_id,workspace_id,decision,policy_version) values ($1,$2,'ADMIT',1)`, [id, w.ws]));
  await failsAs(/risk gate/, (c) => c.query(`select advance_intent($1,'ADMITTED','b')`, [id]));
});

test('P0 emergency_stop: halted workspace refuses new entries but settlement/exit transitions still work', async () => {
  const w = await seedWorld(db);
  const id = await newIntent(w);
  await adv(id, 'CANDIDATE'); await adv(id, 'RISK_EVALUATING');
  await db.asService((c) => c.query(`insert into risk_decisions(intent_id,workspace_id,decision,policy_version) values ($1,$2,'ADMIT',1)`, [id, w.ws]));
  await db.asUser(w.owner, (c) => c.query(`select api_set_global_state($1,'emergency_stopped','test')`, [w.ws]));
  await failsAs(/refuses new entries/, (c) => c.query(`select advance_intent($1,'ADMITTED','z')`, [id]));
  // an in-flight, already-acknowledged order can still fill and settle during the halt
  await db.asUser(w.owner, (c) => c.query(`select api_set_global_state($1,'active','resume')`, [w.ws]));
  const id2 = await newIntent(w);
  await driveToAck(w, id2);
  await db.asUser(w.owner, (c) => c.query(`select api_set_global_state($1,'emergency_stopped','again')`, [w.ws]));
  await db.asService((c) => c.query(`select apply_fill($1,'f1',10,100,0)`, [id2]));
  await adv(id2, 'FILLED'); await adv(id2, 'SETTLING'); await adv(id2, 'FINAL');
});

test('P0 exchange_unknown_outcomes: UNKNOWN can never go back to SUBMITTING (no blind retry)', async () => {
  const w = await seedWorld(db);
  const id = await newIntent(w);
  await driveToAck(w, id);
  // simulate a different order whose submit timed out
  const id2 = await newIntent(w);
  await adv(id2, 'CANDIDATE'); await adv(id2, 'RISK_EVALUATING');
  await db.asService((c) => c.query(`insert into risk_decisions(intent_id,workspace_id,decision,policy_version) values ($1,$2,'ADMIT',1)`, [id2, w.ws]));
  await adv(id2, 'ADMITTED');
  const rid = await db.asService(async (c) => (await c.query(`select reserve_capital($1,'paper',$2,$3,$4,50,'u2') id`, [w.ws, w.bucket, w.wca, w.USDC])).rows[0].id);
  await db.asService((c) => c.query(`update trade_intents set reservation_id=$2 where id=$1`, [id2, rid]));
  for (const s of ['CAPITAL_RESERVED', 'QUOTED', 'PREPARED', 'SUBMITTING', 'UNKNOWN']) await adv(id2, s);
  await failsAs(/illegal transition UNKNOWN -> SUBMITTING/, (c) => c.query(`select advance_intent($1,'SUBMITTING','retry')`, [id2]));
  await adv(id2, 'ACKNOWLEDGED', 'reconciled');   // resolved only via reconciliation
});

test('P0 duplicate_trade_prevention: 50 concurrent deliveries of the same exchange fill => exactly one economic fill', async () => {
  const w = await seedWorld(db, { funds: 1000n });
  const id = await newIntent(w, { qty: 10n, notional: 100n });
  await driveToAck(w, id, 101n);
  const r = await Promise.allSettled(Array.from({ length: 50 }, () => db.asService((c) => c.query(`select apply_fill($1,'venue-fill-1',10,100,1)`, [id]))));
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 50, JSON.stringify(r.filter((x) => x.status === 'rejected').map((x) => x.reason.message)));
  await db.asService(async (c) => {
    assert.equal((await c.query(`select count(*)::int n from fills where intent_id=$1`, [id])).rows[0].n, 1);
    assert.equal(await balance(c, w.ws, w.bucket, w.wca, w.ETH, 'available'), 10n);
    assert.equal(await balance(c, w.ws, w.bucket, w.wca, w.USDC, 'reserved'), 0n); // 101 reserved, 100+1fee consumed once
    await assertConserved(c, w.ws);
  });
});

test('buy then sell: position average cost, realised PnL and fees conserve value', async () => {
  const w = await seedWorld(db, { funds: 10000n });
  const b = await newIntent(w, { qty: 10n, notional: 1000n }); await driveToAck(w, b, 1010n);
  await db.asService((c) => c.query(`select apply_fill($1,'b1',10,1000,10)`, [b]));
  // sell 5 @ 700 total with fee 7: reserve the base asset first
  const s = await newIntent(w, { side: 'sell', qty: 5n, notional: 5n });
  await adv(s, 'CANDIDATE'); await adv(s, 'RISK_EVALUATING');
  await db.asService((c) => c.query(`insert into risk_decisions(intent_id,workspace_id,decision,policy_version) values ($1,$2,'ADMIT',1)`, [s, w.ws]));
  await adv(s, 'ADMITTED');
  const rid = await db.asService(async (c) => (await c.query(`select reserve_capital($1,'paper',$2,$3,$4,5,'sres') id`, [w.ws, w.bucket, w.wca, w.ETH])).rows[0].id);
  await db.asService((c) => c.query(`update trade_intents set reservation_id=$2 where id=$1`, [s, rid]));
  for (const st of ['CAPITAL_RESERVED', 'QUOTED', 'PREPARED', 'SUBMITTING', 'ACKNOWLEDGED']) await adv(s, st);
  await db.asService((c) => c.query(`select apply_fill($1,'s1',5,700,7)`, [s]));
  await db.asService(async (c) => {
    const p = (await c.query(`select qty::text, cost_basis_quote::text, realized_pnl_quote::text from positions where bucket_id=$1`, [w.bucket])).rows[0];
    assert.equal(p.qty, '5'); assert.equal(p.cost_basis_quote, '505'); // (1000+10)/2
    assert.equal(p.realized_pnl_quote, String(700 - 7 - 505));
    await assertConserved(c, w.ws);
  });
});

test('P0 environment_isolation + live gate: live portfolio/intents impossible unless every gate PASS + opt-in + flag', async () => {
  const w = await seedWorld(db);
  await assert.rejects(db.asUser(w.owner, (c) => c.query(`select api_create_portfolio($1,'LiveP','live')`, [w.ws])), /live portfolios require/);
  // even service-level insertion of a live intent is refused by the DB guard
  await assert.rejects(db.asService((c) => c.query(
    `insert into trade_intents(workspace_id,environment,bucket_id,strategy_key,wallet_chain_account_id,base_asset,quote_asset,side,quantity,notional,idempotency_key)
     values ($1,'live',$2,'x',$3,$4,$5,'buy',1,1,'live1')`, [w.ws, w.bucket, w.wca, w.ETH, w.USDC])), /LIVE EXECUTION DISABLED/);
  // opt-in + flag alone are insufficient while gates are NOT_RUN
  await db.asUser(w.owner, (c) => c.query(`select api_set_live_opt_in($1,true)`, [w.ws]));
  await db.asService((c) => c.query(`update workspace_settings set live_feature_flag=true where workspace_id=$1`, [w.ws]));
  assert.equal(await db.asService(async (c) => (await c.query(`select live_allowed($1) a`, [w.ws])).rows[0].a), false);
  // a PASS without evidence is rejected by constraint
  await assert.rejects(db.asUser(w.owner, (c) => c.query(`select api_set_gate($1,'ledger_conservation','PASS',null,null)`, [w.ws])), /pass_needs_evidence|evidence reference is required/);
});

test('live ledger mutations are refused for end users (reconciler-only)', async () => {
  const w = await seedWorld(db);
  await db.asService((c) => c.query(`insert into portfolios(workspace_id,name,environment) values ($1,'LP','live')`, [w.ws]));
  const lb = await db.asService(async (c) => (await c.query(`insert into buckets(workspace_id,portfolio_id,environment,name) select $1,id,'live','LB' from portfolios where name='LP' and workspace_id=$1 returning id`, [w.ws])).rows[0].id);
  await db.asService((c) => c.query(`insert into wallet_bucket_allocations(wallet_id,bucket_id) values ($1,$2)`, [w.wallet2, lb]).catch(() => {}));
  await assert.rejects(db.asUser(w.owner, (c) => c.query(`select api_allocate($1,$2,$3,$4,1,'livealloc')`, [w.ws, lb, w.wca, w.USDC])), /restricted to the reconciliation service|exclusive allocation|not assigned/);
});
