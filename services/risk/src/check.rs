//! The independent risk gate. Pure, deterministic, no I/O. Output is a typed ADMIT/VETO.
//!
//! Rules (spec sections 8 and 15):
//! * Entries are vetoed when global state is not `active`, when the bucket is not active, when data is
//!   degraded, when the quote is stale, and for every limit breach. All breaches are collected (no short-circuit)
//!   so the operator sees the full reason list.
//! * Risk-reducing exits (`reduces_exposure == true` and side Sell; the caller must derive this from the
//!   authoritative position, never from strategy/LLM input) bypass entry-only checks (global/bucket halt, data
//!   health, notional/concentration/fee-edge/unknown-order/failed-tx/allowlist limits). They remain subject to the
//!   quote-age and slippage ceilings because a stale or absurdly-priced order is not "safe" merely for being a sell.
//! * There is no API to turn a VETO into an ADMIT. A persisted VETO is sticky (see `db::record_decision`).

use crate::policy::Policy;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum GlobalState {
    Active,
    HaltNewEntries,
    ExitOnly,
    EmergencyStopped,
}
impl GlobalState {
    /// Unknown strings fail closed to the most restrictive state.
    pub fn parse(s: &str) -> GlobalState {
        match s {
            "active" => GlobalState::Active,
            "halt_new_entries" => GlobalState::HaltNewEntries,
            "exit_only" => GlobalState::ExitOnly,
            _ => GlobalState::EmergencyStopped,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            GlobalState::Active => "active",
            GlobalState::HaltNewEntries => "halt_new_entries",
            GlobalState::ExitOnly => "exit_only",
            GlobalState::EmergencyStopped => "emergency_stopped",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DataHealth {
    Healthy,
    /// Any of risk / fee / chain / market-data / ML services degraded.
    Degraded,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Side {
    Buy,
    Sell,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RiskInput {
    pub side: Side,
    pub asset_key: String,
    /// Quote base units.
    pub notional: u128,
    /// Bucket value in quote base units (available + reserved).
    pub bucket_value: u128,
    pub slippage_bps: u32,
    pub quote_age_ms: u64,
    pub data_health: DataHealth,
    /// Total round-trip fee in bps of notional (entry + exit).
    pub total_fee_bps: u32,
    /// Expected gross edge in bps of notional (may be <= 0).
    pub expected_edge_bps: i64,
    /// Exposure to `asset_key` after this trade, bps of bucket value.
    pub post_trade_concentration_bps: u32,
    pub failed_tx_rate_bps: u32,
    pub open_unknown_orders: u32,
    pub global_state: GlobalState,
    pub bucket_active: bool,
    /// Verified by the caller against the authoritative position: this order only reduces existing exposure.
    pub reduces_exposure: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", content = "detail", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum VetoReason {
    GlobalStateBlocksEntries(String),
    BucketNotActive,
    EntriesDisabledByPolicy,
    DataDegraded,
    QuoteStale { age_ms: u64, max_ms: u64 },
    SlippageTooHigh { bps: u32, max_bps: u32 },
    OrderTooLarge { notional_bps: u128, max_bps: u32 },
    BucketEmpty,
    FeeCeilingExceeded { fee_bps: u32, edge_bps: i64, max_fee_to_edge_bps: u32 },
    NoPositiveEdge { edge_bps: i64 },
    ConcentrationExceeded { bps: u32, max_bps: u32 },
    FailedTxRateTooHigh { bps: u32, max_bps: u32 },
    UnknownOrdersOpen { open: u32, max: u32 },
    AssetBlacklisted(String),
    AssetNotAllowlisted(String),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Decision {
    Admit { exit_path: bool },
    Veto(Vec<VetoReason>),
}

impl Decision {
    pub fn is_admit(&self) -> bool {
        matches!(self, Decision::Admit { .. })
    }
    pub fn as_db_str(&self) -> &'static str {
        if self.is_admit() {
            "ADMIT"
        } else {
            "VETO"
        }
    }
    /// JSON array stored in `risk_decisions.reasons`.
    pub fn reasons_json(&self) -> serde_json::Value {
        match self {
            Decision::Admit { exit_path } => {
                serde_json::json!([{ "code": if *exit_path { "ADMIT_EXIT_PATH" } else { "ADMIT_ALL_CHECKS_PASSED" } }])
            }
            Decision::Veto(rs) => serde_json::to_value(rs).expect("serialize reasons"),
        }
    }
}

/// Evaluate `input` against a fully resolved `policy`.
pub fn evaluate(policy: &Policy, i: &RiskInput) -> Decision {
    let mut v: Vec<VetoReason> = Vec::new();
    let exit = i.reduces_exposure && i.side == Side::Sell;

    // Checks that apply to every order, exits included.
    if i.quote_age_ms > policy.max_quote_age_ms {
        v.push(VetoReason::QuoteStale { age_ms: i.quote_age_ms, max_ms: policy.max_quote_age_ms });
    }
    if i.slippage_bps > policy.max_slippage_bps {
        v.push(VetoReason::SlippageTooHigh { bps: i.slippage_bps, max_bps: policy.max_slippage_bps });
    }

    if !exit {
        if i.global_state != GlobalState::Active {
            v.push(VetoReason::GlobalStateBlocksEntries(i.global_state.as_str().to_string()));
        }
        if !i.bucket_active {
            v.push(VetoReason::BucketNotActive);
        }
        if !policy.entries_enabled {
            v.push(VetoReason::EntriesDisabledByPolicy);
        }
        if i.data_health != DataHealth::Healthy {
            v.push(VetoReason::DataDegraded);
        }
        if i.bucket_value == 0 {
            v.push(VetoReason::BucketEmpty);
        } else {
            // ceil so that rounding can never let an oversize order through
            let bps = (i.notional.saturating_mul(10_000) + i.bucket_value - 1) / i.bucket_value;
            if bps > policy.max_order_notional_bps_of_bucket as u128 {
                v.push(VetoReason::OrderTooLarge { notional_bps: bps, max_bps: policy.max_order_notional_bps_of_bucket });
            }
        }
        if i.expected_edge_bps <= 0 {
            v.push(VetoReason::NoPositiveEdge { edge_bps: i.expected_edge_bps });
        } else {
            // fees * 10_000 > edge * max_fee_to_edge  (exact integer comparison, no rounding)
            let lhs = (i.total_fee_bps as i128) * 10_000;
            let rhs = (i.expected_edge_bps as i128) * (policy.max_fee_to_edge_bps as i128);
            if lhs > rhs {
                v.push(VetoReason::FeeCeilingExceeded {
                    fee_bps: i.total_fee_bps,
                    edge_bps: i.expected_edge_bps,
                    max_fee_to_edge_bps: policy.max_fee_to_edge_bps,
                });
            }
        }
        if i.post_trade_concentration_bps > policy.max_concentration_bps {
            v.push(VetoReason::ConcentrationExceeded { bps: i.post_trade_concentration_bps, max_bps: policy.max_concentration_bps });
        }
        if i.failed_tx_rate_bps > policy.max_failed_tx_rate_bps {
            v.push(VetoReason::FailedTxRateTooHigh { bps: i.failed_tx_rate_bps, max_bps: policy.max_failed_tx_rate_bps });
        }
        if i.open_unknown_orders > policy.max_open_unknown_orders {
            v.push(VetoReason::UnknownOrdersOpen { open: i.open_unknown_orders, max: policy.max_open_unknown_orders });
        }
        if policy.blacklist.contains(&i.asset_key) {
            v.push(VetoReason::AssetBlacklisted(i.asset_key.clone()));
        }
        if let Some(al) = &policy.allowlist {
            if !al.contains(&i.asset_key) {
                v.push(VetoReason::AssetNotAllowlisted(i.asset_key.clone()));
            }
        }
    }

    if v.is_empty() {
        Decision::Admit { exit_path: exit }
    } else {
        Decision::Veto(v)
    }
}
