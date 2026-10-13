//! Idempotent dispatcher: intent -> risk -> reserve -> quote -> submit -> fills, entirely state-driven.
//!
//! * `drive(intent)` reads the CURRENT state from Postgres and performs the next action, so a crash at any point
//!   is recovered by calling `drive` again (or `recover()` at startup). Every action is idempotent: transitions use
//!   deterministic event keys (`advance_intent` ignores duplicates), reservations are keyed `intent:<id>`, fills are
//!   unique per (intent, venue_fill_id) and bounded by the reservation (`apply_fill_checked`).
//! * The one dangerous window is between "state = SUBMITTING" and "venue acknowledged". A SUBMITTING state found by
//!   anything other than the run that just wrote it is NEVER resubmitted: the venue is asked about the client order
//!   id; if it knows the order we adopt it, otherwise the intent becomes UNKNOWN. A timeout/unavailable on submit also
//!   becomes UNKNOWN. UNKNOWN is left alone by `drive`/`recover`; only `reconcile` (authoritative lookup) resolves it,
//!   and no code path ever calls `submit` for an intent that already left SUBMITTING.
//! * Reservations are released/consumed exactly once when an intent reaches an outcome state
//!   (`settle_intent_reservation`); funds of UNKNOWN orders stay reserved (pending funds are unavailable).

use crate::db::{parse_u128, BoxFut, Db, Tx};
use crate::economics::{self, EconomicsConfig, EconomicsInput};
use crate::error::ExecError;
use crate::state::OrderState;
use crate::venue::*;
use apex_risk::{DataHealth, GlobalState, Level, PolicyLayer, RiskInput, Side};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeSet;
use std::sync::Arc;
use uuid::Uuid;

/// Market facts a strategy / data layer supplies with an intent. Persisted immutably with the intent so that replay
/// is deterministic and never depends on the wall clock.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MarketSnapshot {
    pub slippage_bps: u32,
    pub quote_age_ms: u64,
    pub data_health: DataHealth,
    pub expected_edge_bps: i64,
    pub entry_fee_bps: u32,
    pub exit_fee_bps: u32,
    pub exit_slippage_bps: u32,
    #[serde(with = "crate::u128s")]
    pub gas_entry_quote: u128,
    #[serde(with = "crate::u128s")]
    pub gas_exit_quote: u128,
    pub failed_tx_prob_bps: u32,
    #[serde(with = "crate::u128s")]
    pub failed_tx_cost_quote: u128,
    pub adverse_selection_bps: u32,
    pub failed_tx_rate_bps: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IntentContext {
    pub asset_key: String,
    pub tif: Tif,
    pub base_decimals: u32,
    /// Highest fee rate that may be charged (budgeted into the reservation).
    pub max_fee_bps: u32,
    pub market: MarketSnapshot,
    /// wallet / basket / strategy / order policy layers supplied with the intent (tighten-only).
    pub layers: Vec<(Level, PolicyLayer)>,
    pub econ: EconomicsConfig,
}

#[derive(Clone, Debug)]
pub struct IntentSpec {
    pub workspace: Uuid,
    pub environment: String,
    pub bucket: Uuid,
    pub strategy_key: String,
    pub wca: Uuid,
    pub base_asset: Uuid,
    pub quote_asset: Uuid,
    pub side: Side,
    pub quantity: u128,
    pub limit_price: u128,
    pub idempotency_key: String,
    pub venue: String,
    pub ctx: IntentContext,
}

fn ceil_div(a: u128, b: u128) -> u128 {
    a / b + u128::from(a % b != 0)
}

impl IntentSpec {
    /// Gross quote value of the order at its limit price.
    pub fn gross_quote(&self) -> u128 {
        let dec = 10u128.pow(self.ctx.base_decimals);
        let g = self.quantity * self.limit_price;
        if self.side == Side::Buy {
            ceil_div(g, dec)
        } else {
            g / dec
        }
    }
    /// Amount to reserve. Buy: quote budget = gross + maximum fee. Sell: base quantity.
    pub fn notional(&self) -> u128 {
        match self.side {
            Side::Buy => {
                let g = self.gross_quote();
                g + ceil_div(g * self.ctx.max_fee_bps as u128, 10_000)
            }
            Side::Sell => self.quantity,
        }
    }
}

