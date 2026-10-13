//! Measurements, not estimates. Ignored by default; run in release:
//!   cargo test --release -p apex-execution --test bench -- --ignored --nocapture
//! Prints a report that is pasted verbatim into docs/evidence/rust-benchmarks.md.
mod common;
use apex_execution::dispatcher::*;
use apex_execution::paper::book::Book;
use apex_execution::paper::{PaperConfig, PaperExchange};
use apex_execution::venue::*;
use apex_risk::*;
use common::*;
use std::hint::black_box;
use std::time::Instant;

fn pct(v: &mut Vec<u64>, p: f64) -> u64 {
    v.sort_unstable();
    v[((v.len() as f64 - 1.0) * p).round() as usize]
}
fn dist(label: &str, v: &mut Vec<u64>, unit: &str) {
    let n = v.len();
    let mean = v.iter().sum::<u64>() as f64 / n as f64;
    println!("| {label} | {n} | {mean:.0} | {} | {} | {} | {} | {unit} |", pct(v, 0.5), pct(v, 0.99), pct(v, 0.999), v[n - 1]);
}

fn sample_input() -> (Policy, RiskInput) {
    let p = Policy::conservative_defaults().tighten(&PolicyLayer { max_slippage_bps: Some(80), blacklist: Some(["SCAM".to_string()].into()), allowlist: Some(["ETH".to_string(), "BTC".to_string()].into()), ..Default::default() });
    let i = RiskInput {
        side: Side::Buy,
        asset_key: "ETH".into(),
        notional: 20_000_000,
        bucket_value: 1_000_000_000,
        slippage_bps: 10,
        quote_age_ms: 100,
        data_health: DataHealth::Healthy,
        total_fee_bps: 50,
        expected_edge_bps: 200,
        post_trade_concentration_bps: 500,
        failed_tx_rate_bps: 0,
        open_unknown_orders: 0,
        global_state: GlobalState::Active,
        bucket_active: true,
        reduces_exposure: false,
    };
    (p, i)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore]
