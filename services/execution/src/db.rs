//! Postgres access. Every operation runs in a transaction that first sets the service-role context
//! (`set local apex.service = 'on'` equivalent via set_config(..., true)) and then calls the SAME SQL functions the
//! rest of the platform uses (`reserve_capital`, `apply_fill`, `advance_intent`, ...). Retries on deadlock /
//! serialization failure are safe because every operation is idempotent.

use crate::error::ExecError;
use deadpool_postgres::{Manager, ManagerConfig, Object, Pool, RecyclingMethod};
use std::future::Future;
use std::pin::Pin;
use std::str::FromStr;
use tokio_postgres::NoTls;

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = Result<T, ExecError>> + Send + 'a>>;

#[derive(Clone)]
pub struct Db {
    pool: Pool,
    /// Bounds concurrent per-intent drivers to half the pool: each driver pins one connection for its advisory lock
    /// and needs a second one for its transactions, so this makes pool-exhaustion deadlock impossible.
    drive_permits: std::sync::Arc<tokio::sync::Semaphore>,
}

/// An open service-role transaction. Dropping it without commit/rollback DISCARDS the connection (the server rolls
/// the transaction back) rather than returning a connection with an open transaction to the pool.
pub struct Tx {
    obj: Option<Object>,
}

impl Tx {
    pub fn c(&self) -> &tokio_postgres::Client {
        let o: &deadpool_postgres::ClientWrapper = self.obj.as_ref().expect("tx open");
        &**o
    }
    pub async fn commit(mut self) -> Result<(), ExecError> {
        let o = self.obj.take().expect("tx open");
        match o.batch_execute("commit").await {
            Ok(()) => Ok(()),
            Err(e) => {
                let _ = Object::take(o);
                Err(e.into())
            }
        }
    }
    pub async fn rollback(mut self) {
        if let Some(o) = self.obj.take() {
            if o.batch_execute("rollback").await.is_err() {
                let _ = Object::take(o);
            }
        }
    }
}
impl Drop for Tx {
    fn drop(&mut self) {
        if let Some(o) = self.obj.take() {
            let _ = Object::take(o);
        }
    }
}

impl Db {
    pub fn connect(url: &str, max_size: usize) -> Result<Db, ExecError> {
        let cfg = tokio_postgres::Config::from_str(url).map_err(|e| ExecError::Pool(e.to_string()))?;
        let mgr = Manager::from_config(cfg, NoTls, ManagerConfig { recycling_method: RecyclingMethod::Fast });
        let max_size = max_size.max(2);
        let pool = Pool::builder(mgr).max_size(max_size).build().map_err(|e| ExecError::Pool(e.to_string()))?;
        Ok(Db { pool, drive_permits: std::sync::Arc::new(tokio::sync::Semaphore::new(max_size / 2)) })
    }

    pub async fn begin(&self) -> Result<Tx, ExecError> {
        let o = self.pool.get().await.map_err(|e| ExecError::Pool(e.to_string()))?;
        o.batch_execute("begin").await?;
        if let Err(e) = o.batch_execute("select set_config('apex.service','on',true)").await {
            let _ = Object::take(o);
            return Err(e.into());
        }
        Ok(Tx { obj: Some(o) })
    }

    /// Run `f` in a transaction; commit on Ok, rollback on Err; retry (max 12) on deadlock / serialization failure.
    pub async fn run<T, F>(&self, f: F) -> Result<T, ExecError>
    where
        F: for<'a> Fn(&'a Tx) -> BoxFut<'a, T>,
    {
        let mut attempt = 0u32;
        loop {
            let tx = self.begin().await?;
            match f(&tx).await {
                Ok(v) => match tx.commit().await {
                    Ok(()) => return Ok(v),
                    Err(e) if e.is_retryable() && attempt < 12 => {}
                    Err(e) => return Err(e),
                },
                Err(e) => {
                    tx.rollback().await;
                    if e.is_retryable() && attempt < 12 {
                    } else {
                        return Err(e);
                    }
                }
            }
            attempt += 1;
            tokio::time::sleep(std::time::Duration::from_millis(5 * attempt as u64)).await;
        }
    }

    pub async fn drive_permit(&self) -> tokio::sync::OwnedSemaphorePermit {
        self.drive_permits.clone().acquire_owned().await.expect("semaphore never closed")
    }

    /// Plain pooled connection (no transaction) for session-level things like advisory locks.
    pub async fn conn(&self) -> Result<Object, ExecError> {
        self.pool.get().await.map_err(|e| ExecError::Pool(e.to_string()))
    }
}

pub fn parse_u128(s: &str) -> Result<u128, ExecError> {
    let head = s.split('.').next().unwrap_or(s);
    head.parse::<u128>().map_err(|e| ExecError::Other(format!("bad numeric '{s}': {e}")))
}
