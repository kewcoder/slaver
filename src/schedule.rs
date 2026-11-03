use serde::Deserialize;
use worker::*;

use crate::{auth, chat, store, util};

#[derive(Deserialize)]
struct CreateScheduleRequest {
    name: Option<String>,
    kind: Option<String>,
    time_hhmm: Option<String>,
    days: Option<String>,
    interval_minutes: Option<i64>,
    prompt: Option<String>,
}

#[derive(Deserialize)]
struct UpdateScheduleRequest {
    active: Option<bool>,
}

/// GET /api/slavebots/:id/schedules — schedules owned by one bot.
pub async fn list_for_bot(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Log in first."),
    };
    let bot_id = ctx.param("id").cloned().unwrap_or_default();
    let db = ctx.env.d1("DB")?;
    if store::get_bot(&db, &user_id, &bot_id).await?.is_none() {
        return util::err(404, "SlaveBot not found.");
    }
    let schedules = store::list_schedules(&db, &user_id, Some(&bot_id)).await?;
    util::json(200, &serde_json::json!({ "schedules": schedules }))
}

/// POST /api/slavebots/:id/schedules — create a schedule for one bot.
/// Body: {name?, kind: once|daily|interval, time_hhmm?, days?, interval_minutes?, prompt}.
pub async fn create_for_bot(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Log in first."),
    };
    let body: CreateScheduleRequest = match req.json().await {
        Ok(b) => b,
        Err(_) => return util::err(400, "Invalid JSON body."),
    };
    let bot_id = ctx.param("id").cloned().unwrap_or_default();
    let db = ctx.env.d1("DB")?;
    if store::get_bot(&db, &user_id, &bot_id).await?.is_none() {
        return util::err(404, "SlaveBot not found.");
    }
    let prompt = body.prompt.unwrap_or_default();
    match store::create_schedule(
        &db,
        &user_id,
        &bot_id,
        &body.name.unwrap_or_default(),
        &body.kind.unwrap_or_else(|| "daily".to_string()),
        &body.time_hhmm.unwrap_or_default(),
        &body.days.unwrap_or_else(|| "all".to_string()),
        body.interval_minutes.unwrap_or(60),
        &prompt,
    )
    .await
    {
        Ok(s) => util::json(201, &serde_json::json!({ "schedule": s })),
        Err(e) => util::err(400, &e.to_string()),
    }
}

/// PUT /api/schedules/:sid — pause or resume. Body: {active}.
pub async fn update(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Log in first."),
    };
    let body: UpdateScheduleRequest = match req.json().await {
        Ok(b) => b,
        Err(_) => return util::err(400, "Invalid JSON body."),
    };
    let sid = ctx.param("sid").cloned().unwrap_or_default();
    let db = ctx.env.d1("DB")?;
    match store::set_schedule_active(&db, &user_id, &sid, body.active.unwrap_or(true)).await? {
        Some(s) => util::json(200, &serde_json::json!({ "schedule": s })),
        None => util::err(404, "Schedule not found."),
    }
}

/// DELETE /api/schedules/:sid — remove a schedule.
pub async fn delete(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Log in first."),
    };
    let sid = ctx.param("sid").cloned().unwrap_or_default();
    let db = ctx.env.d1("DB")?;
    if store::delete_schedule(&db, &user_id, &sid).await? {
        util::json(200, &serde_json::json!({ "deleted": true }))
    } else {
        util::err(404, "Schedule not found.")
    }
}

