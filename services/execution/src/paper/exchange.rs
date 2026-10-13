//! The paper exchange core (synchronous, single-threaded, fully deterministic given `PaperConfig::seed` and the
//! sequence of calls). Every state-changing event is appended to a canonical text log whose SHA-256 is the
//! reproducibility fingerprint.
//!
//! What is simulated: a synthetic, SEEDED market (passive adds, cancels, aggressive orders around a drifting mid),
//! price-time priority matching, partial fills, maker/taker fees, FIFO queue position for our resting orders.
//! What is NOT: real venue latency, hidden liquidity, queue-jumping, other participants reacting to us (no market
//! impact feedback beyond consuming displayed liquidity). Results are therefore a mechanical test of the pipeline
//! and accounting, not evidence of profitability.

use super::book::{Book, Trade, OURS_BASE};
use super::rng::SplitMix64;
use crate::venue::{CloseReason, Liquidity, OrderStatus, Tif, VenueAck, VenueError, VenueFill, VenueOrder};
use apex_risk::Side;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Clone, Debug)]
pub struct PaperConfig {
    pub seed: u64,
    pub base_decimals: u32,
    /// Price increment, quote base units.
    pub tick: u128,
    /// Quantity increment, base units.
    pub lot: u128,
    /// Initial mid, quote base units per whole base.
    pub start_mid: u128,
    pub maker_fee_bps: u32,
    pub taker_fee_bps: u32,
    pub initial_levels: u32,
    /// Keep every log line in memory (tests compare byte-for-byte); the hash is always maintained.
    pub keep_log_lines: bool,
}
impl Default for PaperConfig {
    fn default() -> Self {
        PaperConfig {
            seed: 42,
            base_decimals: 18,
            tick: 10_000,                 // 0.01 of a 6-decimals quote asset
            lot: 1_000_000_000_000_000,   // 0.001 of an 18-decimals base asset
            start_mid: 2_000_000_000,     // 2000.000000 quote per whole base
            maker_fee_bps: 10,
            taker_fee_bps: 25,
            initial_levels: 20,
            keep_log_lines: false,
        }
    }
}

