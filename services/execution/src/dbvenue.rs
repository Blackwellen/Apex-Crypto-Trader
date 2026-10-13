//! `DbPaperVenue`: the deterministic PAPER venue used by `apex-execution serve`.
//!
//! Why this exists next to the in-memory `PaperVenue`: a long-running service must survive `kill -9`. The in-memory matcher forgets
//! every order when the process dies, so a restarted service could never tell "the venue never saw it" from "the venue filled it".
//! `DbPaperVenue` keeps its order records in `paper_venue_orders` (migration 0300), i.e. it behaves like an external venue whose
//! state outlives our process: `status()` answers AUTHORITATIVELY, `submit()` is idempotent on the client order id, and the fills
//! are a PURE FUNCTION of (seed, client_order_id, order): they do not depend on wall-clock, process, processing order or restarts.
//! Same seed + same intents => byte-identical fills, whether or not the service crashed in between.
//!
//! Everything it does is SIMULATED: fills are drawn from a hash, with price improvement of 0..`improve_bps_max` bps inside the
//! order's limit (the feed sets the limit a fixed tolerance through the synthetic close), about 3% of orders find no liquidity,
//! about 12% fill partially, fees are a flat taker rate. It is not a model of any real venue. SYNTHETIC; paper only.

use crate::db::{parse_u128, BoxFut, Db, Tx};
use crate::venue::*;
use apex_risk::Side;
use async_trait::async_trait;
use serde_json::json;
use sha2::{Digest, Sha256};

#[derive(Clone)]
pub struct DbPaperVenue {
    db: Db,
    pub seed: u64,
    /// flat taker fee charged on the fill's quote amount
    pub taker_fee_bps: u32,
    /// fills happen between the limit and `improve_bps_max` bps better than it
    pub improve_bps_max: u32,
}

pub const VENUE_NAME: &str = "paper-sim";

fn hash64(seed: u64, id: &str, tag: &str, salt: u64) -> u64 {
    let mut h = Sha256::new();
    h.update(seed.to_le_bytes());
    h.update(id.as_bytes());
    h.update([0u8]);
    h.update(tag.as_bytes());
    h.update(salt.to_le_bytes());
    let d = h.finalize();
    u64::from_le_bytes(d[..8].try_into().unwrap())
}

fn ceil_div(a: u128, b: u128) -> u128 {
    a / b + u128::from(a % b != 0)
}

/// What the venue decided for one order. Pure; exposed for tests.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    pub venue_order_id: String,
    pub fills: Vec<VenueFill>,
    pub filled_qty: u128,
    pub fully_filled: bool,
}

impl DbPaperVenue {
    pub fn new(db: Db, seed: u64) -> Self {
        DbPaperVenue { db, seed, taker_fee_bps: 20, improve_bps_max: 20 }
    }

    pub fn venue_order_id(&self, client_order_id: &str) -> String {
        format!("pv-{:016x}", hash64(self.seed, client_order_id, "venue_order_id", 0))
    }

    /// Deterministic fill plan. `base_decimals`: the base asset's decimals (price is quote base units per 10^base_decimals).
    pub fn plan(&self, o: &VenueOrder, base_decimals: u32) -> Plan {
        let id = o.client_order_id.as_str();
        let voi = self.venue_order_id(id);
        let class = hash64(self.seed, id, "class", 0) % 100;
        let target: u128 = if class < 3 {
            0
        } else if class < 15 {
            o.qty * (30 + (hash64(self.seed, id, "ratio", 0) % 66) as u128) / 100
        } else {
            o.qty
        };
        let dec = 10u128.pow(base_decimals);
        let mut fills = Vec::new();
        if target > 0 {
            let n = (1 + hash64(self.seed, id, "n", 0) % 3) as u128;
            let n = if target < n { 1 } else { n };
            let mut left = target;
            for j in 0..n {
                let q = if j + 1 == n { left } else { target / n };
                left -= q;
                if q == 0 {
                    continue;
                }
                let imp = (hash64(self.seed, id, "imp", j as u64) % (self.improve_bps_max as u64 + 1)) as u128;
                let px = match o.side {
                    Side::Buy => o.price * (10_000 - imp) / 10_000,
                    Side::Sell => o.price * (10_000 + imp) / 10_000,
                };
                let quote = (q * px / dec).max(1);
                let fee = ceil_div(quote * self.taker_fee_bps as u128, 10_000);
                fills.push(VenueFill { venue_fill_id: format!("{voi}-f{j}"), qty: q, quote_amount: quote, fee_quote: fee, liquidity: Liquidity::Taker });
            }
        }
        let filled_qty: u128 = fills.iter().map(|f| f.qty).sum();
        Plan { venue_order_id: voi, fills, filled_qty, fully_filled: filled_qty == o.qty }
    }

