use chrono::{Datelike, Utc};
use anyhow::Result;
use crate::{chat, db::Db, store};

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
    db: &Db,
    user_id: &str,
    bot_id: &str,
    _period: &str,
    prompt: &str,
) -> Result<String> {
    let messages = vec![chat::ChatMessage {
        role: "user".to_string(),
        content: prompt.to_string(),
        ..Default::default()
    }];
    // Summaries always use the provider default model; `model` here is the period name.
    // They run on the owner's key when set (cron included), else the server key.
    let team_id = crate::store::get_bot_any(db, bot_id)
        .await?
        .map(|b| b.team_id)
        .unwrap_or_default();
    let team_id = if team_id.trim().is_empty() {
        crate::store::ensure_personal_team(db, user_id).await.map(|t| t.id).unwrap_or_default()
    } else {
        team_id
    };
    let prov = crate::provider::provider_for(db, &team_id)
        .await
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let summary_model = crate::provider::effective_model(&prov.preset, "");
    match chat::complete_with_usage(&prov, &summary_model, &messages, Some(bot_id)).await {
        Ok(done) => {
            let text = done.text.trim().to_string();
            if text.is_empty() {
                return Err(anyhow::anyhow!("empty summary".to_string()));
            }
            let _ = store::record_usage(
                db,
                user_id,
                Some(bot_id),
                &store::UsageInput {
                    model: format!("{summary_model} (summary)"),
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
        Err(e) => Err(anyhow::anyhow!(e)),
    }
}

/// Summarize one bot's yesterday. Returns None when there is nothing to do.
pub async fn run_daily(db: &Db, bot: &store::BotRow, owner_id: &str) -> Result<Option<store::SummaryRow>> {
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
    let content = summarize_text(db, owner_id, &bot.id, "daily", &prompt).await?;
    Ok(Some(store::upsert_summary(db, &bot.id, "daily", &key, &content).await?))
}

/// Roll up the last 7 daily summaries into a weekly one.
pub async fn run_weekly(db: &Db, bot: &store::BotRow, owner_id: &str) -> Result<Option<store::SummaryRow>> {
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
    let content = summarize_text(db, owner_id, &bot.id, "weekly", &prompt).await?;
    Ok(Some(store::upsert_summary(db, &bot.id, "weekly", &key, &content).await?))
}

/// Roll up the last 4 weekly summaries (fallback: dailies) into a monthly one.
pub async fn run_monthly(db: &Db, bot: &store::BotRow, owner_id: &str) -> Result<Option<store::SummaryRow>> {
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
    let content = summarize_text(db, owner_id, &bot.id, "monthly", &prompt).await?;
    Ok(Some(store::upsert_summary(db, &bot.id, "monthly", &key, &content).await?))
}

/// Build the "past conversations" context block: latest weekly + monthly and
/// the last 7 daily summaries, newest last. Empty when the bot has no history.
pub async fn context_block(db: &Db, bot_id: &str) -> Result<String> {
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
