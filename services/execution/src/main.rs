//! `apex-execution` binary.
//!   apex-execution recover     replay every non-terminal intent against the PAPER venue, print a JSON summary
//!   apex-execution unknown     list intents parked in UNKNOWN (need reconciliation)
//!   apex-execution serve       long-running supervised PAPER loop (see `serve.rs`); SIGTERM/SIGINT = graceful stop
//!   apex-execution drain       like serve, but exits once nothing has progressed for APEX_SERVE_IDLE_MS (default 3000)
//! Env: DATABASE_URL (required), APEX_PAPER_SEED (default 42), APEX_SERVE_POLL_MS (500), APEX_SERVE_GROUPS (4), APEX_SERVE_INSTANCE,
//!      APEX_SERVE_STEP_DELAY_MS (test knob, 0), APEX_SERVE_METRICS_MS (10000).
//! This binary has no live mode. Live submission is not implemented (see `venue::LiveVenue`).
use apex_execution::{db::Db, dbvenue::DbPaperVenue, dispatcher::{Dispatcher, DriveOpts}, paper::{PaperConfig, PaperVenue}, serve::{self, ServeConfig, Shutdown}};
use std::sync::Arc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let url = std::env::var("DATABASE_URL").map_err(|_| anyhow::anyhow!("DATABASE_URL is required"))?;
    let seed: u64 = std::env::var("APEX_PAPER_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(42);
    let cmd = std::env::args().nth(1).unwrap_or_else(|| "recover".into());
    let db = Db::connect(&url, 8)?;
    // A freshly started paper venue has no memory of earlier orders and (correctly) does not claim authoritative absence,
    // so intents that were mid-flight stay UNKNOWN until reconciled rather than being failed or resubmitted.
    let venue = Arc::new(PaperVenue::new(PaperConfig { seed, ..Default::default() }).with_non_authoritative_absence());
    let d = Dispatcher::new(db, venue);
    match cmd.as_str() {
        "recover" => {
            let res = d.recover(DriveOpts::default()).await?;
            let rows: Vec<_> = res.iter().map(|(id, r)| serde_json::json!({"intent": id, "outcome": format!("{:?}", r.outcome), "steps": r.steps})).collect();
            println!("{}", serde_json::json!({"recovered": rows.len(), "intents": rows}));
        }
        "serve" | "drain" => {
            // `serve` uses the DB-backed deterministic paper venue (survives kill -9); the in-memory venue above is for `recover`/tests.
            let env_u64 = |k: &str, d: u64| std::env::var(k).ok().and_then(|s| s.parse().ok()).unwrap_or(d);
            let groups = env_u64("APEX_SERVE_GROUPS", 4) as usize;
            let db = Db::connect(&url, groups * 5 + 4)?;
            let venue = Arc::new(DbPaperVenue::new(db.clone(), seed));
            let d = Dispatcher::new(db, venue);
            let mut cfg = ServeConfig::default();
            cfg.poll_ms = env_u64("APEX_SERVE_POLL_MS", 500);
            cfg.groups_parallel = groups;
            cfg.step_delay_ms = env_u64("APEX_SERVE_STEP_DELAY_MS", 0);
            cfg.metrics_every_ms = env_u64("APEX_SERVE_METRICS_MS", 10_000);
            if let Ok(i) = std::env::var("APEX_SERVE_INSTANCE") {
                cfg.instance = i;
            }
            if cmd == "drain" {
                cfg.exit_when_idle_ms = Some(env_u64("APEX_SERVE_IDLE_MS", 3_000));
            }
            let sd = Arc::new(Shutdown::default());
            {
                let sd = sd.clone();
                tokio::spawn(async move {
                    use tokio::signal::unix::{signal, SignalKind};
                    let mut term = signal(SignalKind::terminate()).expect("sigterm handler");
                    tokio::select! { _ = term.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
                    eprintln!("{}", serde_json::json!({"event": "signal", "action": "graceful shutdown"}));
                    sd.trigger();
                });
            }
            serve::run(d, cfg, sd).await?;
        }
        "unknown" => {
            for id in d.unknown_intents().await? {
                println!("{id}");
            }
        }
        other => anyhow::bail!("unknown command {other}"),
    }
    Ok(())
}
