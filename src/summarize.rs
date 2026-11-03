use chrono::{Datelike, Utc};
use worker::*;

use crate::{auth, chat, store, util};

// Conversation rollups: a daily cron summarizes yesterday's messages, a
// weekly cron rolls up the week's dailies, a monthly cron rolls up the
// week's monthlies. Chat context then searches these instead of raw history.

fn yesterday_utc() -> chrono::NaiveDate {
    Utc::now().date_naive().pred_opt().unwrap_or_else(|| Utc::now().date_naive())
}

fn day_start_iso(day: &chrono::NaiveDate) -> String {
    format!("{}T00:00:00.000Z", day.format("%Y-%m-%d"))
}

fn truncate_chars(s: &str, n: usize) -> String {
    if s.len() <= n {
        return s.to_string();
    }
    s.chars().take(n).collect()
}

async fn summarize_text(
    env: &Env,
    db: &D1Database,
    user_id: &str,
    bot_id: &str,
    model: &str,
    prompt: &str,
) -> Result<String> {
    let messages = vec![chat::ChatMessage {
        role: "user".to_string(),
        content: prompt.to_string(),
    }];
    match chat::complete_with_usage(env, "muse-spark-1.3", &messages).await {
        Ok(done) => {
            let text = done.text.trim().to_string();
            if text.is_empty() {
                return Err(Error::RustError("empty summary".to_string()));
            }
            let _ = store::record_usage(
                db,
                user_id,
                Some(bot_id),
                &store::UsageInput {
                    model: format!("{model} (summary)"),
                    prompt_tokens: done.prompt_tokens,
                    cached_tokens: done.cached_tokens,
                    completion_tokens: done.completion_tokens,
                    estimated: done.estimated,
                    audio_seconds: 0.0,
                    cost_override: None,
                },
            )
            .await;
            Ok(text)
        }
        Err(e) => Err(Error::RustError(e)),
    }
}

/// Summarize one bot's yesterday. Returns None when there is nothing to do.
pub async fn run_daily(env: &Env, db: &D1Database, bot: &store::BotRow, owner_id: &str) -> Result<Option<store::SummaryRow>> {
    let day = yesterday_utc();
    let key = day.format("%Y-%m-%d").to_string();
    let messages = store::messages_since(db, &bot.id, &day_start_iso(&day), 200).await?;
    if messages.is_empty() {
        return Ok(None);
    }
    let mut transcript = String::new();
    for m in &messages {
        transcript.push_str(&m.role);
        transcript.push_str(": ");
        transcript.push_str(&truncate_chars(&m.content, 600));
        transcript.push('\n');
        if transcript.len() > 12_000 {
            break;
        }
    }
    let prompt = format!(
        "Summarize this chat conversation for long-term memory in at most 12 lines. \
         Capture: key facts about the user, decisions made, preferences stated, and open items. \
         Plain text, no flattery, no preamble.\n\n{transcript}"
    );
    let content = summarize_text(env, db, owner_id, &bot.id, "daily", &prompt).await?;
    Ok(Some(store::upsert_summary(db, &bot.id, "daily", &key, &content).await?))
}

/// Roll up the last 7 daily summaries into a weekly one.
pub async fn run_weekly(env: &Env, db: &D1Database, bot: &store::BotRow, owner_id: &str) -> Result<Option<store::SummaryRow>> {
    let dailies = store::list_summaries(db, &bot.id, "daily", 7).await?;
    if dailies.is_empty() {
        return Ok(None);
    }
    let week = yesterday_utc().iso_week();
    let key = format!("{:04}-W{:02}", week.year(), week.week());
    let mut combined = String::new();
    for d in dailies.iter().rev() {
        combined.push_str(&format!("[{}]\n{}\n", d.period_key, d.content));
    }
    let prompt = format!(
        "Combine these daily conversation summaries into one weekly recap of at most 15 lines. \
         Keep durable facts, decisions, and preferences; drop small talk.\n\n{combined}"
    );
    let content = summarize_text(env, db, owner_id, &bot.id, "weekly", &prompt).await?;
    Ok(Some(store::upsert_summary(db, &bot.id, "weekly", &key, &content).await?))
}

