//! APEX execution service: typed order state machine, round-trip economics, deterministic paper exchange,
//! idempotent dispatcher over the Postgres ledger. LIVE submission is intentionally not implemented.
pub mod db;
pub mod dispatcher;
pub mod economics;
pub mod error;
pub mod paper;
pub mod state;
pub mod venue;

pub use error::ExecError;
pub use state::OrderState;

/// serde helper: u128 as decimal string (JSON numbers cannot carry u128).
pub mod u128s {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &u128, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u128, D::Error> {
        let s = String::deserialize(d)?;
        s.parse().map_err(serde::de::Error::custom)
    }
}
