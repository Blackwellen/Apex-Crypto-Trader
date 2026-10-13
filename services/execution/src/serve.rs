//! `apex-execution serve`: the long-running, supervised PAPER execution loop.
//!
//! Every `poll_ms` it asks Postgres which PAPER intents need work and drives them through the existing dispatcher
//! (in-process risk gate + SQL enforcement) against the deterministic `DbPaperVenue`.
//!
//! Work selection (paper environment only; live intents are never selected):
//!   * SIGNAL / CANDIDATE / RISK_EVALUATING   only when the workspace has `paper_running = true`, OR is halted
//!                                            (a halted workspace gets its pending entries vetoed and its exits admitted promptly)
//!   * ADMITTED .. PARTIALLY_FILLED, SETTLING, FINAL   always (an admitted order is drained, never abandoned; admitted ENTRIES are
//!                                            cancelled instead of submitted when the workspace is halted: see the dispatcher)
//!   * UNKNOWN                                reconciled against the venue's authoritative answer; NEVER resubmitted
//!   * FILLED / CANCELLED / EXPIRED with fills   instant PAPER settlement (SETTLING -> FINAL -> RECONCILED) and, when the bucket has a
//!                                            compounding policy, `apply_waterfall` for realised profit (all inside `paper_settle_intent`)
//!
//! Serialisation: work is grouped by (workspace, bucket, wallet-chain-account). A group is processed by exactly one serve loop at a
//! time (session advisory lock `pg_try_advisory_lock`), strictly in (created_at, id) order, so risk evaluation, reservation and fills
//! of one bucket/wallet never interleave and capital is never allocated twice. A second serve process simply skips groups that are
//! locked. Different groups run in parallel. Every individual step is also idempotent in SQL, so a crash at any point is recovered by
//! the next poll (this IS the startup recovery: the very first poll picks up every non-terminal paper intent).

use crate::db::{BoxFut, Db, Tx};
use crate::dispatcher::{DriveOpts, Dispatcher, Outcome};
use crate::error::ExecError;
use crate::state::OrderState;
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Notify, Semaphore};
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct ServeConfig {
    pub poll_ms: u64,
    /// groups processed in parallel inside this process
    pub groups_parallel: usize,
    pub instance: String,
    pub heartbeat_ms: u64,
    pub metrics_every_ms: u64,
    /// return when no progress has been made for this long (None = run until shutdown). Used by tests and one-shot drains.
    pub exit_when_idle_ms: Option<u64>,
    pub batch_limit: i64,
    /// TEST KNOB: sleep after each intent so a kill -9 reliably lands mid-flow. 0 in production.
    pub step_delay_ms: u64,
}

impl Default for ServeConfig {
    fn default() -> Self {
        ServeConfig {
            poll_ms: 500,
            groups_parallel: 4,
            instance: format!("exec-{}", std::process::id()),
            heartbeat_ms: 2_000,
            metrics_every_ms: 10_000,
            exit_when_idle_ms: None,
            batch_limit: 500,
            step_delay_ms: 0,
        }
    }
}

#[derive(Default)]
pub struct Counters {
    pub polls: AtomicU64,
    pub work_items: AtomicU64,
    pub driven: AtomicU64,
    pub filled: AtomicU64,
    pub cancelled: AtomicU64,
    pub expired: AtomicU64,
    pub failed: AtomicU64,
    pub waiting: AtomicU64,
    pub unknown_blocked: AtomicU64,
    pub reconciled_unknown: AtomicU64,
    pub intent_busy: AtomicU64,
    pub group_busy: AtomicU64,
    pub settled: AtomicU64,
    pub errors: AtomicU64,
    progress: AtomicU64,
}

impl Counters {
    fn inc(c: &AtomicU64) {
        c.fetch_add(1, Ordering::Relaxed);
    }
    pub fn snapshot(&self) -> serde_json::Value {
        let g = |c: &AtomicU64| c.load(Ordering::Relaxed);
        json!({
            "polls": g(&self.polls), "work_items": g(&self.work_items), "driven": g(&self.driven), "filled": g(&self.filled),
            "cancelled": g(&self.cancelled), "expired": g(&self.expired), "failed": g(&self.failed), "waiting": g(&self.waiting),
            "unknown_blocked": g(&self.unknown_blocked), "reconciled_unknown": g(&self.reconciled_unknown),
            "intent_busy": g(&self.intent_busy), "group_busy": g(&self.group_busy), "settled": g(&self.settled), "errors": g(&self.errors),
        })
    }
    pub fn get(&self, name: &str) -> u64 {
        self.snapshot().get(name).and_then(|v| v.as_u64()).unwrap_or(0)
    }
}

