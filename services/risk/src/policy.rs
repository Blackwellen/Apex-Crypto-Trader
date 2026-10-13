//! Risk policy hierarchy: global > portfolio > bucket > wallet > basket > strategy > order.
//!
//! A child layer can only TIGHTEN its parent. `Policy::tighten` is the only way layers are combined and it is
//! built exclusively from `min`, logical AND, set-union (deny lists) and set-intersection (allow lists),
//! so by construction the result is never looser than the parent. Nothing in this crate offers a "relax" operation.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum Level {
    Global,
    Portfolio,
    Bucket,
    Wallet,
    Basket,
    Strategy,
    Order,
}

/// A fully resolved policy (every limit present).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Policy {
    /// Max single-order notional as bps of the bucket's value.
    pub max_order_notional_bps_of_bucket: u32,
    pub max_slippage_bps: u32,
    pub max_quote_age_ms: u64,
    /// Round-trip fees may consume at most this many bps OF the expected edge (10_000 = fees may equal the edge).
    pub max_fee_to_edge_bps: u32,
    /// Max post-trade exposure to a single asset, bps of bucket value.
    pub max_concentration_bps: u32,
    pub max_failed_tx_rate_bps: u32,
    pub max_open_unknown_orders: u32,
    /// false => new entries disabled at this scope (exits still allowed).
    pub entries_enabled: bool,
    /// Denied assets (union across layers).
    pub blacklist: BTreeSet<String>,
    /// If Some, only these assets may be entered (intersection across layers).
    pub allowlist: Option<BTreeSet<String>>,
}

/// A partial policy supplied by one level. `None` = "no opinion" (inherits the parent).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyLayer {
    pub max_order_notional_bps_of_bucket: Option<u32>,
    pub max_slippage_bps: Option<u32>,
    pub max_quote_age_ms: Option<u64>,
    pub max_fee_to_edge_bps: Option<u32>,
    pub max_concentration_bps: Option<u32>,
    pub max_failed_tx_rate_bps: Option<u32>,
    pub max_open_unknown_orders: Option<u32>,
    pub entries_enabled: Option<bool>,
    pub blacklist: Option<BTreeSet<String>>,
    pub allowlist: Option<BTreeSet<String>>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PolicyError {
    #[error("policy key {0} has an invalid value (fail closed)")]
    BadValue(String),
    #[error("policy json must be an object")]
    NotObject,
}

impl Policy {
    /// Conservative built-in defaults used for any key the stored global limits do not mention (fail closed).
    pub fn conservative_defaults() -> Policy {
        Policy {
            max_order_notional_bps_of_bucket: 2_500,
            max_slippage_bps: 100,
            max_quote_age_ms: 2_000,
            max_fee_to_edge_bps: 5_000,
            max_concentration_bps: 3_000,
            max_failed_tx_rate_bps: 1_000,
            max_open_unknown_orders: 0,
            entries_enabled: true,
            blacklist: BTreeSet::new(),
            allowlist: None,
        }
    }

    /// Root (global) policy: conservative defaults overridden by whatever keys the stored global limits specify.
    pub fn global_from_json(v: &Value) -> Result<Policy, PolicyError> {
        let layer = PolicyLayer::from_json(v)?;
        let mut p = Policy::conservative_defaults();
        macro_rules! ov { ($($f:ident),*) => { $( if let Some(x) = layer.$f.clone() { p.$f = x; } )* } }
        ov!(
            max_order_notional_bps_of_bucket,
            max_slippage_bps,
            max_quote_age_ms,
            max_fee_to_edge_bps,
            max_concentration_bps,
            max_failed_tx_rate_bps,
            max_open_unknown_orders,
            entries_enabled,
            blacklist
        );
        p.allowlist = layer.allowlist;
        Ok(p)
    }

    /// Combine with a child layer. The result is never looser than `self`, nor than the layer.
    pub fn tighten(&self, l: &PolicyLayer) -> Policy {
        fn m<T: Ord + Copy>(a: T, b: Option<T>) -> T {
            match b {
                Some(b) => a.min(b),
                None => a,
            }
        }
        let mut blacklist = self.blacklist.clone();
        if let Some(b) = &l.blacklist {
            blacklist.extend(b.iter().cloned());
        }
        let allowlist = match (&self.allowlist, &l.allowlist) {
            (None, None) => None,
            (Some(a), None) => Some(a.clone()),
            (None, Some(b)) => Some(b.clone()),
            (Some(a), Some(b)) => Some(a.intersection(b).cloned().collect()),
        };
        Policy {
            max_order_notional_bps_of_bucket: m(self.max_order_notional_bps_of_bucket, l.max_order_notional_bps_of_bucket),
            max_slippage_bps: m(self.max_slippage_bps, l.max_slippage_bps),
            max_quote_age_ms: m(self.max_quote_age_ms, l.max_quote_age_ms),
            max_fee_to_edge_bps: m(self.max_fee_to_edge_bps, l.max_fee_to_edge_bps),
            max_concentration_bps: m(self.max_concentration_bps, l.max_concentration_bps),
            max_failed_tx_rate_bps: m(self.max_failed_tx_rate_bps, l.max_failed_tx_rate_bps),
            max_open_unknown_orders: m(self.max_open_unknown_orders, l.max_open_unknown_orders),
            entries_enabled: self.entries_enabled && l.entries_enabled.unwrap_or(true),
            blacklist,
            allowlist,
        }
    }

