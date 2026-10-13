//! Integration tests for `apex-execution serve` (real Postgres, fresh database per test; all migrations applied).
//! Paper + SYNTHETIC only. Covers: end-to-end flow + settlement + waterfall, two concurrent serve loops on one DB,
//! kill -9 crash/restart giving the identical ledger, halt mid-run, UNKNOWN never resubmitted, venue determinism.
mod common;
use apex_execution::dbvenue::DbPaperVenue;
use apex_execution::dispatcher::*;
use apex_execution::serve::{self, ServeConfig, Shutdown};
use apex_execution::venue::*;
use apex_risk::Side;
use common::*;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use uuid::Uuid;

const PX: u128 = 2_000_000_000; // 2000 USDC per ETH, quote base units (6 decimals)
const LOT: u128 = 1_000_000_000_000_000; // 0.001 ETH

/// paper_running + one enabled strategy instance + a capital budget (what the feed needs), done as test fixtures with SQL.
async fn enable_paper(t: &TestDb, w: &World) {
    let c = t.client().await;
    c.execute("update workspace_settings set paper_running = true where workspace_id = $1", &[&w.ws]).await.unwrap();
    c.execute(
        "insert into strategy_instances(workspace_id, bucket_id, environment, strategy_key, strategy_version, enabled) values ($1,$2,'paper','cex_trend_momentum',1,true) on conflict do nothing",
        &[&w.ws, &w.bucket],
    )
    .await
    .unwrap();
    c.execute(
        "insert into strategy_capital_budgets(workspace_id, bucket_id, strategy_key, asset_id, limit_amount) values ($1,$2,'cex_trend_momentum',$3,$4::text::numeric) on conflict do nothing",
        &[&w.ws, &w.bucket, &w.usdc, &(w.funds.to_string())],
    )
    .await
    .unwrap();
}

/// create a SIGNAL intent through the real service-role SQL function (same path as the Python feed)
async fn signal(t: &TestDb, w: &World, key: &str, side: Side, lots: u128, price: u128) -> Uuid {
    let mut s = spec(w, key, side, lots, price, Tif::Ioc);
    s.strategy_key = "cex_trend_momentum".into();
    s.ctx.max_fee_bps = 25;
    let ctx = serde_json::to_value(&s.ctx).unwrap();
    let c = t.client().await;
    c.batch_execute("begin; select set_config('apex.service','on',true)").await.unwrap();
    let id: Uuid = c
        .query_one(
            "select create_signal_intent($1,$2,$3,$4,$5,$6,$7::text::numeric,$8::text::numeric,'cex_trend_momentum',$9,$10)",
            &[&w.ws, &w.bucket, &w.wca, &w.eth, &w.usdc, &(if side == Side::Buy { "buy" } else { "sell" }), &s.quantity.to_string(), &price.to_string(), &key, &ctx],
        )
        .await
        .unwrap()
        .get(0);
    c.batch_execute("commit").await.unwrap();
    // Rust and SQL agree on how much to reserve
    let n: String = c.query_one("select notional::text from trade_intents where id = $1", &[&id]).await.unwrap().get(0);
    assert_eq!(n.parse::<u128>().unwrap(), s.notional(), "SQL notional != Rust IntentSpec::notional()");
    id
}

fn cfg(name: &str) -> ServeConfig {
    ServeConfig { poll_ms: 40, groups_parallel: 4, instance: name.into(), heartbeat_ms: 300, metrics_every_ms: 60_000, exit_when_idle_ms: Some(1_200), batch_limit: 500, step_delay_ms: 0 }
}

async fn run_serve(t: &TestDb, name: &str, seed: u64, step_delay_ms: u64) -> Arc<serve::Counters> {
    let db = t.db(24);
    let d = Dispatcher::new(db.clone(), Arc::new(DbPaperVenue::new(db, seed)));
    let mut c = cfg(name);
    c.step_delay_ms = step_delay_ms;
    serve::run(d, c, Arc::new(Shutdown::default())).await.unwrap()
}