    async fn base_decimals(&self, client_order_id: &str) -> Result<u32, VenueError> {
        fn op<'a>(tx: &'a Tx, id: String) -> BoxFut<'a, Vec<i32>> {
            Box::pin(async move {
                let rows = tx
                    .c()
                    .query("select (c.context->>'base_decimals')::int from trade_intents t join intent_context c on c.intent_id = t.id where t.idempotency_key = $1", &[&id])
                    .await?;
                Ok(rows.iter().map(|r| r.get::<_, i32>(0)).collect())
            })
        }
        let id = client_order_id.to_string();
        let v = self.db.run(|tx| op(tx, id.clone())).await.map_err(|_| VenueError::Unavailable)?;
        match v.as_slice() {
            [d] => Ok(*d as u32),
            [] => Err(VenueError::Rejected("no intent context for this client order id".into())),
            _ => Err(VenueError::Rejected("client order id is ambiguous across workspaces; refusing to guess".into())),
        }
    }

    async fn load(&self, client_order_id: &str) -> Result<Option<(String, String, serde_json::Value)>, VenueError> {
        fn op<'a>(tx: &'a Tx, id: String) -> BoxFut<'a, Option<(String, String, serde_json::Value)>> {
            Box::pin(async move {
                let r = tx
                    .c()
                    .query_opt("select status, venue_order_id, fills from paper_venue_orders where venue = 'paper-sim' and client_order_id = $1", &[&id])
                    .await?;
                Ok(r.map(|r| (r.get(0), r.get(1), r.get(2))))
            })
        }
        let id = client_order_id.to_string();
        self.db.run(|tx| op(tx, id.clone())).await.map_err(|_| VenueError::Unavailable)
    }
}

fn fills_from_json(v: &serde_json::Value) -> Vec<VenueFill> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|f| {
                    Some(VenueFill {
                        venue_fill_id: f.get("id")?.as_str()?.to_string(),
                        qty: parse_u128(f.get("qty")?.as_str()?).ok()?,
                        quote_amount: parse_u128(f.get("quote")?.as_str()?).ok()?,
                        fee_quote: parse_u128(f.get("fee")?.as_str()?).ok()?,
                        liquidity: Liquidity::Taker,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[async_trait]
impl Venue for DbPaperVenue {
    fn name(&self) -> &str {
        VENUE_NAME
    }

    async fn submit(&self, o: &VenueOrder) -> Result<VenueAck, VenueError> {
        if let Some((_, voi, _)) = self.load(&o.client_order_id).await? {
            return Ok(VenueAck { venue_order_id: voi, queue_ahead: 0 }); // idempotent on the client order id
        }
        let dec = self.base_decimals(&o.client_order_id).await?;
        let plan = self.plan(o, dec);
        let fills_json: Vec<_> = plan.fills.iter().map(|f| json!({"id": f.venue_fill_id, "qty": f.qty.to_string(), "quote": f.quote_amount.to_string(), "fee": f.fee_quote.to_string()})).collect();
        let status = if plan.fully_filled { "filled" } else { "expired" };
        let side = if o.side == Side::Buy { "buy" } else { "sell" };
        let tif = format!("{:?}", o.tif);
        fn op<'a>(tx: &'a Tx, id: String, voi: String, side: String, price: String, qty: String, tif: String, status: String, filled: String, fills: serde_json::Value, seed: i64) -> BoxFut<'a, ()> {
            Box::pin(async move {
                tx.c()
                    .execute(
                        "insert into paper_venue_orders(venue, client_order_id, venue_order_id, side, price, qty, tif, status, filled_qty, fills, seed) \
                         values ('paper-sim',$1,$2,$3,$4::text::numeric,$5::text::numeric,$6,$7,$8::text::numeric,$9,$10) on conflict (venue, client_order_id) do nothing",
                        &[&id, &voi, &side, &price, &qty, &tif, &status, &filled, &fills, &seed],
                    )
                    .await?;
                Ok(())
            })
        }
        let fj = serde_json::Value::Array(fills_json);
        self.db
            .run(|tx| {
                op(tx, o.client_order_id.clone(), plan.venue_order_id.clone(), side.into(), o.price.to_string(), o.qty.to_string(), tif.clone(), status.into(), plan.filled_qty.to_string(), fj.clone(), self.seed as i64)
            })
            .await
            .map_err(|_| VenueError::Timeout)?; // a failed write means the outcome is unknown to us
        Ok(VenueAck { venue_order_id: plan.venue_order_id, queue_ahead: 0 })
    }

    async fn fills(&self, c: &str) -> Result<Vec<VenueFill>, VenueError> {
        Ok(self.load(c).await?.map(|(_, _, f)| fills_from_json(&f)).unwrap_or_default())
    }

    async fn status(&self, c: &str) -> Result<OrderStatus, VenueError> {
        match self.load(c).await? {
            None => Ok(OrderStatus::NotFound { authoritative: true }), // the venue's own table is the source of truth
            Some((st, _, f)) => {
                let filled: u128 = fills_from_json(&f).iter().map(|x| x.qty).sum();
                Ok(match st.as_str() {
                    "filled" => OrderStatus::Closed { filled_qty: filled, reason: CloseReason::Filled },
                    "cancelled" => OrderStatus::Closed { filled_qty: filled, reason: CloseReason::Cancelled },
                    "expired" => OrderStatus::Closed { filled_qty: filled, reason: CloseReason::Expired },
                    _ => OrderStatus::Open { filled_qty: filled },
                })
            }
        }
    }

    async fn cancel(&self, _c: &str) -> Result<(), VenueError> {
        Ok(()) // orders are IOC and closed at acceptance: nothing is ever resting
    }
}