    /// True iff `self` permits nothing that `other` forbids.
    pub fn is_at_most_as_loose_as(&self, other: &Policy) -> bool {
        let allow_ok = match (&self.allowlist, &other.allowlist) {
            (_, None) => true,
            (None, Some(_)) => false,
            (Some(s), Some(o)) => s.is_subset(o),
        };
        self.max_order_notional_bps_of_bucket <= other.max_order_notional_bps_of_bucket
            && self.max_slippage_bps <= other.max_slippage_bps
            && self.max_quote_age_ms <= other.max_quote_age_ms
            && self.max_fee_to_edge_bps <= other.max_fee_to_edge_bps
            && self.max_concentration_bps <= other.max_concentration_bps
            && self.max_failed_tx_rate_bps <= other.max_failed_tx_rate_bps
            && self.max_open_unknown_orders <= other.max_open_unknown_orders
            && (!self.entries_enabled || other.entries_enabled)
            && self.blacklist.is_superset(&other.blacklist)
            && allow_ok
    }

    /// Resolve a hierarchy: start at `root` (global) and apply layers in hierarchy order (portfolio -> ... -> order).
    /// A layer tagged `Level::Global` is applied as a tightening too (it cannot loosen the root).
    pub fn resolve(root: &Policy, layers: &[(Level, PolicyLayer)]) -> Policy {
        let mut ls: Vec<&(Level, PolicyLayer)> = layers.iter().collect();
        ls.sort_by_key(|(lv, _)| *lv);
        ls.into_iter().fold(root.clone(), |acc, (_, l)| acc.tighten(l))
    }
}

impl PolicyLayer {
    pub fn from_json(v: &Value) -> Result<PolicyLayer, PolicyError> {
        let o = v.as_object().ok_or(PolicyError::NotObject)?;
        fn num(o: &serde_json::Map<String, Value>, k: &str) -> Result<Option<u64>, PolicyError> {
            match o.get(k) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::Number(n)) => n.as_u64().map(Some).ok_or_else(|| PolicyError::BadValue(k.into())),
                Some(Value::String(s)) => s.parse::<u64>().map(Some).map_err(|_| PolicyError::BadValue(k.into())),
                _ => Err(PolicyError::BadValue(k.into())),
            }
        }
        fn u32k(o: &serde_json::Map<String, Value>, k: &str) -> Result<Option<u32>, PolicyError> {
            match num(o, k)? {
                None => Ok(None),
                Some(x) => u32::try_from(x).map(Some).map_err(|_| PolicyError::BadValue(k.into())),
            }
        }
        fn set(o: &serde_json::Map<String, Value>, k: &str) -> Result<Option<BTreeSet<String>>, PolicyError> {
            match o.get(k) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::Array(a)) => a
                    .iter()
                    .map(|x| x.as_str().map(str::to_string).ok_or_else(|| PolicyError::BadValue(k.into())))
                    .collect::<Result<BTreeSet<_>, _>>()
                    .map(Some),
                _ => Err(PolicyError::BadValue(k.into())),
            }
        }
        let entries_enabled = match o.get("entries_enabled") {
            None | Some(Value::Null) => None,
            Some(Value::Bool(b)) => Some(*b),
            _ => return Err(PolicyError::BadValue("entries_enabled".into())),
        };
        Ok(PolicyLayer {
            max_order_notional_bps_of_bucket: u32k(o, "max_order_notional_bps_of_bucket")?,
            max_slippage_bps: u32k(o, "max_slippage_bps")?,
            max_quote_age_ms: num(o, "max_quote_age_ms")?,
            max_fee_to_edge_bps: u32k(o, "max_fee_to_edge_bps")?,
            max_concentration_bps: u32k(o, "max_concentration_bps")?,
            max_failed_tx_rate_bps: u32k(o, "max_failed_tx_rate_bps")?,
            max_open_unknown_orders: u32k(o, "max_open_unknown_orders")?,
            entries_enabled,
            blacklist: set(o, "blacklist")?,
            allowlist: set(o, "allowlist")?,
        })
    }
}
