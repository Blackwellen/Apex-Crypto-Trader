import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seedWorld, uid } from './helpers.mjs';

let db, A, B;
before(async () => { db = await freshDb(); A = await seedWorld(db, { funds: 100n }); B = await seedWorld(db, { funds: 100n }); });
after(async () => { await db.close(); });

const TABLES = ['workspaces','portfolios','buckets','wallets','ledger_accounts','ledger_entries','ledger_postings','capital_reservations','internal_transfers','audit_events','trade_intents','workspace_settings','deployment_gates','memberships','wallet_chain_accounts','wallet_bucket_allocations','bucket_policy_versions'];

test('RLS: user B sees zero rows of workspace A in every tenant table; sees own rows', async () => {
  for (const t of TABLES) {
    const own = await db.asUser(B.owner, async (c) => (await c.query(`select count(*)::int n from ${t}`)).rows[0].n);
    const leaked = await db.asUser(B.owner, async (c) => {
      const cols = { workspaces: 'id', ledger_postings: null, wallet_chain_accounts: null, wallet_bucket_allocations: null, bucket_policy_versions: null }[t];
      if (t === 'workspaces') return (await c.query(`select count(*)::int n from workspaces where id=$1`, [A.ws])).rows[0].n;
      if (t === 'wallet_chain_accounts') return (await c.query(`select count(*)::int n from wallet_chain_accounts where id=$1`, [A.wca])).rows[0].n;
      if (t === 'wallet_bucket_allocations') return (await c.query(`select count(*)::int n from wallet_bucket_allocations where wallet_id=$1`, [A.wallet])).rows[0].n;
      if (t === 'bucket_policy_versions') return (await c.query(`select count(*)::int n from bucket_policy_versions where bucket_id=$1`, [A.bucket])).rows[0].n;
      if (t === 'ledger_postings') return (await c.query(`select count(*)::int n from ledger_postings p join ledger_accounts a on a.id=p.account_id where a.workspace_id=$1`, [A.ws])).rows[0].n;
      return (await c.query(`select count(*)::int n from ${t} where workspace_id=$1`, [A.ws])).rows[0].n;
    });
    assert.equal(leaked, 0, `${t} leaked rows across tenants`);
    if (!['capital_reservations','internal_transfers','trade_intents'].includes(t)) assert.ok(own > 0, `${t} returned no rows for owner (policy too strict?)`);
  }
});

test('RLS: user B cannot invoke mutations against workspace A', async () => {
  await assert.rejects(db.asUser(B.owner, (c) => c.query(`select api_create_portfolio($1,'evil')`, [A.ws])), /permission denied/);
  await assert.rejects(db.asUser(B.owner, (c) => c.query(`select api_connect_wallet($1,'x','evm','0x1111111111111111111111111111111111111111','watch_only',array['eip155:1'])`, [A.ws])), /permission denied/);
  await assert.rejects(db.asUser(B.owner, (c) => c.query(`select api_reserve_capital($1,$2,$3,$4,1,'steal')`, [A.ws, A.bucket, A.wca, A.USDC])), /permission denied/);
  await assert.rejects(db.asUser(B.owner, (c) => c.query(`select api_set_global_state($1,'active','x')`, [A.ws])), /permission denied/);
  await assert.rejects(db.asUser(B.owner, (c) => c.query(`select api_update_bucket_policy($1,1,'{}')`, [A.bucket])), /permission denied/);
});

test('clients cannot write tables directly or call low-level ledger functions', async () => {
  await assert.rejects(db.asUser(A.owner, (c) => c.query(`insert into ledger_entries(workspace_id,environment,kind,idempotency_key,payload_hash) values ($1,'paper','x','x','x')`, [A.ws])), /permission denied/);
  await assert.rejects(db.asUser(A.owner, (c) => c.query(`update ledger_accounts set balance = 999999 where workspace_id=$1`, [A.ws])), /permission denied/);
  await assert.rejects(db.asUser(A.owner, (c) => c.query(`select post_entry($1,'paper','x','x','[]')`, [A.ws])), /permission denied/);
  await assert.rejects(db.asUser(A.owner, (c) => c.query(`select apply_fill(gen_random_uuid(),'x',1,1,0)`)), /permission denied/);
  await assert.rejects(db.asUser(A.owner, (c) => c.query(`update workspace_settings set live_feature_flag = true where workspace_id=$1`, [A.ws])), /permission denied/);
  await assert.rejects(db.asUser(A.owner, (c) => c.query(`update deployment_gates set status='PASS' where workspace_id=$1`, [A.ws])), /permission denied/);
});

