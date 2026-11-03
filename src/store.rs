use chrono::Datelike;
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
    pub archived: i64,
    pub voice: String,
    pub active_days: String,
    pub active_start: String,
    pub active_end: String,
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
    db.prepare("SELECT id, name, title, model, memory, avatar_key, archived, voice, active_days, active_start, active_end, created_at, updated_at FROM slavebots WHERE id = ? AND user_id = ?")
        .bind(&[str_val(id), str_val(user_id)])?
        .first(None)
        .await
}

#[allow(clippy::too_many_arguments)]
pub async fn update_bot(
    db: &D1Database,
    user_id: &str,
    id: &str,
    name: Option<&str>,
    memory: Option<&str>,
    model: Option<&str>,
    voice: Option<&str>,
    active_days: Option<&str>,
    active_start: Option<&str>,
    active_end: Option<&str>,
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
    if let Some(voice) = voice.map(str::trim).filter(|v| {
        ["luna", "athena", "orion", "zeus", "hera", "perseus", "angus", "stella"].contains(v)
    }) {
        db.prepare("UPDATE slavebots SET voice = ? WHERE id = ? AND user_id = ?")
            .bind(&[str_val(voice), str_val(id), str_val(user_id)])?
            .run()
            .await?;
    }
    if let Some(days) = active_days.map(str::trim).filter(|d| !d.is_empty()) {
        let days: String = days
            .to_lowercase()
            .chars()
            .take(40)
            .collect::<String>()
            .split(',')
            .map(str::trim)
            .filter(|d| {
                ["all", "weekdays", "weekends", "mon", "tue", "wed", "thu", "fri", "sat", "sun"]
                    .contains(d)
            })
            .collect::<Vec<_>>()
            .join(",");
        let days = if days.is_empty() { "all".to_string() } else { days };
        db.prepare("UPDATE slavebots SET active_days = ? WHERE id = ? AND user_id = ?")
            .bind(&[str_val(&days), str_val(id), str_val(user_id)])?
            .run()
            .await?;
    }
    for (col, val) in [("active_start", active_start), ("active_end", active_end)] {
        if let Some(hhmm) = val.map(str::trim).filter(|v| valid_hhmm(v) || v.is_empty()) {
            let sql = format!("UPDATE slavebots SET {col} = ? WHERE id = ? AND user_id = ?");
            db.prepare(&sql)
                .bind(&[str_val(hhmm), str_val(id), str_val(user_id)])?
                .run()
                .await?;
        }
    }
    touch_bot(db, id).await?;
    get_bot(db, user_id, id).await
}