/// Roll up the last 4 weekly summaries (fallback: dailies) into a monthly one.
pub async fn run_monthly(env: &Env, db: &D1Database, bot: &store::BotRow, owner_id: &str) -> Result<Option<store::SummaryRow>> {
    let day = yesterday_utc();
    let key = if day.month() == 1 {
        format!("{:04}-12", day.year() - 1)
    } else {
        format!("{:04}-{:02}", day.year(), day.month() - 1)
    };
    let weeklies = store::list_summaries(db, &bot.id, "weekly", 5).await?;
    let mut combined = String::new();
    if weeklies.is_empty() {
        for d in store::list_summaries(db, &bot.id, "daily", 30).await?.iter().rev() {
            combined.push_str(&format!("[{}]\n{}\n", d.period_key, d.content));
        }
    } else {
        for w in weeklies.iter().rev() {
            combined.push_str(&format!("[{}]\n{}\n", w.period_key, w.content));
        }
    }
    if combined.trim().is_empty() {
        return Ok(None);
    }
    let prompt = format!(
        "Combine these conversation summaries into one monthly recap of at most 20 lines. \
         Keep durable facts, decisions, and preferences; drop small talk.\n\n{combined}"
    );
    let content = summarize_text(env, db, owner_id, &bot.id, "monthly", &prompt).await?;
    Ok(Some(store::upsert_summary(db, &bot.id, "monthly", &key, &content).await?))
}

/// Build the "past conversations" context block: latest weekly + monthly and
/// the last 7 daily summaries, newest last. Empty when the bot has no history.
pub async fn context_block(db: &D1Database, bot_id: &str) -> Result<String> {
    let mut parts: Vec<String> = Vec::new();
    let push_capped = |parts: &mut Vec<String>, label: &str, rows: Vec<store::SummaryRow>| {
        for r in rows.into_iter().rev() {
            parts.push(format!("[{label} {}]\n{}", r.period_key, truncate_chars(&r.content, 1500)));
        }
    };
    push_capped(
        &mut parts,
        "month",
        store::list_summaries(db, bot_id, "monthly", 1).await?,
    );
    push_capped(
        &mut parts,
        "week",
        store::list_summaries(db, bot_id, "weekly", 1).await?,
    );
    push_capped(
        &mut parts,
        "day",
        store::list_summaries(db, bot_id, "daily", 7).await?,
    );
    if parts.is_empty() {
        return Ok(String::new());
    }
    Ok(format!(
        "Past conversation recaps for this bot (older context the user may ask about):\n{}",
        parts.join("\n")
    ))
}

#[derive(serde::Deserialize)]
struct SummarizeNowRequest {
    slavebot_id: Option<String>,
}

/// POST /api/summaries/run — immediately roll up yesterday for one of my bots.
pub async fn run_now(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Unauthorized."),
    };
    let body: SummarizeNowRequest = match req.json().await {
        Ok(b) => b,
        Err(_) => return util::err(400, "Invalid JSON body."),
    };
    let bot_id = body.slavebot_id.unwrap_or_default();
    let db = ctx.env.d1("DB")?;
    let bot = match store::get_bot(&db, &user_id, &bot_id).await? {
        Some(b) => b,
        None => return util::err(404, "SlaveBot not found."),
    };
    match run_daily(&ctx.env, &db, &bot, &user_id).await? {
        Some(summary) => util::json(200, &serde_json::json!({ "summary": summary })),
        None => util::json(200, &serde_json::json!({ "summary": null, "note": "No new messages to summarize." })),
    }
}

/// GET /api/summaries?slavebot_id= — daily/weekly/monthly recaps for the Bot tab.
pub async fn list(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Unauthorized."),
    };
    let bot_id = req
        .url()?
        .query_pairs()
        .find(|(k, _)| k == "slavebot_id")
        .map(|(_, v)| v.to_string())
        .unwrap_or_default();
    let db = ctx.env.d1("DB")?;
    if store::get_bot(&db, &user_id, &bot_id).await?.is_none() {
        return util::err(404, "SlaveBot not found.");
    }
    let daily = store::list_summaries(&db, &bot_id, "daily", 7).await?;
    let weekly = store::list_summaries(&db, &bot_id, "weekly", 4).await?;
    let monthly = store::list_summaries(&db, &bot_id, "monthly", 3).await?;
    util::json(
        200,
        &serde_json::json!({ "daily": daily, "weekly": weekly, "monthly": monthly }),
    )
}
