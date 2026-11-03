use serde::{Deserialize, Serialize};
use wasm_bindgen::JsValue;
use worker::*;

use crate::chat::ChatMessage;
use crate::pricing;

#[derive(Deserialize, Serialize)]
pub struct UserRecord {
    pub id: String,
    pub email: String,
    pub name: String,
    pub credit_usd: f64,
}

#[derive(Deserialize, Serialize)]
pub struct MessageRow {
    pub role: String,
    pub content: String,
    pub created_at: String,
}

#[derive(Deserialize, Serialize)]
pub struct BotRow {
    pub id: String,
    pub name: String,
    pub title: String,
    pub model: String,
    pub memory: String,
    pub avatar_key: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize, Serialize)]
pub struct UsageRow {
    pub id: i64,
    pub slavebot_id: Option<String>,
    pub slavebot_name: Option<String>,
    pub model: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub cost_usd: f64,
    pub estimated: i64,
    pub audio_seconds: f64,
    pub created_at: String,
}

fn str_val(s: &str) -> JsValue {
    JsValue::from_str(s)
}

pub async fn get_user(db: &D1Database, id: &str) -> Result<Option<UserRecord>> {
    db.prepare("SELECT id, email, name, credit_usd FROM users WHERE id = ?")
        .bind(&[str_val(id)])?
        .first(None)
        .await
}

pub async fn bot_count(db: &D1Database, user_id: &str) -> Result<i64> {
    let row: Option<CountRow> = db
        .prepare("SELECT COUNT(*) AS n FROM slavebots WHERE user_id = ?")
        .bind(&[str_val(user_id)])?
        .first(None)
        .await?;
    Ok(row.map(|r| r.n).unwrap_or(0))
}

#[derive(Deserialize)]
struct CountRow {
    n: i64,
}

/// Create a new slaveBot with an auto-numbered default name.
pub async fn create_bot(db: &D1Database, user_id: &str, model: &str) -> Result<BotRow> {
    let n = bot_count(db, user_id).await? + 1;
    let id = new_id();
    let name = format!("SlaveBot {n}");
    db.prepare("INSERT INTO slavebots (id, user_id, name, title, model) VALUES (?, ?, ?, '', ?)")
        .bind(&[str_val(&id), str_val(user_id), str_val(&name), str_val(model)])?
        .run()
        .await?;
    Ok(get_bot(db, user_id, &id)
        .await?
        .expect("just-inserted bot must exist"))
}

pub async fn get_bot(db: &D1Database, user_id: &str, id: &str) -> Result<Option<BotRow>> {
    db.prepare("SELECT id, name, title, model, memory, avatar_key, created_at, updated_at FROM slavebots WHERE id = ? AND user_id = ?")
        .bind(&[str_val(id), str_val(user_id)])?
        .first(None)
        .await
}

pub async fn update_bot(
    db: &D1Database,
    user_id: &str,
    id: &str,
    name: Option<&str>,
    memory: Option<&str>,
    model: Option<&str>,
) -> Result<Option<BotRow>> {
    if get_bot(db, user_id, id).await?.is_none() {
        return Ok(None);
    }
    if let Some(name) = name {
        let name: String = name.trim().chars().take(40).collect();
        if !name.is_empty() {
            db.prepare("UPDATE slavebots SET name = ? WHERE id = ? AND user_id = ?")
                .bind(&[str_val(&name), str_val(id), str_val(user_id)])?
                .run()
                .await?;
        }
    }
    if let Some(memory) = memory {
        let memory: String = memory.chars().take(4000).collect();
        db.prepare("UPDATE slavebots SET memory = ? WHERE id = ? AND user_id = ?")
            .bind(&[str_val(&memory), str_val(id), str_val(user_id)])?
            .run()
            .await?;
    }
    if let Some(model) = model.filter(|m| *m == "muse-spark-1.3" || *m == "muse-wonder-1.0") {
        db.prepare("UPDATE slavebots SET model = ? WHERE id = ? AND user_id = ?")
            .bind(&[str_val(model), str_val(id), str_val(user_id)])?
            .run()
            .await?;
    }
    touch_bot(db, id).await?;
    get_bot(db, user_id, id).await
}

/// Refresh the title from the first user message (only while still untitled).
pub async fn maybe_title_bot(db: &D1Database, id: &str, first_message: &str) -> Result<()> {
    let title: String = first_message.chars().take(60).collect();
    if title.is_empty() {
        return Ok(());
    }
    db.prepare("UPDATE slavebots SET title = ? WHERE id = ? AND title = ''")
        .bind(&[str_val(&title), str_val(id)])?
        .run()
        .await?;
    Ok(())
}