/// HH:MM 24-hour wall clock, e.g. "07:00".
pub fn valid_hhmm(v: &str) -> bool {
    if v.len() != 5 || v.as_bytes()[2] != b':' {
        return false;
    }
    let (hh, mm) = (&v[0..2], &v[3..5]);
    hh.chars().all(|c| c.is_ascii_digit())
        && mm.chars().all(|c| c.is_ascii_digit())
        && hh <= "23"
        && mm <= "59"
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

pub async fn list_bots(db: &D1Database, user_id: &str, include_archived: bool) -> Result<Vec<BotRow>> {
    let sql = if include_archived {
        "SELECT id, name, title, model, memory, avatar_key, archived, voice, active_days, active_start, active_end, created_at, updated_at FROM slavebots WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100"
    } else {
        "SELECT id, name, title, model, memory, avatar_key, archived, voice, active_days, active_start, active_end, created_at, updated_at FROM slavebots WHERE user_id = ? AND archived = 0 ORDER BY updated_at DESC LIMIT 100"
    };
    db.prepare(sql)
        .bind(&[str_val(user_id)])?
        .all()
        .await?
        .results()
}

pub async fn set_archived(db: &D1Database, user_id: &str, id: &str, archived: bool) -> Result<Option<BotRow>> {
    if get_bot(db, user_id, id).await?.is_none() {
        return Ok(None);
    }
    db.prepare("UPDATE slavebots SET archived = ? WHERE id = ? AND user_id = ?")
        .bind(&[JsValue::from_f64(if archived { 1.0 } else { 0.0 }), str_val(id), str_val(user_id)])?
        .run()
        .await?;
    touch_bot(db, id).await?;
    get_bot(db, user_id, id).await
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

#[derive(Deserialize, Serialize)]
pub struct GroupRow {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize, Serialize)]
pub struct GroupMessageRow {
    pub id: i64,
    pub slavebot_id: Option<String>,
    pub bot_name: Option<String>,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

pub async fn create_group(db: &D1Database, user_id: &str, name: &str) -> Result<GroupRow> {
    let id = new_id();
    let name: String = name.trim().chars().take(40).collect();
    let name = if name.is_empty() { "New group".to_string() } else { name };
    db.prepare("INSERT INTO groups (id, user_id, name) VALUES (?, ?, ?)")
        .bind(&[str_val(&id), str_val(user_id), str_val(&name)])?
        .run()
        .await?;
    get_group(db, user_id, &id)
        .await?
        .ok_or_else(|| Error::RustError("group insert failed".to_string()))
}

pub async fn get_group(db: &D1Database, user_id: &str, id: &str) -> Result<Option<GroupRow>> {
    db.prepare("SELECT id, name, created_at, updated_at FROM groups WHERE id = ? AND user_id = ?")
        .bind(&[str_val(id), str_val(user_id)])?
        .first(None)
        .await
}

pub async fn list_groups(db: &D1Database, user_id: &str) -> Result<Vec<GroupRow>> {
    db.prepare("SELECT id, name, created_at, updated_at FROM groups WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100")
        .bind(&[str_val(user_id)])?
        .all()
        .await?
        .results()
}

pub async fn rename_group(db: &D1Database, user_id: &str, id: &str, name: &str) -> Result<Option<GroupRow>> {
    if get_group(db, user_id, id).await?.is_none() {
        return Ok(None);
    }
    let name: String = name.trim().chars().take(40).collect();
    if !name.is_empty() {
        db.prepare("UPDATE groups SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND user_id = ?")
            .bind(&[str_val(&name), str_val(id), str_val(user_id)])?
            .run()
            .await?;
    }
    get_group(db, user_id, id).await
}

pub async fn delete_group(db: &D1Database, user_id: &str, id: &str) -> Result<bool> {
    if get_group(db, user_id, id).await?.is_none() {
        return Ok(false);
    }
    db.prepare("DELETE FROM group_messages WHERE group_id = ?")
        .bind(&[str_val(id)])?
        .run()
        .await?;
    db.prepare("DELETE FROM group_members WHERE group_id = ?")
        .bind(&[str_val(id)])?
        .run()
        .await?;
    db.prepare("DELETE FROM groups WHERE id = ? AND user_id = ?")
        .bind(&[str_val(id), str_val(user_id)])?
        .run()
        .await?;
    Ok(true)
}

pub async fn group_members(db: &D1Database, user_id: &str, group_id: &str) -> Result<Vec<BotRow>> {
    if get_group(db, user_id, group_id).await?.is_none() {
        return Ok(vec![]);
    }
    db.prepare(
        "SELECT s.id, s.name, s.title, s.model, s.memory, s.avatar_key, s.archived, s.voice, s.active_days, s.active_start, s.active_end, s.created_at, s.updated_at \
         FROM slavebots s JOIN group_members m ON m.slavebot_id = s.id \
         WHERE m.group_id = ? AND s.user_id = ? AND s.archived = 0 ORDER BY m.created_at ASC",
    )
    .bind(&[str_val(group_id), str_val(user_id)])?
    .all()
    .await?
    .results()
}

/// Max 8 bots per group — each group message fans out to every member.
pub const MAX_GROUP_MEMBERS: usize = 8;

pub async fn add_group_member(db: &D1Database, user_id: &str, group_id: &str, bot_id: &str) -> Result<Option<BotRow>> {
    let group = match get_group(db, user_id, group_id).await? {
        Some(g) => g,
        None => return Ok(None),
    };
    let bot = match get_bot(db, user_id, bot_id).await? {
        Some(b) => b,
        None => return Ok(None),
    };
    let members = group_members(db, user_id, &group.id).await?;
    if members.len() >= MAX_GROUP_MEMBERS && !members.iter().any(|m| m.id == bot_id) {
        return Err(Error::RustError(format!("Group is full (max {MAX_GROUP_MEMBERS} bots).")));
    }
    db.prepare("INSERT OR IGNORE INTO group_members (group_id, slavebot_id) VALUES (?, ?)")
        .bind(&[str_val(&group.id), str_val(&bot.id)])?
        .run()
        .await?;
    touch_group(db, &group.id).await?;
    Ok(Some(bot))
}

pub async fn remove_group_member(db: &D1Database, user_id: &str, group_id: &str, bot_id: &str) -> Result<bool> {
    if get_group(db, user_id, group_id).await?.is_none() {
        return Ok(false);
    }
    db.prepare("DELETE FROM group_members WHERE group_id = ? AND slavebot_id = ?")
        .bind(&[str_val(group_id), str_val(bot_id)])?
        .run()
        .await?;
    touch_group(db, group_id).await?;
    Ok(true)
}

pub async fn touch_group(db: &D1Database, group_id: &str) -> Result<()> {
    db.prepare("UPDATE groups SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .bind(&[str_val(group_id)])?
        .run()
        .await?;
    Ok(())
}

pub async fn insert_group_message(
    db: &D1Database,
    group_id: &str,
    slavebot_id: Option<&str>,
    role: &str,
    content: &str,
) -> Result<()> {
    db.prepare("INSERT INTO group_messages (group_id, slavebot_id, role, content) VALUES (?, ?, ?, ?)")
        .bind(&[
            str_val(group_id),
            slavebot_id.map(str_val).unwrap_or(JsValue::NULL),
            str_val(role),
            str_val(content),
        ])?
        .run()
        .await?;
    Ok(())
}

pub async fn group_history(db: &D1Database, group_id: &str, limit: i32) -> Result<Vec<GroupMessageRow>> {
    db.prepare(
        "SELECT g.id, g.slavebot_id, s.name AS bot_name, g.role, g.content, g.created_at \
         FROM group_messages g LEFT JOIN slavebots s ON s.id = g.slavebot_id \
         WHERE g.group_id = ? ORDER BY g.id DESC LIMIT ?",
    )
    .bind(&[str_val(group_id), JsValue::from_f64(limit as f64)])?
    .all()
    .await?
    .results::<GroupMessageRow>()
    .map(|mut rows| {
        rows.reverse();
        rows
    })
}

/// Append a fact to a bot's memory (capped at 4000 chars, oldest trimmed).
pub async fn append_memory(db: &D1Database, user_id: &str, bot_id: &str, text: &str) -> Result<Option<String>> {
    let bot = match get_bot(db, user_id, bot_id).await? {
        Some(b) => b,
        None => return Ok(None),
    };
    let text = text.trim();
    if text.is_empty() || text.len() > 2000 {
        return Err(Error::RustError("Memory snippet must be 1..2000 characters.".to_string()));
    }
    let mut memory = bot.memory;
    if !memory.is_empty() && !memory.ends_with('\n') {
        memory.push('\n');
    }
    memory.push_str("- ");
    memory.push_str(text);
    while memory.len() > 4000 {
        if let Some(pos) = memory.find('\n') {
            memory = memory[pos + 1..].to_string();
        } else {
            memory = truncate_chars(&memory, 4000);
            break;
        }
    }
    db.prepare("UPDATE slavebots SET memory = ? WHERE id = ? AND user_id = ?")
        .bind(&[str_val(&memory), str_val(bot_id), str_val(user_id)])?
        .run()
        .await?;
    touch_bot(db, bot_id).await?;
    Ok(Some(memory))
}

fn truncate_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

#[derive(Deserialize)]
pub struct BotScope {
    pub id: String,
    pub user_id: String,
}

/// Every active bot with its owner — for the scheduled summarizer only.
pub async fn all_bot_scopes(db: &D1Database) -> Result<Vec<BotScope>> {
    db.prepare("SELECT id, user_id FROM slavebots WHERE archived = 0")
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

/// Wall-clock "now" in the bot timezone (Asia/Jakarta, UTC+7, no DST),
/// formatted so lexicographic comparison matches chronological order.
pub fn jakarta_now_iso() -> String {
    let now = chrono::Utc::now() + chrono::Duration::hours(7);
    now.format("%Y-%m-%dT%H:%M:00").to_string()
}

fn jakarta_weekday(now_iso: &str) -> String {
    chrono::NaiveDateTime::parse_from_str(now_iso, "%Y-%m-%dT%H:%M:%S")
        .map(|dt| format!("{:?}", dt.date().weekday()).to_lowercase())
        .unwrap_or_else(|_| "mon".to_string())
}

fn day_matches(days: &str, weekday: &str) -> bool {
    let days = days.trim().to_lowercase();
    if days.is_empty() || days == "all" {
        return true;
    }
    let parts: Vec<&str> = days.split(',').map(str::trim).collect();
    if parts.contains(&"all") {
        return true;
    }
    if parts.contains(&"weekdays") && ["mon", "tue", "wed", "thu", "fri"].contains(&weekday) {
        return true;
    }
    if parts.contains(&"weekends") && ["sat", "sun"].contains(&weekday) {
        return true;
    }
    parts.contains(&weekday)
}

/// Is the bot inside its own active window right now? Empty hours = always on.
pub fn bot_in_window(bot: &BotRow, now_iso: &str) -> bool {
    if !day_matches(&bot.active_days, &jakarta_weekday(now_iso)) {
        return false;
    }
    let (s, e) = (bot.active_start.trim(), bot.active_end.trim());
    if s.is_empty() || e.is_empty() || s == e {
        return true;
    }
    let t: String = now_iso.chars().skip(11).take(5).collect();
    let (t, s, e) = (t.as_str(), s, e);
    if s <= e {
        s <= t && t < e
    } else {
        t >= s || t < e
    }
}

/// Next run (Jakarta wall-clock ISO) strictly after `now_iso`.
pub fn next_run_after(
    kind: &str,
    time_hhmm: &str,
    days: &str,
    interval_minutes: i64,
    now_iso: &str,
) -> Option<String> {
    let now = chrono::NaiveDateTime::parse_from_str(now_iso, "%Y-%m-%dT%H:%M:%S").ok()?;
    match kind {
        "interval" => {
            let mins = interval_minutes.clamp(5, 60 * 24 * 7).max(5);
            Some((now + chrono::Duration::minutes(mins)).format("%Y-%m-%dT%H:%M:00").to_string())
        }
        _ => {
            if !valid_hhmm(time_hhmm) {
                return None;
            }
            for offset in 0..=8 {
                let day = now.date() + chrono::Days::new(offset);
                let cand = format!("{}T{}:00", day.format("%Y-%m-%d"), time_hhmm);
                if cand.as_str() <= now_iso {
                    continue;
                }
                let weekday = format!("{:?}", day.weekday()).to_lowercase();
                if kind == "once" || day_matches(days, &weekday) {
                    return Some(cand);
                }
            }
            None
        }
    }
}

#[derive(Deserialize, Serialize, Clone)]
pub struct ScheduleRow {
    pub id: String,
    pub user_id: String,
    pub slavebot_id: String,
    pub name: String,
    pub kind: String,
    pub time_hhmm: String,
    pub days: String,
    pub interval_minutes: i64,
    pub prompt: String,
    pub active: i64,
    pub next_run_at: String,
    pub last_run_at: String,
    pub created_at: String,
}

#[allow(clippy::too_many_arguments)]
pub async fn create_schedule(
    db: &D1Database,
    user_id: &str,
    bot_id: &str,
    name: &str,
    kind: &str,
    time_hhmm: &str,
    days: &str,
    interval_minutes: i64,
    prompt: &str,
) -> Result<ScheduleRow> {
    let kind = match kind {
        "once" | "daily" | "interval" => kind,
        _ => "daily",
    };
    let prompt: String = prompt.trim().chars().take(1000).collect();
    if prompt.is_empty() {
        return Err(Error::RustError("Schedule prompt must be 1..1000 characters.".to_string()));
    }
    let days = if days.trim().is_empty() { "all" } else { days.trim() };
    let now = jakarta_now_iso();
    let next = next_run_after(kind, time_hhmm, days, interval_minutes, &now)
        .ok_or_else(|| Error::RustError("Could not compute the next run time.".to_string()))?;
    let id = new_id();
    let name: String = if name.trim().is_empty() {
        "Scheduled task".to_string()
    } else {
        name.trim().chars().take(60).collect()
    };
    db.prepare(
        "INSERT INTO schedules (id, user_id, slavebot_id, name, kind, time_hhmm, days, interval_minutes, prompt, next_run_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&[
        str_val(&id),
        str_val(user_id),
        str_val(bot_id),
        str_val(&name),
        str_val(kind),
        str_val(time_hhmm),
        str_val(days),
        JsValue::from_f64(interval_minutes as f64),
        str_val(&prompt),
        str_val(&next),
    ])?
    .run()
    .await?;
    get_schedule(db, user_id, &id)
        .await?
        .ok_or_else(|| Error::RustError("schedule insert failed".to_string()))
}

pub async fn get_schedule(db: &D1Database, user_id: &str, id: &str) -> Result<Option<ScheduleRow>> {
    db.prepare(
        "SELECT id, user_id, slavebot_id, name, kind, time_hhmm, days, interval_minutes, prompt, active, next_run_at, last_run_at, created_at \
         FROM schedules WHERE id = ? AND user_id = ?",
    )
    .bind(&[str_val(id), str_val(user_id)])?
    .first(None)
    .await
}

pub async fn list_schedules(
    db: &D1Database,
    user_id: &str,
    bot_id: Option<&str>,
) -> Result<Vec<ScheduleRow>> {
    if let Some(bot) = bot_id {
        db.prepare(
            "SELECT id, user_id, slavebot_id, name, kind, time_hhmm, days, interval_minutes, prompt, active, next_run_at, last_run_at, created_at \
             FROM schedules WHERE user_id = ? AND slavebot_id = ? ORDER BY next_run_at ASC LIMIT 100",
        )
        .bind(&[str_val(user_id), str_val(bot)])?
        .all()
        .await?
        .results()
    } else {
        db.prepare(
            "SELECT id, user_id, slavebot_id, name, kind, time_hhmm, days, interval_minutes, prompt, active, next_run_at, last_run_at, created_at \
             FROM schedules WHERE user_id = ? ORDER BY next_run_at ASC LIMIT 100",
        )
        .bind(&[str_val(user_id)])?
        .all()
        .await?
        .results()
    }
}

pub async fn set_schedule_active(
    db: &D1Database,
    user_id: &str,
    id: &str,
    active: bool,
) -> Result<Option<ScheduleRow>> {
    let sched = match get_schedule(db, user_id, id).await? {
        Some(s) => s,
        None => return Ok(None),
    };
    let next = if active && sched.next_run_at.is_empty() {
        next_run_after(&sched.kind, &sched.time_hhmm, &sched.days, sched.interval_minutes, &jakarta_now_iso())
            .unwrap_or_default()
    } else {
        sched.next_run_at.clone()
    };
    db.prepare("UPDATE schedules SET active = ?, next_run_at = ? WHERE id = ? AND user_id = ?")
        .bind(&[
            JsValue::from_f64(if active { 1.0 } else { 0.0 }),
            str_val(&next),
            str_val(id),
            str_val(user_id),
        ])?
        .run()
        .await?;
    get_schedule(db, user_id, id).await
}

pub async fn delete_schedule(db: &D1Database, user_id: &str, id: &str) -> Result<bool> {
    if get_schedule(db, user_id, id).await?.is_none() {
        return Ok(false);
    }
    db.prepare("DELETE FROM schedules WHERE id = ? AND user_id = ?")
        .bind(&[str_val(id), str_val(user_id)])?
        .run()
        .await?;
    Ok(true)
}

/// Schedules ready to fire (active, next_run_at passed). Runner re-checks the bot.
pub async fn due_schedules(db: &D1Database, now_iso: &str) -> Result<Vec<ScheduleRow>> {
    db.prepare(
        "SELECT id, user_id, slavebot_id, name, kind, time_hhmm, days, interval_minutes, prompt, active, next_run_at, last_run_at, created_at \
         FROM schedules WHERE active = 1 AND next_run_at <> '' AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT 50",
    )
    .bind(&[str_val(now_iso)])?
    .all()
    .await?
    .results()
}

pub async fn mark_schedule_run(db: &D1Database, id: &str, next_run_at: &str) -> Result<()> {
    db.prepare("UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?")
        .bind(&[
            str_val(&jakarta_now_iso()),
            str_val(next_run_at),
            str_val(id),
        ])?
        .run()
        .await?;
    Ok(())
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