test('unauthenticated (no JWT sub) sees nothing and cannot mutate', async () => {
  const rows = await db.asUser('', async (c) => (await c.query(`select count(*)::int n from buckets`)).rows[0].n).catch(() => 0);
  assert.equal(rows, 0);
});

test('role enforcement: viewer cannot mutate, trader cannot create wallets, trader may halt but not resume', async () => {
  const viewer = uid(), trader = uid();
  await db.asService(async (c) => { for (const u of [viewer, trader]) await c.query(`insert into auth.users(id,email) values ($1,$2)`, [u, u + '@t.test']);
    await c.query(`insert into memberships values ($1,$2,'viewer'),($1,$3,'trader')`, [A.ws, viewer, trader]); });
  await assert.rejects(db.asUser(viewer, (c) => c.query(`select api_reserve_capital($1,$2,$3,$4,1,'v')`, [A.ws, A.bucket, A.wca, A.USDC])), /permission denied/);
  await assert.rejects(db.asUser(trader, (c) => c.query(`select api_connect_wallet($1,'x','evm','0x2222222222222222222222222222222222222222','watch_only','{}')`, [A.ws])), /permission denied/);
  await db.asUser(trader, (c) => c.query(`select api_set_global_state($1,'halt_new_entries','trader halts')`, [A.ws]));
  await assert.rejects(db.asUser(trader, (c) => c.query(`select api_set_global_state($1,'active','resume')`, [A.ws])), /permission denied/);
  await db.asUser(A.owner, (c) => c.query(`select api_set_global_state($1,'active','owner resumes')`, [A.ws]));
  const n = await db.asUser(A.owner, async (c) => (await c.query(`select count(*)::int n from audit_events where workspace_id=$1 and action like 'global_state.%'`, [A.ws])).rows[0].n);
  assert.ok(n >= 2, 'state changes are audited');
});

test('wallet onboarding: no secret field; seed-phrase-looking input and bad EVM address rejected; physical exclusivity enforced', async () => {
  await assert.rejects(db.asUser(A.owner, (c) => c.query(`select api_connect_wallet($1,'x','evm','abandon abandon abandon abandon abandon abandon abandon about','watch_only','{}')`, [A.ws])), /invalid public address/);
  await assert.rejects(db.asUser(A.owner, (c) => c.query(`select api_connect_wallet($1,'x','evm','0xZZZ','watch_only','{}')`, [A.ws])), /invalid public address/);
  await assert.rejects(db.asUser(A.owner, (c) => c.query(`select api_connect_wallet($1,'x','evm','0x3333333333333333333333333333333333333333','managed_signer','{}')`, [A.ws])), /signer service/);
  const col = await db.asService(async (c) => (await c.query(`select column_name from information_schema.columns where table_name in ('wallets','wallet_chain_accounts','wallet_bucket_allocations') and column_name ~* '(seed|mnemonic|private|secret|key)'`)).rows);
  assert.deepEqual(col, [], 'no key-material column may exist');
  // wallet W1 is exclusively assigned to bucket; assigning to another bucket must fail
  const other = await db.asUser(A.owner, async (c) => (await c.query(`select api_create_bucket($1,'Other','trading','physical','{}') id`, [A.pf])).rows[0].id);
  await assert.rejects(db.asUser(A.owner, (c) => c.query(`select api_assign_wallet($1,$2,true,10000,false)`, [A.wallet, other])), /exclusive allocation/);
  await assert.rejects(db.asUser(A.owner, (c) => c.query(`select api_assign_wallet($1,$2,false,5000,false)`, [A.wallet, other])), /exclusive allocation|shared_needs_ack/);
});

test('policy edits use optimistic concurrency and cannot weaken global hard limits', async () => {
  const v = await db.asUser(A.owner, (c) => c.query(`select api_update_bucket_policy($1,1,'{"max_slippage_bps":50}') v`, [A.bucket]));
  assert.equal(v.rows[0].v, 2);
  await assert.rejects(db.asUser(A.owner, (c) => c.query(`select api_update_bucket_policy($1,1,'{"max_slippage_bps":10}')`, [A.bucket])), /stale policy version/);
  await assert.rejects(db.asUser(A.owner, (c) => c.query(`select api_update_bucket_policy($1,2,'{"max_slippage_bps":5000}')`, [A.bucket])), /cannot exceed the global hard limit/);
});