pub async fn touch_bot(db: &D1Database, slavebot_id: &str) -> Result<()> {
    db.prepare("UPDATE slavebots SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .bind(&[str_val(slavebot_id)])?
        .run()
        .await?;
    Ok(())
}

pub async fn insert_message(db: &D1Database, slavebot_id: &str, role: &str, content: &str) -> Result<()> {
    db.prepare("INSERT INTO messages (slavebot_id, role, content) VALUES (?, ?, ?)")
        .bind(&[str_val(slavebot_id), str_val(role), str_val(content)])?
        .run()
        .await?;
    Ok(())
}

pub async fn recent_messages(db: &D1Database, slavebot_id: &str, limit: i32) -> Result<Vec<ChatMessage>> {
    let rows: Vec<MessageRow> = db
        .prepare("SELECT role, content, created_at FROM messages WHERE slavebot_id = ? ORDER BY id DESC LIMIT ?")
        .bind(&[str_val(slavebot_id), JsValue::from_f64(limit as f64)])?
        .all()
        .await?
        .results()?;
    let mut msgs: Vec<ChatMessage> = rows
        .into_iter()
        .rev()
        .map(|r| ChatMessage { role: r.role, content: r.content })
        .collect();
    // Defensive: keep only valid roles for the upstream call.
    msgs.retain(|m| m.role == "system" || m.role == "user" || m.role == "assistant");
    Ok(msgs)
}

pub async fn prompt_chars(db: &D1Database, slavebot_id: &str) -> Result<usize> {
    let rows: Vec<MessageRow> = db
        .prepare("SELECT role, content, created_at FROM messages WHERE slavebot_id = ? ORDER BY id ASC")
        .bind(&[str_val(slavebot_id)])?
        .all()
        .await?
        .results()?;
    Ok(rows.iter().map(|r| r.role.len() + r.content.len()).sum())
}

pub struct UsageInput {
    pub model: String,
    pub prompt_tokens: u64,
    pub cached_tokens: u64,
    pub completion_tokens: u64,
    pub estimated: bool,
    /// Seconds of transcribed audio (voice endpoint only, else 0).
    pub audio_seconds: f64,
    /// Explicit cost in USD (voice bills by audio seconds, not tokens).
    pub cost_override: Option<f64>,
}

/// Insert a usage log row and deduct the cost from the user's credit.
/// Returns (cost_usd, remaining_credit_usd).
pub async fn record_usage(
    db: &D1Database,
    user_id: &str,
    slavebot_id: Option<&str>,
    input: &UsageInput,
) -> Result<(f64, f64)> {
    let rates = pricing::rates_for(&input.model);
    let cost = input.cost_override.unwrap_or_else(|| {
        pricing::cost_usd(&rates, input.prompt_tokens, input.cached_tokens, input.completion_tokens)
    });
    let total = input.prompt_tokens + input.completion_tokens;
    db.prepare(
        "INSERT INTO usage_logs (user_id, slavebot_id, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, estimated, audio_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&[
        str_val(user_id),
        slavebot_id.map(str_val).unwrap_or(JsValue::NULL),
        str_val(&input.model),
        JsValue::from_f64(input.prompt_tokens as f64),
        JsValue::from_f64(input.completion_tokens as f64),
        JsValue::from_f64(total as f64),
        JsValue::from_f64(cost),
        JsValue::from_f64(if input.estimated { 1.0 } else { 0.0 }),
        JsValue::from_f64(input.audio_seconds),
    ])?
    .run()
    .await?;
    db.prepare("UPDATE users SET credit_usd = credit_usd - ? WHERE id = ?")
        .bind(&[JsValue::from_f64(cost), str_val(user_id)])?
        .run()
        .await?;
    let user = get_user(db, user_id).await?;
    Ok((cost, user.map(|u| u.credit_usd).unwrap_or(0.0)))
}

pub async fn list_bots(db: &D1Database, user_id: &str) -> Result<Vec<BotRow>> {
    db.prepare("SELECT id, name, title, model, memory, avatar_key, created_at, updated_at FROM slavebots WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100")
        .bind(&[str_val(user_id)])?
        .all()
        .await?
        .results()
}