async fn states(c: &tokio_postgres::Client, ws: Uuid) -> BTreeMap<String, i64> {
    c.query("select state, count(*) from trade_intents where workspace_id=$1 group by 1", &[&ws]).await.unwrap().iter().map(|r| (r.get::<_, String>(0), r.get::<_, i64>(1))).collect()
}

async fn assert_clean(c: &tokio_postgres::Client, ws: Uuid) {
    assert_conserved(c, ws).await;
    let held: i64 = c.query_one("select count(*) from capital_reservations where workspace_id=$1 and status='held'", &[&ws]).await.unwrap().get(0);
    assert_eq!(held, 0, "reservation still held");
    let b: String = c.query_one("select coalesce(sum(reserved_amount),0)::text from strategy_capital_budgets where workspace_id=$1", &[&ws]).await.unwrap().get(0);
    assert_eq!(b, "0", "budget reserved_amount not returned");
    let r: String = c.query_one("select coalesce(sum(balance),0)::text from ledger_accounts where workspace_id=$1 and state='reserved'", &[&ws]).await.unwrap().get(0);
    assert_eq!(r, "0", "reserved account not empty");
}

// ------------------------------------------------------------------ venue determinism (no DB round trips)

#[tokio::test]
async fn db_paper_venue_plan_is_a_pure_function_of_seed_and_order() {
    let t = TestDb::new().await;
    let a = DbPaperVenue::new(t.db(2), 7);
    let b = DbPaperVenue::new(t.db(2), 7);
    let c = DbPaperVenue::new(t.db(2), 8);
    let mut differs = 0;
    let (mut zero, mut partial, mut full) = (0, 0, 0);
    for i in 0..400u32 {
        for side in [Side::Buy, Side::Sell] {
            let o = VenueOrder { client_order_id: format!("k{i}"), side, price: PX, qty: 10 * LOT, tif: Tif::Ioc };
            let (pa, pb, pc) = (a.plan(&o, 18), b.plan(&o, 18), c.plan(&o, 18));
            assert_eq!(pa, pb, "same seed must give the identical plan");
            if pa != pc {
                differs += 1;
            }
            assert!(pa.filled_qty <= o.qty);
            for f in &pa.fills {
                let at_limit = f.qty * PX / 1_000_000_000_000_000_000;
                match side {
                    Side::Buy => assert!(f.quote_amount <= at_limit, "buy filled above its limit"),
                    Side::Sell => assert!(f.quote_amount >= at_limit, "sell filled below its limit"),
                }
                assert!(f.fee_quote * 10_000 <= f.quote_amount * 20 + 9_999, "fee above the flat taker rate");
            }
            match (pa.filled_qty, pa.fully_filled) {
                (0, _) => zero += 1,
                (_, true) => full += 1,
                _ => partial += 1,
            }
        }
    }
    assert!(differs > 600, "a different seed must change the plans (changed {differs}/800)");
    assert!(zero > 0 && partial > 0 && full > 600, "outcome mix zero={zero} partial={partial} full={full}");
}