pub struct EventLog {
    hasher: Sha256,
    pub count: u64,
    pub lines: Option<Vec<String>>,
}
impl EventLog {
    fn new(keep: bool) -> Self {
        EventLog { hasher: Sha256::new(), count: 0, lines: keep.then(Vec::new) }
    }
    fn push(&mut self, line: String) {
        self.hasher.update(line.as_bytes());
        self.hasher.update(b"\n");
        self.count += 1;
        if let Some(l) = &mut self.lines {
            l.push(line);
        }
    }
    pub fn digest_hex(&self) -> String {
        hex::encode(self.hasher.clone().finalize())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum OState {
    Open,
    Closed(CloseReason),
}

struct OurOrder {
    id: u64,
    side: Side,
    price: u128,
    qty: u128,
    filled: u128,
    state: OState,
    fills: Vec<VenueFill>,
    ack: VenueAck,
}

pub struct PaperExchange {
    pub cfg: PaperConfig,
    book: Book,
    rng: SplitMix64,
    next_market_id: u64,
    next_our_id: u64,
    live_market: Vec<u64>,
    mid: u128,
    pub log: EventLog,
    orders: BTreeMap<String, OurOrder>,
    by_id: BTreeMap<u64, String>,
    pub market_events: u64,
}

fn side_c(s: Side) -> char {
    if s == Side::Buy {
        'B'
    } else {
        'S'
    }
}
fn ceil_div(a: u128, b: u128) -> u128 {
    a / b + u128::from(a % b != 0)
}

impl PaperExchange {
    pub fn new(cfg: PaperConfig) -> Self {
        let mut x = PaperExchange {
            book: Book::default(),
            rng: SplitMix64::new(cfg.seed),
            next_market_id: 1,
            next_our_id: OURS_BASE,
            live_market: Vec::new(),
            mid: cfg.start_mid,
            log: EventLog::new(cfg.keep_log_lines),
            orders: BTreeMap::new(),
            by_id: BTreeMap::new(),
            market_events: 0,
            cfg,
        };
        x.log.push(format!("CFG|seed={}|dec={}|tick={}|lot={}|mid={}|mf={}|tf={}", x.cfg.seed, x.cfg.base_decimals, x.cfg.tick, x.cfg.lot, x.cfg.start_mid, x.cfg.maker_fee_bps, x.cfg.taker_fee_bps));
        for lvl in 1..=x.cfg.initial_levels as u128 {
            for _ in 0..3 {
                let q = (5 + x.rng.below(45) as u128) * x.cfg.lot;
                let bid = x.cfg.start_mid - lvl * x.cfg.tick;
                let ask = x.cfg.start_mid + lvl * x.cfg.tick;
                x.market_add(Side::Buy, bid, q);
                let q = (5 + x.rng.below(45) as u128) * x.cfg.lot;
                x.market_add(Side::Sell, ask, q);
            }
        }
        x
    }

    pub fn best_bid(&self) -> Option<u128> {
        self.book.best_bid()
    }
    pub fn best_ask(&self) -> Option<u128> {
        self.book.best_ask()
    }
    pub fn mid(&self) -> u128 {
        self.mid
    }

    fn market_add(&mut self, side: Side, price: u128, qty: u128) {
        let id = self.next_market_id;
        self.next_market_id += 1;
        self.log.push(format!("M|ADD|{}|{}|{}|{}", id, side_c(side), price, qty));
        let mr = self.book.match_order(id, side, Some(price), qty);
        self.process_trades(&mr.trades);
        if mr.remaining > 0 {
            self.book.rest(id, side, price, mr.remaining);
            self.live_market.push(id);
        }
    }

    /// One synthetic market event. Deterministic function of the RNG state and book.
    pub fn step_market(&mut self) {
        self.market_events += 1;
        let r = self.rng.below(100);
        if r < 55 {
            let side = if self.rng.below(2) == 0 { Side::Buy } else { Side::Sell };
            let k = self.rng.below(8) as u128;
            let qty = (1 + self.rng.below(50) as u128) * self.cfg.lot;
            let price = match side {
                Side::Buy => self.mid.saturating_sub((1 + k) * self.cfg.tick).max(self.cfg.tick),
                Side::Sell => self.mid + (1 + k) * self.cfg.tick,
            };
            self.market_add(side, price, qty);
        } else if r < 80 {
            if !self.live_market.is_empty() {
                let idx = self.rng.below(self.live_market.len() as u64) as usize;
                let id = self.live_market.swap_remove(idx);
                match self.book.cancel(id) {
                    Some(rem) => self.log.push(format!("M|CXL|{}|{}", id, rem)),
                    None => self.log.push(format!("M|CXL_STALE|{}", id)),
                }
            }
        } else {
            let side = if self.rng.below(2) == 0 { Side::Buy } else { Side::Sell };
            let qty = (1 + self.rng.below(30) as u128) * self.cfg.lot;
            let id = self.next_market_id;
            self.next_market_id += 1;
            self.log.push(format!("M|MKT|{}|{}|{}", id, side_c(side), qty));
            let mr = self.book.match_order(id, side, None, qty);
            self.process_trades(&mr.trades);
        }
        // keep both sides quoted so the market never degenerates
        if self.book.best_bid().is_none() {
            let p = self.mid.saturating_sub(self.cfg.tick).max(self.cfg.tick);
            self.market_add(Side::Buy, p, 20 * self.cfg.lot);
        }
        if self.book.best_ask().is_none() {
            let p = self.mid + self.cfg.tick;
            self.market_add(Side::Sell, p, 20 * self.cfg.lot);
        }
        if let (Some(b), Some(a)) = (self.book.best_bid(), self.book.best_ask()) {
            let m = (b + a) / 2;
            self.mid = m - m % self.cfg.tick;
        }
    }

    pub fn advance(&mut self, events: u32) {
        for _ in 0..events {
            self.step_market();
        }
    }

    fn process_trades(&mut self, trades: &[Trade]) {
        for t in trades {
            self.log.push(format!("T|{}|{}|{}|{}|{}|{}", t.seq, t.taker, t.maker, t.price, t.qty, side_c(t.taker_side)));
            if t.taker >= OURS_BASE {
                self.record_fill(t.taker, t.qty, t.price, Liquidity::Taker);
            }
            if t.maker >= OURS_BASE {
                self.record_fill(t.maker, t.qty, t.price, Liquidity::Maker);
            }
        }
    }

    fn record_fill(&mut self, our_id: u64, qty: u128, price: u128, liq: Liquidity) {
        let client = self.by_id.get(&our_id).cloned().expect("our order registered");
        let dec = 10u128.pow(self.cfg.base_decimals);
        let bps = if liq == Liquidity::Maker { self.cfg.maker_fee_bps } else { self.cfg.taker_fee_bps };
        let o = self.orders.get_mut(&client).expect("order");
        let notional = qty * price;
        // buyer pays rounded UP, seller receives rounded DOWN (never favourable to us)
        let quote = if o.side == Side::Buy { ceil_div(notional, dec) } else { notional / dec };
        let fee = ceil_div(quote * bps as u128, 10_000);
        let vid = format!("{}:{}", client, o.fills.len() + 1);
        o.filled += qty;
        o.fills.push(VenueFill { venue_fill_id: vid.clone(), qty, quote_amount: quote, fee_quote: fee, liquidity: liq });
        if o.filled == o.qty {
            o.state = OState::Closed(CloseReason::Filled);
        }
        let l = if liq == Liquidity::Maker { 'M' } else { 'T' };
        self.log.push(format!("O|FILL|{}|{}|{}|{}|{}|{}", client, vid, qty, quote, fee, l));
    }

    pub fn place_order(&mut self, ord: &VenueOrder) -> Result<VenueAck, VenueError> {
        if let Some(o) = self.orders.get(&ord.client_order_id) {
            return Ok(o.ack.clone()); // venue-side idempotency on client order id
        }
        if ord.qty == 0 || ord.price == 0 || ord.price % self.cfg.tick != 0 || ord.qty % self.cfg.lot != 0 {
            return Err(VenueError::Rejected("tick/lot filter".into()));
        }
        let id = self.next_our_id;
        self.next_our_id += 1;
        self.log.push(format!(
            "O|SUBMIT|{}|{}|{}|{}|{}|{}",
            ord.client_order_id,
            id,
            side_c(ord.side),
            ord.price,
            ord.qty,
            if ord.tif == Tif::Gtc { "GTC" } else { "IOC" }
        ));
        let ack = VenueAck { venue_order_id: format!("paper-{}", id), queue_ahead: 0 };
        self.orders.insert(
            ord.client_order_id.clone(),
            OurOrder { id, side: ord.side, price: ord.price, qty: ord.qty, filled: 0, state: OState::Open, fills: vec![], ack: ack.clone() },
        );
        self.by_id.insert(id, ord.client_order_id.clone());
        let mr = self.book.match_order(id, ord.side, Some(ord.price), ord.qty);
        self.process_trades(&mr.trades);
        let mut queue_ahead = 0;
        if mr.remaining > 0 {
            if mr.self_trade_blocked {
                self.orders.get_mut(&ord.client_order_id).unwrap().state = OState::Closed(CloseReason::Cancelled);
                self.log.push(format!("O|STP_CANCEL|{}|{}", ord.client_order_id, mr.remaining));
            } else if ord.tif == Tif::Gtc {
                self.book.rest(id, ord.side, ord.price, mr.remaining);
                queue_ahead = self.book.queue_ahead(id).unwrap_or(0);
                self.log.push(format!("O|REST|{}|{}|{}", ord.client_order_id, mr.remaining, queue_ahead));
            } else {
                self.orders.get_mut(&ord.client_order_id).unwrap().state = OState::Closed(CloseReason::Expired);
                self.log.push(format!("O|IOC_EXPIRE|{}|{}", ord.client_order_id, mr.remaining));
            }
        }
        let o = self.orders.get_mut(&ord.client_order_id).unwrap();
        o.ack.queue_ahead = queue_ahead;
        Ok(o.ack.clone())
    }

    pub fn cancel_order(&mut self, client: &str) {
        let Some(o) = self.orders.get_mut(client) else { return };
        if o.state != OState::Open {
            return;
        }
        let id = o.id;
        o.state = OState::Closed(CloseReason::Cancelled);
        let rem = self.book.cancel(id).unwrap_or(0);
        self.log.push(format!("O|CANCEL|{}|{}", client, rem));
    }

    pub fn fills(&self, client: &str) -> Vec<VenueFill> {
        self.orders.get(client).map(|o| o.fills.clone()).unwrap_or_default()
    }

    pub fn queue_ahead(&self, client: &str) -> Option<u128> {
        self.orders.get(client).and_then(|o| self.book.queue_ahead(o.id))
    }

    pub fn status(&self, client: &str, authoritative_absence: bool) -> OrderStatus {
        match self.orders.get(client) {
            None => OrderStatus::NotFound { authoritative: authoritative_absence },
            Some(o) => match o.state {
                OState::Open => OrderStatus::Open { filled_qty: o.filled },
                OState::Closed(r) => OrderStatus::Closed { filled_qty: o.filled, reason: r },
            },
        }
    }

    pub fn order_price(&self, client: &str) -> Option<u128> {
        self.orders.get(client).map(|o| o.price)
    }
}

// ---- test support (deterministic helpers used by the test-suite; no effect on production paths)
impl PaperExchange {
    /// Total quantity resting at one bid price (test support).
    pub fn with_level_qty(&self, side: Side, price: u128) -> u128 {
        self.book.level_qty(side, price)
    }
    pub fn depth_for_test(&self, side: Side) -> u128 {
        self.book.depth_qty(side)
    }
    /// An anonymous market sell for `qty` (consumes bids in price-time order).
    pub fn market_sell_for_test(&mut self, qty: u128) {
        let id = self.next_market_id;
        self.next_market_id += 1;
        self.log.push(format!("M|MKT|{}|S|{}", id, qty));
        let mr = self.book.match_order(id, Side::Sell, None, qty);
        self.process_trades(&mr.trades);
    }
}
