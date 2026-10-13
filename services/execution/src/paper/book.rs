//! Limit order book with price-time priority. Integer prices (quote base units per whole base) and quantities
//! (base units). Pure data structure: no clock, no randomness, no hashing-order dependence (BTreeMap everywhere).

use apex_risk::Side;
use std::collections::{BTreeMap, VecDeque};

/// Ids at or above this belong to OUR orders (used for self-trade prevention).
pub const OURS_BASE: u64 = 1 << 62;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resting {
    pub id: u64,
    pub qty: u128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Trade {
    pub seq: u64,
    pub taker: u64,
    pub maker: u64,
    /// Always the maker's (resting) price.
    pub price: u128,
    pub qty: u128,
    pub taker_side: Side,
    pub maker_exhausted: bool,
}

#[derive(Default, Debug, Clone)]
pub struct Book {
    bids: BTreeMap<u128, VecDeque<Resting>>,
    asks: BTreeMap<u128, VecDeque<Resting>>,
    loc: BTreeMap<u64, (Side, u128)>,
    trade_seq: u64,
}

pub struct MatchResult {
    pub trades: Vec<Trade>,
    pub remaining: u128,
    /// Matching stopped because the next maker was also ours (self-trade prevention: cancel newest).
    pub self_trade_blocked: bool,
}

impl Book {
    pub fn best_bid(&self) -> Option<u128> {
        self.bids.keys().next_back().copied()
    }
    pub fn best_ask(&self) -> Option<u128> {
        self.asks.keys().next().copied()
    }
    pub fn contains(&self, id: u64) -> bool {
        self.loc.contains_key(&id)
    }
    pub fn depth_qty(&self, side: Side) -> u128 {
        let m = if side == Side::Buy { &self.bids } else { &self.asks };
        m.values().flat_map(|q| q.iter()).map(|r| r.qty).sum()
    }

    /// Match an incoming order against the opposite side. `limit = None` means a market order.
    pub fn match_order(&mut self, taker: u64, side: Side, limit: Option<u128>, mut qty: u128) -> MatchResult {
        let mut trades = Vec::new();
        let mut blocked = false;
        while qty > 0 {
            // best opposite level
            let level_price = match side {
                Side::Buy => self.asks.keys().next().copied(),
                Side::Sell => self.bids.keys().next_back().copied(),
            };
            let Some(px) = level_price else { break };
            let crosses = match (side, limit) {
                (_, None) => true,
                (Side::Buy, Some(l)) => px <= l,
                (Side::Sell, Some(l)) => px >= l,
            };
            if !crosses {
                break;
            }
            let book_side = if side == Side::Buy { &mut self.asks } else { &mut self.bids };
            let q = book_side.get_mut(&px).expect("level exists");
            let front = q.front_mut().expect("non-empty level");
            if taker >= OURS_BASE && front.id >= OURS_BASE {
                blocked = true;
                break;
            }
            let take = qty.min(front.qty);
            front.qty -= take;
            qty -= take;
            let maker = front.id;
            let exhausted = front.qty == 0;
            if exhausted {
                q.pop_front();
                self.loc.remove(&maker);
            }
            if q.is_empty() {
                book_side.remove(&px);
            }
            self.trade_seq += 1;
            trades.push(Trade { seq: self.trade_seq, taker, maker, price: px, qty: take, taker_side: side, maker_exhausted: exhausted });
        }
        MatchResult { trades, remaining: qty, self_trade_blocked: blocked }
    }

    /// Add a resting order at the TAIL of its price level (time priority).
    pub fn rest(&mut self, id: u64, side: Side, price: u128, qty: u128) {
        debug_assert!(qty > 0);
        let m = if side == Side::Buy { &mut self.bids } else { &mut self.asks };
        m.entry(price).or_default().push_back(Resting { id, qty });
        self.loc.insert(id, (side, price));
    }

    /// Cancel a resting order; returns the remaining quantity that was cancelled.
    pub fn cancel(&mut self, id: u64) -> Option<u128> {
        let (side, price) = self.loc.remove(&id)?;
        let m = if side == Side::Buy { &mut self.bids } else { &mut self.asks };
        let q = m.get_mut(&price)?;
        let pos = q.iter().position(|r| r.id == id)?;
        let r = q.remove(pos)?;
        if q.is_empty() {
            m.remove(&price);
        }
        Some(r.qty)
    }

    /// Queue position model: quantity resting AHEAD of `id` in its price level (strict FIFO).
    pub fn queue_ahead(&self, id: u64) -> Option<u128> {
        let (side, price) = *self.loc.get(&id)?;
        let m = if side == Side::Buy { &self.bids } else { &self.asks };
        let q = m.get(&price)?;
        let mut ahead = 0u128;
        for r in q {
            if r.id == id {
                return Some(ahead);
            }
            ahead += r.qty;
        }
        None
    }

    pub fn remaining(&self, id: u64) -> Option<u128> {
        let (side, price) = *self.loc.get(&id)?;
        let m = if side == Side::Buy { &self.bids } else { &self.asks };
        m.get(&price)?.iter().find(|r| r.id == id).map(|r| r.qty)
    }
}