/// Cooperative shutdown flag shared by the loop, the heartbeat task and the signal handler.
#[derive(Default)]
pub struct Shutdown {
    flag: AtomicBool,
    notify: Notify,
}
impl Shutdown {
    pub fn trigger(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }
    pub fn is_set(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
    async fn sleep(&self, d: Duration) {
        if self.is_set() {
            return;
        }
        let _ = tokio::time::timeout(d, self.notify.notified()).await;
    }
}

#[derive(Clone, Debug)]
struct Work {
    id: Uuid,
    ws: Uuid,
    bucket: Uuid,
    wca: Uuid,
    state: OrderState,
}

const WORK_SQL: &str = "
select t.id, t.workspace_id, t.bucket_id, t.wallet_chain_account_id, t.state
  from trade_intents t join workspace_settings s on s.workspace_id = t.workspace_id
 where t.environment = 'paper' and (
       (t.state in ('SIGNAL','CANDIDATE','RISK_EVALUATING') and (s.paper_running or s.global_state <> 'active'))
    or t.state in ('ADMITTED','CAPITAL_RESERVED','QUOTED','PREPARED','SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED','UNKNOWN','SETTLING','FINAL')
    or (t.state in ('FILLED','CANCELLED','EXPIRED','FAILED') and t.reservation_id is not null
        and exists (select 1 from capital_reservations r where r.id = t.reservation_id and r.status = 'held'))
    or (t.state in ('FILLED','CANCELLED','EXPIRED') and exists (select 1 from fills f where f.intent_id = t.id))
    or (t.state = 'RECONCILED'
        and exists (select 1 from profit_eligibility_events e where e.intent_id = t.id and e.realized_net_quote > 0
                     and not exists (select 1 from waterfall_executions w where w.profit_event_id = e.id))
        and exists (select 1 from compounding_policies p where p.bucket_id = t.bucket_id))
 ) order by t.created_at, t.id limit $1";

async fn find_work(db: &Db, limit: i64) -> Result<Vec<Work>, ExecError> {
    fn op(tx: &Tx, limit: i64) -> BoxFut<'_, Vec<Work>> {
        Box::pin(async move {
            let rows = tx.c().query(WORK_SQL, &[&limit]).await?;
            let mut out = Vec::with_capacity(rows.len());
            for r in rows {
                let st: String = r.get(4);
                let Some(state) = OrderState::parse(&st) else { continue };
                out.push(Work { id: r.get(0), ws: r.get(1), bucket: r.get(2), wca: r.get(3), state });
            }
            Ok(out)
        })
    }
    db.run(|tx| op(tx, limit)).await
}

struct Engine {
    d: Dispatcher,
    db: Db,
    cfg: ServeConfig,
    counters: Arc<Counters>,
    shutdown: Arc<Shutdown>,
}

impl Engine {
    /// One intent: drive it as far as it goes, then settle (paper). Returns whether anything changed.
    async fn process(&self, w: &Work) -> Result<bool, ExecError> {
        use OrderState::*;
        let mut progressed = false;
        match w.state {
            Unknown => {
                // Authoritative lookup only. Never submits. A venue that cannot answer leaves it UNKNOWN.
                let r = self.d.reconcile(w.id, DriveOpts::default()).await?;
                if r.steps > 0 {
                    Counters::inc(&self.counters.reconciled_unknown);
                    progressed = true;
                } else {
                    Counters::inc(&self.counters.unknown_blocked);
                }
                self.account(r.outcome);
            }
            Settling | Final | Reconciled => {}
            _ => {
                let r = self.d.drive(w.id, DriveOpts::default()).await?;
                Counters::inc(&self.counters.driven);
                progressed |= r.steps > 0;
                self.account(r.outcome);
                if matches!(r.outcome, Outcome::Busy) {
                    return Ok(false);
                }
            }
        }
        if self.settle(w.id).await? {
            progressed = true;
        }
        Ok(progressed)
    }