pub async fn bot_messages(db: &D1Database, user_id: &str, slavebot_id: &str) -> Result<Option<(BotRow, Vec<MessageRow>)>> {
    let bot = match get_bot(db, user_id, slavebot_id).await? {
        Some(b) => b,
        None => return Ok(None),
    };
    let messages: Vec<MessageRow> = db
        .prepare("SELECT role, content, created_at FROM messages WHERE slavebot_id = ? ORDER BY id ASC LIMIT 500")
        .bind(&[str_val(slavebot_id)])?
        .all()
        .await?
        .results()?;
    Ok(Some((bot, messages)))
}

pub async fn list_usage(db: &D1Database, user_id: &str, limit: i32) -> Result<(Vec<UsageRow>, f64)> {
    let logs: Vec<UsageRow> = db
        .prepare(
            "SELECT u.id, u.slavebot_id, c.name AS slavebot_name, u.model, u.prompt_tokens, u.completion_tokens, u.total_tokens, u.cost_usd, u.estimated, u.audio_seconds, u.created_at \
             FROM usage_logs u LEFT JOIN slavebots c ON c.id = u.slavebot_id \
             WHERE u.user_id = ? ORDER BY u.id DESC LIMIT ?",
        )
        .bind(&[str_val(user_id), JsValue::from_f64(limit as f64)])?
        .all()
        .await?
        .results()?;
    let spent: Option<UsageSum> = db
        .prepare("SELECT COALESCE(SUM(cost_usd), 0.0) AS total FROM usage_logs WHERE user_id = ?")
        .bind(&[str_val(user_id)])?
        .first(None)
        .await?;
    Ok((logs, spent.map(|s| s.total).unwrap_or(0.0)))
}

#[derive(Deserialize)]
pub struct BotScope {
    pub id: String,
    pub user_id: String,
}

/// Every bot with its owner — for the scheduled summarizer only.
pub async fn all_bot_scopes(db: &D1Database) -> Result<Vec<BotScope>> {
    db.prepare("SELECT id, user_id FROM slavebots")
        .all()
        .await?
        .results()
}

/// Messages since a UTC timestamp (ISO-8601), oldest first, capped for prompts.
pub async fn messages_since(
    db: &D1Database,
    slavebot_id: &str,
    since_iso: &str,
    limit: i32,
) -> Result<Vec<MessageRow>> {
    db.prepare("SELECT role, content, created_at FROM messages WHERE slavebot_id = ? AND created_at >= ? ORDER BY id ASC LIMIT ?")
        .bind(&[str_val(slavebot_id), str_val(since_iso), JsValue::from_f64(limit as f64)])?
        .all()
        .await?
        .results()
}

#[derive(Deserialize, Serialize)]
pub struct SummaryRow {
    pub id: i64,
    pub period: String,
    pub period_key: String,
    pub content: String,
    pub created_at: String,
}

pub async fn upsert_summary(
    db: &D1Database,
    slavebot_id: &str,
    period: &str,
    period_key: &str,
    content: &str,
) -> Result<SummaryRow> {
    db.prepare(
        "INSERT INTO summaries (slavebot_id, period, period_key, content) VALUES (?, ?, ?, ?) \
         ON CONFLICT(slavebot_id, period, period_key) DO UPDATE SET content = excluded.content",
    )
    .bind(&[str_val(slavebot_id), str_val(period), str_val(period_key), str_val(content)])?
    .run()
    .await?;
    let row: Option<SummaryRow> = db
        .prepare("SELECT id, period, period_key, content, created_at FROM summaries WHERE slavebot_id = ? AND period = ? AND period_key = ?")
        .bind(&[str_val(slavebot_id), str_val(period), str_val(period_key)])?
        .first(None)
        .await?;
    row.ok_or_else(|| Error::RustError("summary upsert failed".to_string()))
}

pub async fn list_summaries(
    db: &D1Database,
    slavebot_id: &str,
    period: &str,
    limit: i32,
) -> Result<Vec<SummaryRow>> {
    db.prepare("SELECT id, period, period_key, content, created_at FROM summaries WHERE slavebot_id = ? AND period = ? ORDER BY period_key DESC LIMIT ?")
        .bind(&[str_val(slavebot_id), str_val(period), JsValue::from_f64(limit as f64)])?
        .all()
        .await?
        .results()
}

#[derive(Deserialize)]
struct UsageSum {
    total: f64,
}

fn new_id() -> String {
    let mut b = [0u8; 16];
    if getrandom::getrandom(&mut b).is_err() {
        let t = Date::now().as_millis();
        b[..8].copy_from_slice(&t.to_be_bytes());
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex::encode(b);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}
