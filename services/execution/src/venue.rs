//! Venue abstraction. The only implementations are the deterministic `PaperVenue` and the `LiveVenue` STUB that
//! always returns `Err(LiveDisabled)`. There is no code path in this crate that can place a live order.

use apex_risk::Side;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Tif {
    /// Good-till-cancel limit order (may rest and queue).
    Gtc,
    /// Immediate-or-cancel (marketable limit; remainder cancelled).
    Ioc,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VenueOrder {
    /// Idempotency key doubles as the client order id.
    pub client_order_id: String,
    pub side: Side,
    /// Quote base units per whole base asset (10^base_decimals base units).
    pub price: u128,
    /// Base units.
    pub qty: u128,
    pub tif: Tif,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VenueAck {
    pub venue_order_id: String,
    /// Quantity queued ahead of us at our price level at acceptance (0 if we took liquidity).
    pub queue_ahead: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Liquidity {
    Maker,
    Taker,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VenueFill {
    /// Stable per fill: re-fetching fills yields identical ids (at-least-once delivery is safe).
    pub venue_fill_id: String,
    pub qty: u128,
    pub quote_amount: u128,
    pub fee_quote: u128,
    pub liquidity: Liquidity,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseReason {
    Filled,
    Cancelled,
    /// IOC remainder / time expiry.
    Expired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderStatus {
    /// `authoritative`: the venue positively asserts it has never accepted this client order id.
    NotFound { authoritative: bool },
    Open { filled_qty: u128 },
    Closed { filled_qty: u128, reason: CloseReason },
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum VenueError {
    /// The request may or may not have reached the venue. The caller MUST treat the outcome as UNKNOWN.
    #[error("venue timeout (outcome unknown)")]
    Timeout,
    #[error("venue unavailable")]
    Unavailable,
    #[error("venue rejected order: {0}")]
    Rejected(String),
    #[error("live execution is disabled")]
    LiveDisabled,
}

#[async_trait]
pub trait Venue: Send + Sync {
    fn name(&self) -> &str;
    async fn submit(&self, order: &VenueOrder) -> Result<VenueAck, VenueError>;
    /// All fills so far for the order, in stable order with stable ids.
    async fn fills(&self, client_order_id: &str) -> Result<Vec<VenueFill>, VenueError>;
    async fn status(&self, client_order_id: &str) -> Result<OrderStatus, VenueError>;
    async fn cancel(&self, client_order_id: &str) -> Result<(), VenueError>;
    /// Let `events` units of venue time pass (paper: replay more market events). Real venues: no-op.
    async fn advance(&self, _events: u32) {}
}

/// LIVE venue STUB. Intentionally inert: every method returns `Err(LiveDisabled)`. Live trading additionally
/// requires the SQL gate `live_allowed(workspace)`, which the dispatcher consults first; with all deployment gates
/// not PASS it is false. Implementing a real live venue is out of scope until Phase F gates are passed.
#[derive(Clone, Copy, Debug, Default)]
pub struct LiveVenue;

#[async_trait]
impl Venue for LiveVenue {
    fn name(&self) -> &str {
        "live-disabled"
    }
    async fn submit(&self, _o: &VenueOrder) -> Result<VenueAck, VenueError> {
        Err(VenueError::LiveDisabled)
    }
    async fn fills(&self, _c: &str) -> Result<Vec<VenueFill>, VenueError> {
        Err(VenueError::LiveDisabled)
    }
    async fn status(&self, _c: &str) -> Result<OrderStatus, VenueError> {
        Err(VenueError::LiveDisabled)
    }
    async fn cancel(&self, _c: &str) -> Result<(), VenueError> {
        Err(VenueError::LiveDisabled)
    }
}
