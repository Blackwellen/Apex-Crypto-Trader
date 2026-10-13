import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres@localhost:54329/postgres';

/** Creates a fresh database, applies auth shim + ALL migrations. Returns connection helpers. */
export async function freshDb(name = 'apex_t_' + Math.random().toString(36).slice(2, 8)) {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = ADMIN_URL.replace(/\/[^/]*$/, '/' + name);
  execFileSync('psql', [url, '-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(here, '../../../infra/local/auth_shim.sql')], { stdio: 'pipe' });
  execFileSync(path.join(here, '../migrate.sh'), [], { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
  const pool = new pg.Pool({ connectionString: url, max: 120 });
  return {
    url, name, pool,
    /** run fn in a transaction as an authenticated end user (RLS applies, role = authenticated) */
    async asUser(userId, fn) {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query('set local role authenticated');
        await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
        const r = await fn(c);
        await c.query('commit');
        return r;
      } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
    },
    /** engine/service context (superuser stand-in for the privileged service role) */
    async asService(fn) {
      const c = await pool.connect();
      try { await c.query('begin'); await c.query(`select set_config('apex.service','on',true)`); const r = await fn(c); await c.query('commit'); return r; }
      catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
    },
    async close() { await pool.end(); const a = new pg.Client({ connectionString: ADMIN_URL }); await a.connect(); await a.query(`drop database if exists ${name} with (force)`); await a.end(); },
  };
}

export const uid = () => randomUUID();

/** Build a standard paper world: workspace(owner), portfolio, trading bucket, EVM wallet+chain account, asset, funded + allocated. */
export async function seedWorld(db, { funds = 1000n, owner = uid() } = {}) {
  const w = {};
  w.owner = owner;
  await db.asService(async (c) => {
    await c.query(`insert into auth.users(id,email) values ($1,$2)`, [owner, owner + '@t.test']);
    await c.query(`insert into chain_registry(id,namespace,chain_ref,family,name,native_symbol,native_decimals,finality_model,address_format)
      values ('eip155:1','eip155','1','evm','Ethereum','ETH',18,'probabilistic','0x-hex20') on conflict do nothing`);
    const a = await c.query(`insert into assets(chain_id,contract,symbol,decimals) values ('eip155:1','native','ETH',18),('eip155:1','0xusdc','USDC',6) on conflict do nothing returning id,symbol`);
    const all = await c.query(`select id,symbol from assets where chain_id='eip155:1'`);
    w.ETH = all.rows.find((r) => r.symbol === 'ETH').id; w.USDC = all.rows.find((r) => r.symbol === 'USDC').id;
  });
  await db.asUser(owner, async (c) => {
    w.ws = (await c.query(`select api_create_workspace('Test WS') id`)).rows[0].id;
    w.pf = (await c.query(`select api_create_portfolio($1,'Core','paper') id`, [w.ws])).rows[0].id;
    w.bucket = (await c.query(`select api_create_bucket($1,'Trading','trading','physical','{}') id`, [w.pf])).rows[0].id;
    w.vault = (await c.query(`select api_create_bucket($1,'Vault','protected_vault','protected','{}') id`, [w.pf])).rows[0].id;
    w.wallet = (await c.query(`select api_connect_wallet($1,'W1','evm','0x9a4Fc2bC7897dd21305B92C0e5cb86DFFc984362','watch_only',array['eip155:1']) id`, [w.ws])).rows[0].id;
    w.wallet2 = (await c.query(`select api_connect_wallet($1,'W2','evm','0x44f9830d8f779C62ba1C3B98ecbB17C260A69aC4','watch_only',array['eip155:1']) id`, [w.ws])).rows[0].id;
    await c.query(`select api_assign_wallet($1,$2,true,10000,false)`, [w.wallet, w.bucket]);
    await c.query(`select api_assign_wallet($1,$2,true,10000,false)`, [w.wallet2, w.vault]);
    w.wca = (await c.query(`select id from wallet_chain_accounts where wallet_id=$1`, [w.wallet])).rows[0].id;
    w.wca2 = (await c.query(`select id from wallet_chain_accounts where wallet_id=$1`, [w.wallet2])).rows[0].id;
    await c.query(`select api_paper_deposit($1,$2,$3,$4,'dep1')`, [w.ws, w.wca, w.USDC, funds.toString()]);
    await c.query(`select api_allocate($1,$2,$3,$4,$5,'alloc1')`, [w.ws, w.bucket, w.wca, w.USDC, funds.toString()]);
  });
  return w;
}

export async function balance(c, ws, bucket, wca, asset, state) {
  const r = await c.query(
    `select coalesce(sum(balance),0)::text b from ledger_accounts where workspace_id=$1 and asset_id=$4 and state=$5
       and ($2::uuid is null or bucket_id=$2) and ($3::uuid is null or wallet_chain_account_id=$3)`, [ws, bucket, wca, asset, state]);
  return BigInt(r.rows[0].b);
}
/** Global conservation check: for each asset in env, sum of ALL ledger balances (incl. contra) is exactly zero. */
export async function assertConserved(c, ws) {
  const r = await c.query(`select asset_id, sum(balance)::text s from ledger_accounts where workspace_id=$1 group by asset_id`, [ws]);
  for (const row of r.rows) if (BigInt(row.s) !== 0n) throw new Error(`conservation violated for asset ${row.asset_id}: ${row.s}`);
  const n = await c.query(`select count(*)::int n from ledger_accounts where workspace_id=$1 and state not in ('external','equity','fees_expense') and balance < 0`, [ws]);
  if (n.rows[0].n) throw new Error('negative balance on non-contra account');
}
