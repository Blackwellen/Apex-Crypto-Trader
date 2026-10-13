#![allow(dead_code)]
//! Test harness: a fresh Postgres database per test (auth shim + ALL migrations), a seeded paper world, and helpers.
use apex_execution::db::Db;
use apex_execution::dispatcher::*;
use apex_execution::economics::EconomicsConfig;
use apex_execution::paper::{PaperConfig, PaperVenue};
use apex_execution::venue::Tif;
use apex_risk::{DataHealth, Side};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use tokio_postgres::NoTls;
use uuid::Uuid;

pub const ADMIN_URL: &str = "postgres://postgres@localhost:54329/postgres";
static N: AtomicU32 = AtomicU32::new(0);

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap()
}

pub struct TestDb {
    pub name: String,
    pub url: String,
}

impl TestDb {
    pub async fn new() -> TestDb {
        let admin_url = std::env::var("ADMIN_DATABASE_URL").unwrap_or_else(|_| ADMIN_URL.to_string());
        let name = format!("apex_rs_{}_{}_{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst), Uuid::new_v4().simple().to_string()[..6].to_string());
        let (c, conn) = tokio_postgres::connect(&admin_url, NoTls).await.expect("admin connect (is Postgres on :54329 up?)");
        tokio::spawn(conn);
        c.batch_execute(&format!("drop database if exists {name}")).await.unwrap();
        c.batch_execute(&format!("create database {name}")).await.unwrap();
        let url = admin_url.rsplit_once('/').unwrap().0.to_string() + "/" + &name;
        let root = repo_root();
        let st = Command::new("psql")
            .args([&url, "-q", "-v", "ON_ERROR_STOP=1", "-f"])
            .arg(root.join("infra/local/auth_shim.sql"))
            .output()
            .expect("psql");
        assert!(st.status.success(), "auth shim failed: {}", String::from_utf8_lossy(&st.stderr));
        let st = Command::new(root.join("packages/db/migrate.sh")).env("DATABASE_URL", &url).output().expect("migrate.sh");
        assert!(st.status.success(), "migrations failed: {}", String::from_utf8_lossy(&st.stderr));
        TestDb { name, url }
    }
    pub async fn client(&self) -> tokio_postgres::Client {
        let (c, conn) = tokio_postgres::connect(&self.url, NoTls).await.unwrap();
        tokio::spawn(conn);
        c
    }
    pub fn db(&self, pool: usize) -> Db {
        Db::connect(&self.url, pool).unwrap()
    }
}
impl Drop for TestDb {
    fn drop(&mut self) {
        let admin_url = std::env::var("ADMIN_DATABASE_URL").unwrap_or_else(|_| ADMIN_URL.to_string());
        let _ = Command::new("psql").args([&admin_url, "-q", "-c", &format!("drop database if exists {} with (force)", self.name)]).output();
    }
}

#[derive(Clone)]
pub struct World {
    pub ws: Uuid,
    pub bucket: Uuid,
    pub wca: Uuid,
    pub eth: Uuid,
    pub usdc: Uuid,
    pub funds: u128,
}

/// workspace + paper portfolio + trading bucket + wallet (watch-only, paper), funded and allocated with `funds` USDC base units.
pub async fn seed_world(t: &TestDb, funds: u128) -> World {
    let c = t.client().await;
    let owner = Uuid::new_v4();
    c.batch_execute("begin; select set_config('apex.service','on',true)").await.unwrap();
    c.execute("insert into auth.users(id,email) values ($1,$2)", &[&owner, &format!("{owner}@t.test")]).await.unwrap();
    c.batch_execute(
        "insert into chain_registry(id,namespace,chain_ref,family,name,native_symbol,native_decimals,finality_model,address_format) \
         values ('eip155:1','eip155','1','evm','Ethereum','ETH',18,'probabilistic','0x-hex20') on conflict do nothing; \
         insert into assets(chain_id,contract,symbol,decimals) values ('eip155:1','native','ETH',18),('eip155:1','0xusdc','USDC',6) on conflict do nothing",
    )
    .await
    .unwrap();
    let eth: Uuid = c.query_one("select id from assets where chain_id='eip155:1' and symbol='ETH'", &[]).await.unwrap().get(0);
    let usdc: Uuid = c.query_one("select id from assets where chain_id='eip155:1' and symbol='USDC'", &[]).await.unwrap().get(0);
    c.batch_execute("commit").await.unwrap();

    c.batch_execute("begin; set local role authenticated").await.unwrap();
    c.execute("select set_config('request.jwt.claim.sub', $1, true)", &[&owner.to_string()]).await.unwrap();
    let ws: Uuid = c.query_one("select api_create_workspace('Test WS')", &[]).await.unwrap().get(0);
    let pf: Uuid = c.query_one("select api_create_portfolio($1,'Core','paper')", &[&ws]).await.unwrap().get(0);
    let bucket: Uuid = c.query_one("select api_create_bucket($1,'Trading','trading','physical','{}')", &[&pf]).await.unwrap().get(0);
    let wallet: Uuid = c
        .query_one("select api_connect_wallet($1,'W1','evm','0x9a4Fc2bC7897dd21305B92C0e5cb86DFFc984362','watch_only',array['eip155:1'])", &[&ws])
        .await
        .unwrap()
        .get(0);
    c.execute("select api_assign_wallet($1,$2,true,10000,false)", &[&wallet, &bucket]).await.unwrap();
    let wca: Uuid = c.query_one("select id from wallet_chain_accounts where wallet_id=$1", &[&wallet]).await.unwrap().get(0);
    c.execute("select api_paper_deposit($1,$2,$3,$4::text::numeric,'dep1')", &[&ws, &wca, &usdc, &funds.to_string()]).await.unwrap();
    c.execute("select api_allocate($1,$2,$3,$4::text::numeric,'alloc1')", &[&ws, &bucket, &wca, &usdc, &funds.to_string()]).await.unwrap();
    c.batch_execute("commit").await.unwrap();
    World { ws, bucket, wca, eth, usdc, funds }
}

pub async fn set_global_limits(t: &TestDb, ws: Uuid, limits: serde_json::Value) {
    let c = t.client().await;
    c.execute("update workspace_settings set global_limits=$2 where workspace_id=$1", &[&ws, &limits]).await.unwrap();
}

pub async fn set_global_state(t: &TestDb, ws: Uuid, st: &str) {
    let c = t.client().await;
    c.batch_execute("begin; select set_config('apex.service','on',true)").await.unwrap();
    c.execute("select set_global_state($1,$2,'test')", &[&ws, &st]).await.unwrap();
    c.batch_execute("commit").await.unwrap();
}

pub fn healthy_market() -> MarketSnapshot {
    MarketSnapshot {
        slippage_bps: 10,
        quote_age_ms: 100,
        data_health: DataHealth::Healthy,
        expected_edge_bps: 200,
        entry_fee_bps: 25,
        exit_fee_bps: 25,
        exit_slippage_bps: 10,
        gas_entry_quote: 0,
        gas_exit_quote: 0,
        failed_tx_prob_bps: 0,
        failed_tx_cost_quote: 0,
        adverse_selection_bps: 10,
        failed_tx_rate_bps: 0,
    }
}

pub fn spec(w: &World, key: &str, side: Side, lots: u128, price: u128, tif: Tif) -> IntentSpec {
    IntentSpec {
        workspace: w.ws,
        environment: "paper".into(),
        bucket: w.bucket,
        strategy_key: "test-strategy".into(),
        wca: w.wca,
        base_asset: w.eth,
        quote_asset: w.usdc,
        side,
        quantity: lots * 1_000_000_000_000_000,
        limit_price: price,
        idempotency_key: key.into(),
        venue: "paper".into(),
        ctx: IntentContext {
            asset_key: "ETH".into(),
            tif,
            base_decimals: 18,
            max_fee_bps: 25,
            market: healthy_market(),
            layers: vec![],
            econ: EconomicsConfig::default(),
        },
    }
}

pub fn new_venue(seed: u64, keep_lines: bool) -> Arc<PaperVenue> {
    Arc::new(PaperVenue::new(PaperConfig { seed, keep_log_lines: keep_lines, ..Default::default() }))
}

/// marketable buy price: 20 ticks through the best ask (IOC fills at maker prices, never worse than this)
pub fn marketable_buy_px(v: &PaperVenue) -> u128 {
    v.with_exchange(|e| e.best_ask().unwrap() + 20 * e.cfg.tick)
}
pub fn marketable_sell_px(v: &PaperVenue) -> u128 {
    v.with_exchange(|e| e.best_bid().unwrap() - 20 * e.cfg.tick)
}

pub async fn sum_text(c: &tokio_postgres::Client, sql: &str, params: &[&(dyn tokio_postgres::types::ToSql + Sync)]) -> i128 {
    c.query_one(sql, params).await.unwrap().get::<_, String>(0).parse().unwrap()
}

/// Conservation: per asset, sum of ALL ledger balances == 0; no negative balance on a non-contra account.
pub async fn assert_conserved(c: &tokio_postgres::Client, ws: Uuid) {
    let rows = c.query("select asset_id, sum(balance)::text from ledger_accounts where workspace_id=$1 group by asset_id", &[&ws]).await.unwrap();
    for r in rows {
        assert_eq!(r.get::<_, String>(1), "0", "conservation violated for asset {}", r.get::<_, Uuid>(0));
    }
    let n: i64 = c
        .query_one("select count(*) from ledger_accounts where workspace_id=$1 and state not in ('external','equity','fees_expense') and balance < 0", &[&ws])
        .await
        .unwrap()
        .get(0);
    assert_eq!(n, 0, "negative balance on a non-contra account");
}

pub async fn bal(c: &tokio_postgres::Client, ws: Uuid, asset: Uuid, state: &str) -> i128 {
    sum_text(c, "select coalesce(sum(balance),0)::text from ledger_accounts where workspace_id=$1 and asset_id=$2 and state=$3::text::account_state", &[&ws, &asset, &state]).await
}

pub async fn state_of(c: &tokio_postgres::Client, id: Uuid) -> String {
    c.query_one("select state from trade_intents where id=$1", &[&id]).await.unwrap().get(0)
}

/// Drive an intent to an end, advancing venue time while it waits; cancels after `rounds` waits.
pub async fn run_to_end(d: &Dispatcher, v: &PaperVenue, id: Uuid, rounds: u32) -> Outcome {
    let mut waited = 0;
    loop {
        let r = d.drive(id, DriveOpts { cancel_if_open: waited >= rounds, ..Default::default() }).await.unwrap();
        match r.outcome {
            Outcome::Waiting(_) => {
                use apex_execution::venue::Venue;
                v.advance(7).await;
                waited += 1;
            }
            o => return o,
        }
    }
}
