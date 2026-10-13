import { z } from 'zod';
import type { RouteModule } from './ctx.ts';

/**
 * UI-capital routes: portfolio summary, baskets, wallet activity/fees, wallet lifecycle commands.
 * Reads run through ctx.read (RLS). Writes only call SECURITY DEFINER api_* functions (migration 0200) which check role + audit.
 */
export const capitalRoutes: RouteModule = ({ app, read, cmd, one, q, schemas }) => {
  const { uuid, ws } = schemas;
  const nf = (m = 'not found') => Object.assign(new Error(m), { statusCode: 404, code: 'not_found' });

  // Per-portfolio summary: bucket counts by declared and *effective* segregation, wallet/strategy counts, ledger totals per asset and state.
  app.get('/v1/portfolios/summary', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => {
    const portfolios = (await c.query(
      `select p.id, p.name, p.environment, p.created_at,
              (select count(*) from buckets b where b.portfolio_id=p.id)::int bucket_count,
              (select count(*) from buckets b where b.portfolio_id=p.id and b.segregation='physical')::int declared_physical,
              (select count(*) from buckets b where b.portfolio_id=p.id and b.segregation='logical')::int declared_logical,
              (select count(*) from buckets b where b.portfolio_id=p.id and b.segregation='protected')::int declared_protected,
              (select count(distinct a.wallet_id) from wallet_bucket_allocations a join buckets b on b.id=a.bucket_id where b.portfolio_id=p.id)::int wallet_count,
              (select count(*) from buckets b where b.portfolio_id=p.id and not exists (select 1 from wallet_bucket_allocations a where a.bucket_id=b.id))::int unassigned_buckets,
              (select count(*) from buckets b where b.portfolio_id=p.id and exists (select 1 from wallet_bucket_allocations a where a.bucket_id=b.id and not a.exclusive))::int shared_wallet_buckets,
              (select count(distinct (s.bucket_id, s.strategy_key)) from strategy_capital_budgets s join buckets b on b.id=s.bucket_id where b.portfolio_id=p.id)::int strategy_count
         from portfolios p where p.workspace_id=$1 order by p.created_at`, [workspace])).rows;
    const balances = (await c.query(
      `select b.portfolio_id, s.symbol, s.decimals, s.chain_id, a.state, sum(a.balance)::text amount
         from ledger_accounts a join buckets b on b.id=a.bucket_id join assets s on s.id=a.asset_id
        where b.workspace_id=$1 and a.state not in ('external','equity','fees_expense') and a.balance<>0 group by 1,2,3,4,5 order by 1,2,5`, [workspace])).rows;
    return { portfolios, balances,
      provenance: 'Counts and balances come from the authoritative ledger and allocation tables. No market-price valuation exists, so equity is shown per asset in base units, never as a fiat total.' };
  }); });

  // Baskets with members and the bucket's current ledger balances (for the units-based rebalancing preview).
  app.get('/v1/baskets', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => {
    const baskets = (await c.query(
      `select k.id, k.name, k.bucket_id, b.name bucket_name, b.portfolio_id, b.environment,
              coalesce((select jsonb_agg(jsonb_build_object('asset', m.asset_id, 'symbol', s.symbol, 'decimals', s.decimals, 'chain_id', s.chain_id, 'weight_bps', m.target_weight_bps) order by m.target_weight_bps desc)
                          from basket_members m join assets s on s.id=m.asset_id where m.basket_id=k.id), '[]') members
         from baskets k join buckets b on b.id=k.bucket_id where k.workspace_id=$1 order by k.name`, [workspace])).rows;
    const holdings = (await c.query(
      `select a.bucket_id, a.asset_id asset, s.symbol, s.decimals, sum(a.balance)::text amount
         from ledger_accounts a join assets s on s.id=a.asset_id
        where a.workspace_id=$1 and a.bucket_id is not null and a.state='available' and a.balance<>0 group by 1,2,3,4`, [workspace])).rows;
    return { baskets, holdings,
      note: 'Rebalancing previews use ledger units and target weights only. No market-price feed exists, so weights are compared by units (decimal-normalised), not by fiat value.' };
  }); });

  // All wallet chain accounts of a workspace (ids needed for deposits/allocations/destinations) with ledger balances per wallet-account.
  // Registered as a static path so it wins over /v1/wallets/:id.
  app.get('/v1/wallets/accounts', async (req) => { const { workspace } = q(ws, req); return read(req, async (c) => {
    const accounts = (await c.query(
      `select x.id, x.wallet_id, x.chain_id, r.name chain_name, r.native_symbol, w.nickname, w.family, w.address, w.capability, w.state
         from wallet_chain_accounts x join wallets w on w.id=x.wallet_id join chain_registry r on r.id=x.chain_id where w.workspace_id=$1 order by w.created_at, r.name`, [workspace])).rows;
    const balances = (await c.query(
      `select a.wallet_chain_account_id wca, a.bucket_id, a.environment, a.state, s.id asset, s.symbol, s.decimals, a.balance::text amount
         from ledger_accounts a join assets s on s.id=a.asset_id join wallet_chain_accounts x on x.id=a.wallet_chain_account_id join wallets w on w.id=x.wallet_id
        where w.workspace_id=$1 and a.balance<>0 and a.state not in ('external','equity','fees_expense')`, [workspace])).rows;
    return { accounts, balances, note: 'Balances are internal-ledger balances (paper or reconciled). On-chain balance verification is not available until a certified read adapter is connected.' };
  }); });

  const wallet = async (c: any, id: string) => { const w = (await c.query(`select * from wallets where id=$1`, [id])).rows[0]; if (!w) throw nf(); return w; };

  // Wallet activity: ledger entries touching this wallet's accounts + audit events about the wallet. Newest first.
  app.get('/v1/wallets/:id/activity', async (req) => { const { id } = z.object({ id: uuid }).parse(req.params); return read(req, async (c) => {
    await wallet(c, id);
    const entries = (await c.query(
      `select e.id, e.kind, e.environment, e.created_at, e.memo,
              jsonb_agg(jsonb_build_object('chain_id', s.chain_id, 'symbol', s.symbol, 'decimals', s.decimals, 'state', a.state, 'bucket_id', a.bucket_id, 'amount', p.amount::text) order by p.id) legs
         from ledger_entries e join ledger_postings p on p.entry_id=e.id join ledger_accounts a on a.id=p.account_id join assets s on s.id=a.asset_id
         join wallet_chain_accounts x on x.id=a.wallet_chain_account_id
        where x.wallet_id=$1 group by e.id order by e.created_at desc limit 100`, [id])).rows;
    const audit = (await c.query(
      `select id, actor, action, environment, detail, created_at from audit_events where entity='wallets' and entity_id=$1 order by id desc limit 100`, [id])).rows;
    return { entries, audit, note: 'Ledger activity only. Signed on-chain transaction history requires a certified read adapter and is not available yet.' };
  }); });

  // Wallet fees: fee reserves held and transfer fees paid by this wallet (ledger/transfer rows only).
  app.get('/v1/wallets/:id/fees', async (req) => { const { id } = z.object({ id: uuid }).parse(req.params); return read(req, async (c) => {
    await wallet(c, id);
    const reserves = (await c.query(
      `select x.chain_id, s.symbol, s.decimals, a.bucket_id, a.balance::text amount
         from ledger_accounts a join wallet_chain_accounts x on x.id=a.wallet_chain_account_id join assets s on s.id=a.asset_id
        where x.wallet_id=$1 and a.state='fee_reserve' order by 1,2`, [id])).rows;
    const transferFees = (await c.query(
      `select t.id, t.kind, t.status, t.fee_amount::text fee, s.symbol, s.decimals, t.created_at
         from internal_transfers t join assets s on s.id=t.asset_id join wallet_chain_accounts x on x.id=t.src_wca
        where x.wallet_id=$1 and t.fee_amount>0 order by t.created_at desc limit 50`, [id])).rows;
    return { reserves, transferFees, note: 'Fee reserve and transfer fees as recorded in the internal ledger. Live gas telemetry requires a certified chain adapter.' };
  }); });

  // Wallet obligations (what blocks revoke/archive/move) so the UI can explain refusals before they happen.
  app.get('/v1/wallets/:id/obligations', async (req) => { const { id } = z.object({ id: uuid }).parse(req.params); return read(req, async (c) => {
    await wallet(c, id);
    const o = (await c.query(`select wallet_open_obligations($1) o`, [id])).rows[0].o;
    return { obligations: o };
  }); });

  // Capital-flow waterfall executions for one bucket, with the quote asset resolved (the generic /v1/compounding rows carry no asset).
  app.get('/v1/buckets/:id/waterfall', async (req) => { const { id } = z.object({ id: uuid }).parse(req.params); return read(req, async (c) => {
    const b = (await c.query(`select id from buckets where id=$1`, [id])).rows[0]; if (!b) throw nf();
    const rows = (await c.query(
      `select x.id, x.created_at, x.policy_id, pol.version policy_version, s.symbol, s.decimals, x.gross::text gross, x.deficit_recovered::text deficit_recovered, x.eligible::text eligible,
              x.tax_provision::text tax_provision, x.to_reinvest::text to_reinvest, x.to_vault::text to_vault, x.to_cross::text to_cross, x.to_reserve::text to_reserve
         from waterfall_executions x join compounding_policies pol on pol.id=x.policy_id join profit_eligibility_events e on e.id=x.profit_event_id join assets s on s.id=e.quote_asset
        where pol.bucket_id=$1 order by x.created_at desc limit 50`, [id])).rows;
    return { executions: rows, note: 'Only realised, reconciled profit enters the waterfall. Nothing here is a projection.' };
  }); });

  const reason = z.string().min(3).max(300);
  const setState = (name: string, st: string) => cmd(name, z.object({ wallet: uuid, reason }).strict(),
    async (c, b) => ({ state: (await one(c, `select api_set_wallet_state($1,$2,$3) s`, [b.wallet, st, b.reason])).s }));
  setState('pauseWallet', 'paused'); setState('resumeWallet', 'active'); setState('archiveWallet', 'archived'); setState('revokeWallet', 'revoked');
  cmd('moveWalletBucket', z.object({ wallet: uuid, fromBucket: uuid, toBucket: uuid, exclusive: z.boolean().default(true), maxAllocationBps: z.number().int().min(1).max(10000).default(10000), logicalAck: z.boolean().default(false) }).strict(),
    async (c, b) => { await c.query(`select api_move_wallet_bucket($1,$2,$3,$4,$5,$6)`, [b.wallet, b.fromBucket, b.toBucket, b.exclusive, b.maxAllocationBps, b.logicalAck]); return {}; });
};
