//! Deterministic paper exchange: seeded order-book replay with price-time priority matching, partial fills,
//! maker/taker fees and a FIFO queue-position model for resting limit orders.
pub mod book;
pub mod exchange;
pub mod rng;
pub mod venue;

pub use exchange::{PaperConfig, PaperExchange};
pub use venue::{Fault, PaperVenue};
