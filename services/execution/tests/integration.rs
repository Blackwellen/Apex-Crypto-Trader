mod common;
use apex_execution::dispatcher::*;
use apex_execution::paper::Fault;
use apex_execution::state::{OrderState, ALLOWED, ALL_STATES};
use apex_execution::venue::*;
use apex_execution::ExecError;
use apex_risk::Side;
use common::*;
use std::collections::BTreeSet;
use std::sync::Arc;
use uuid::Uuid;

fn mt() {}

// ------------------------------------------------------------------ (3a) state table == SQL

fn parse_sql_transitions(sql: &str) -> BTreeSet<(String, String)> {
    let start = sql.find("insert into allowed_transitions values").expect("insert statement present");
    let rest = &sql[start..];
    let end = rest.find(';').expect("statement end");
    let body = &rest[..end];
    // strip line comments
    let body: String = body.lines().map(|l| l.split("--").next().unwrap()).collect::<Vec<_>>().join("\n");
    let mut out = BTreeSet::new();
    let mut i = 0;
    let b = body.as_bytes();
    while i < b.len() {
        if b[i] == b'(' {
            let j = body[i..].find(')').unwrap() + i;
            let parts: Vec<String> = body[i + 1..j].split(',').map(|p| p.trim().trim_matches('\'').to_string()).collect();
            assert_eq!(parts.len(), 2, "bad pair {:?}", parts);
            out.insert((parts[0].clone(), parts[1].clone()));
            i = j;
        }
        i += 1;
    }
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn state_machine_table_equals_migration_0003_and_live_db() {
    mt();
    let sql = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/db/migrations/0003_trading.sql")).unwrap();
    let from_sql = parse_sql_transitions(&sql);
    let from_rust: BTreeSet<(String, String)> = ALLOWED.iter().map(|(a, b)| (a.as_str().to_string(), b.as_str().to_string())).collect();
    assert_eq!(from_sql.len(), 44, "expected 44 transitions in the migration");
    assert_eq!(from_rust, from_sql, "Rust ALLOWED != migration 0003 allowed_transitions");

    // and against a freshly migrated database (all migrations applied, incl. any later additions)
    let t = TestDb::new().await;
    let c = t.client().await;
    let rows = c.query("select from_state, to_state from allowed_transitions", &[]).await.unwrap();
    let from_db: BTreeSet<(String, String)> = rows.iter().map(|r| (r.get(0), r.get(1))).collect();
    assert_eq!(from_rust, from_db, "Rust ALLOWED != allowed_transitions in a fresh DB");

    // every state name round-trips and appears in the table; every non-listed pair is rejected by the typed API
    for s in ALL_STATES {
        assert_eq!(OrderState::parse(s.as_str()), Some(s));
    }
    let names: BTreeSet<&str> = ALL_STATES.iter().map(|s| s.as_str()).collect();
    for (a, b) in &from_db {
        assert!(names.contains(a.as_str()) && names.contains(b.as_str()));
    }
    let mut illegal = 0;
    for a in ALL_STATES {
        for b in ALL_STATES {
            let listed = from_db.contains(&(a.as_str().to_string(), b.as_str().to_string()));
            assert_eq!(a.can_transition_to(b), listed);
            assert_eq!(a.transition(b).is_ok(), listed);
            if !listed {
                illegal += 1;
            }
        }
    }
    assert_eq!(illegal, 23 * 23 - 44);
    assert!(!OrderState::Unknown.can_transition_to(OrderState::Submitting), "UNKNOWN -> SUBMITTING must never be legal");
}

// ------------------------------------------------------------------ happy path

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn buy_then_sell_flow_end_to_end_ledger_exact() {
    let t = TestDb::new().await;
    let w = seed_world(&t, 1_000_000_000).await; // 1000 USDC
    let v = new_venue(7, false);
    let d = Dispatcher::new(t.db(8), v.clone());
    let c = t.client().await;

    let px = marketable_buy_px(&v);
    let buy = d.create_intent(&spec(&w, "buy-1", Side::Buy, 20, px, Tif::Ioc)).await.unwrap();
    // idempotent creation
    assert_eq!(d.create_intent(&spec(&w, "buy-1", Side::Buy, 20, px, Tif::Ioc)).await.unwrap(), buy);
    assert_eq!(run_to_end(&d, &v, buy, 3).await, Outcome::Terminal(OrderState::Filled));

    let fills = c.query("select qty::text, quote_amount::text, fee_quote::text from fills where intent_id=$1 order by venue_fill_id", &[&buy]).await.unwrap();
    assert!(!fills.is_empty());
    let (mut q, mut quote, mut fee) = (0u128, 0u128, 0u128);
    for f in &fills {
        q += f.get::<_, String>(0).parse::<u128>().unwrap();
        quote += f.get::<_, String>(1).parse::<u128>().unwrap();
        fee += f.get::<_, String>(2).parse::<u128>().unwrap();
    }
    assert_eq!(q, 20 * 1_000_000_000_000_000);
    // exact ledger: available = funds - quote - fee ; reserved = 0 ; ETH available = q ; fees_expense = fee
    assert_eq!(bal(&c, w.ws, w.usdc, "available").await, 1_000_000_000 - (quote + fee) as i128);
    assert_eq!(bal(&c, w.ws, w.usdc, "reserved").await, 0);
    assert_eq!(bal(&c, w.ws, w.eth, "available").await, q as i128);
    assert_eq!(bal(&c, w.ws, w.usdc, "fees_expense").await, fee as i128);
    let res: String = c.query_one("select r.status from capital_reservations r join trade_intents t on t.reservation_id=r.id where t.id=$1", &[&buy]).await.unwrap().get(0);
    assert_eq!(res, "consumed");
    let pos: (String, String) = {
        let r = c.query_one("select qty::text, cost_basis_quote::text from positions where bucket_id=$1", &[&w.bucket]).await.unwrap();
        (r.get(0), r.get(1))
    };
    assert_eq!(pos.0.parse::<u128>().unwrap(), q);
    assert_eq!(pos.1.parse::<u128>().unwrap(), quote + fee);
    assert_conserved(&c, w.ws).await;

    // state trail is exactly the spec path
    let trail: Vec<String> = c.query("select to_state from order_events where intent_id=$1 order by id", &[&buy]).await.unwrap().iter().map(|r| r.get(0)).collect();
    assert_eq!(&trail[..9], ["CANDIDATE", "RISK_EVALUATING", "ADMITTED", "CAPITAL_RESERVED", "QUOTED", "PREPARED", "SUBMITTING", "ACKNOWLEDGED", trail[8].as_str()]);
    assert_eq!(trail.last().unwrap(), "FILLED");
    let rd: String = c.query_one("select decision from risk_decisions where intent_id=$1", &[&buy]).await.unwrap().get(0);
    assert_eq!(rd, "ADMIT");

    // sell half back (exit): realised PnL booked through apply_fill
    let spx = marketable_sell_px(&v);
    let sell = d.create_intent(&spec(&w, "sell-1", Side::Sell, 10, spx, Tif::Ioc)).await.unwrap();
    assert_eq!(run_to_end(&d, &v, sell, 3).await, Outcome::Terminal(OrderState::Filled));
    assert_eq!(bal(&c, w.ws, w.eth, "available").await, (q - 10 * 1_000_000_000_000_000) as i128);
    assert_eq!(bal(&c, w.ws, w.eth, "reserved").await, 0);
    assert_conserved(&c, w.ws).await;
    let pe: i64 = c.query_one("select count(*) from profit_eligibility_events where intent_id=$1", &[&sell]).await.unwrap().get(0);
    assert_eq!(pe, 1);
}

// ------------------------------------------------------------------ risk veto can't be relaxed

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn risk_veto_is_final_and_enforced_in_sql() {
    let t = TestDb::new().await;
    let w = seed_world(&t, 1_000_000_000).await;
    let v = new_venue(1, false);
    let d = Dispatcher::new(t.db(4), v.clone());
    let c = t.client().await;
    let px = marketable_buy_px(&v);
    let mut s = spec(&w, "stale-1", Side::Buy, 10, px, Tif::Ioc);
    s.ctx.market.quote_age_ms = 5_000; // stale
    let id = d.create_intent(&s).await.unwrap();
    assert_eq!(d.drive(id, DriveOpts::default()).await.unwrap().outcome, Outcome::Terminal(OrderState::Failed));
    let r = c.query_one("select decision, reasons::text from risk_decisions where intent_id=$1", &[&id]).await.unwrap();
    assert_eq!(r.get::<_, String>(0), "VETO");
    assert!(r.get::<_, String>(1).contains("QUOTE_STALE"));
    // no reservation, no fills, nothing submitted
    let n: i64 = c.query_one("select count(*) from capital_reservations", &[]).await.unwrap().get(0);
    assert_eq!(n, 0);
    assert_eq!(v.total_submit_calls(), 0);

    // an actor who now inserts an ADMIT row (e.g. a compromised strategy/LLM) still cannot advance: VETO present.
    c.batch_execute("begin; select set_config('apex.service','on',true)").await.unwrap();
    c.execute("insert into risk_decisions(intent_id, workspace_id, decision, policy_version, evaluator) values ($1,$2,'ADMIT',1,'attacker')", &[&id, &w.ws]).await.unwrap();
    c.batch_execute("commit").await.unwrap();
    // our own recorder is sticky: a later ADMIT is never inserted over a VETO
    let rec = {
        let tx = t.db(1).begin().await.unwrap();
        let rr = apex_risk::db::record_decision(tx.c(), id, w.ws, &apex_risk::Decision::Admit { exit_path: false }, 1, "x").await.unwrap();
        tx.rollback().await;
        rr
    };
    assert_eq!(rec.decision, "VETO");
    assert!(!rec.inserted);

    // direct SQL attempt on a fresh intent: ADMITTED without any ADMIT row is refused
    let id2 = d.create_intent(&spec(&w, "noadmit", Side::Buy, 10, px, Tif::Ioc)).await.unwrap();
    d.drive(id2, DriveOpts { stop_at: Some(OrderState::RiskEvaluating), ..Default::default() }).await.unwrap();
    let e = c.query_one("select advance_intent($1,'ADMITTED','forced')", &[&id2]).await.unwrap_err();
    assert!(e.as_db_error().unwrap().message().contains("risk gate"), "{e}");
    assert_conserved(&c, w.ws).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn each_degraded_input_denies_entry() {
    let t = TestDb::new().await;
    let w = seed_world(&t, 1_000_000_000).await;
    let v = new_venue(1, false);
    let d = Dispatcher::new(t.db(4), v.clone());
    let c = t.client().await;
    let px = marketable_buy_px(&v);
    let cases: Vec<(&str, Box<dyn Fn(&mut IntentSpec)>, &str)> = vec![
        ("degraded", Box::new(|s| s.ctx.market.data_health = apex_risk::DataHealth::Degraded), "DATA_DEGRADED"),
        ("slip", Box::new(|s| s.ctx.market.slippage_bps = 500), "SLIPPAGE_TOO_HIGH"),
        ("fee", Box::new(|s| { s.ctx.market.entry_fee_bps = 80; s.ctx.market.exit_fee_bps = 80; }), "FEE_CEILING_EXCEEDED"),
        ("failed_tx", Box::new(|s| s.ctx.market.failed_tx_rate_bps = 5_000), "FAILED_TX_RATE_TOO_HIGH"),
        ("big", Box::new(|s| s.quantity = 400 * 1_000_000_000_000_000), "ORDER_TOO_LARGE"), // ~800 USDC > 25% of 1000
        ("blacklist", Box::new(|s| s.ctx.layers = vec![(apex_risk::Level::Strategy, apex_risk::PolicyLayer { blacklist: Some(["ETH".to_string()].into()), ..Default::default() })]), "ASSET_BLACKLISTED"),
    ];
    for (name, f, code) in cases {
        let mut s = spec(&w, name, Side::Buy, 10, px, Tif::Ioc);
        f(&mut s);
        let id = d.create_intent(&s).await.unwrap();
        let r = d.drive(id, DriveOpts::default()).await.unwrap();
        assert_eq!(r.outcome, Outcome::Terminal(OrderState::Failed), "{name}");
        let reasons: String = c.query_one("select reasons::text from risk_decisions where intent_id=$1", &[&id]).await.unwrap().get(0);
        assert!(reasons.contains(code), "{name}: expected {code} in {reasons}");
    }
    assert_eq!(v.total_submit_calls(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unprofitable_quote_rejected_with_reasons_and_funds_released() {
    let t = TestDb::new().await;
    let w = seed_world(&t, 1_000_000_000).await;
    let v = new_venue(3, false);
    let d = Dispatcher::new(t.db(4), v.clone());
    let c = t.client().await;
    let px = marketable_buy_px(&v);
    let mut s = spec(&w, "unprofitable", Side::Buy, 10, px, Tif::Ioc);
    // edge 100 - fees 50 - slippage 10+10 - adverse 40 = -10 bps  (passes the risk fee-share bar: 50/100 <= 50%)
    s.ctx.market.expected_edge_bps = 100;
    s.ctx.market.adverse_selection_bps = 40;
    let id = d.create_intent(&s).await.unwrap();
    assert_eq!(d.drive(id, DriveOpts::default()).await.unwrap().outcome, Outcome::Terminal(OrderState::Failed));
    let ev = c.query_one("select detail::text from order_events where intent_id=$1 and to_state='FAILED'", &[&id]).await.unwrap().get::<_, String>(0);
    assert!(ev.contains("unprofitable_quote") && ev.contains("NetEvNotPositive"), "{ev}");
    // reserved funds came back
    assert_eq!(bal(&c, w.ws, w.usdc, "reserved").await, 0);
    assert_eq!(bal(&c, w.ws, w.usdc, "available").await, 1_000_000_000);
    assert_eq!(v.total_submit_calls(), 0);
    assert_conserved(&c, w.ws).await;
}

// ------------------------------------------------------------------ 100 concurrent intents / one bucket

fn spawn_driver(d: Arc<Dispatcher>, ids: Vec<Uuid>, opts: DriveOpts) -> Vec<tokio::task::JoinHandle<DriveReport>> {
    ids.into_iter()
        .map(|id| {
            let d = d.clone();
            let o = opts.clone();
            tokio::spawn(async move { d.drive(id, o).await.unwrap() })
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn hundred_concurrent_intents_one_bucket_no_overspend() {
    let t = TestDb::new().await;
    let v = new_venue(11, false);
    let px = marketable_buy_px(&v);
    // budget per intent
    let probe_w = World { ws: Uuid::nil(), bucket: Uuid::nil(), wca: Uuid::nil(), eth: Uuid::nil(), usdc: Uuid::nil(), funds: 0 };
    let budget = spec(&probe_w, "p", Side::Buy, 10, px, Tif::Ioc).notional();
    let funds = 20 * budget + budget / 2; // room for exactly 20
    let w = seed_world(&t, funds).await;
    set_global_limits(&t, w.ws, serde_json::json!({"max_order_notional_bps_of_bucket":2500,"max_slippage_bps":100,"max_quote_age_ms":2000,"max_concentration_bps":10000})).await;
    let d = Arc::new(Dispatcher::new(t.db(40), v.clone()));
    let c = t.client().await;

    let mut ids = Vec::new();
    for i in 0..100 {
        ids.push(d.create_intent(&spec(&w, &format!("c-{i:03}"), Side::Buy, 10, px, Tif::Ioc)).await.unwrap());
    }
    // Phase 1: all 100 race through risk + reservation (stop before quoting so nothing is released back).
    let hs = spawn_driver(d.clone(), ids.clone(), DriveOpts { stop_at: Some(OrderState::CapitalReserved), ..Default::default() });
    for h in hs {
        h.await.unwrap();
    }
    let reserved_intents: i64 = c.query_one("select count(*) from trade_intents where state='CAPITAL_RESERVED'", &[]).await.unwrap().get(0);
    let failed: i64 = c.query_one("select count(*) from trade_intents where state='FAILED'", &[]).await.unwrap().get(0);
    assert_eq!(reserved_intents, 20, "exactly 20 intents may reserve");
    assert_eq!(failed, 80, "the other 80 must be refused");
    let why: i64 = c.query_one("select count(*) from order_events where to_state='FAILED' and event_key='failed:insufficient_funds'", &[]).await.unwrap().get(0);
    assert_eq!(why, 80);
    assert_eq!(bal(&c, w.ws, w.usdc, "reserved").await, (20 * budget) as i128);
    assert_eq!(bal(&c, w.ws, w.usdc, "available").await, (funds - 20 * budget) as i128);
    assert!(bal(&c, w.ws, w.usdc, "available").await >= 0);
    assert_conserved(&c, w.ws).await;

    // Phase 2: the 20 winners run to completion concurrently against the shared paper venue.
    let winners: Vec<Uuid> = c.query("select id from trade_intents where state='CAPITAL_RESERVED'", &[]).await.unwrap().iter().map(|r| r.get(0)).collect();
    let hs = spawn_driver(d.clone(), winners.clone(), DriveOpts { cancel_if_open: true, ..Default::default() });
    for h in hs {
        let r = h.await.unwrap();
        assert!(matches!(r.outcome, Outcome::Terminal(_)), "{r:?}");
    }
    assert_conserved(&c, w.ws).await;
    assert_eq!(bal(&c, w.ws, w.usdc, "reserved").await, 0, "all reservations settled");
    let spent = sum_text(&c, "select coalesce(sum(quote_amount+fee_quote),0)::text from fills", &[]).await;
    assert_eq!(bal(&c, w.ws, w.usdc, "available").await, funds as i128 - spent);
    assert!(spent <= (20 * budget) as i128);
    let eth = bal(&c, w.ws, w.eth, "available").await;
    assert_eq!(eth, sum_text(&c, "select coalesce(sum(qty),0)::text from fills", &[]).await);
    let one_fill_each: i64 = c.query_one("select count(*) from (select intent_id, venue_fill_id from fills group by 1,2 having count(*)>1) x", &[]).await.unwrap().get(0);
    assert_eq!(one_fill_each, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn hundred_concurrent_full_flows_invariants_hold() {
    let t = TestDb::new().await;
    let v = new_venue(12, false);
    let px = marketable_buy_px(&v);
    let probe_w = World { ws: Uuid::nil(), bucket: Uuid::nil(), wca: Uuid::nil(), eth: Uuid::nil(), usdc: Uuid::nil(), funds: 0 };
    let budget = spec(&probe_w, "p", Side::Buy, 10, px, Tif::Ioc).notional();
    let funds = 20 * budget;
    let w = seed_world(&t, funds).await;
    set_global_limits(&t, w.ws, serde_json::json!({"max_order_notional_bps_of_bucket":2500,"max_slippage_bps":100,"max_quote_age_ms":2000,"max_concentration_bps":10000})).await;
    let d = Arc::new(Dispatcher::new(t.db(40), v.clone()));
    let c = t.client().await;
    let mut ids = Vec::new();
    for i in 0..100 {
        ids.push(d.create_intent(&spec(&w, &format!("f-{i:03}"), Side::Buy, 10, px, Tif::Ioc)).await.unwrap());
    }
    let hs = spawn_driver(d.clone(), ids.clone(), DriveOpts { cancel_if_open: true, ..Default::default() });
    for h in hs {
        assert!(matches!(h.await.unwrap().outcome, Outcome::Terminal(_)));
    }
    assert_conserved(&c, w.ws).await;
    assert_eq!(bal(&c, w.ws, w.usdc, "reserved").await, 0);
    let spent = sum_text(&c, "select coalesce(sum(quote_amount+fee_quote),0)::text from fills", &[]).await;
    assert!(spent <= funds as i128, "never spend more than the bucket held: spent {spent} funds {funds}");
    assert_eq!(bal(&c, w.ws, w.usdc, "available").await, funds as i128 - spent);
    let sum_state: i64 = c.query_one("select count(*) from trade_intents where state not in ('FILLED','FAILED','CANCELLED','EXPIRED')", &[]).await.unwrap().get(0);
    assert_eq!(sum_state, 0);
}

// ------------------------------------------------------------------ duplicate fill delivery

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn duplicate_fill_delivery_is_one_economic_fill() {
    let t = TestDb::new().await;
    let w = seed_world(&t, 1_000_000_000).await;
    let v = new_venue(5, false);
    let d = Arc::new(Dispatcher::new(t.db(24), v.clone()));
    let c = t.client().await;
    let px = marketable_buy_px(&v);
    let id = d.create_intent(&spec(&w, "dup-1", Side::Buy, 15, px, Tif::Ioc)).await.unwrap();
    // park at ACKNOWLEDGED (order is at the venue, fills exist, none applied yet)
    let r = d.drive(id, DriveOpts { stop_at: Some(OrderState::Acknowledged), ..Default::default() }).await.unwrap();
    assert_eq!(r.outcome, Outcome::Blocked(OrderState::Acknowledged));
    let fills = v.fills("dup-1").await.unwrap();
    assert!(!fills.is_empty());
    // every fill delivered 10x concurrently (at-least-once + races)
    let mut hs = Vec::new();
    for f in &fills {
        for _ in 0..10 {
            let (d, f) = (d.clone(), f.clone());
            hs.push(tokio::spawn(async move { d.deliver_fill(id, &f).await }));
        }
    }
    for h in hs {
        h.await.unwrap().unwrap();
    }
    let n_fills: i64 = c.query_one("select count(*) from fills where intent_id=$1", &[&id]).await.unwrap().get(0);
    assert_eq!(n_fills as usize, fills.len(), "one fills row per venue fill");
    let entries: i64 = c.query_one("select count(*) from ledger_entries where kind='fill_buy'", &[]).await.unwrap().get(0);
    assert_eq!(entries as usize, fills.len(), "one ledger entry per economic fill");
    let q: u128 = fills.iter().map(|f| f.qty).sum();
    assert_eq!(bal(&c, w.ws, w.eth, "available").await, q as i128);
    let cost: u128 = fills.iter().map(|f| f.quote_amount + f.fee_quote).sum();
    let before = bal(&c, w.ws, w.usdc, "reserved").await;
    assert_conserved(&c, w.ws).await;
    // finishing the flow after the duplicates changes nothing about fills; replays of the whole drive are no-ops
    assert_eq!(d.drive(id, DriveOpts::default()).await.unwrap().outcome, Outcome::Terminal(OrderState::Filled));
    for _ in 0..3 {
        d.drive(id, DriveOpts::default()).await.unwrap();
        d.recover(DriveOpts::default()).await.unwrap();
    }
    let n_after: i64 = c.query_one("select count(*) from fills where intent_id=$1", &[&id]).await.unwrap().get(0);
    assert_eq!(n_after, n_fills);
    assert_eq!(bal(&c, w.ws, w.usdc, "available").await, 1_000_000_000 - cost as i128);
    assert_eq!(bal(&c, w.ws, w.usdc, "reserved").await, 0);
    assert!(before > 0);
    // SQL-level bounds: a fill exceeding the intent quantity is refused
    let e = c.query_one("select apply_fill_checked($1,'bogus',1,1,0)", &[&id]).await;
    assert!(e.is_err());
    assert_conserved(&c, w.ws).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fill_cannot_exceed_reservation_or_steal_other_reservations() {
    let t = TestDb::new().await;
    let w = seed_world(&t, 1_000_000_000).await;
    let v = new_venue(5, false);
    let d = Dispatcher::new(t.db(8), v.clone());
    let c = t.client().await;
    let px = marketable_buy_px(&v);
    // two reserved intents share the 'reserved' account; a bogus oversize fill on A must not eat B's money
    let a = d.create_intent(&spec(&w, "A", Side::Buy, 10, px, Tif::Gtc)).await.unwrap();
    let b = d.create_intent(&spec(&w, "B", Side::Buy, 10, px, Tif::Gtc)).await.unwrap();
    for id in [a, b] {
        d.drive(id, DriveOpts { stop_at: Some(OrderState::Quoted), ..Default::default() }).await.unwrap();
    }
    c.batch_execute("begin; select set_config('apex.service','on',true)").await.unwrap();
    c.execute("select advance_intent($1,'PREPARED','p')", &[&a]).await.unwrap();
    c.execute("select advance_intent($1,'SUBMITTING','s')", &[&a]).await.unwrap();
    c.execute("select advance_intent($1,'ACKNOWLEDGED','k')", &[&a]).await.unwrap();
    c.batch_execute("commit").await.unwrap();
    let budget = 10_000_000_000_000_000u128; // 10 lots = qty
    let _ = budget;
    c.batch_execute("begin; select set_config('apex.service','on',true)").await.unwrap();
    let r = c.query_one("select apply_fill_checked($1,'x1',10000000000000000, 999999999999, 0)", &[&a]).await;
    assert!(r.is_err(), "fill larger than the reservation must be refused");
    c.batch_execute("rollback").await.unwrap();
    assert_conserved(&c, w.ws).await;
}

// ------------------------------------------------------------------ crash recovery / replay

/// Checkpoints performed before the SUBMITTING->venue window (see `drive_inner`): verified by the window test below.
const WINDOW_STEPS: usize = 9;

async fn run_with_crash(db: &apex_execution::db::Db, v: &Arc<apex_execution::paper::PaperVenue>, id: Uuid, crash: Option<usize>) -> Outcome {
    let mut d = Dispatcher::new(db.clone(), v.clone());
    let mut waited = 0u32;
    let mut crash = crash;
    loop {
        let opts = DriveOpts { cancel_if_open: waited >= 3, crash_after: crash.take(), ..Default::default() };
        match d.drive(id, opts).await {
            Err(ExecError::Crash(_)) => {
                // process died: brand-new dispatcher, startup recovery replays every non-terminal intent
                d = Dispatcher::new(db.clone(), v.clone());
                d.recover(DriveOpts::default()).await.unwrap();
            }
            Err(e) => panic!("{e}"),
            Ok(r) => match r.outcome {
                Outcome::Waiting(_) => {
                    v.advance(7).await;
                    waited += 1;
                }
                o => return o,
            },
        }
    }
}

async fn ledger_snapshot(c: &tokio_postgres::Client, ws: Uuid) -> String {
    let mut out = String::new();
    for r in c.query("select a.state::text, s.symbol, sum(a.balance)::text from ledger_accounts a join assets s on s.id=a.asset_id where a.workspace_id=$1 group by 1,2 order by 1,2", &[&ws]).await.unwrap() {
        out += &format!("ACC|{}|{}|{}\n", r.get::<_, String>(0), r.get::<_, String>(1), r.get::<_, String>(2));
    }
    for r in c.query("select t.idempotency_key, t.state, coalesce(f.venue_fill_id,''), coalesce(f.qty,0)::text, coalesce(f.quote_amount,0)::text, coalesce(f.fee_quote,0)::text from trade_intents t left join fills f on f.intent_id=t.id order by 1,3", &[]).await.unwrap() {
        out += &format!("INT|{}|{}|{}|{}|{}|{}\n", r.get::<_, String>(0), r.get::<_, String>(1), r.get::<_, String>(2), r.get::<_, String>(3), r.get::<_, String>(4), r.get::<_, String>(5));
    }
    for r in c.query("select kind, count(*)::text from ledger_entries where workspace_id=$1 group by 1 order by 1", &[&ws]).await.unwrap() {
        out += &format!("ENT|{}|{}\n", r.get::<_, String>(0), r.get::<_, String>(1));
    }
    for r in c.query("select t.idempotency_key, e.event_key, e.from_state, e.to_state from order_events e join trade_intents t on t.id=e.intent_id order by 1, e.id", &[]).await.unwrap() {
        out += &format!("EVT|{}|{}|{}|{}\n", r.get::<_, String>(0), r.get::<_, String>(1), r.get::<_, String>(2), r.get::<_, String>(3));
    }
    for r in c.query("select qty::text, cost_basis_quote::text, realized_pnl_quote::text from positions", &[]).await.unwrap() {
        out += &format!("POS|{}|{}|{}\n", r.get::<_, String>(0), r.get::<_, String>(1), r.get::<_, String>(2));
    }
    out
}

async fn flow_world(crashes: bool) -> (TestDb, World, Arc<apex_execution::paper::PaperVenue>, String, Vec<(String, Outcome)>) {
    let t = TestDb::new().await;
    let w = seed_world(&t, 5_000_000_000).await;
    set_global_limits(&t, w.ws, serde_json::json!({"max_order_notional_bps_of_bucket":2500,"max_slippage_bps":100,"max_quote_age_ms":2000,"max_concentration_bps":10000})).await;
    let v = new_venue(99, false);
    let db = t.db(8);
    let setup = Dispatcher::new(db.clone(), v.clone());
    let mut outcomes = Vec::new();
    // 24 sequential intents; crash point k = 1..=12 for each of two shapes (IOC and resting GTC), sells mixed in
    let mut k = 0usize;
    for i in 0..24usize {
        let key = format!("flow-{i:02}");
        let is_sell = i % 4 == 3;
        let (side, px, tif) = if is_sell {
            (Side::Sell, marketable_sell_px(&v), Tif::Ioc)
        } else if i % 2 == 0 {
            (Side::Buy, marketable_buy_px(&v), Tif::Ioc)
        } else {
            (Side::Buy, v.with_exchange(|e| e.best_bid().unwrap()), Tif::Gtc) // joins the bid queue
        };
        let id = setup.create_intent(&spec(&w, &key, side, 5, px, tif)).await.unwrap();
        let crash = if crashes {
            k += 1;
            let mut c = 1 + (k % 16);
            if c == WINDOW_STEPS {
                c += 1; // the SUBMITTING window is tested separately (it resolves to UNKNOWN by design)
            }
            Some(c)
        } else {
            None
        };
        let o = run_with_crash(&db, &v, id, crash).await;
        outcomes.push((key, o));
    }
    let c = t.client().await;
    let snap = ledger_snapshot(&c, w.ws).await;
    (t, w, v, snap, outcomes)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn crash_at_every_checkpoint_then_replay_gives_identical_final_ledger() {
    let (ta, wa, va, snap_a, out_a) = flow_world(false).await;
    let (tb, wb, vb, snap_b, out_b) = flow_world(true).await;
    assert_eq!(out_a, out_b, "per-intent outcomes differ between uncrashed and crash/replay runs");
    assert_eq!(snap_a, snap_b, "final ledger / fills / events differ after crash+replay");
    assert_eq!(va.log_hash(), vb.log_hash(), "venue saw a different sequence of operations (a duplicate submit?)");
    assert_eq!(va.total_submit_calls(), vb.total_submit_calls());
    // sanity: the scenario actually traded, with partial fills, and resting orders existed
    assert!(snap_a.contains("INT|flow-00|FILLED"), "{snap_a}");
    assert!(snap_a.lines().filter(|l| l.starts_with("INT|") && l.split('|').nth(3) != Some("")).count() > 24, "expected multi-fill intents");
    let c = ta.client().await;
    assert_conserved(&c, wa.ws).await;
    let c = tb.client().await;
    assert_conserved(&c, wb.ws).await;
    // no duplicate economic fills anywhere in the crashed world
    let dups: i64 = c.query_one("select count(*) from (select intent_id, venue_fill_id from fills group by 1,2 having count(*)>1) x", &[]).await.unwrap().get(0);
    assert_eq!(dups, 0);
    let fills: i64 = c.query_one("select count(*) from fills", &[]).await.unwrap().get(0);
    let fill_entries: i64 = c.query_one("select count(*) from ledger_entries where kind in ('fill_buy','fill_sell')", &[]).await.unwrap().get(0);
    assert_eq!(fills, fill_entries);
    eprintln!("replay test: {} intents, {} fills, venue log hash {}", out_b.len(), fills, vb.log_hash());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn crash_in_submitting_window_goes_unknown_never_resubmits() {
    let t = TestDb::new().await;
    let w = seed_world(&t, 1_000_000_000).await;
    let v = new_venue(2, false);
    let db = t.db(8);
    let d = Dispatcher::new(db.clone(), v.clone());
    let c = t.client().await;
    let px = marketable_buy_px(&v);
    let id = d.create_intent(&spec(&w, "win-1", Side::Buy, 10, px, Tif::Ioc)).await.unwrap();
    let r = d.drive(id, DriveOpts { stop_at: Some(OrderState::Submitting), ..Default::default() }).await.unwrap();
    assert_eq!(r.outcome, Outcome::Blocked(OrderState::Submitting));
    assert_eq!(r.steps, WINDOW_STEPS, "WINDOW_STEPS constant is stale");
    assert_eq!(v.submit_calls("win-1"), 0);
    // process "restarts": SUBMITTING found on recovery, venue has no record => UNKNOWN, no submit
    let d2 = Dispatcher::new(db.clone(), v.clone());
    let rec = d2.recover(DriveOpts::default()).await.unwrap();
    assert_eq!(rec.len(), 1);
    assert_eq!(rec[0].1.outcome, Outcome::Blocked(OrderState::Unknown));
    assert_eq!(v.submit_calls("win-1"), 0, "recovery must never submit");
    assert_eq!(bal(&c, w.ws, w.usdc, "reserved").await > 0, true, "funds stay reserved while UNKNOWN");
    // only reconciliation (authoritative 'no such order') resolves it
    let r = d2.reconcile(id, DriveOpts::default()).await.unwrap();
    assert_eq!(r.outcome, Outcome::Terminal(OrderState::Failed));
    assert_eq!(v.submit_calls("win-1"), 0);
    assert_eq!(bal(&c, w.ws, w.usdc, "reserved").await, 0);
    assert_eq!(bal(&c, w.ws, w.usdc, "available").await, 1_000_000_000);
    assert_conserved(&c, w.ws).await;
}

// ------------------------------------------------------------------ UNKNOWN

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unknown_outcome_is_never_resubmitted_only_reconciliation_resolves_it() {
    let t = TestDb::new().await;
    let w = seed_world(&t, 1_000_000_000).await;
    let v = new_venue(21, false);
    let d = Dispatcher::new(t.db(8), v.clone());
    let c = t.client().await;
    let px = marketable_buy_px(&v);
    // (a) venue booked the order but the response was lost
    let a = d.create_intent(&spec(&w, "u-after", Side::Buy, 10, px, Tif::Ioc)).await.unwrap();
    v.inject_fault("u-after", Fault::TimeoutAfterAccept);
    assert_eq!(d.drive(a, DriveOpts::default()).await.unwrap().outcome, Outcome::Blocked(OrderState::Unknown));
    // (b) request never arrived
    let b = d.create_intent(&spec(&w, "u-before", Side::Buy, 10, px, Tif::Ioc)).await.unwrap();
    v.inject_fault("u-before", Fault::TimeoutBeforeAccept);
    assert_eq!(d.drive(b, DriveOpts::default()).await.unwrap().outcome, Outcome::Blocked(OrderState::Unknown));
    assert_eq!(state_of(&c, a).await, "UNKNOWN");
    assert_eq!(v.submit_calls("u-after"), 1);
    assert_eq!(v.submit_calls("u-before"), 1);
    let reserved = bal(&c, w.ws, w.usdc, "reserved").await;
    assert!(reserved > 0);

    // hammer: repeated drive / recover / restart-style dispatchers never submit again, never release funds
    v.clear_faults();
    for _ in 0..5 {
        d.drive(a, DriveOpts::default()).await.unwrap();
        d.drive(b, DriveOpts::default()).await.unwrap();
        let d2 = Dispatcher::new(t.db(4), v.clone());
        d2.recover(DriveOpts::default()).await.unwrap();
    }
    assert_eq!(v.submit_calls("u-after"), 1, "UNKNOWN must never be resubmitted");
    assert_eq!(v.submit_calls("u-before"), 1, "UNKNOWN must never be resubmitted");
    assert_eq!(state_of(&c, a).await, "UNKNOWN");
    assert_eq!(bal(&c, w.ws, w.usdc, "reserved").await, reserved);
    // the state machine itself forbids it as well
    c.batch_execute("begin; select set_config('apex.service','on',true)").await.unwrap();
    let e = c.query_one("select advance_intent($1,'SUBMITTING','hack')", &[&a]).await.unwrap_err();
    assert!(e.as_db_error().unwrap().message().contains("illegal transition"), "{e}");
    c.batch_execute("rollback").await.unwrap();
    // and an UNKNOWN order counts against the bucket: new entries are vetoed (max_open_unknown_orders = 0)
    let n = d.create_intent(&spec(&w, "after-unknown", Side::Buy, 10, px, Tif::Ioc)).await.unwrap();
    assert_eq!(d.drive(n, DriveOpts::default()).await.unwrap().outcome, Outcome::Terminal(OrderState::Failed));
    let why: String = c.query_one("select reasons::text from risk_decisions where intent_id=$1", &[&n]).await.unwrap().get(0);
    assert!(why.contains("UNKNOWN_ORDERS_OPEN"), "{why}");

    // reconciliation: (a) the venue has it -> adopted and completed; (b) authoritatively absent -> FAILED + released
    let ra = d.reconcile(a, DriveOpts::default()).await.unwrap();
    assert_eq!(ra.outcome, Outcome::Terminal(OrderState::Filled));
    let rb = d.reconcile(b, DriveOpts::default()).await.unwrap();
    assert_eq!(rb.outcome, Outcome::Terminal(OrderState::Failed));
    assert_eq!(v.submit_calls("u-after"), 1);
    assert_eq!(v.submit_calls("u-before"), 1);
    assert_eq!(bal(&c, w.ws, w.usdc, "reserved").await, 0);
    assert_conserved(&c, w.ws).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn non_authoritative_not_found_keeps_unknown() {
    let t = TestDb::new().await;
    let w = seed_world(&t, 1_000_000_000).await;
    let v = Arc::new(apex_execution::paper::PaperVenue::new(Default::default()).with_non_authoritative_absence());
    let d = Dispatcher::new(t.db(8), v.clone());
    let px = marketable_buy_px(&v);
    let id = d.create_intent(&spec(&w, "na-1", Side::Buy, 10, px, Tif::Ioc)).await.unwrap();
    v.inject_fault("na-1", Fault::TimeoutBeforeAccept);
    assert_eq!(d.drive(id, DriveOpts::default()).await.unwrap().outcome, Outcome::Blocked(OrderState::Unknown));
    let r = d.reconcile(id, DriveOpts::default()).await.unwrap();
    assert_eq!(r.outcome, Outcome::Blocked(OrderState::Unknown), "a non-authoritative 'not found' must not fail or resubmit the order");
    assert_eq!(v.submit_calls("na-1"), 1);
}

// ------------------------------------------------------------------ global states: block entries, allow exits

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn exits_allowed_while_halted_entries_blocked() {
    let t = TestDb::new().await;
    let w = seed_world(&t, 2_000_000_000).await;
    let v = new_venue(31, false);
    let d = Dispatcher::new(t.db(8), v.clone());
    let c = t.client().await;
    let bpx = marketable_buy_px(&v);
    let buy = d.create_intent(&spec(&w, "pos-1", Side::Buy, 30, bpx, Tif::Ioc)).await.unwrap();
    assert_eq!(run_to_end(&d, &v, buy, 3).await, Outcome::Terminal(OrderState::Filled));
    let eth0 = bal(&c, w.ws, w.eth, "available").await;
    let mut sold = 0i128;
    for (i, st) in ["halt_new_entries", "exit_only", "emergency_stopped"].iter().enumerate() {
        set_global_state(&t, w.ws, st).await;
        // entry: vetoed
        let e = d.create_intent(&spec(&w, &format!("entry-{st}"), Side::Buy, 5, marketable_buy_px(&v), Tif::Ioc)).await.unwrap();
        assert_eq!(d.drive(e, DriveOpts::default()).await.unwrap().outcome, Outcome::Terminal(OrderState::Failed), "{st}");
        let why: String = c.query_one("select reasons::text from risk_decisions where intent_id=$1", &[&e]).await.unwrap().get(0);
        assert!(why.contains("GLOBAL_STATE_BLOCKS_ENTRIES") && why.contains(st), "{why}");
        // exit: admitted and filled
        let x = d.create_intent(&spec(&w, &format!("exit-{st}"), Side::Sell, 5, marketable_sell_px(&v), Tif::Ioc)).await.unwrap();
        assert_eq!(run_to_end(&d, &v, x, 3).await, Outcome::Terminal(OrderState::Filled), "exit must be allowed while {st}");
        let code: String = c.query_one("select reasons->0->>'code' from risk_decisions where intent_id=$1", &[&x]).await.unwrap().get(0);
        assert_eq!(code, "ADMIT_EXIT_PATH");
        sold += 5 * 1_000_000_000_000_000;
        assert_eq!(bal(&c, w.ws, w.eth, "available").await, eth0 - sold, "after exit {i}");
    }
    // an exit that is NOT covered by the position is an entry in disguise: vetoed while halted
    let big = d.create_intent(&spec(&w, "oversell", Side::Sell, 500, marketable_sell_px(&v), Tif::Ioc)).await.unwrap();
    assert_eq!(d.drive(big, DriveOpts::default()).await.unwrap().outcome, Outcome::Terminal(OrderState::Failed));
    // SQL-level defence in depth: even with a forged ADMIT row, advance_intent refuses a BUY while halted
    let forged = d.create_intent(&spec(&w, "forged", Side::Buy, 5, marketable_buy_px(&v), Tif::Ioc)).await.unwrap();
    d.drive(forged, DriveOpts { stop_at: Some(OrderState::RiskEvaluating), ..Default::default() }).await.unwrap();
    c.batch_execute("begin; select set_config('apex.service','on',true)").await.unwrap();
    c.execute("insert into risk_decisions(intent_id, workspace_id, decision, policy_version, evaluator) values ($1,$2,'ADMIT',1,'forged')", &[&forged, &w.ws]).await.unwrap();
    let e = c.query_one("select advance_intent($1,'ADMITTED','forged-admit')", &[&forged]).await.unwrap_err();
    assert!(e.as_db_error().unwrap().message().contains("refuses new entries"), "{e}");
    c.batch_execute("rollback").await.unwrap();
    assert_conserved(&c, w.ws).await;
    // resume
    set_global_state(&t, w.ws, "active").await;
    let again = d.create_intent(&spec(&w, "entry-after", Side::Buy, 5, marketable_buy_px(&v), Tif::Ioc)).await.unwrap();
    assert_eq!(run_to_end(&d, &v, again, 3).await, Outcome::Terminal(OrderState::Filled));
}

// ------------------------------------------------------------------ live is impossible

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn live_path_is_disabled_everywhere() {
    // the stub
    let lv = LiveVenue;
    let o = VenueOrder { client_order_id: "x".into(), side: Side::Buy, price: 1, qty: 1, tif: Tif::Ioc };
    assert_eq!(lv.submit(&o).await, Err(VenueError::LiveDisabled));
    assert_eq!(lv.status("x").await, Err(VenueError::LiveDisabled));
    assert_eq!(lv.fills("x").await, Err(VenueError::LiveDisabled));
    assert_eq!(lv.cancel("x").await, Err(VenueError::LiveDisabled));
    // the SQL gate
    let t = TestDb::new().await;
    let w = seed_world(&t, 1_000_000_000).await;
    let c = t.client().await;
    let allowed: bool = c.query_one("select live_allowed($1)", &[&w.ws]).await.unwrap().get(0);
    assert!(!allowed, "live_allowed must be false: gates NOT_RUN");
    // a live intent cannot even be created (DB guard trigger)
    let d = Dispatcher::new(t.db(4), new_venue(1, false));
    let mut s = spec(&w, "live-1", Side::Buy, 5, 2_000_000_000, Tif::Ioc);
    s.environment = "live".into();
    let err = d.create_intent(&s).await.unwrap_err();
    assert!(err.message().contains("LIVE EXECUTION DISABLED"), "{err}");
}
