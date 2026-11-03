use serde::Deserialize;
use worker::*;

use crate::{auth, chat, provider, store, util};

/// Slack-style huddles: one topic is pushed to bots, and each bot decides by
/// itself (from its role + memory) whether to join. Joined bots then discuss
/// in the shared huddle thread. Join decisions are capped at 8 bots so one
/// huddle start stays inside a single request's time budget.
///
/// POST /api/huddles {topic, slavebot_ids?} — notify + collect decisions.
/// GET /api/huddles — list. GET /api/huddles/:id — thread + participants.
/// POST /api/huddles/:id/chat {message, model?} — talk to the joined bots.
/// DELETE /api/huddles/:id — remove.
const MAX_HUDDLE_BOTS: usize = 8;

#[derive(Deserialize)]
struct HuddleCreateBody {
    topic: Option<String>,
    team_id: Option<String>,
    slavebot_ids: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct HuddleChatBody {
    message: Option<String>,
    model: Option<String>,
}

/// Ask one bot whether the huddle topic deserves its time.
/// Returns (joined, reason) and bills the short decision call.
async fn ask_to_join(
    prov: &provider::Provider,
    db: &D1Database,
    user_id: &str,
    bot: &store::BotRow,
    topic: &str,
) -> (bool, String) {
    let role = if bot.role.trim().is_empty() {
        "no specific role yet".to_string()
    } else {
        bot.role.trim().to_string()
    };
    let messages = vec![
        chat::ChatMessage {
            role: "system".to_string(),
            content: format!(
                "You are {name}, a slaveBot with this identity.\nRole: {role}\nOwner notes about you: {memory}\n\nA live huddle (short group call) just started. Only join when your role or knowledge is genuinely relevant to the topic.",
                name = bot.name,
                memory = bot.memory.trim(),
            ),
        },
        chat::ChatMessage {
            role: "user".to_string(),
            content: format!(
                "Huddle topic: \"{topic}\"\nReply with exactly one line: either `JOIN: <short reason>` or `DECLINE: <short reason>`.",
            ),
        },
    ];
    let model = provider::effective_model(&prov.preset, &bot.model);
    let done = match chat::complete_with_usage(prov, &model, &messages).await {
        Ok(d) => d,
        Err(e) => {
            console_error!("huddle ask {} failed: {e}", bot.id);
            return (false, "could not be reached".to_string());
        }
    };
    let line = done.text.lines().next().unwrap_or("").trim().to_string();
    let joined = line.to_ascii_uppercase().starts_with("JOIN");
    let reason = line
        .split_once(':')
        .map(|(_, r)| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .unwrap_or_else(|| {
            line.split_whitespace()
                .skip(1)
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(200)
                .collect()
        });
    let reason = if reason.is_empty() {
        if joined { "count me in".to_string() } else { "not relevant to me".to_string() }
    } else {
        reason
    };
    let _ = store::record_usage(
        db,
        user_id,
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
    .await;
    (joined, reason)
}

/// Core huddle start, shared by the HTTP route and the MCP tool.
/// Returns the huddle plus every bot's join/decline decision.
pub async fn start_huddle(
    env: &Env,
    db: &D1Database,
    user_id: &str,
    team_id: &str,
    topic: &str,
    slavebot_ids: Option<Vec<String>>,
) -> Result<(store::HuddleRow, Vec<store::HuddleParticipant>), String> {
    if topic.trim().is_empty() || topic.len() > 500 {
        return Err("topic must be 1..500 characters.".to_string());
    }
    let prov = provider::provider_for(db, env, user_id).await.map_err(|e| e.to_string())?;
    let credit = store::get_user(db, user_id)
        .await
        .map_err(|e| e.to_string())?
        .map(|u| u.credit_usd)
        .unwrap_or(0.0);
    if !prov.own && credit <= 0.0 {
        return Err("Out of credit (balance $0.00). Demo credit is $10 per user.".to_string());
    }
    let mut candidates: Vec<store::BotRow> = Vec::new();
    if let Some(ids) = slavebot_ids {
        for id in ids.iter().take(MAX_HUDDLE_BOTS) {
            if let Some(bot) = store::get_bot(db, user_id, id).await.map_err(|e| e.to_string())? {
                if bot.archived == 0 {
                    candidates.push(bot);
                }
            }
        }
    } else {
        candidates = store::list_bots(db, user_id, false)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .take(MAX_HUDDLE_BOTS)
            .collect();
    }
    if candidates.is_empty() {
        return Err("No active slaveBots to huddle with.".to_string());
    }
    let huddle = store::create_huddle(db, user_id, team_id, topic).await.map_err(|e| e.to_string())?;
    // Only bots on the huddle's team may be asked.
    candidates.retain(|b| b.team_id == huddle.team_id);
    if candidates.is_empty() {
        return Err("None of those bots are on this huddle's team.".to_string());
    }
    for bot in &candidates {
        if !prov.own {
            let credit_now = store::get_user(db, user_id)
                .await
                .map_err(|e| e.to_string())?
                .map(|u| u.credit_usd)
                .unwrap_or(0.0);
            if credit_now <= 0.0 {
                break;
            }
        }
        let (joined, reason) = ask_to_join(&prov, db, user_id, bot, huddle.topic.trim()).await;
        store::set_participant(db, &huddle.id, &bot.id, if joined { "join" } else { "decline" }, &reason)
            .await
            .map_err(|e| e.to_string())?;
    }
    store::touch_huddle(db, &huddle.id).await.map_err(|e| e.to_string())?;
    let participants = store::huddle_participants(db, &huddle.id).await.map_err(|e| e.to_string())?;
    Ok((huddle, participants))
}

pub async fn create(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Log in first."),
    };
    let body: HuddleCreateBody = match req.json().await {
        Ok(b) => b,
        Err(_) => return util::err(400, "Invalid JSON body."),
    };
    let db = ctx.env.d1("DB")?;
    let team_id = body.team_id.unwrap_or_default();
    match start_huddle(&ctx.env, &db, &user_id, &team_id, &body.topic.unwrap_or_default(), body.slavebot_ids).await {
        Ok((huddle, participants)) => {
            util::json(201, &serde_json::json!({ "huddle": huddle, "participants": participants }))
        }
        Err(e) => {
            let status = if e.starts_with("Out of credit") {
                402
            } else if e == "You are not on that team." {
                403
            } else {
                400
            };
            util::err(status, &e)
        }
    }
}

pub async fn list(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Log in first."),
    };
    let db = ctx.env.d1("DB")?;
    let huddles = store::list_huddles(&db, &user_id).await?;
    util::json(200, &serde_json::json!({ "huddles": huddles }))
}

pub async fn detail(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Log in first."),
    };
    let huddle_id = ctx.param("id").cloned().unwrap_or_default();
    let db = ctx.env.d1("DB")?;
    match store::get_huddle(&db, &user_id, &huddle_id).await? {
        Some(huddle) => {
            let participants = store::huddle_participants(&db, &huddle_id).await?;
            let messages = store::huddle_history(&db, &huddle_id, 100).await?;
            util::json(200, &serde_json::json!({ "huddle": huddle, "participants": participants, "messages": messages }))
        }
        None => util::err(404, "Huddle not found."),
    }
}