    fn account(&self, o: Outcome) {
        use OrderState::*;
        match o {
            Outcome::Terminal(Filled) => Counters::inc(&self.counters.filled),
            Outcome::Terminal(Cancelled) => Counters::inc(&self.counters.cancelled),
            Outcome::Terminal(Expired) => Counters::inc(&self.counters.expired),
            Outcome::Terminal(Failed) => Counters::inc(&self.counters.failed),
            Outcome::Terminal(_) => {}
            Outcome::Waiting(_) => Counters::inc(&self.counters.waiting),
            Outcome::Blocked(_) => {}
            Outcome::Busy => Counters::inc(&self.counters.intent_busy),
        }
    }

    /// PAPER-only settlement + waterfall in one SQL transaction. True if the intent's state changed.
    async fn settle(&self, id: Uuid) -> Result<bool, ExecError> {
        fn op(tx: &Tx, id: Uuid) -> BoxFut<'_, (String, String)> {
            Box::pin(async move {
                let before: String = tx.c().query_one("select state from trade_intents where id = $1", &[&id]).await?.get(0);
                let after: String = tx.c().query_one("select paper_settle_intent($1)", &[&id]).await?.get(0);
                Ok((before, after))
            })
        }
        let (before, after) = self.db.run(|tx| op(tx, id)).await?;
        if before != after {
            Counters::inc(&self.counters.settled);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    async fn process_group(self: Arc<Self>, key: (Uuid, Uuid, Uuid), items: Vec<Work>) {
        // session-level advisory lock on a pinned connection; ALWAYS released (or the connection discarded) before returning
        let lock_name = format!("apex-exec-group:{}:{}:{}", key.0, key.1, key.2);
        let conn = match self.db.conn().await {
            Ok(c) => c,
            Err(e) => {
                Counters::inc(&self.counters.errors);
                eprintln!("{}", json!({"event": "error", "where": "group_conn", "error": e.to_string()}));
                return;
            }
        };
        let got: bool = match conn.query_one("select pg_try_advisory_lock(hashtextextended($1,0))", &[&lock_name]).await {
            Ok(r) => r.get(0),
            Err(_) => {
                let _ = deadpool_postgres::Object::take(conn);
                Counters::inc(&self.counters.errors);
                return;
            }
        };
        if !got {
            Counters::inc(&self.counters.group_busy);
            return;
        }
        for w in &items {
            if self.shutdown.is_set() {
                break;
            }
            match self.process(w).await {
                Ok(p) => {
                    if p {
                        self.counters.progress.fetch_add(1, Ordering::Relaxed);
                    }
                }
                Err(e) => {
                    Counters::inc(&self.counters.errors);
                    eprintln!("{}", json!({"event": "error", "intent": w.id, "state": w.state.as_str(), "error": e.to_string()}));
                }
            }
            if self.cfg.step_delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(self.cfg.step_delay_ms)).await;
            }
        }
        if conn.query_one("select pg_advisory_unlock(hashtextextended($1,0))", &[&lock_name]).await.is_err() {
            let _ = deadpool_postgres::Object::take(conn); // closing the session releases the lock
        }
    }
}

fn host() -> String {
    std::env::var("HOSTNAME").ok().or_else(|| std::fs::read_to_string("/etc/hostname").ok().map(|s| s.trim().to_string())).unwrap_or_else(|| "unknown".into())
}

async fn heartbeat(db: &Db, cfg: &ServeConfig, started: chrono_free::Ts, counters: &Counters, stopped: bool, info: &serde_json::Value) -> Result<(), ExecError> {
    fn op<'a>(tx: &'a Tx, inst: String, pid: i32, host: String, started: f64, counters: serde_json::Value, info: serde_json::Value, stopped: bool) -> BoxFut<'a, ()> {
        Box::pin(async move {
            tx.c()
                .execute(
                    "select engine_heartbeat('execution', $1, $2, $3, to_timestamp($4), $5, $6, $7)",
                    &[&inst, &pid, &host, &started, &counters, &info, &stopped],
                )
                .await?;
            Ok(())
        })
    }
    let c = counters.snapshot();
    db.run(|tx| op(tx, cfg.instance.clone(), std::process::id() as i32, host(), started.0, c.clone(), info.clone(), stopped)).await
}

mod chrono_free {
    #[derive(Clone, Copy)]
    pub struct Ts(pub f64);
    impl Ts {
        pub fn now() -> Ts {
            Ts(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0))
        }
    }
}

