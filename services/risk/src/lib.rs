//! APEX independent risk gate. See `policy` (hierarchy, tighten-only), `check` (pure ADMIT/VETO), `db` (persistence).
pub mod check;
pub mod db;
pub mod policy;

pub use check::{evaluate, DataHealth, Decision, GlobalState, RiskInput, Side, VetoReason};
pub use policy::{Level, Policy, PolicyLayer};