pub async fn delete(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Log in first."),
    };
    let huddle_id = ctx.param("id").cloned().unwrap_or_default();
    let db = ctx.env.d1("DB")?;
    if store::delete_huddle(&db, &user_id, &huddle_id).await? {
        util::json(200, &serde_json::json!({ "deleted": true }))
    } else {
        util::err(404, "Huddle not found.")
    }
}

pub struct HuddleChatResult {
    pub replies: Vec<serde_json::Value>,
    pub total_cost: f64,
    pub credit: f64,
}

/// Core huddle fan-out, shared by the HTTP route and the MCP tool.
pub async fn post_message(
    env: &Env,
    db: &D1Database,
    user_id: &str,
    huddle_id: &str,
    message: &str,
    model_override: Option<String>,
) -> Result<HuddleChatResult, String> {
    if message.is_empty() || message.len() > 8000 {
        return Err("message must be 1..8000 characters.".to_string());
    }
    let prov = provider::provider_for(db, env, user_id).await.map_err(|e| e.to_string())?;
    let credit = store::get_user(db, user_id)
        .await
        .map_err(|e| e.to_string())?
        .map(|u| u.credit_usd)
        .unwrap_or(0.0);
    if !prov.own && credit <= 0.0 {
        return Err("Out of credit (balance $0.00). Demo credit is $10 per user.".to_string());
    }
    if store::get_huddle(db, user_id, huddle_id)
        .await
        .map_err(|e| e.to_string())?
        .is_none()
    {
        return Err("Huddle not found.".to_string());
    }
    // Full bot rows for the joined participants (participants only carry names).
    let mut members: Vec<store::BotRow> = Vec::new();
    for p in store::huddle_participants(db, huddle_id).await.map_err(|e| e.to_string())? {
        if p.decision != "join" {
            continue;
        }
        if let Some(bot) = store::get_bot(db, user_id, &p.slavebot_id).await.map_err(|e| e.to_string())? {
            if bot.archived == 0 {
                members.push(bot);
            }
        }
    }
    if members.is_empty() {
        return Err("Nobody joined this huddle.".to_string());
    }

    store::insert_huddle_message(db, huddle_id, None, "user", message)
        .await
        .map_err(|e| e.to_string())?;
    let thread = store::huddle_history(db, huddle_id, 20).await.map_err(|e| e.to_string())?;

    let mut replies = Vec::new();
    let mut total_cost = 0.0;
    let mut remaining = credit;
    for bot in &members {
        let model = match model_override.clone().filter(|m| provider::valid_for(&prov.preset, m)) {
            Some(m) => m,
            None => provider::effective_model(&prov.preset, &bot.model),
        };
        let role_line = if bot.role.trim().is_empty() {
            String::new()
        } else {
            format!(" Your role: {}.", bot.role.trim())
        };
        let mut history = vec![chat::ChatMessage {
            role: "user".to_string(),
            content: format!(
                "You are {name}, in a live huddle about the topic above.{role_line} Reply as yourself, briefly.",
                name = bot.name,
            ),
        }];
        for row in &thread {
            let content = match (&row.slavebot_id, &row.bot_name) {
                (Some(id), Some(name)) if id != &bot.id => format!("[{name}]: {}", row.content),
                (Some(id), _) if id != &bot.id => format!("[teammate]: {}", row.content),
                _ => row.content.clone(),
            };
            let role = if row.role == "assistant" { "assistant" } else { "user" };
            history.push(chat::ChatMessage { role: role.to_string(), content });
        }
        let recaps = crate::summarize::context_block(db, &bot.id).await.unwrap_or_default();
        let mut with_context = Vec::with_capacity(history.len() + 2);
        let mut context_head = String::new();
        if !bot.role.trim().is_empty() {
            context_head.push_str(&format!("Your role: {}.\n", bot.role.trim()));
        }
        if !bot.memory.trim().is_empty() {
            context_head.push_str(&format!("Owner notes about you:\n{}\n", bot.memory.trim()));
        }
        if !context_head.is_empty() {
            with_context.push(chat::ChatMessage { role: "system".to_string(), content: context_head });
        }
        if !recaps.trim().is_empty() {
            with_context.push(chat::ChatMessage { role: "system".to_string(), content: recaps });
        }
        with_context.extend(history);

        let done = match chat::complete_with_usage(&prov, &model, &with_context).await {
            Ok(d) => d,
            Err(e) => {
                console_error!("huddle chat bot {} failed: {e}", bot.id);
                replies.push(serde_json::json!({
                    "slavebot_id": bot.id, "name": bot.name,
                    "error": chat::describe_upstream_error(502, &e),
                }));
                continue;
            }
        };
        store::insert_huddle_message(db, huddle_id, Some(bot), "assistant", &done.text)
            .await
            .map_err(|e| e.to_string())?;
        let (cost, credit_left) = store::record_usage(
            db,
            user_id,
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
        total_cost += cost;
        remaining = credit_left;
        replies.push(serde_json::json!({
            "slavebot_id": bot.id, "name": bot.name, "reply": done.text,
            "usage": { "prompt_tokens": done.prompt_tokens, "completion_tokens": done.completion_tokens, "estimated": done.estimated },
            "cost_usd": cost,
        }));
    }
    store::touch_huddle(db, huddle_id).await.map_err(|e| e.to_string())?;
    Ok(HuddleChatResult { replies, total_cost, credit: remaining })

}

/// POST /api/huddles/:id/chat — talk to the bots that joined.
pub async fn chat(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Log in first."),
    };
    let body: HuddleChatBody = match req.json().await {
        Ok(b) => b,
        Err(_) => return util::err(400, "Invalid JSON body."),
    };
    let huddle_id = ctx.param("id").cloned().unwrap_or_default();
    let db = ctx.env.d1("DB")?;
    match post_message(
        &ctx.env,
        &db,
        &user_id,
        &huddle_id,
        &body.message.unwrap_or_default(),
        body.model,
    )
    .await
    {
        Ok(r) => util::json(
            200,
            &serde_json::json!({ "replies": r.replies, "total_cost_usd": r.total_cost, "credit_usd": r.credit }),
        ),
        Err(e) => {
            let status = if e.starts_with("Out of credit") {
                402
            } else if e == "Huddle not found." {
                404
            } else {
                400
            };
            util::err(status, &e)
        }
    }
}