/// Run the loop until `shutdown` is triggered (or until idle, if `exit_when_idle_ms` is set). Returns the final counters.
pub async fn run(d: Dispatcher, cfg: ServeConfig, shutdown: Arc<Shutdown>) -> Result<Arc<Counters>, ExecError> {
    let db = d.db.clone();
    let counters = Arc::new(Counters::default());
    let started = chrono_free::Ts::now();
    let info = json!({"data_provenance": "SYNTHETIC", "mode": "paper", "venue": crate::dbvenue::VENUE_NAME, "poll_ms": cfg.poll_ms, "live": "not implemented"});
    let eng = Arc::new(Engine { d, db: db.clone(), cfg: cfg.clone(), counters: counters.clone(), shutdown: shutdown.clone() });
    eprintln!("{}", json!({"event": "start", "instance": cfg.instance, "pid": std::process::id(), "poll_ms": cfg.poll_ms}));
    if let Err(e) = heartbeat(&db, &cfg, started, &counters, false, &info).await {
        eprintln!("{}", json!({"event": "error", "where": "first_heartbeat", "error": e.to_string()}));
    }

    // heartbeat task
    let hb = {
        let (db, cfg, counters, shutdown, info) = (db.clone(), cfg.clone(), counters.clone(), shutdown.clone(), info.clone());
        tokio::spawn(async move {
            while !shutdown.is_set() {
                shutdown.sleep(Duration::from_millis(cfg.heartbeat_ms)).await;
                if shutdown.is_set() {
                    break;
                }
                if let Err(e) = heartbeat(&db, &cfg, started, &counters, false, &info).await {
                    Counters::inc(&counters.errors);
                    eprintln!("{}", json!({"event": "error", "where": "heartbeat", "error": e.to_string()}));
                }
            }
        })
    };

    let sem = Arc::new(Semaphore::new(cfg.groups_parallel.max(1)));
    let mut last_metrics = Instant::now();
    let mut last_progress = Instant::now();
    let mut seen_progress = 0u64;
    while !shutdown.is_set() {
        Counters::inc(&counters.polls);
        match find_work(&db, cfg.batch_limit).await {
            Ok(work) => {
                counters.work_items.fetch_add(work.len() as u64, Ordering::Relaxed);
                // group, preserving the global (created_at, id) order inside each group
                let mut order: Vec<(Uuid, Uuid, Uuid)> = Vec::new();
                let mut groups: HashMap<(Uuid, Uuid, Uuid), Vec<Work>> = HashMap::new();
                for w in work {
                    let k = (w.ws, w.bucket, w.wca);
                    groups.entry(k).or_insert_with(|| {
                        order.push(k);
                        Vec::new()
                    }).push(w);
                }
                let mut set = tokio::task::JoinSet::new();
                for k in order {
                    let items = groups.remove(&k).unwrap();
                    let eng = eng.clone();
                    let permit = sem.clone().acquire_owned().await.expect("semaphore open");
                    set.spawn(async move {
                        eng.process_group(k, items).await;
                        drop(permit);
                    });
                }
                while set.join_next().await.is_some() {}
            }
            Err(e) => {
                Counters::inc(&counters.errors);
                eprintln!("{}", json!({"event": "error", "where": "find_work", "error": e.to_string()}));
            }
        }
        let prog = counters.progress.load(Ordering::Relaxed);
        if prog != seen_progress {
            seen_progress = prog;
            last_progress = Instant::now();
        } else {
            if let Some(idle) = cfg.exit_when_idle_ms {
                if last_progress.elapsed() >= Duration::from_millis(idle) {
                    break;
                }
            }
            shutdown.sleep(Duration::from_millis(cfg.poll_ms)).await;
        }
        if last_metrics.elapsed() >= Duration::from_millis(cfg.metrics_every_ms) {
            last_metrics = Instant::now();
            println!("{}", json!({"event": "metrics", "instance": cfg.instance, "counters": counters.snapshot()}));
        }
    }
    shutdown.trigger();
    let _ = hb.await;
    // final heartbeat marks the process as cleanly stopped, so the console never shows a dead process as alive
    let _ = heartbeat(&db, &cfg, started, &counters, true, &info).await;
    println!("{}", json!({"event": "stopped", "instance": cfg.instance, "counters": counters.snapshot()}));
    Ok(counters)
}