async fn bench_report() {
    println!("\n## RAW OUTPUT");
    println!("build: {}", if cfg!(debug_assertions) { "DEBUG (numbers not meaningful!)" } else { "release" });

    // ---------------- timer overhead baseline
    let mut base: Vec<u64> = (0..200_000).map(|_| { let t = Instant::now(); black_box(()); t.elapsed().as_nanos() as u64 }).collect();
    println!("\n| metric | samples | mean | p50 | p99 | p99.9 | max | unit |\n|---|---|---|---|---|---|---|---|");
    dist("Instant::now()+elapsed() overhead (baseline)", &mut base, "ns");

    // ---------------- risk gate, in-process, pure
    let (p, i) = sample_input();
    assert!(evaluate(&p, &i).is_admit());
    let mut lat: Vec<u64> = Vec::with_capacity(500_000);
    for _ in 0..500_000 {
        let t = Instant::now();
        let d = evaluate(black_box(&p), black_box(&i));
        let e = t.elapsed().as_nanos() as u64;
        black_box(d);
        lat.push(e);
    }
    dist("risk evaluate() per call (ADMIT path, includes timer overhead)", &mut lat, "ns");
    let mut veto_in = i.clone();
    veto_in.quote_age_ms = 9_999;
    veto_in.global_state = GlobalState::HaltNewEntries;
    veto_in.data_health = DataHealth::Degraded;
    let mut lat: Vec<u64> = Vec::with_capacity(500_000);
    for _ in 0..500_000 {
        let t = Instant::now();
        let d = evaluate(black_box(&p), black_box(&veto_in));
        let e = t.elapsed().as_nanos() as u64;
        black_box(d);
        lat.push(e);
    }
    dist("risk evaluate() per call (VETO path, 3 reasons allocated)", &mut lat, "ns");
    let n = 5_000_000u64;
    let t = Instant::now();
    for _ in 0..n {
        black_box(evaluate(black_box(&p), black_box(&i)));
    }
    let el = t.elapsed();
    println!("\nrisk evaluate() batch: {n} calls in {:.3}s = {:.1} ns/call = {:.2} M checks/s (single thread, no per-call timer)", el.as_secs_f64(), el.as_nanos() as f64 / n as f64, n as f64 / el.as_secs_f64() / 1e6);
    let layers: Vec<(Level, PolicyLayer)> = vec![
        (Level::Bucket, PolicyLayer { max_slippage_bps: Some(90), ..Default::default() }),
        (Level::Wallet, PolicyLayer { max_quote_age_ms: Some(1500), ..Default::default() }),
        (Level::Strategy, PolicyLayer { blacklist: Some(["SCAM".to_string()].into()), ..Default::default() }),
        (Level::Order, PolicyLayer { max_order_notional_bps_of_bucket: Some(500), ..Default::default() }),
    ];
    let t = Instant::now();
    for _ in 0..1_000_000 {
        black_box(Policy::resolve(black_box(&p), black_box(&layers)));
    }
    println!("policy resolve (4 layers incl. clone): {:.0} ns/call", t.elapsed().as_nanos() as f64 / 1e6);

    // ---------------- matcher
    let t = Instant::now();
    let mut ex = PaperExchange::new(PaperConfig::default());
    let n = 2_000_000u32;
    ex.advance(n);
    let el = t.elapsed();
    println!(
        "\npaper exchange step_market (synthetic event generation + matching + canonical log line + SHA-256): {} events in {:.3}s = {:.0} events/s ({:.0} ns/event); log lines hashed: {}",
        n, el.as_secs_f64(), n as f64 / el.as_secs_f64(), el.as_nanos() as f64 / n as f64, ex.log.count
    );
    // book only: ping-pong aggressive orders against a deep book (no hashing/formatting)
    let mut b = Book::default();
    for lvl in 1..=50u128 {
        for k in 0..20u64 { b.rest(lvl as u64 * 100 + k, Side::Sell, 10_000 + lvl, 1_000_000); b.rest(1_000_000 + lvl as u64 * 100 + k, Side::Buy, 10_000 - lvl, 1_000_000); }
    }
    let t = Instant::now();
    let mut trades = 0u64;
    let mut id = 10_000_000u64;
    let reps = 3_000_000u64;
    for r in 0..reps {
        id += 1;
        let side = if r % 2 == 0 { Side::Buy } else { Side::Sell };
        let m = b.match_order(id, side, None, 1_500_000);
        trades += m.trades.len() as u64;
        // replenish the consumed liquidity at the touch so depth stays constant
        for t in &m.trades { id += 1; let (s, px) = if side == Side::Buy { (Side::Sell, t.price) } else { (Side::Buy, t.price) }; b.rest(id, s, px, t.qty); }
    }
    let el = t.elapsed();
    println!("Book::match_order + replenish (price-time, no log/hash): {} aggressive orders, {} trades in {:.3}s = {:.2} M orders/s, {:.2} M trades/s", reps, trades, el.as_secs_f64(), reps as f64 / el.as_secs_f64() / 1e6, trades as f64 / el.as_secs_f64() / 1e6);
    let mut lat: Vec<u64> = Vec::with_capacity(100_000);
    let mut ex = PaperExchange::new(PaperConfig::default());
    for k in 0..100_000u32 {
        ex.advance(1);
        let px = ex.best_ask().unwrap() + 5 * ex.cfg.tick;
        let o = VenueOrder { client_order_id: format!("b{k}"), side: Side::Buy, price: px, qty: ex.cfg.lot, tif: Tif::Ioc };
        let t = Instant::now();
        let a = ex.place_order(&o);
        let e = t.elapsed().as_nanos() as u64;
        let _ = black_box(a);
        lat.push(e);
    }
    println!("\n| metric | samples | mean | p50 | p99 | p99.9 | max | unit |\n|---|---|---|---|---|---|---|---|");
    dist("PaperExchange::place_order IOC marketable (match + 1 fill + log/hash)", &mut lat, "ns");

    // ---------------- Postgres-backed pipeline (loopback, same host: NOT representative of a network deployment)
    let t = TestDb::new().await;
    let w = seed_world(&t, 50_000_000_000_000).await;
    set_global_limits(&t, w.ws, serde_json::json!({"max_order_notional_bps_of_bucket":2500,"max_slippage_bps":100,"max_quote_age_ms":2000,"max_concentration_bps":10000})).await;
    let v = new_venue(77, false);
    let d = std::sync::Arc::new(Dispatcher::new(t.db(48), v.clone()));
    let px = marketable_buy_px(&v);
    // risk decision DB round trip: load policy + evaluate + insert decision, rolled back so it repeats
    let id = d.create_intent(&spec(&w, "riskprobe", Side::Buy, 10, px, Tif::Ioc)).await.unwrap();
    let db = t.db(4);
    let mut lat: Vec<u64> = Vec::new();
    for _ in 0..500 {
        let tx = db.begin().await.unwrap();
        let t0 = Instant::now();
        let (pol, ver) = apex_risk::db::load_policy(tx.c(), w.ws, w.bucket, &[]).await.unwrap();
        let (_, inp) = sample_input();
        let dec = evaluate(&pol, &inp);
        apex_risk::db::record_decision(tx.c(), id, w.ws, &dec, ver, "bench").await.unwrap();
        lat.push(t0.elapsed().as_micros() as u64);
        tx.rollback().await;
    }
    dist("risk decision persisted: load_policy + evaluate + INSERT risk_decisions (loopback PG, 1 tx)", &mut lat, "us");

    let n_seq = 300;
    let mut lat: Vec<u64> = Vec::new();
    let t0 = Instant::now();
    for k in 0..n_seq {
        v.advance(25).await; // venue time passes between intents so the synthetic book is replenished
        let px = marketable_buy_px(&v);
        let id = d.create_intent(&spec(&w, &format!("seq-{k}"), Side::Buy, 10, px, Tif::Ioc)).await.unwrap();
        let s = Instant::now();
        let r = d.drive(id, DriveOpts::default()).await.unwrap();
        assert!(matches!(r.outcome, Outcome::Terminal(apex_execution::OrderState::Filled | apex_execution::OrderState::Cancelled)), "{r:?}");
        lat.push(s.elapsed().as_micros() as u64);
    }
    let el = t0.elapsed() - std::time::Duration::from_nanos(0);
    println!("\nsequential full pipeline (intent->risk->reserve->quote->submit(paper)->fill->settle): {n_seq} intents in {:.2}s = {:.1} intents/s", el.as_secs_f64(), n_seq as f64 / el.as_secs_f64());
    dist("drive() latency, one intent, sequential (loopback PG)", &mut lat, "us");

    let n_par = 600;
    let mut ids = Vec::new();
    for k in 0..n_par {
        if k % 10 == 0 { v.advance(25).await; }
        let px = marketable_buy_px(&v);
        ids.push(d.create_intent(&spec(&w, &format!("par-{k}"), Side::Buy, 10, px, Tif::Ioc)).await.unwrap());
    }
    let t0 = Instant::now();
    let hs: Vec<_> = ids.into_iter().map(|id| { let d = d.clone(); tokio::spawn(async move { d.drive(id, DriveOpts::default()).await.unwrap() }) }).collect();
    for h in hs { assert!(matches!(h.await.unwrap().outcome, Outcome::Terminal(_))); }
    let el = t0.elapsed();
    println!("\nconcurrent full pipeline (24 concurrent drivers, pool 48): {n_par} intents in {:.2}s = {:.1} intents/s", el.as_secs_f64(), n_par as f64 / el.as_secs_f64());
    let c = t.client().await;
    assert_conserved(&c, w.ws).await;
    println!("ledger conservation after benchmark: OK");
}
