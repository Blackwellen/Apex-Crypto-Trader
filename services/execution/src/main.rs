//! `apex-execution` binary.
//!   apex-execution recover     replay every non-terminal intent against the PAPER venue, print a JSON summary
//!   apex-execution unknown     list intents parked in UNKNOWN (need reconciliation)
//! Env: DATABASE_URL (required), APEX_PAPER_SEED (default 42).
//! This binary has no live mode. Live submission is not implemented (see `venue::LiveVenue`).
use apex_execution::{db::Db, dispatcher::{Dispatcher, DriveOpts}, paper::{PaperConfig, PaperVenue}};
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
        "unknown" => {
            for id in d.unknown_intents().await? {
                println!("{id}");
            }
        }
        other => anyhow::bail!("unknown command {other}"),
    }
    Ok(())
}