// ------------------------------------------------------------------ end to end

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn serve_runs_signals_to_settlement_with_waterfall_idempotently() {
    let t = TestDb::new().await;
    let w = seed_world(&t, 1_000_000_000).await;
    enable_paper(&t, &w).await;
    let c = t.client().await;
    // a compounding policy exists => realised profit goes through apply_waterfall (100% reinvest keeps the test about idempotency)
    c.execute(
        "insert into compounding_policies(workspace_id, bucket_id, version, mode, reinvest_bps, vault_bps, reserve_bps, tax_provision_bps) values ($1,$2,1,'fixed',7000,0,3000,0)",
        &[&w.ws, &w.bucket],
    )
    .await
    .unwrap();
    // buys at 2000 and sells with limits 3% higher => positive realised PnL on the sells even after fees
    let mut ids = vec![];
    for i in 0..12 {
        ids.push(signal(&t, &w, &format!("e2e-b{i}"), Side::Buy, 5, PX).await);
        if i % 2 == 1 {
            ids.push(signal(&t, &w, &format!("e2e-s{i}"), Side::Sell, 4, PX * 103 / 100).await);
        }
    }
    let ctr = run_serve(&t, "e2e", 11, 0).await;
    let st = states(&c, w.ws).await;
    println!("states after serve: {st:?} counters {}", ctr.snapshot());
    for (s, n) in &st {
        assert!(matches!(s.as_str(), "RECONCILED" | "FAILED" | "CANCELLED" | "EXPIRED"), "intent left in {s} ({n})");
    }
    let fills: i64 = c.query_one("select count(*) from fills where workspace_id=$1", &[&w.ws]).await.unwrap().get(0);
    assert!(fills >= 10, "expected fills, got {fills}");
    assert_clean(&c, w.ws).await;
    // every intent with a fill reached RECONCILED through SETTLING and FINAL, paper settlement only
    let bad: i64 = c
        .query_one(
            "select count(*) from trade_intents t where workspace_id=$1 and exists (select 1 from fills f where f.intent_id=t.id) and state <> 'RECONCILED'",
            &[&w.ws],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(bad, 0);
    let trail: Vec<String> = c
        .query("select to_state from order_events where intent_id = (select intent_id from fills where workspace_id=$1 order by created_at limit 1) order by id", &[&w.ws])
        .await
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(&trail[trail.len() - 3..], ["SETTLING", "FINAL", "RECONCILED"], "trail {trail:?}");
    // waterfall ran for profitable sells; exactly once per profit event
    let wf: i64 = c.query_one("select count(*) from waterfall_executions where workspace_id=$1", &[&w.ws]).await.unwrap().get(0);
    let profitable: i64 = c.query_one("select count(*) from profit_eligibility_events where workspace_id=$1 and realized_net_quote > 0", &[&w.ws]).await.unwrap().get(0);
    assert!(profitable > 0, "fixture should produce profitable sells");
    assert_eq!(wf, profitable, "one waterfall execution per profitable event");
    let restricted_before = bal(&c, w.ws, w.usdc, "fee_reserve").await;
    assert!(restricted_before > 0, "reserve share of the waterfall must have landed in fee_reserve");

    // idempotency: run serve again with nothing to do. Nothing changes.
    let ev_before: i64 = c.query_one("select count(*) from order_events where workspace_id=$1", &[&w.ws]).await.unwrap().get(0);
    let led_before: i64 = c.query_one("select count(*) from ledger_entries where workspace_id=$1", &[&w.ws]).await.unwrap().get(0);
    run_serve(&t, "e2e-again", 11, 0).await;
    let ev_after: i64 = c.query_one("select count(*) from order_events where workspace_id=$1", &[&w.ws]).await.unwrap().get(0);
    let led_after: i64 = c.query_one("select count(*) from ledger_entries where workspace_id=$1", &[&w.ws]).await.unwrap().get(0);
    assert_eq!((ev_before, led_before), (ev_after, led_after), "second serve over a finished workspace must change nothing");
    let wf2: i64 = c.query_one("select count(*) from waterfall_executions where workspace_id=$1", &[&w.ws]).await.unwrap().get(0);
    assert_eq!(wf, wf2);

    // heartbeat row exists and is marked cleanly stopped
    let hb: (String, bool) = {
        let r = c.query_one("select instance_id, stopped_at is not null from engine_heartbeats where component='execution' and instance_id='e2e'", &[]).await.unwrap();
        (r.get(0), r.get(1))
    };
    assert!(hb.1, "clean exit must record stopped_at");
    // the DB-backed venue saw exactly one order per submitted intent
    let submitted: i64 = c.query_one("select count(distinct intent_id) from order_events where workspace_id=$1 and to_state='SUBMITTING'", &[&w.ws]).await.unwrap().get(0);
    let venue_orders: i64 = c.query_one("select count(*) from paper_venue_orders", &[]).await.unwrap().get(0);
    assert_eq!(submitted, venue_orders);
}

// ------------------------------------------------------------------ two serve loops, one database

#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
async fn two_concurrent_serve_loops_on_one_db_no_duplicates_and_ledger_conserved() {
    let t = TestDb::new().await;
    let mut worlds = vec![];
    for k in 0..4 {
        let w = seed_world_addr(&t, 1_000_000_000, &format!("0x{:040x}", 0xabc000 + k)).await;
        enable_paper(&t, &w).await;
        worlds.push(w);
    }
    let mut total = 0;
    for (k, w) in worlds.iter().enumerate() {
        for i in 0..30 {
            signal(&t, w, &format!("w{k}-b{i}"), Side::Buy, 3 + (i % 4) as u128, PX).await;
            total += 1;
            if i % 3 == 2 {
                signal(&t, w, &format!("w{k}-s{i}"), Side::Sell, 3, PX * 101 / 100).await;
                total += 1;
            }
        }
    }
    // both loops started together, each with its own pool and venue handle: they can only coordinate through Postgres
    let (ta, tb) = (t.url.clone(), t.url.clone());
    let mk = |url: String, name: &'static str| {
        tokio::spawn(async move {
            let db = apex_execution::db::Db::connect(&url, 24).unwrap();
            let d = Dispatcher::new(db.clone(), Arc::new(DbPaperVenue::new(db, 5)));
            let mut c = cfg(name);
            c.step_delay_ms = 4;
            serve::run(d, c, Arc::new(Shutdown::default())).await.unwrap()
        })
    };
    let (ha, hb) = (mk(ta, "loop-A"), mk(tb, "loop-B"));
    let (ca, cb) = (ha.await.unwrap(), hb.await.unwrap());
    println!("loop A {}\nloop B {}", ca.snapshot(), cb.snapshot());
    assert_eq!(ca.get("errors") + cb.get("errors"), 0, "no errors expected");
    assert!(ca.get("group_busy") + cb.get("group_busy") > 0, "the loops must actually have contended for groups");

    let c = t.client().await;
    let n: i64 = c.query_one("select count(*) from trade_intents", &[]).await.unwrap().get(0);
    assert_eq!(n, total);
    // no intent was submitted twice, no client order id has two venue records, no fill delivered twice
    let dup_submit: i64 = c.query_one("select count(*) from (select intent_id from order_events where to_state='SUBMITTING' group by 1 having count(*) > 1) x", &[]).await.unwrap().get(0);
    assert_eq!(dup_submit, 0);
    let submitted: i64 = c.query_one("select count(distinct intent_id) from order_events where to_state='SUBMITTING'", &[]).await.unwrap().get(0);
    let venue_orders: i64 = c.query_one("select count(*) from paper_venue_orders", &[]).await.unwrap().get(0);
    assert_eq!(submitted, venue_orders, "one venue order per submitted intent");
    // fills in the ledger == fills the venue produced (each exactly once)
    let venue_fills: i64 = c.query_one("select coalesce(sum(jsonb_array_length(fills)),0) from paper_venue_orders", &[]).await.unwrap().get(0);
    let db_fills: i64 = c.query_one("select count(*) from fills", &[]).await.unwrap().get(0);
    assert_eq!(venue_fills, db_fills, "every venue fill applied exactly once");
    let dup_entries: i64 = c.query_one("select count(*) from (select 1 from ledger_entries group by workspace_id, idempotency_key having count(*) > 1) x", &[]).await.unwrap().get(0);
    assert_eq!(dup_entries, 0);
    let fill_entries: i64 = c.query_one("select count(*) from ledger_entries where kind in ('fill_buy','fill_sell')", &[]).await.unwrap().get(0);
    assert_eq!(fill_entries, db_fills, "one ledger entry per fill");
    for w in &worlds {
        assert_clean(&c, w.ws).await;
        let st = states(&c, w.ws).await;
        for s in st.keys() {
            assert!(matches!(s.as_str(), "RECONCILED" | "FAILED" | "CANCELLED" | "EXPIRED"), "ws left intent in {s}");
        }
    }
    println!("two loops: {total} intents, {submitted} submitted, {db_fills} fills, 0 duplicates, ledger conserved in 4 workspaces");
}