#[derive(Clone, Debug)]
pub struct IntentRow {
    pub id: Uuid,
    pub workspace: Uuid,
    pub environment: String,
    pub bucket: Uuid,
    pub wca: Uuid,
    pub base_asset: Uuid,
    pub quote_asset: Uuid,
    pub side: Side,
    pub quantity: u128,
    pub limit_price: u128,
    pub notional: u128,
    pub state: OrderState,
    pub reservation: Option<Uuid>,
    pub idem: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Reached an outcome state with its reservation settled.
    Terminal(OrderState),
    /// Order is live at the venue and nothing more can happen until venue time advances.
    Waiting(OrderState),
    /// Parked: UNKNOWN (needs reconciliation) or `stop_at` reached.
    Blocked(OrderState),
    /// Another driver holds the per-intent lock.
    Busy,
}

#[derive(Clone, Debug, Default)]
pub struct DriveOpts {
    pub stop_at: Option<OrderState>,
    /// Simulated process crash after this many durable actions (returns `ExecError::Crash`).
    pub crash_after: Option<usize>,
    /// Cancel at the venue if the order is still open and nothing else can progress.
    pub cancel_if_open: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct DriveReport {
    pub outcome: Outcome,
    /// Number of durable actions (DB commits / venue calls) performed by this call.
    pub steps: usize,
}

struct Run {
    steps: usize,
    crash_after: Option<usize>,
}
impl Run {
    fn cp(&mut self) -> Result<(), ExecError> {
        self.steps += 1;
        if self.crash_after == Some(self.steps) {
            return Err(ExecError::Crash(self.steps));
        }
        Ok(())
    }
}

enum Flow {
    Continue,
    Waiting,
}

pub struct Dispatcher {
    pub db: Db,
    paper: Arc<dyn Venue>,
    live: LiveVenue,
    evaluator: String,
}

// ------------------------------------------------------------------ SQL operations (each runs in one transaction)

fn pstate(s: &str) -> Result<OrderState, ExecError> {
    OrderState::parse(s).ok_or_else(|| ExecError::Other(format!("unknown state {s}")))
}

async fn load_intent_op(tx: &Tx, id: Uuid) -> Result<IntentRow, ExecError> {
    let r = tx
        .c()
        .query_one(
            "select id, workspace_id, environment::text, bucket_id, wallet_chain_account_id, base_asset, quote_asset, side, \
             quantity::text, coalesce(trunc(limit_price),0)::text, notional::text, state, reservation_id, idempotency_key \
             from trade_intents where id = $1",
            &[&id],
        )
        .await?;
    let side: String = r.get(7);
    Ok(IntentRow {
        id: r.get(0),
        workspace: r.get(1),
        environment: r.get(2),
        bucket: r.get(3),
        wca: r.get(4),
        base_asset: r.get(5),
        quote_asset: r.get(6),
        side: if side == "buy" { Side::Buy } else { Side::Sell },
        quantity: parse_u128(&r.get::<_, String>(8))?,
        limit_price: parse_u128(&r.get::<_, String>(9))?,
        notional: parse_u128(&r.get::<_, String>(10))?,
        state: pstate(&r.get::<_, String>(11))?,
        reservation: r.get(12),
        idem: r.get(13),
    })
}

async fn load_ctx_op(tx: &Tx, id: Uuid) -> Result<IntentContext, ExecError> {
    let r = tx.c().query_one("select context from intent_context where intent_id = $1", &[&id]).await?;
    let v: serde_json::Value = r.get(0);
    serde_json::from_value(v).map_err(|e| ExecError::Other(format!("bad intent context: {e}")))
}

async fn create_intent_op(tx: &Tx, s: &IntentSpec) -> Result<Uuid, ExecError> {
    let side = if s.side == Side::Buy { "buy" } else { "sell" };
    let ins = tx
        .c()
        .query_opt(
            "insert into trade_intents(workspace_id, environment, bucket_id, strategy_key, wallet_chain_account_id, base_asset, quote_asset, \
             side, quantity, limit_price, notional, idempotency_key, venue) \
             values ($1,$2::text::environment,$3,$4,$5,$6,$7,$8,$9::text::numeric,$10::text::numeric,$11::text::numeric,$12,$13) \
             on conflict (workspace_id, idempotency_key) do nothing returning id",
            &[
                &s.workspace, &s.environment, &s.bucket, &s.strategy_key, &s.wca, &s.base_asset, &s.quote_asset, &side,
                &s.quantity.to_string(), &s.limit_price.to_string(), &s.notional().to_string(), &s.idempotency_key, &s.venue,
            ],
        )
        .await?;
    let id: Uuid = match ins {
        Some(r) => r.get(0),
        None => tx.c().query_one("select id from trade_intents where workspace_id=$1 and idempotency_key=$2", &[&s.workspace, &s.idempotency_key]).await?.get(0),
    };
    let ctx = serde_json::to_value(&s.ctx).map_err(|e| ExecError::Other(e.to_string()))?;
    tx.c()
        .execute("insert into intent_context(intent_id, workspace_id, context) values ($1,$2,$3) on conflict (intent_id) do nothing", &[&id, &s.workspace, &ctx])
        .await?;
    Ok(id)
}

async fn advance_op(tx: &Tx, id: Uuid, to: OrderState, key: String, detail: serde_json::Value) -> Result<OrderState, ExecError> {
    let r = tx.c().query_one("select advance_intent($1,$2,$3,$4)", &[&id, &to.as_str(), &key, &detail]).await?;
    pstate(&r.get::<_, String>(0))
}

async fn risk_op(tx: &Tx, id: Uuid, evaluator: String) -> Result<(bool, serde_json::Value), ExecError> {
    let c = tx.c();
    // serialise with other writers of this intent's decision
    c.query_one("select id from trade_intents where id=$1 for update", &[&id]).await?;
    if let Some(r) = c.query_opt("select decision, reasons from risk_decisions where intent_id=$1 order by (decision='VETO') desc, created_at limit 1", &[&id]).await? {
        let d: String = r.get(0);
        return Ok((d == "ADMIT", r.get(1)));
    }
    let it = load_intent_op(tx, id).await?;
    let ctx = load_ctx_op(tx, id).await?;
    let bucket_active: bool = c.query_one("select state = 'active' from buckets where id=$1", &[&it.bucket]).await?.get(0);
    let gs: String = c.query_one("select global_state from workspace_settings where workspace_id=$1", &[&it.workspace]).await?.get(0);
    let qv = parse_u128(
        &c.query_one(
            "select coalesce(sum(balance),0)::text from ledger_accounts where workspace_id=$1 and bucket_id=$2 and asset_id=$3 and state in ('available','reserved')",
            &[&it.workspace, &it.bucket, &it.quote_asset],
        )
        .await?
        .get::<_, String>(0),
    )?;
    let pos = c
        .query_opt(
            "select qty::text, cost_basis_quote::text from positions where bucket_id=$1 and wallet_chain_account_id=$2 and base_asset=$3 and quote_asset=$4",
            &[&it.bucket, &it.wca, &it.base_asset, &it.quote_asset],
        )
        .await?;
    let (pos_qty, pos_cost) = match pos {
        Some(r) => (parse_u128(&r.get::<_, String>(0))?, parse_u128(&r.get::<_, String>(1))?),
        None => (0, 0),
    };
    let all_cost = parse_u128(
        &c.query_one("select coalesce(sum(cost_basis_quote),0)::text from positions where bucket_id=$1 and quote_asset=$2", &[&it.bucket, &it.quote_asset])
            .await?
            .get::<_, String>(0),
    )?;
    let unknown: i64 = c
        .query_one("select count(*) from trade_intents where workspace_id=$1 and bucket_id=$2 and state='UNKNOWN' and id<>$3", &[&it.workspace, &it.bucket, &id])
        .await?
        .get(0);
    let bucket_value = qv + all_cost;
    let reduces = it.side == Side::Sell && pos_qty >= it.quantity;
    let notional = if it.side == Side::Buy { it.notional } else { ceil_div(it.quantity * it.limit_price, 10u128.pow(ctx.base_decimals)) };
    let concentration = if it.side == Side::Buy && bucket_value > 0 { ceil_div((pos_cost + notional) * 10_000, bucket_value) } else { 0 };
    let input = RiskInput {
        side: it.side,
        asset_key: ctx.asset_key.clone(),
        notional,
        bucket_value,
        slippage_bps: ctx.market.slippage_bps,
        quote_age_ms: ctx.market.quote_age_ms,
        data_health: ctx.market.data_health,
        total_fee_bps: ctx.market.entry_fee_bps.saturating_add(ctx.market.exit_fee_bps),
        expected_edge_bps: ctx.market.expected_edge_bps,
        post_trade_concentration_bps: concentration.min(u32::MAX as u128) as u32,
        failed_tx_rate_bps: ctx.market.failed_tx_rate_bps,
        open_unknown_orders: unknown as u32,
        global_state: GlobalState::parse(&gs),
        bucket_active,
        reduces_exposure: reduces,
    };
    let (policy, ver) = apex_risk::db::load_policy(c, it.workspace, it.bucket, &ctx.layers).await?;
    let decision = apex_risk::evaluate(&policy, &input);
    let rec = apex_risk::db::record_decision(c, id, it.workspace, &decision, ver, &evaluator).await?;
    let reasons = if rec.inserted { decision.reasons_json() } else { json!([]) };
    Ok((rec.decision == "ADMIT", reasons))
}

async fn reserve_op(tx: &Tx, id: Uuid) -> Result<Uuid, ExecError> {
    Ok(tx.c().query_one("select reserve_for_intent($1)", &[&id]).await?.get(0))
}

async fn deliver_fill_op(tx: &Tx, id: Uuid, f: VenueFill) -> Result<OrderState, ExecError> {
    let c = tx.c();
    c.query_one(
        "select apply_fill_checked($1,$2,$3::text::numeric,$4::text::numeric,$5::text::numeric)",
        &[&id, &f.venue_fill_id, &f.qty.to_string(), &f.quote_amount.to_string(), &f.fee_quote.to_string()],
    )
    .await?;
    let r = c
        .query_one("select (select coalesce(sum(qty),0) from fills where intent_id=$1)::text, (select quantity from trade_intents where id=$1)::text", &[&id])
        .await?;
    let cum = parse_u128(&r.get::<_, String>(0))?;
    let want = parse_u128(&r.get::<_, String>(1))?;
    let to = if cum >= want { OrderState::Filled } else { OrderState::PartiallyFilled };
    advance_op(tx, id, to, format!("fill:{}", f.venue_fill_id), json!({"venue_fill_id": f.venue_fill_id, "qty": f.qty.to_string(), "quote": f.quote_amount.to_string(), "fee": f.fee_quote.to_string(), "liquidity": format!("{:?}", f.liquidity)})).await
}

impl Dispatcher {
    pub fn new(db: Db, paper: Arc<dyn Venue>) -> Self {
        Dispatcher { db, paper, live: LiveVenue, evaluator: "apex-risk".into() }
    }

