//! Fee / economics engine. Round-trip net expected value, integer arithmetic only (quote base units, bps).
//!
//!   net_ev = edge - entry_fee - exit_fee - slippage(entry+exit) - gas/priority(entry+exit)
//!            - P(failed tx) * cost(failed tx) * legs - adverse_selection
//!
//! Rounding is always CONSERVATIVE: the edge is rounded down, every cost is rounded up. Nothing here is a
//! prediction of profit; `expected_edge_bps` is an input supplied by a strategy and is only as good as that model.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EconomicsInput {
    /// Entry-leg notional in quote base units.
    #[serde(with = "crate::u128s")]
    pub notional: u128,
    /// Gross expected edge in bps of notional (may be negative).
    pub expected_edge_bps: i64,
    pub entry_fee_bps: u32,
    pub exit_fee_bps: u32,
    pub entry_slippage_bps: u32,
    pub exit_slippage_bps: u32,
    /// Gas / priority fee in quote base units for the entry and exit transactions (0 for CEX).
    #[serde(with = "crate::u128s")]
    pub gas_entry_quote: u128,
    #[serde(with = "crate::u128s")]
    pub gas_exit_quote: u128,
    /// Probability (bps) that a transaction fails and burns its cost.
    pub failed_tx_prob_bps: u32,
    #[serde(with = "crate::u128s")]
    pub failed_tx_cost_quote: u128,
    /// Number of transactions in the round trip exposed to failure (entry + exit = 2).
    pub tx_legs: u32,
    pub adverse_selection_bps: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EconomicsConfig {
    /// Required net EV margin (bps of notional); the quote is rejected below it.
    pub min_net_ev_bps: i64,
    /// Max total fees (entry+exit, bps of notional) as a share of the gross edge, in bps (10_000 = 100%).
    pub max_fee_share_of_edge_bps: u32,
}
impl Default for EconomicsConfig {
    fn default() -> Self {
        EconomicsConfig { min_net_ev_bps: 1, max_fee_share_of_edge_bps: 5_000 }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Economics {
    pub gross_edge: i128,
    pub entry_fee: i128,
    pub exit_fee: i128,
    pub slippage: i128,
    pub gas: i128,
    pub failed_tx_expected: i128,
    pub adverse_selection: i128,
    pub total_cost: i128,
    pub net_ev: i128,
    /// floor(net_ev * 10_000 / notional)
    pub net_ev_bps: i128,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "code", content = "detail")]
pub enum EconomicsReject {
    ZeroNotional,
    Overflow,
    NetEvNotPositive { net_ev: i128 },
    BelowMinMargin { net_ev_bps: i128, min_bps: i64 },
    FeeShareOfEdgeTooHigh { fee_bps: u32, edge_bps: i64, max_share_bps: u32 },
}

fn bps_ceil(n: u128, bps: u32) -> Option<u128> {
    let p = n.checked_mul(bps as u128)?;
    Some(p / 10_000 + u128::from(p % 10_000 != 0))
}

pub fn compute(i: &EconomicsInput) -> Result<Economics, EconomicsReject> {
    if i.notional == 0 {
        return Err(EconomicsReject::ZeroNotional);
    }
    let ov = || EconomicsReject::Overflow;
    let n = i.notional;
    let gross_edge: i128 = {
        let p = (n as i128).checked_mul(i.expected_edge_bps as i128).ok_or_else(ov)?;
        p.div_euclid(10_000) // floor toward -inf: conservative for both signs
    };
    let entry_fee = bps_ceil(n, i.entry_fee_bps).ok_or_else(ov)? as i128;
    let exit_fee = bps_ceil(n, i.exit_fee_bps).ok_or_else(ov)? as i128; // exit notional approximated by entry notional
    let slippage = (bps_ceil(n, i.entry_slippage_bps).ok_or_else(ov)? as i128)
        .checked_add(bps_ceil(n, i.exit_slippage_bps).ok_or_else(ov)? as i128)
        .ok_or_else(ov)?;
    let gas = (i.gas_entry_quote as i128).checked_add(i.gas_exit_quote as i128).ok_or_else(ov)?;
    let failed_tx_expected = {
        let per = i.failed_tx_cost_quote.checked_mul(i.tx_legs as u128).ok_or_else(ov)?;
        bps_ceil(per, i.failed_tx_prob_bps).ok_or_else(ov)? as i128
    };
    let adverse_selection = bps_ceil(n, i.adverse_selection_bps).ok_or_else(ov)? as i128;
    let total_cost = entry_fee + exit_fee + slippage + gas + failed_tx_expected + adverse_selection;
    let net_ev = gross_edge - total_cost;
    let net_ev_bps = (net_ev * 10_000).div_euclid(n as i128);
    Ok(Economics { gross_edge, entry_fee, exit_fee, slippage, gas, failed_tx_expected, adverse_selection, total_cost, net_ev, net_ev_bps })
}

/// Evaluate a quote: Ok(economics) if it clears every bar, else Err(all reasons).
pub fn evaluate(i: &EconomicsInput, cfg: &EconomicsConfig) -> Result<Economics, (Option<Economics>, Vec<EconomicsReject>)> {
    let e = match compute(i) {
        Ok(e) => e,
        Err(r) => return Err((None, vec![r])),
    };
    let mut reasons = Vec::new();
    if e.net_ev <= 0 {
        reasons.push(EconomicsReject::NetEvNotPositive { net_ev: e.net_ev });
    }
    if e.net_ev_bps < cfg.min_net_ev_bps as i128 {
        reasons.push(EconomicsReject::BelowMinMargin { net_ev_bps: e.net_ev_bps, min_bps: cfg.min_net_ev_bps });
    }
    let fee_bps = i.entry_fee_bps.saturating_add(i.exit_fee_bps);
    // fee_bps / edge_bps > max_share / 10_000  <=>  fee_bps * 10_000 > edge_bps * max_share
    if i.expected_edge_bps <= 0 || (fee_bps as i128) * 10_000 > (i.expected_edge_bps as i128) * (cfg.max_fee_share_of_edge_bps as i128) {
        reasons.push(EconomicsReject::FeeShareOfEdgeTooHigh {
            fee_bps,
            edge_bps: i.expected_edge_bps,
            max_share_bps: cfg.max_fee_share_of_edge_bps,
        });
    }
    if reasons.is_empty() {
        Ok(e)
    } else {
        Err((Some(e), reasons))
    }
}
