use crate::state::{IllegalTransition, OrderState};
use crate::venue::VenueError;

#[derive(Debug, thiserror::Error)]
pub enum ExecError {
    #[error("db: {0}")]
    Db(#[from] tokio_postgres::Error),
    #[error("pool: {0}")]
    Pool(String),
    #[error("risk: {0}")]
    Risk(#[from] apex_risk::db::RiskDbError),
    #[error("venue: {0}")]
    Venue(#[from] VenueError),
    #[error("{0}")]
    Illegal(#[from] IllegalTransition),
    #[error("injected crash at checkpoint {0}")]
    Crash(usize),
    #[error("intent {0} is in unexpected state {1}")]
    UnexpectedState(uuid::Uuid, OrderState),
    #[error("{0}")]
    Other(String),
}

impl ExecError {
    pub fn sqlstate(&self) -> Option<String> {
        match self {
            ExecError::Db(e) => e.code().map(|c| c.code().to_string()),
            ExecError::Risk(apex_risk::db::RiskDbError::Db(e)) => e.code().map(|c| c.code().to_string()),
            _ => None,
        }
    }
    /// deadlock / serialization failure: safe to retry because every DB operation here is idempotent.
    pub fn is_retryable(&self) -> bool {
        matches!(self.sqlstate().as_deref(), Some("40P01") | Some("40001"))
    }
    /// non_negative / budget check violations => insufficient funds
    pub fn is_insufficient_funds(&self) -> bool {
        matches!(self.sqlstate().as_deref(), Some("23514"))
    }
    pub fn message(&self) -> String {
        match self {
            ExecError::Db(e) => e.as_db_error().map(|d| d.message().to_string()).unwrap_or_else(|| e.to_string()),
            other => other.to_string(),
        }
    }
}
