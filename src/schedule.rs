use crate::{chat, db::Db, provider, store};

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
pub async fn run_due(db: &Db) -> usize {
    let now = store::jakarta_now_iso();
    let due = match store::due_schedules(db, &now).await {
        Ok(d) => d,
        Err(e) => {
            eprintln!("schedules: list due failed: {e}");
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
        if let Err(e) = fire_one(db, &sched).await {
            eprintln!("schedules: fire {} failed: {e}", sched.id);
            continue;
        }
        fired += 1;
    }
    fired
}

async fn fire_one(db: &Db, sched: &store::ScheduleRow) -> Result<(), String> {
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
    let prov = provider::provider_for(db, &bot.team_id).await.map_err(|e| e.to_string())?;
    let credit = store::get_user(db, &sched.user_id)
        .await
        .map_err(|e| e.to_string())?
        .map(|u| u.credit_usd)
        .unwrap_or(0.0);
    if !prov.own && credit <= 0.0 {
        return Err("owner out of credit".to_string());
    }
    let task = format!("Scheduled task \"{}\": {}\nReply briefly, in character.", sched.name, sched.prompt);
    let recaps = crate::summarize::context_block(db, &bot.id).await.unwrap_or_default();
    let mut history = Vec::new();
    if !bot.memory.trim().is_empty() {
        history.push(chat::ChatMessage {
            role: "system".to_string(),
            content: format!("Bot memory set by the owner (treat as persistent facts):\n{}", bot.memory.trim()),
        ..Default::default()
        });
    }
    if !recaps.trim().is_empty() {
        history.push(chat::ChatMessage { role: "system".to_string(), content: recaps, ..Default::default() });
    }
    for m in store::recent_messages(db, &bot.id, 10).await.map_err(|e| e.to_string())? {
        history.push(m);
    }
    history.push(chat::ChatMessage { role: "user".to_string(), content: task.clone(), ..Default::default() });
    let model = provider::effective_model(&prov.preset, &bot.model);
    let done = chat::complete_with_usage(&prov, &model, &history, Some(&bot.id))
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
            model: model.clone(),
            prompt_tokens: done.prompt_tokens,
            cached_tokens: done.cached_tokens,
            completion_tokens: done.completion_tokens,
            estimated: done.estimated,
            audio_seconds: 0.0,
            cost_override: None,
            own_key: prov.own,
        },
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}
