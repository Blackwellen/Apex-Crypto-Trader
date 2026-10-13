//! Persistence for risk decisions and policy loading, through the DB's own tables.
//! `advance_intent` (SQL) independently refuses ADMITTED without an ADMIT row and with any VETO row, so a
//! strategy/LLM cannot route around the gate.

use crate::check::Decision;
use crate::policy::{Level, Policy, PolicyError, PolicyLayer};
use tokio_postgres::GenericClient;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum RiskDbError {
    #[error("database: {0}")]
    Db(#[from] tokio_postgres::Error),
    #[error("policy: {0}")]
    Policy(#[from] PolicyError),
    #[error("not found: {0}")]
    NotFound(&'static str),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Recorded {
    /// "ADMIT" or "VETO" - the EFFECTIVE decision on record (a prior row always wins; VETO beats ADMIT).
    pub decision: String,
    pub inserted: bool,
}

/// Persist a decision exactly once per intent. If a decision already exists it is returned unchanged; in
/// particular a stored VETO can never be replaced by a later ADMIT (the lock on the intent row serialises racers).
pub async fn record_decision<C: GenericClient>(
    c: &C,
    intent: Uuid,
    workspace: Uuid,
    decision: &Decision,
    policy_version: i32,
    evaluator: &str,
) -> Result<Recorded, RiskDbError> {
    c.query_one("select id from trade_intents where id = $1 for update", &[&intent]).await?;
    let existing = c
        .query(
            "select decision from risk_decisions where intent_id = $1 order by (decision = 'VETO') desc, created_at limit 1",
            &[&intent],
        )
        .await?;
    if let Some(r) = existing.first() {
        return Ok(Recorded { decision: r.get(0), inserted: false });
    }
    c.execute(
        "insert into risk_decisions(intent_id, workspace_id, decision, reasons, policy_version, evaluator) values ($1,$2,$3,$4,$5,$6)",
        &[&intent, &workspace, &decision.as_db_str(), &decision.reasons_json(), &policy_version, &evaluator],
    )
    .await?;
    Ok(Recorded { decision: decision.as_db_str().to_string(), inserted: true })
}

/// Load the stored hierarchy that exists in the DB today: global (workspace_settings.global_limits) then the
/// bucket policy; `extra` carries wallet/basket/strategy/order layers supplied by the caller (tighten-only).
/// Returns the resolved policy and the bucket policy version recorded in `risk_decisions.policy_version`.
pub async fn load_policy<C: GenericClient>(
    c: &C,
    workspace: Uuid,
    bucket: Uuid,
    extra: &[(Level, PolicyLayer)],
) -> Result<(Policy, i32), RiskDbError> {
    let g = c
        .query_opt("select global_limits from workspace_settings where workspace_id = $1", &[&workspace])
        .await?
        .ok_or(RiskDbError::NotFound("workspace_settings"))?;
    let gl: serde_json::Value = g.get(0);
    let root = Policy::global_from_json(&gl)?;
    let b = c
        .query_opt("select policy, policy_version from buckets where id = $1 and workspace_id = $2", &[&bucket, &workspace])
        .await?
        .ok_or(RiskDbError::NotFound("bucket"))?;
    let bp: serde_json::Value = b.get(0);
    let ver: i32 = b.get(1);
    let mut layers = vec![(Level::Bucket, PolicyLayer::from_json(&bp)?)];
    layers.extend(extra.iter().cloned());
    Ok((Policy::resolve(&root, &layers), ver))
}
