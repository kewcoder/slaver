//! SQLite database layer (replaces Cloudflare D1).
//!
//! A [`Db`] wraps a single rusqlite connection behind an async mutex. The
//! query helpers intentionally mirror the old D1 call shape
//! (`prepare → bind → first/all/run`) so business logic barely changes:
//! rows are converted to JSON and deserialized into the existing structs.

use anyhow::{Context, Result};
use base64::Engine as _;
use rusqlite::{types::Value as SqlValue, Connection};
use serde::de::DeserializeOwned;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct Db {
    inner: Arc<Mutex<Connection>>,
    path: String,
}

impl Db {
    pub fn open(path: &str) -> Result<Self> {
        if let Some(parent) = std::path::Path::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(10))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        Ok(Self { inner: Arc::new(Mutex::new(conn)), path: path.to_string() })
    }

    /// Apply every `*.sql` file in `dir` in sorted order. Migration files are
    /// written with IF NOT EXISTS / additive statements, so re-running is safe.
    /// Synchronous: call before entering the async runtime (or from
    /// `spawn_blocking`).
    pub fn run_migrations(&self, dir: &str) -> Result<()> {
        let mut files: Vec<_> = std::fs::read_dir(dir)
            .with_context(|| format!("cannot read migrations dir {dir}"))?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().map(|x| x == "sql").unwrap_or(false))
            .collect();
        files.sort();
        if files.is_empty() {
            anyhow::bail!("no migration files found in {dir}");
        }
        // Open a short-lived direct connection for setup; the pooled
        // connection is only used once the runtime is up. (WAL mode allows
        // both connections to the same file.)
        let setup = Connection::open(&self.path)?;
        for f in files {
            let sql = std::fs::read_to_string(&f)?;
            setup
                .execute_batch(&sql)
                .with_context(|| format!("migration failed: {}", f.display()))?;
        }
        Ok(())
    }

    pub fn prepare(&self, sql: &str) -> Q<'_> {
        Q { db: self, sql: sql.to_string(), params: Vec::new() }
    }
}

pub struct Q<'a> {
    db: &'a Db,
    sql: String,
    params: Vec<SqlValue>,
}

impl<'a> Q<'a> {
    pub fn bind(mut self, params: &[SqlValue]) -> Result<Bound<'a>> {
        self.params = params.to_vec();
        Ok(Bound { db: self.db, sql: self.sql, params: self.params })
    }
}

pub struct Bound<'a> {
    db: &'a Db,
    sql: String,
    params: Vec<SqlValue>,
}

impl Bound<'_> {
    async fn fetch(&self) -> Result<Vec<serde_json::Value>> {
        let db = self.db.inner.lock().await;
        let mut stmt = db.prepare(&self.sql)?;
        let cols: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let mut out = Vec::new();
        let mut rows = stmt.query(rusqlite::params_from_iter(self.params.iter()))?;
        while let Some(row) = rows.next()? {
            let mut map = serde_json::Map::with_capacity(cols.len());
            for (i, name) in cols.iter().enumerate() {
                let v: SqlValue = row.get(i)?;
                map.insert(name.clone(), sql_to_json(v));
            }
            out.push(serde_json::Value::Object(map));
        }
        Ok(out)
    }

    pub async fn first<T: DeserializeOwned>(self, _opt: Option<()>) -> Result<Option<T>> {
        let mut rows = self.fetch().await?;
        match rows.into_iter().next() {
            Some(v) => Ok(Some(serde_json::from_value(v)?)),
            None => Ok(None),
        }
    }

    pub async fn all(self) -> Result<Rows> {
        Ok(Rows(self.fetch().await?))
    }

    pub async fn run(self) -> Result<()> {
        let db = self.db.inner.lock().await;
        let mut stmt = db.prepare(&self.sql)?;
        stmt.execute(rusqlite::params_from_iter(self.params.iter()))?;
        Ok(())
    }
}

pub struct Rows(Vec<serde_json::Value>);

impl Rows {
    pub fn results<T: DeserializeOwned>(self) -> Result<Vec<T>> {
        self.0
            .into_iter()
            .map(serde_json::from_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into)
    }
}

fn sql_to_json(v: SqlValue) -> serde_json::Value {
    match v {
        SqlValue::Null => serde_json::Value::Null,
        SqlValue::Integer(i) => serde_json::json!(i),
        SqlValue::Real(f) => serde_json::json!(f),
        SqlValue::Text(s) => serde_json::json!(s),
        SqlValue::Blob(b) => serde_json::json!(base64::engine::general_purpose::STANDARD.encode(b)),
    }
}

/// Text query parameter.
pub fn v_text(s: &str) -> SqlValue {
    SqlValue::Text(s.to_string())
}

/// Float query parameter.
pub fn v_real(f: f64) -> SqlValue {
    SqlValue::Real(f)
}

/// Integer query parameter.
pub fn v_int(i: i64) -> SqlValue {
    SqlValue::Integer(i)
}

/// NULL query parameter.
pub fn v_null() -> SqlValue {
    SqlValue::Null
}

/// Milliseconds since the Unix epoch (replaces worker `Date::now()`).
pub fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