// ------------------------------------------------------------------ crash (kill -9) then restart

const BIN: &str = env!("CARGO_BIN_EXE_apex-execution");

fn child(url: &str, mode: &str, instance: &str, delay: u64) -> std::process::Child {
    std::process::Command::new(BIN)
        .arg(mode)
        .env("DATABASE_URL", url)
        .env("APEX_PAPER_SEED", "99")
        .env("APEX_SERVE_POLL_MS", "40")
        .env("APEX_SERVE_IDLE_MS", "1500")
        .env("APEX_SERVE_INSTANCE", instance)
        .env("APEX_SERVE_STEP_DELAY_MS", delay.to_string())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn apex-execution")
}

/// canonical, DB-id-free summary of everything economic: per idempotency key the state trail + fills, per (symbol,state) totals, positions
async fn canonical(c: &tokio_postgres::Client, ws: Uuid) -> String {
    let mut out = String::new();
    for r in c
        .query(
            "select t.idempotency_key, t.state, \
               (select string_agg(e.to_state, '>' order by e.id) from order_events e where e.intent_id = t.id), \
               (select string_agg(f.venue_fill_id || ':' || f.qty::text || ':' || f.quote_amount::text || ':' || f.fee_quote::text, ',' order by f.venue_fill_id) from fills f where f.intent_id = t.id), \
               (select d.decision || coalesce(d.reasons->0->>'code','') from risk_decisions d where d.intent_id = t.id order by d.created_at limit 1) \
             from trade_intents t where t.workspace_id = $1 order by t.idempotency_key",
            &[&ws],
        )
        .await
        .unwrap()
    {
        out += &format!("{} | {} | {} | {} | {}\n", r.get::<_, String>(0), r.get::<_, String>(1), r.get::<_, Option<String>>(2).unwrap_or_default(), r.get::<_, Option<String>>(3).unwrap_or_default(), r.get::<_, Option<String>>(4).unwrap_or_default());
    }
    for r in c
        .query(
            "select s.symbol, a.state::text, sum(a.balance)::text from ledger_accounts a join assets s on s.id = a.asset_id where a.workspace_id = $1 group by 1, 2 order by 1, 2",
            &[&ws],
        )
        .await
        .unwrap()
    {
        out += &format!("BAL {} {} {}\n", r.get::<_, String>(0), r.get::<_, String>(1), r.get::<_, String>(2));
    }
    for r in c.query("select qty::text, cost_basis_quote::text, realized_pnl_quote::text from positions where bucket_id in (select id from buckets where workspace_id = $1)", &[&ws]).await.unwrap() {
        out += &format!("POS {} {} {}\n", r.get::<_, String>(0), r.get::<_, String>(1), r.get::<_, String>(2));
    }
    let n: i64 = c.query_one("select count(*) from ledger_entries where workspace_id = $1", &[&ws]).await.unwrap().get(0);
    out += &format!("ENTRIES {n}\n");
    out
}

