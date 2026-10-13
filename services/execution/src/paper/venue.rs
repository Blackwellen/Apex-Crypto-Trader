//! `PaperVenue`: async `Venue` over `PaperExchange` with explicit, test-only fault injection.
use super::exchange::{PaperConfig, PaperExchange};
use crate::venue::*;
use async_trait::async_trait;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
    /// Venue accepts and books the order, but the response is lost (client sees Timeout).
    TimeoutAfterAccept,
    /// Request never reaches the venue (client sees Timeout).
    TimeoutBeforeAccept,
}

struct Inner {
    ex: PaperExchange,
    faults: BTreeMap<String, Fault>,
    submit_calls: BTreeMap<String, u32>,
    accepted: BTreeSet<String>,
}

pub struct PaperVenue {
    inner: Mutex<Inner>,
    authoritative_absence: bool,
}

impl PaperVenue {
    pub fn new(cfg: PaperConfig) -> Self {
        PaperVenue {
            inner: Mutex::new(Inner { ex: PaperExchange::new(cfg), faults: BTreeMap::new(), submit_calls: BTreeMap::new(), accepted: BTreeSet::new() }),
            authoritative_absence: true,
        }
    }
    /// A venue whose "not found" answers are NOT authoritative (e.g. eventually consistent order lookup).
    pub fn with_non_authoritative_absence(mut self) -> Self {
        self.authoritative_absence = false;
        self
    }
    pub fn inject_fault(&self, client_order_id: &str, f: Fault) {
        self.inner.lock().unwrap().faults.insert(client_order_id.to_string(), f);
    }
    pub fn clear_faults(&self) {
        self.inner.lock().unwrap().faults.clear();
    }
    /// How many times `submit` was invoked for this client order id (the "never resubmit" evidence).
    pub fn submit_calls(&self, client_order_id: &str) -> u32 {
        *self.inner.lock().unwrap().submit_calls.get(client_order_id).unwrap_or(&0)
    }
    pub fn total_submit_calls(&self) -> u32 {
        self.inner.lock().unwrap().submit_calls.values().sum()
    }
    pub fn log_hash(&self) -> String {
        self.inner.lock().unwrap().ex.log.digest_hex()
    }
    pub fn log_lines(&self) -> Vec<String> {
        self.inner.lock().unwrap().ex.log.lines.clone().unwrap_or_default()
    }
    pub fn with_exchange<R>(&self, f: impl FnOnce(&mut PaperExchange) -> R) -> R {
        f(&mut self.inner.lock().unwrap().ex)
    }
}

#[async_trait]
impl Venue for PaperVenue {
    fn name(&self) -> &str {
        "paper"
    }
    async fn submit(&self, o: &VenueOrder) -> Result<VenueAck, VenueError> {
        let mut g = self.inner.lock().unwrap();
        *g.submit_calls.entry(o.client_order_id.clone()).or_insert(0) += 1;
        match g.faults.get(&o.client_order_id).copied() {
            Some(Fault::TimeoutBeforeAccept) => Err(VenueError::Timeout),
            Some(Fault::TimeoutAfterAccept) => {
                g.ex.place_order(o)?;
                g.accepted.insert(o.client_order_id.clone());
                Err(VenueError::Timeout)
            }
            None => {
                let a = g.ex.place_order(o)?;
                g.accepted.insert(o.client_order_id.clone());
                Ok(a)
            }
        }
    }
    async fn fills(&self, c: &str) -> Result<Vec<VenueFill>, VenueError> {
        Ok(self.inner.lock().unwrap().ex.fills(c))
    }
    async fn status(&self, c: &str) -> Result<OrderStatus, VenueError> {
        Ok(self.inner.lock().unwrap().ex.status(c, self.authoritative_absence))
    }
    async fn cancel(&self, c: &str) -> Result<(), VenueError> {
        self.inner.lock().unwrap().ex.cancel_order(c);
        Ok(())
    }
    async fn advance(&self, events: u32) {
        self.inner.lock().unwrap().ex.advance(events);
    }
}
