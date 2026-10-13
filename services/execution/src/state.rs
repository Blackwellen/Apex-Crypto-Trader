//! Typed order-state machine. `ALLOWED` is the Rust mirror of `allowed_transitions` (migration 0003); an integration
//! test asserts the two sets are EQUAL (parsed from the SQL file and read from a freshly migrated database), so any
//! drift fails CI. The authoritative enforcement is still `advance_intent` in Postgres - this type gives the
//! dispatcher compile-time-checked states and lets it refuse an illegal move before it reaches the DB.

use std::fmt;

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum OrderState {
    Signal,
    Candidate,
    RiskEvaluating,
    Admitted,
    CapitalReserved,
    Quoted,
    Prepared,
    ApprovalWait,
    Submitting,
    Acknowledged,
    Unknown,
    PartiallyFilled,
    Filled,
    Cancelled,
    Expired,
    Failed,
    Settling,
    Final,
    Reorged,
    Disputed,
    Reconciled,
    LedgerApplied,
    CompoundingEligible,
}

use OrderState::*;

pub const ALL_STATES: [OrderState; 23] = [
    Signal, Candidate, RiskEvaluating, Admitted, CapitalReserved, Quoted, Prepared, ApprovalWait, Submitting, Acknowledged,
    Unknown, PartiallyFilled, Filled, Cancelled, Expired, Failed, Settling, Final, Reorged, Disputed, Reconciled,
    LedgerApplied, CompoundingEligible,
];

/// Mirror of every row inserted into `allowed_transitions` by the migrations (0003, plus the pre-submit CANCELLED
/// moves added by 0244).
pub const ALLOWED: &[(OrderState, OrderState)] = &[
    (Signal, Candidate),
    (Candidate, RiskEvaluating),
    (RiskEvaluating, Admitted),
    (RiskEvaluating, Failed),
    (Admitted, CapitalReserved),
    (Admitted, Failed),
    (CapitalReserved, Quoted),
    (CapitalReserved, Failed),
    (Quoted, Prepared),
    (Quoted, Expired),
    (Quoted, Failed),
    (Prepared, ApprovalWait),
    (Prepared, Submitting),
    (Prepared, Failed),
    (ApprovalWait, Submitting),
    (ApprovalWait, Cancelled),
    (ApprovalWait, Expired),
    (Submitting, Acknowledged),
    (Submitting, Unknown),
    (Submitting, Failed),
    (Unknown, Acknowledged),
    (Unknown, Failed),
    (Unknown, Cancelled),
    (Unknown, Filled),
    (Unknown, PartiallyFilled),
    (Acknowledged, PartiallyFilled),
    (Acknowledged, Filled),
    (Acknowledged, Cancelled),
    (Acknowledged, Expired),
    (Acknowledged, Failed),
    (PartiallyFilled, PartiallyFilled),
    (PartiallyFilled, Filled),
    (PartiallyFilled, Cancelled),
    (Filled, Settling),
    (Cancelled, Settling),
    (Expired, Settling),
    (Failed, Settling),
    (Settling, Final),
    (Settling, Reorged),
    (Settling, Disputed),
    (Reorged, Settling),
    (Disputed, Settling),
    (Final, Reconciled),
    (Reconciled, LedgerApplied),
    (LedgerApplied, CompoundingEligible),
    // migration 0244: cancelling BEFORE submission is legal
    (Signal, Cancelled),
    (Candidate, Cancelled),
    (RiskEvaluating, Cancelled),
    (Admitted, Cancelled),
    (CapitalReserved, Cancelled),
    (Quoted, Cancelled),
    (Prepared, Cancelled),
];

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("illegal transition {0} -> {1}")]
pub struct IllegalTransition(pub OrderState, pub OrderState);

impl OrderState {
    pub fn as_str(self) -> &'static str {
        match self {
            Signal => "SIGNAL",
            Candidate => "CANDIDATE",
            RiskEvaluating => "RISK_EVALUATING",
            Admitted => "ADMITTED",
            CapitalReserved => "CAPITAL_RESERVED",
            Quoted => "QUOTED",
            Prepared => "PREPARED",
            ApprovalWait => "APPROVAL_WAIT",
            Submitting => "SUBMITTING",
            Acknowledged => "ACKNOWLEDGED",
            Unknown => "UNKNOWN",
            PartiallyFilled => "PARTIALLY_FILLED",
            Filled => "FILLED",
            Cancelled => "CANCELLED",
            Expired => "EXPIRED",
            Failed => "FAILED",
            Settling => "SETTLING",
            Final => "FINAL",
            Reorged => "REORGED",
            Disputed => "DISPUTED",
            Reconciled => "RECONCILED",
            LedgerApplied => "LEDGER_APPLIED",
            CompoundingEligible => "COMPOUNDING_ELIGIBLE",
        }
    }
    pub fn parse(s: &str) -> Option<OrderState> {
        ALL_STATES.iter().copied().find(|st| st.as_str() == s)
    }
    pub fn can_transition_to(self, to: OrderState) -> bool {
        ALLOWED.iter().any(|&(f, t)| f == self && t == to)
    }
    /// Typed transition: returns the new state or an error. Never panics.
    pub fn transition(self, to: OrderState) -> Result<OrderState, IllegalTransition> {
        if self.can_transition_to(to) {
            Ok(to)
        } else {
            Err(IllegalTransition(self, to))
        }
    }
    /// States where the order's economic outcome is decided (funds either spent or to be released).
    pub fn is_outcome(self) -> bool {
        matches!(self, Filled | Cancelled | Expired | Failed)
    }
    /// States owned by the post-trade settlement/reconciliation pipeline (not by the dispatcher).
    pub fn is_post_trade(self) -> bool {
        matches!(self, Settling | Final | Reorged | Disputed | Reconciled | LedgerApplied | CompoundingEligible)
    }
}

impl fmt::Display for OrderState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}