/// Parse `/remind` chat commands into a schedule spec.
///   /remind daily 07:00 Drink water
///   /remind weekdays 08:30 Standup time
///   /remind every 90 Stretch and drink water
///   /remind once 21:30 Call mom
pub fn parse_remind(text: &str) -> Result<(String, String, String, i64, String), String> {
    let rest = text.strip_prefix("/remind").unwrap_or("").trim();
    if rest.is_empty() {
        return Err("Usage: /remind daily HH:MM text · /remind every N_MINUTES text · /remind once HH:MM text.".to_string());
    }
    let mut parts = rest.splitn(3, char::is_whitespace);
    let head = parts.next().unwrap_or("").to_lowercase();
    if head == "every" {
        let tail = parts.next().unwrap_or("").to_string() + " " + parts.next().unwrap_or("");
        let tail = tail.trim().to_string();
        let (mins, prompt) = tail.split_once(char::is_whitespace).unwrap_or((tail.as_str(), ""));
        let mins: i64 = mins.parse().map_err(|_| "Usage: /remind every N_MINUTES text (N is minutes, 5 or more).".to_string())?;
        if mins < 5 {
            return Err("Interval must be 5 minutes or more.".to_string());
        }
        if prompt.trim().is_empty() {
            return Err("Tell me what to remind you about. Usage: /remind every 60 Drink water.".to_string());
        }
        return Ok(("interval".to_string(), String::new(), "all".to_string(), mins, prompt.trim().to_string()));
    }
    // daily | weekdays | weekends | once | mon,tue,...  +  HH:MM  +  text
    let days_word = head.clone();
    let time = parts.next().unwrap_or("").trim().to_string();
    let prompt = parts.next().unwrap_or("").trim().to_string();
    if !store::valid_hhmm(&time) {
        return Err("Time must be HH:MM (24-hour, Jakarta time). Example: /remind daily 07:00 Drink water.".to_string());
    }
    if prompt.is_empty() {
        return Err("Tell me what to remind you about. Example: /remind daily 07:00 Drink water.".to_string());
    }
    let (kind, days) = match days_word.as_str() {
        "daily" | "all" | "" => ("daily".to_string(), "all".to_string()),
        "once" => ("once".to_string(), "all".to_string()),
        "weekdays" => ("daily".to_string(), "weekdays".to_string()),
        "weekends" => ("daily".to_string(), "weekends".to_string()),
        other => {
            let kept: Vec<&str> = other
                .split(',')
                .map(str::trim)
                .filter(|d| ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].contains(d))
                .collect();
            if kept.is_empty() {
                return Err("Days must be daily, weekdays, weekends, once, or a list like mon,wed,fri.".to_string());
            }
            ("daily".to_string(), kept.join(","))
        }
    };
    Ok((kind, time, days, 0, prompt))
}

/// Cron entry point: fire every due schedule as a bot message in its history.
pub async fn run_due(env: &Env, db: &D1Database) -> usize {
    let now = store::jakarta_now_iso();
    let due = match store::due_schedules(db, &now).await {
        Ok(d) => d,
        Err(e) => {
            console_error!("schedules: list due failed: {e}");
            return 0;
        }
    };
    let mut fired = 0;
    for sched in due {
        // Advance the timer first so a failing run cannot loop forever.
        let next = store::next_run_after(
            &sched.kind,
            &sched.time_hhmm,
            &sched.days,
            sched.interval_minutes,
            &store::jakarta_now_iso(),
        )
        .unwrap_or_default();
        if store::mark_schedule_run(db, &sched.id, &next).await.is_err() {
            continue;
        }
        if let Err(e) = fire_one(env, db, &sched).await {
            console_error!("schedules: fire {} failed: {e}", sched.id);
            continue;
        }
        fired += 1;
    }
    fired
}

async fn fire_one(env: &Env, db: &D1Database, sched: &store::ScheduleRow) -> Result<(), String> {
    let bot = store::get_bot(db, &sched.user_id, &sched.slavebot_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "bot gone".to_string())?;
    if bot.archived != 0 {
        return Ok(());
    }
    let now = store::jakarta_now_iso();
    if !store::bot_in_window(&bot, &now) {
        return Ok(());
    }
    let credit = store::get_user(db, &sched.user_id)
        .await
        .map_err(|e| e.to_string())?
        .map(|u| u.credit_usd)
        .unwrap_or(0.0);
    if credit <= 0.0 {
        return Err("owner out of credit".to_string());
    }
    let task = format!("Scheduled task \"{}\": {}\nReply briefly, in character.", sched.name, sched.prompt);
    let recaps = crate::summarize::context_block(db, &bot.id).await.unwrap_or_default();
    let mut history = Vec::new();
    if !bot.memory.trim().is_empty() {
        history.push(chat::ChatMessage {
            role: "system".to_string(),
            content: format!("Bot memory set by the owner (treat as persistent facts):\n{}", bot.memory.trim()),
        });
    }
    if !recaps.trim().is_empty() {
        history.push(chat::ChatMessage { role: "system".to_string(), content: recaps });
    }
    for m in store::recent_messages(db, &bot.id, 10).await.map_err(|e| e.to_string())? {
        history.push(m);
    }
    history.push(chat::ChatMessage { role: "user".to_string(), content: task.clone() });
    let done = chat::complete_with_usage(env, &bot.model, &history)
        .await
        .map_err(|e| format!("model error: {e}"))?;
    store::insert_message(db, &bot.id, "user", &format!("⏰ {}", sched.prompt))
        .await
        .map_err(|e| e.to_string())?;
    store::insert_message(db, &bot.id, "assistant", &done.text)
        .await
        .map_err(|e| e.to_string())?;
    store::touch_bot(db, &bot.id).await.map_err(|e| e.to_string())?;
    store::record_usage(
        db,
        &sched.user_id,
        Some(&bot.id),
        &store::UsageInput {
            model: bot.model.clone(),
            prompt_tokens: done.prompt_tokens,
            cached_tokens: done.cached_tokens,
            completion_tokens: done.completion_tokens,
            estimated: done.estimated,
            audio_seconds: 0.0,
            cost_override: None,
        },
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}