    fn venue_for(&self, env: &str) -> &dyn Venue {
        if env == "live" {
            &self.live
        } else {
            self.paper.as_ref()
        }
    }

    pub async fn create_intent(&self, spec: &IntentSpec) -> Result<Uuid, ExecError> {
        fn op(tx: &Tx, s: IntentSpec) -> BoxFut<'_, Uuid> {
            Box::pin(async move { create_intent_op(tx, &s).await })
        }
        self.db.run(|tx| op(tx, spec.clone())).await
    }

    pub async fn load(&self, id: Uuid) -> Result<IntentRow, ExecError> {
        fn op(tx: &Tx, id: Uuid) -> BoxFut<'_, IntentRow> {
            Box::pin(load_intent_op(tx, id))
        }
        self.db.run(|tx| op(tx, id)).await
    }

    async fn advance(&self, id: Uuid, to: OrderState, key: &str, detail: serde_json::Value) -> Result<OrderState, ExecError> {
        fn op(tx: &Tx, id: Uuid, to: OrderState, key: String, d: serde_json::Value) -> BoxFut<'_, OrderState> {
            Box::pin(advance_op(tx, id, to, key, d))
        }
        self.db.run(|tx| op(tx, id, to, key.to_string(), detail.clone())).await
    }

    /// Deliver one venue fill (idempotent; safe to call any number of times, concurrently, in any order).
    pub async fn deliver_fill(&self, id: Uuid, f: &VenueFill) -> Result<OrderState, ExecError> {
        fn op(tx: &Tx, id: Uuid, f: VenueFill) -> BoxFut<'_, OrderState> {
            Box::pin(deliver_fill_op(tx, id, f))
        }
        self.db.run(|tx| op(tx, id, f.clone())).await
    }

    async fn settle(&self, id: Uuid) -> Result<(), ExecError> {
        fn op(tx: &Tx, id: Uuid) -> BoxFut<'_, ()> {
            Box::pin(async move {
                tx.c().execute("select settle_intent_reservation($1)", &[&id]).await?;
                Ok(())
            })
        }
        self.db.run(|tx| op(tx, id)).await
    }

    /// Drive one intent as far as it can go. Takes a per-intent advisory lock so two drivers never act on one intent.
    pub async fn drive(&self, id: Uuid, opts: DriveOpts) -> Result<DriveReport, ExecError> {
        let _permit = self.db.drive_permit().await;
        let lock = self.db.conn().await?;
        let key = id.to_string();
        let got: bool = lock.query_one("select pg_try_advisory_lock(hashtextextended($1,0))", &[&key]).await?.get(0);
        if !got {
            return Ok(DriveReport { outcome: Outcome::Busy, steps: 0 });
        }
        let mut run = Run { steps: 0, crash_after: opts.crash_after };
        let r = self.drive_inner(id, &opts, &mut run).await;
        let _ = lock.query_one("select pg_advisory_unlock(hashtextextended($1,0))", &[&key]).await;
        r.map(|outcome| DriveReport { outcome, steps: run.steps })
    }

    async fn drive_inner(&self, id: Uuid, opts: &DriveOpts, run: &mut Run) -> Result<Outcome, ExecError> {
        let mut just_submitting = false;
        let mut raced = 0u32;
        loop {
            match self.step(id, opts, run, &mut just_submitting).await {
                Ok(Some(o)) => return Ok(o),
                Ok(None) => {}
                // someone else (e.g. a console cancel) moved the intent between our read and our write: re-read and go on
                Err(ExecError::Db(ref e)) if raced < 5 && e.as_db_error().map(|d| d.message().contains("illegal transition")).unwrap_or(false) => {
                    raced += 1;
                }
                Err(e) => return Err(e),
            }
        }
    }

    /// One state-driven step. `Ok(Some(outcome))` ends the drive, `Ok(None)` means "loop again".
    async fn step(&self, id: Uuid, opts: &DriveOpts, run: &mut Run, just_submitting: &mut bool) -> Result<Option<Outcome>, ExecError> {
        let it = self.load(id).await?;
        if opts.stop_at == Some(it.state) {
            return Ok(Some(Outcome::Blocked(it.state)));
        }
            use OrderState::*;
            match it.state {
                Signal => {
                    self.advance(id, Candidate, "candidate", json!({})).await?;
                    run.cp()?;
                }
                Candidate => {
                    self.advance(id, RiskEvaluating, "risk_evaluating", json!({})).await?;
                    run.cp()?;
                }
                RiskEvaluating => {
                    fn op(tx: &Tx, id: Uuid, ev: String) -> BoxFut<'_, (bool, serde_json::Value)> {
                        Box::pin(risk_op(tx, id, ev))
                    }
                    let ev = self.evaluator.clone();
                    let (admit, reasons) = self.db.run(|tx| op(tx, id, ev.clone())).await?;
                    run.cp()?;
                    if admit {
                        match self.advance(id, Admitted, "admitted", json!({})).await {
                            Ok(_) => {}
                            Err(e) if e.message().contains("refuses new entries") || e.message().contains("risk gate") => {
                                self.advance(id, Failed, "failed:admit_refused", json!({"reason": e.message()})).await?;
                            }
                            Err(e) => return Err(e),
                        }
                    } else {
                        self.advance(id, Failed, "failed:risk_veto", json!({"reason": "risk_veto", "reasons": reasons})).await?;
                    }
                    run.cp()?;
                }
                Admitted => {
                    fn op(tx: &Tx, id: Uuid) -> BoxFut<'_, Uuid> {
                        Box::pin(reserve_op(tx, id))
                    }
                    match self.db.run(|tx| op(tx, id)).await {
                        Ok(_) => {
                            run.cp()?;
                            self.advance(id, CapitalReserved, "capital_reserved", json!({})).await?;
                        }
                        Err(e) if e.is_insufficient_funds() => {
                            self.advance(id, Failed, "failed:insufficient_funds", json!({"reason": "insufficient_funds", "db": e.message()})).await?;
                        }
                        Err(e) => return Err(e),
                    }
                    run.cp()?;
                }
                CapitalReserved => {
                    let ctx = self.load_ctx(id).await?;
                    let exit = self.is_exit_path(id).await?;
                    let dec = 10u128.pow(ctx.base_decimals);
                    let gross = if it.side == Side::Buy { ceil_div(it.quantity * it.limit_price, dec) } else { it.quantity * it.limit_price / dec };
                    let m = &ctx.market;
                    let inp = EconomicsInput {
                        notional: gross,
                        expected_edge_bps: m.expected_edge_bps,
                        entry_fee_bps: m.entry_fee_bps,
                        exit_fee_bps: m.exit_fee_bps,
                        entry_slippage_bps: m.slippage_bps,
                        exit_slippage_bps: m.exit_slippage_bps,
                        gas_entry_quote: m.gas_entry_quote,
                        gas_exit_quote: m.gas_exit_quote,
                        failed_tx_prob_bps: m.failed_tx_prob_bps,
                        failed_tx_cost_quote: m.failed_tx_cost_quote,
                        tx_legs: 2,
                        adverse_selection_bps: m.adverse_selection_bps,
                    };
                    match economics::evaluate(&inp, &ctx.econ) {
                        Ok(e) => {
                            self.advance(id, Quoted, "quoted", json!({"economics": e, "exit_override": false})).await?;
                        }
                        Err((e, reasons)) if exit => {
                            // risk-reducing exits are never blocked by entry economics; recorded for attribution
                            self.advance(id, Quoted, "quoted", json!({"economics": e, "reasons": reasons, "exit_override": true})).await?;
                        }
                        Err((e, reasons)) => {
                            self.advance(id, Failed, "failed:unprofitable_quote", json!({"reason": "unprofitable_quote", "economics": e, "reasons": reasons})).await?;
                        }
                    }
                    run.cp()?;
                }
                Quoted => {
                    self.advance(id, Prepared, "prepared", json!({})).await?;
                    run.cp()?;
                }
                Prepared => {
                    self.advance(id, Submitting, "submitting", json!({})).await?;
                    *just_submitting = true;
                    run.cp()?;
                }
                Submitting => {
                    self.submit_step(&it, *just_submitting, run).await?;
                    *just_submitting = false;
                }
                Acknowledged | PartiallyFilled => match self.fill_step(&it, opts, run).await? {
                    Flow::Continue => {}
                    Flow::Waiting => return Ok(Some(Outcome::Waiting(it.state))),
                },
                Unknown => return Ok(Some(Outcome::Blocked(Unknown))),
                Filled | Cancelled | Expired | Failed => {
                    self.settle(id).await?;
                    run.cp()?;
                    return Ok(Some(Outcome::Terminal(it.state)));
                }
                ApprovalWait => return Ok(Some(Outcome::Blocked(ApprovalWait))),
                s => return Ok(Some(Outcome::Terminal(s))), // post-trade states belong to the settlement pipeline
        }
        Ok(None)
    }

    async fn load_ctx(&self, id: Uuid) -> Result<IntentContext, ExecError> {
        fn op(tx: &Tx, id: Uuid) -> BoxFut<'_, IntentContext> {
            Box::pin(load_ctx_op(tx, id))
        }
        self.db.run(|tx| op(tx, id)).await
    }

    async fn is_exit_path(&self, id: Uuid) -> Result<bool, ExecError> {
        fn op(tx: &Tx, id: Uuid) -> BoxFut<'_, bool> {
            Box::pin(async move {
                let r = tx.c().query_opt("select reasons->0->>'code' from risk_decisions where intent_id=$1 and decision='ADMIT'", &[&id]).await?;
                Ok(r.and_then(|r| r.get::<_, Option<String>>(0)).as_deref() == Some("ADMIT_EXIT_PATH"))
            })
        }
        self.db.run(|tx| op(tx, id)).await
    }

    async fn submit_step(&self, it: &IntentRow, allowed_to_submit: bool, run: &mut Run) -> Result<(), ExecError> {
        use OrderState::*;
        let id = it.id;
        if it.environment == "live" {
            let allowed: bool = self.db.conn().await?.query_one("select live_allowed($1)", &[&it.workspace]).await?.get(0);
            if !allowed {
                self.advance(id, Failed, "failed:live_not_allowed", json!({"reason": "live_allowed(ws) is false"})).await?;
                return run.cp();
            }
        }
        let venue = self.venue_for(&it.environment);
        match venue.status(&it.idem).await {
            Ok(OrderStatus::Open { .. }) | Ok(OrderStatus::Closed { .. }) => {
                // the venue already knows this client order id: adopt it, never resubmit
                self.advance(id, Acknowledged, "acknowledged", json!({"adopted": true})).await?;
                run.cp()
            }
            Ok(OrderStatus::NotFound { .. }) if allowed_to_submit => {
                let ctx = self.load_ctx(id).await?;
                let order = VenueOrder { client_order_id: it.idem.clone(), side: it.side, price: it.limit_price, qty: it.quantity, tif: ctx.tif };
                let res = venue.submit(&order).await; // the ONLY submit call site
                run.cp()?; // window: venue has the order, DB does not know yet
                match res {
                    Ok(ack) => {
                        self.advance(id, Acknowledged, "acknowledged", json!({"venue_order_id": ack.venue_order_id, "queue_ahead": ack.queue_ahead.to_string()})).await?;
                    }
                    Err(VenueError::Timeout) | Err(VenueError::Unavailable) => {
                        self.advance(id, Unknown, "unknown", json!({"reason": "submit timeout/unavailable; outcome unknown; resubmission forbidden"})).await?;
                    }
                    Err(e) => {
                        self.advance(id, Failed, "failed:venue_rejected", json!({"reason": e.to_string()})).await?;
                    }
                }
                run.cp()
            }
            // Not found but we cannot prove the previous run didn't send it, or the status call itself failed.
            _ => {
                self.advance(id, Unknown, "unknown", json!({"reason": "SUBMITTING found on recovery without venue confirmation; outcome unknown"})).await?;
                run.cp()
            }
        }
    }

    async fn fill_step(&self, it: &IntentRow, opts: &DriveOpts, run: &mut Run) -> Result<Flow, ExecError> {
        use OrderState::*;
        let id = it.id;
        let venue = self.venue_for(&it.environment);
        let status = match venue.status(&it.idem).await {
            Ok(s) => s,
            Err(_) => return Ok(Flow::Waiting),
        };
        let fills = match venue.fills(&it.idem).await {
            Ok(f) => f,
            Err(_) => return Ok(Flow::Waiting),
        };
        fn applied_op(tx: &Tx, id: Uuid) -> BoxFut<'_, BTreeSet<String>> {
            Box::pin(async move {
                let rows = tx.c().query("select venue_fill_id from fills where intent_id=$1", &[&id]).await?;
                Ok(rows.iter().map(|r| r.get::<_, String>(0)).collect())
            })
        }
        let applied = self.db.run(|tx| applied_op(tx, id)).await?;
        let mut progressed = false;
        for f in fills.iter().filter(|f| !applied.contains(&f.venue_fill_id)) {
            self.deliver_fill(id, f).await?;
            run.cp()?;
            progressed = true;
        }
        if progressed {
            return Ok(Flow::Continue);
        }
        match status {
            OrderStatus::Open { .. } => {
                if opts.cancel_if_open {
                    venue.cancel(&it.idem).await?;
                    run.cp()?;
                    Ok(Flow::Continue)
                } else {
                    Ok(Flow::Waiting)
                }
            }
            OrderStatus::Closed { reason, .. } => {
                if reason == CloseReason::Filled {
                    return Ok(Flow::Waiting); // all fills must still arrive
                }
                let to = if it.state == Acknowledged && reason == CloseReason::Expired { Expired } else { Cancelled };
                self.advance(id, to, &format!("closed:{reason:?}"), json!({"venue_reason": format!("{reason:?}")})).await?;
                run.cp()?;
                Ok(Flow::Continue)
            }
            OrderStatus::NotFound { .. } => Ok(Flow::Waiting),
        }
    }

    /// Resolve an UNKNOWN intent using the venue's AUTHORITATIVE answer only. Never submits.
    /// Returns the resulting outcome (still `Blocked(Unknown)` if the venue cannot give an authoritative answer).
    pub async fn reconcile(&self, id: Uuid, opts: DriveOpts) -> Result<DriveReport, ExecError> {
        use OrderState::*;
        let it = self.load(id).await?;
        if it.state != Unknown {
            return self.drive(id, opts).await;
        }
        let venue = self.venue_for(&it.environment);
        match venue.status(&it.idem).await {
            Ok(OrderStatus::Open { .. }) | Ok(OrderStatus::Closed { .. }) => {
                self.advance(id, Acknowledged, "reconciled:found", json!({"source": "venue status lookup"})).await?;
            }
            Ok(OrderStatus::NotFound { authoritative: true }) => {
                self.advance(id, Failed, "reconciled:not_found", json!({"reason": "venue authoritatively reports no such order"})).await?;
            }
            _ => return Ok(DriveReport { outcome: Outcome::Blocked(Unknown), steps: 0 }),
        }
        self.drive(id, opts).await
    }

    pub async fn unknown_intents(&self) -> Result<Vec<Uuid>, ExecError> {
        fn op(tx: &Tx) -> BoxFut<'_, Vec<Uuid>> {
            Box::pin(async move {
                Ok(tx.c().query("select id from trade_intents where state='UNKNOWN' order by created_at, id", &[]).await?.iter().map(|r| r.get(0)).collect())
            })
        }
        self.db.run(|tx| op(tx)).await
    }

    /// Startup recovery: deterministically replay every non-terminal intent (UNKNOWN ones are left parked) and every
    /// intent that reached an outcome but whose reservation is still held. Order: creation time, then id.
    pub async fn recover(&self, opts: DriveOpts) -> Result<Vec<(Uuid, DriveReport)>, ExecError> {
        fn op(tx: &Tx) -> BoxFut<'_, Vec<Uuid>> {
            Box::pin(async move {
                let rows = tx
                    .c()
                    .query(
                        "select t.id from trade_intents t where \
                           (t.state not in ('UNKNOWN','FILLED','CANCELLED','EXPIRED','FAILED','SETTLING','FINAL','REORGED','DISPUTED','RECONCILED','LEDGER_APPLIED','COMPOUNDING_ELIGIBLE','APPROVAL_WAIT')) \
                        or (t.state in ('FILLED','CANCELLED','EXPIRED','FAILED') and t.reservation_id is not null \
                            and exists (select 1 from capital_reservations r where r.id = t.reservation_id and r.status = 'held')) \
                        order by t.created_at, t.id",
                        &[],
                    )
                    .await?;
                Ok(rows.iter().map(|r| r.get(0)).collect())
            })
        }
        let ids = self.db.run(|tx| op(tx)).await?;
        let mut out = Vec::new();
        for id in ids {
            out.push((id, self.drive(id, opts.clone()).await?));
        }
        Ok(out)
    }
}
