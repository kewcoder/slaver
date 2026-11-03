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
pub struct ChatRow {
    pub id: String,
    pub title: String,
    pub model: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize, Serialize)]
pub struct MessageRow {
    pub role: String,
    pub content: String,
    pub created_at: String,
}

#[derive(Deserialize, Serialize)]
pub struct UsageRow {
    pub id: i64,
    pub chat_id: Option<String>,
    pub chat_title: Option<String>,
    pub model: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub cost_usd: f64,
    pub estimated: i64,
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

/// Load an owned chat, or create it (title from the first message).
/// Returns the chat id.
pub async fn ensure_chat(
    db: &D1Database,
    user_id: &str,
    chat_id: Option<&str>,
    model: &str,
    first_message: &str,
) -> Result<String> {
    if let Some(id) = chat_id.filter(|s| !s.is_empty()) {
        let row: Option<ChatRow> = db
            .prepare("SELECT id, title, model, created_at, updated_at FROM chats WHERE id = ? AND user_id = ?")
            .bind(&[str_val(id), str_val(user_id)])?
            .first(None)
            .await?;
        if row.is_some() {
            return Ok(id.to_string());
        }
    }
    let id = new_id();
    let title: String = first_message.chars().take(60).collect();
    let title = if title.is_empty() { "New chat".to_string() } else { title };
    db.prepare(
        "INSERT INTO chats (id, user_id, title, model) VALUES (?, ?, ?, ?)",
    )
    .bind(&[str_val(&id), str_val(user_id), str_val(&title), str_val(model)])?
    .run()
    .await?;
    Ok(id)
}

pub async fn touch_chat(db: &D1Database, chat_id: &str) -> Result<()> {
    db.prepare("UPDATE chats SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .bind(&[str_val(chat_id)])?
        .run()
        .await?;
    Ok(())
}

pub async fn insert_message(db: &D1Database, chat_id: &str, role: &str, content: &str) -> Result<()> {
    db.prepare("INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)")
        .bind(&[str_val(chat_id), str_val(role), str_val(content)])?
        .run()
        .await?;
    Ok(())
}

pub async fn recent_messages(db: &D1Database, chat_id: &str, limit: i32) -> Result<Vec<ChatMessage>> {
    let rows: Vec<MessageRow> = db
        .prepare("SELECT role, content, created_at FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?")
        .bind(&[str_val(chat_id), JsValue::from_f64(limit as f64)])?
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

pub async fn prompt_chars(db: &D1Database, chat_id: &str) -> Result<usize> {
    let rows: Vec<MessageRow> = db
        .prepare("SELECT role, content, created_at FROM messages WHERE chat_id = ? ORDER BY id ASC")
        .bind(&[str_val(chat_id)])?
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
}

/// Insert a usage log row and deduct the cost from the user's credit.
/// Returns (cost_usd, remaining_credit_usd).
pub async fn record_usage(
    db: &D1Database,
    user_id: &str,
    chat_id: Option<&str>,
    input: &UsageInput,
) -> Result<(f64, f64)> {
    let rates = pricing::rates_for(&input.model);
    let cost =
        pricing::cost_usd(&rates, input.prompt_tokens, input.cached_tokens, input.completion_tokens);
    let total = input.prompt_tokens + input.completion_tokens;
    db.prepare(
        "INSERT INTO usage_logs (user_id, chat_id, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, estimated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&[
        str_val(user_id),
        chat_id.map(str_val).unwrap_or(JsValue::NULL),
        str_val(&input.model),
        JsValue::from_f64(input.prompt_tokens as f64),
        JsValue::from_f64(input.completion_tokens as f64),
        JsValue::from_f64(total as f64),
        JsValue::from_f64(cost),
        JsValue::from_f64(if input.estimated { 1.0 } else { 0.0 }),
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

pub async fn list_chats(db: &D1Database, user_id: &str) -> Result<Vec<ChatRow>> {
    db.prepare("SELECT id, title, model, created_at, updated_at FROM chats WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100")
        .bind(&[str_val(user_id)])?
        .all()
        .await?
        .results()
}

pub async fn chat_messages(db: &D1Database, user_id: &str, chat_id: &str) -> Result<Option<(ChatRow, Vec<MessageRow>)>> {
    let chat: Option<ChatRow> = db
        .prepare("SELECT id, title, model, created_at, updated_at FROM chats WHERE id = ? AND user_id = ?")
        .bind(&[str_val(chat_id), str_val(user_id)])?
        .first(None)
        .await?;
    let chat = match chat {
        Some(c) => c,
        None => return Ok(None),
    };
    let messages: Vec<MessageRow> = db
        .prepare("SELECT role, content, created_at FROM messages WHERE chat_id = ? ORDER BY id ASC LIMIT 500")
        .bind(&[str_val(chat_id)])?
        .all()
        .await?
        .results()?;
    Ok(Some((chat, messages)))
}

pub async fn list_usage(db: &D1Database, user_id: &str, limit: i32) -> Result<(Vec<UsageRow>, f64)> {
    let logs: Vec<UsageRow> = db
        .prepare(
            "SELECT u.id, u.chat_id, c.title AS chat_title, u.model, u.prompt_tokens, u.completion_tokens, u.total_tokens, u.cost_usd, u.estimated, u.created_at \
             FROM usage_logs u LEFT JOIN chats c ON c.id = u.chat_id \
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