async fn seeded(n: usize) -> (TestDb, World) {
    let t = TestDb::new().await;
    let w = seed_world(&t, 1_000_000_000).await;
    enable_paper(&t, &w).await;
    for i in 0..n {
        signal(&t, &w, &format!("c{i:03}-b"), Side::Buy, 2 + (i % 5) as u128, PX).await;
        if i % 3 == 2 {
            signal(&t, &w, &format!("c{i:03}-s"), Side::Sell, 2, PX * 102 / 100).await;
        }
    }
    (t, w)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn kill_dash_9_mid_flow_then_restart_gives_identical_ledger_to_uninterrupted_run() {
    // baseline: same seed, uninterrupted
    let (tb, wb) = seeded(40).await;
    let mut p = child(&tb.url, "drain", "baseline", 0);
    assert!(p.wait().unwrap().success());
    let cb = tb.client().await;
    let baseline = canonical(&cb, wb.ws).await;
    assert_clean(&cb, wb.ws).await;
    let settled: i64 = cb.query_one("select count(*) from trade_intents where state='RECONCILED'", &[]).await.unwrap().get(0);
    assert!(settled > 20, "baseline should settle many intents, got {settled}");

    let mut report = vec![];
    let mut identical = false;
    for attempt in 0..6u64 {
        let (tc, wc) = seeded(40).await;
        let cc = tc.client().await;
        let mut p = child(&tc.url, "serve", &format!("victim-{attempt}"), 12);
        // wait until it is demonstrably mid-flow, then SIGKILL (std Child::kill == SIGKILL: no cleanup, no heartbeat, no unlock)
        let target = 8 + attempt as i64 * 5;
        let t0 = Instant::now();
        loop {
            let done: i64 = cc.query_one("select count(*) from trade_intents where state in ('RECONCILED','FAILED','CANCELLED','EXPIRED')", &[]).await.unwrap().get(0);
            if done >= target || t0.elapsed() > Duration::from_secs(60) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        p.kill().unwrap();
        p.wait().unwrap();
        let mid = states(&cc, wc.ws).await;
        let unfinished: i64 = mid.iter().filter(|(s, _)| !matches!(s.as_str(), "RECONCILED" | "FAILED" | "CANCELLED" | "EXPIRED")).map(|(_, n)| *n).sum();
        assert!(unfinished > 0, "kill landed after the work was done; test is not mid-flow ({mid:?})");
        // the heartbeat must now be stale and NOT marked stopped: the console must be able to call this process dead
        let hb: bool = cc.query_one("select stopped_at is null from engine_heartbeats where instance_id = $1", &[&format!("victim-{attempt}")]).await.unwrap().get(0);
        assert!(hb, "a killed process cannot have recorded a clean stop");
        // restart on the same database
        let mut p2 = child(&tc.url, "drain", &format!("restart-{attempt}"), 0);
        assert!(p2.wait().unwrap().success());
        let after = canonical(&cc, wc.ws).await;
        assert_clean(&cc, wc.ws).await;
        let unknown_hit = after.contains("UNKNOWN");
        if after == baseline {
            report.push(format!("attempt {attempt}: killed with {unfinished} unfinished intents ({mid:?}) -> identical to baseline"));
            identical = true;
            break;
        } else {
            // The one window that cannot converge to the uncrashed run BY DESIGN: killed after SUBMITTING was committed but before the venue
            // call. That intent goes UNKNOWN and is never resubmitted (-> FAILED by authoritative reconciliation). Prove that is the only cause.
            assert!(unknown_hit, "ledger differs from baseline but NO intent went through UNKNOWN. This is a real bug.\n--- baseline\n{baseline}\n--- after\n{after}");
            let sub_but_no_venue: i64 = cc
                .query_one("select count(*) from order_events e where e.to_state='SUBMITTING' and not exists (select 1 from paper_venue_orders v where v.client_order_id = (select idempotency_key from trade_intents where id = e.intent_id))", &[])
                .await
                .unwrap()
                .get(0);
            assert!(sub_but_no_venue >= 1, "UNKNOWN without a SUBMITTING-with-no-venue-record intent");
            report.push(format!("attempt {attempt}: kill hit the SUBMITTING window ({sub_but_no_venue} intent(s) UNKNOWN->FAILED, never resubmitted); retrying at a different point"));
        }
    }
    println!("{}", report.join("\n"));
    assert!(identical, "no attempt converged to the baseline ledger:\n{}", report.join("\n"));
}

// ------------------------------------------------------------------ halt mid run

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn halt_mid_run_blocks_new_entries_but_exits_still_fill() {
    let t = TestDb::new().await;
    let w = seed_world(&t, 1_000_000_000).await;
    enable_paper(&t, &w).await;
    let c = t.client().await;
    // build a position first (buys only), so that exits are covered
    for i in 0..6 {
        signal(&t, &w, &format!("pre-b{i}"), Side::Buy, 10, PX).await;
    }
    run_serve(&t, "pre", 21, 0).await;
    let pos: String = c.query_one("select coalesce(sum(qty),0)::text from positions where bucket_id=$1", &[&w.bucket]).await.unwrap().get(0);
    let pos: u128 = pos.parse().unwrap();
    assert!(pos >= 20 * LOT, "need a position to exit, got {pos}");
    // now a queue that interleaves buys and covered sells
    let mut buys = vec![];
    let mut sells = vec![];
    for i in 0..20 {
        buys.push(signal(&t, &w, &format!("h-b{i:02}"), Side::Buy, 3, PX).await);
        if i % 2 == 0 {
            sells.push(signal(&t, &w, &format!("h-s{i:02}"), Side::Sell, 2, PX * 99 / 100).await);
        }
    }
    let db = t.db(24);
    let d = Dispatcher::new(db.clone(), Arc::new(DbPaperVenue::new(db, 21)));
    let sd = Arc::new(Shutdown::default());
    let mut cf = cfg("halt-run");
    cf.step_delay_ms = 25;
    let h = tokio::spawn(serve::run(d, cf, sd));
    // wait for the run to be demonstrably mid-way, then the operator halts (set_global_state: also what Emergency stop calls)
    let t0 = Instant::now();
    loop {
        let done: i64 = c.query_one("select count(*) from trade_intents where idempotency_key like 'feed:h-%' and state in ('RECONCILED','FAILED','CANCELLED','EXPIRED')", &[]).await.unwrap().get(0);
        if done >= 8 || t0.elapsed() > Duration::from_secs(30) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let done_at_halt: i64 = c.query_one("select count(*) from trade_intents where idempotency_key like 'feed:h-%' and state in ('RECONCILED','FAILED','CANCELLED','EXPIRED')", &[]).await.unwrap().get(0);
    println!("done at halt: {done_at_halt} after {:?}", t0.elapsed());
    let c2 = t.client().await;
    c2.batch_execute("begin; select set_config('apex.service','on',true)").await.unwrap();
    c2.execute("select set_global_state($1,'emergency_stopped','test halt')", &[&w.ws]).await.unwrap();
    c2.batch_execute("commit").await.unwrap();
    let halted_at: chrono_like::Ts = c2.query_one("select extract(epoch from clock_timestamp())::float8", &[]).await.unwrap().get::<_, f64>(0).into();
    h.await.unwrap().unwrap();

    // 1) no BUY was submitted after the halt was committed
    let late_buy_submits: i64 = c
        .query_one(
            "select count(*) from order_events e join trade_intents t on t.id = e.intent_id where t.side='buy' and e.to_state='SUBMITTING' and extract(epoch from e.created_at)::float8 > $1",
            &[&halted_at.0],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(late_buy_submits, 0, "a buy was submitted after the halt");
    let late_buy_fills: i64 = c
        .query_one("select count(*) from fills f join trade_intents t on t.id = f.intent_id where t.side='buy' and t.idempotency_key like 'feed:h-%' and extract(epoch from f.created_at)::float8 > $1", &[&halted_at.0])
        .await
        .unwrap()
        .get(0);
    // (a fill can only be applied after the halt for an order submitted before it; the serve loop is sequential per group, so none is in flight)
    println!("buy fills applied after the halt: {late_buy_fills}");
    // 2) every h-buy created after the halt is FAILED (vetoed) or CANCELLED, never filled
    let filled_pending_buys: i64 = c.query_one("select count(*) from trade_intents t where t.side='buy' and t.idempotency_key like 'feed:h-%' and exists (select 1 from fills f where f.intent_id=t.id) and not exists (select 1 from order_events e where e.intent_id=t.id and e.to_state='SUBMITTING' and extract(epoch from e.created_at)::float8 <= $1)", &[&halted_at.0]).await.unwrap().get(0);
    assert_eq!(filled_pending_buys, 0);
    let blocked: i64 = c.query_one("select count(*) from trade_intents t where t.side='buy' and t.idempotency_key like 'feed:h-%' and t.state in ('FAILED','CANCELLED')", &[]).await.unwrap().get(0);
    assert!(blocked >= 5, "halt should have stopped a good share of the queued entries, blocked {blocked}");
    // 3) exits queued before/after the halt still executed: sells that were processed after the halt were admitted via the exit path
    let late_sell_fills: i64 = c
        .query_one("select count(*) from fills f join trade_intents t on t.id = f.intent_id where t.side='sell' and t.idempotency_key like 'feed:h-%' and extract(epoch from f.created_at)::float8 > $1", &[&halted_at.0])
        .await
        .unwrap()
        .get(0);
    assert!(late_sell_fills >= 1, "exits must still be allowed after the halt");
    let exit_admits: i64 = c.query_one("select count(*) from risk_decisions where reasons->0->>'code' = 'ADMIT_EXIT_PATH'", &[]).await.unwrap().get(0);
    assert!(exit_admits >= 1);
    let live: i64 = c.query_one("select count(*) from trade_intents where state not in ('RECONCILED','FAILED','CANCELLED','EXPIRED')", &[]).await.unwrap().get(0);
    assert_eq!(live, 0, "everything drained or refused");
    assert_clean(&c, w.ws).await;
    let paper_running: bool = c.query_one("select paper_running from workspace_settings where workspace_id=$1", &[&w.ws]).await.unwrap().get(0);
    assert!(!paper_running, "emergency stop switches the paper engine flag off");
    println!("halt: {late_sell_fills} exit fills after halt, {blocked} entries blocked, 0 entry submits after halt");
}

mod chrono_like {
    pub struct Ts(pub f64);
    impl From<f64> for Ts {
        fn from(v: f64) -> Ts {
            Ts(v)
        }
    }
}

// ------------------------------------------------------------------ UNKNOWN is never resubmitted

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn submitting_without_a_venue_record_is_unknown_never_resubmitted_by_serve() {
    let t = TestDb::new().await;
    let w = seed_world(&t, 1_000_000_000).await;
    enable_paper(&t, &w).await;
    let c = t.client().await;
    let id = signal(&t, &w, "unk-1", Side::Buy, 5, PX).await;
    // a previous process wrote SUBMITTING and died before calling the venue
    let db = t.db(8);
    let d = Dispatcher::new(db.clone(), Arc::new(DbPaperVenue::new(db, 3)));
    let r = d.drive(id, DriveOpts { stop_at: Some(apex_execution::OrderState::Submitting), ..Default::default() }).await.unwrap();
    assert!(matches!(r.outcome, Outcome::Blocked(apex_execution::OrderState::Submitting)));
    assert_eq!(state_of(&c, id).await, "SUBMITTING");
    let ctr = run_serve(&t, "unk", 3, 0).await;
    assert_eq!(state_of(&c, id).await, "FAILED", "UNKNOWN is resolved only by authoritative reconciliation");
    let trail: Vec<String> = c.query("select to_state from order_events where intent_id=$1 order by id", &[&id]).await.unwrap().iter().map(|r| r.get(0)).collect();
    assert!(trail.contains(&"UNKNOWN".to_string()) && !trail.contains(&"ACKNOWLEDGED".to_string()), "{trail:?}");
    let venue_orders: i64 = c.query_one("select count(*) from paper_venue_orders", &[]).await.unwrap().get(0);
    assert_eq!(venue_orders, 0, "the order must never have been (re)submitted");
    assert_eq!(ctr.get("reconciled_unknown"), 1);
    assert_clean(&c, w.ws).await;
}
