use serde::{Deserialize, Serialize};
use worker::*;

use crate::{auth, pricing, provider, schedule, store, util};

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
struct ChatRequest {
    slavebot_id: Option<String>,
    message: Option<String>,
    model: Option<String>,
    stream: Option<bool>,
}

#[derive(Deserialize)]
pub struct ClientUsage {
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

#[derive(Deserialize)]
struct FinishRequest {
    slavebot_id: Option<String>,
    content: Option<String>,
    usage: Option<ClientUsage>,
}

#[derive(Deserialize)]
struct CreateBotRequest {
    model: Option<String>,
    team_id: Option<String>,
    owner_user_id: Option<String>,
}

#[derive(Deserialize)]
struct UpdateBotRequest {
    name: Option<String>,
    memory: Option<String>,
    model: Option<String>,
    voice: Option<String>,
    archived: Option<bool>,
    pinned: Option<bool>,
    active_days: Option<String>,
    active_start: Option<String>,
    active_end: Option<String>,
    role: Option<String>,
    relay: Option<bool>,
}



/// Build the upstream message list: bot memory and past-conversation recaps
/// first (as system context), then the saved history (which already ends with
/// the new user message).
fn with_memory(memory: &str, recaps: &str, history: Vec<ChatMessage>) -> Vec<ChatMessage> {
    let mut msgs = Vec::with_capacity(history.len() + 2);
    let memory = memory.trim();
    if !memory.is_empty() {
        msgs.push(ChatMessage {
            role: "system".to_string(),
            content: format!("Bot memory set by the owner (treat as persistent facts about the user and past conversations):\n{memory}"),
        });
    }
    let recaps = recaps.trim();
    if !recaps.is_empty() {
        msgs.push(ChatMessage {
            role: "system".to_string(),
            content: recaps.to_string(),
        });
    }
    msgs.extend(history);
    msgs
}

/// POST /api/chat — chat with a slaveBot. Body: {slavebot_id, message, model?, stream?}.
/// Non-streaming returns the reply + cost inline. Streaming returns SSE with an
/// X-Chat-Id header — the client then POSTs the final text to /api/chat/finish.
pub async fn chat(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Log in before chatting."),
    };
    let db = ctx.env.d1("DB")?;
    let credit = store::get_user(&db, &user_id)
        .await?
        .map(|u| u.credit_usd)
        .unwrap_or(0.0);

    let body: ChatRequest = match req.json().await {
        Ok(b) => b,
        Err(_) => return util::err(400, "Invalid JSON body."),
    };
    let bot_id = body.slavebot_id.unwrap_or_default();
    let message = body.message.unwrap_or_default();
    if bot_id.is_empty() {
        return util::err(400, "Select a slaveBot first.");
    }
    if message.is_empty() || message.len() > 8000 {
        return util::err(400, "message must be 1..8000 characters.");
    }
    let bot = match store::get_bot(&db, &user_id, &bot_id).await? {
        Some(b) => b,
        None => return util::err(404, "SlaveBot not found."),
    };
    let stream = body.stream.unwrap_or(true);

    // Slash commands run locally (no model call, nothing saved to history).
    // The web client sends these with stream:false and renders `reply` directly.
    if message.starts_with('/') {
        return handle_command(&ctx.env, &db, &user_id, &bot, &message).await;
    }

    // The team's own key pays; demo credit is never touched for team-key calls.
    let prov = match provider::provider_for(&db, &bot.team_id).await {
        Ok(v) => v,
        Err(e) => return util::err(502, &e.to_string()),
    };
    if !prov.own && credit <= 0.0 {
        return util::err(402, "Out of credit (balance $0.00). Demo credit is $10 per user.");
    }
    let model = match body.model.filter(|m| provider::valid_for(&prov.preset, m)) {
        Some(m) => m,
        None => provider::effective_model(&prov.preset, &bot.model),
    };

    // The agent may consult peer bots itself before replying (one hop max).
    let relay_notes = consult_peers(&db, &prov, &model, &bot, &user_id, &message).await;
    store::insert_message(&db, &bot_id, "user", &message).await?;
    store::maybe_title_bot(&db, &bot_id, &message).await?;
    let recaps = crate::summarize::context_block(&db, &bot_id)
        .await
        .unwrap_or_default();
    let mut history = with_memory(&bot.memory, &recaps, store::recent_messages(&db, &bot_id, 20).await?);
    history.extend(relay_notes);

    let mut upstream =
        match provider::post_chat_completions(&prov, &model, &history, stream).await {
            Ok(r) => r,
            Err(e) => {
                console_error!("chat upstream fetch failed: {e}");
                return util::err(502, "Could not reach the model provider.");
            }
        };

    if upstream.status_code() != 200 {
        let status = upstream.status_code();
        let text = upstream.text().await.unwrap_or_default();
        console_error!(
            "chat upstream status={} body={}",
            status,
            util::truncate(&text, 300)
        );
        return util::json(
            502,
            &serde_json::json!({
                "error": describe_upstream_error(status, &text),
                "detail": util::truncate(&text, 500),
            }),
        );
    }

    if !stream {
        let data: serde_json::Value = upstream.json().await.unwrap_or(serde_json::Value::Null);
        let reply = data
            .pointer("/choices/0/message/content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let usage = data.get("usage");
        let prompt = usage.and_then(|u| u.get("prompt_tokens")).and_then(|v| v.as_u64()).unwrap_or_else(|| {
            history.iter().map(|m| m.role.len() + m.content.len()).sum::<usize>() as u64 / 4
        });
        let cached = usage
            .and_then(|u| u.get("prompt_tokens_details"))
            .and_then(|d| d.get("cached_tokens"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let completion = usage
            .and_then(|u| u.get("completion_tokens"))
            .and_then(|v| v.as_u64())
            .unwrap_or_else(|| pricing::estimate_tokens(&reply));
        let estimated = usage.is_none();
        store::insert_message(&db, &bot_id, "assistant", &reply).await?;
        store::touch_bot(&db, &bot_id).await?;
        let (cost, remaining) = store::record_usage(
            &db,
            &user_id,
            Some(&bot_id),
            &store::UsageInput { model: model.clone(), prompt_tokens: prompt, cached_tokens: cached, completion_tokens: completion, estimated, audio_seconds: 0.0, cost_override: None, own_key: prov.own },
        )
        .await?;
        return util::json(
            200,
            &serde_json::json!({
                "slavebot_id": bot_id,
                "reply": reply,
                "usage": { "prompt_tokens": prompt, "completion_tokens": completion, "estimated": estimated },
                "cost_usd": cost,
                "credit_usd": remaining,
            }),
        );
    }

    let body_stream = upstream.stream()?;
    let mut resp = Response::from_stream(body_stream)?;
    {
        let h = resp.headers_mut();
        h.set("Content-Type", "text/event-stream; charset=utf-8")?;
        h.set("Cache-Control", "no-cache, no-transform")?;
        h.set("Connection", "keep-alive")?;
        h.set("X-Accel-Buffering", "no")?;
        h.set("X-Chat-Id", &bot_id)?;
    }
    util::cors(&mut resp)?;
    Ok(resp)
}

/// POST /api/chat/finish — called by the client after an SSE stream ends.
/// Persists the assistant message, logs exact-or-estimated usage, deducts credit.
pub async fn finish(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Log in before chatting."),
    };
    let body: FinishRequest = match req.json().await {
        Ok(b) => b,
        Err(_) => return util::err(400, "Invalid JSON body."),
    };
    let bot_id = body.slavebot_id.unwrap_or_default();
    let content = body.content.unwrap_or_default();
    if bot_id.is_empty() || content.is_empty() || content.len() > 200_000 {
        return util::err(400, "slavebot_id and content are required.");
    }
    let db = ctx.env.d1("DB")?;
    let bot = match store::get_bot(&db, &user_id, &bot_id).await? {
        Some(b) => b,
        None => return util::err(404, "SlaveBot not found."),
    };

    let prompt = match body.usage.as_ref().and_then(|u| u.prompt_tokens) {
        Some(p) => p,
        None => {
            let chars = store::prompt_chars(&db, &bot_id).await?;
            (chars as f64 / 4.0).ceil() as u64
        }
    };
    let completion = match body.usage.as_ref().and_then(|u| u.completion_tokens) {
        Some(c) => c,
        None => match body.usage.as_ref().and_then(|u| u.total_tokens) {
            Some(t) => t.saturating_sub(prompt),
            None => pricing::estimate_tokens(&content),
        },
    };
    let estimated = body.usage.is_none();

    store::insert_message(&db, &bot_id, "assistant", &content).await?;
    store::touch_bot(&db, &bot_id).await?;
    let own = provider::provider_for(&db, &bot.team_id).await.map(|p| p.own).unwrap_or(false);
    let (cost, remaining) = store::record_usage(
        &db,
        &user_id,
        Some(&bot_id),
        &store::UsageInput { model: bot.model.clone(), prompt_tokens: prompt, cached_tokens: 0, completion_tokens: completion, estimated, audio_seconds: 0.0, cost_override: None, own_key: own },
    )
    .await?;
    util::json(
        200,
        &serde_json::json!({
            "slavebot_id": bot_id,
            "usage": { "prompt_tokens": prompt, "completion_tokens": completion, "estimated": estimated },
            "cost_usd": cost,
            "credit_usd": remaining,
        }),
    )
}

/// GET /api/slavebots — the user's bots, most recently active first.
pub async fn list_bots(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Unauthorized."),
    };
    let db = ctx.env.d1("DB")?;
    let bots = store::list_bots(&db, &user_id, true).await?;
    util::json(200, &serde_json::json!({ "slavebots": bots }))
}

/// POST /api/slavebots — create a new bot in a team. Body: {model?, team_id?}.
/// The new bot opens with a greeting that asks the owner what its job is,
/// so every bot gets a personal identity from the first exchange.
pub async fn create_bot(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Unauthorized."),
    };
    let body: CreateBotRequest = match req.json().await {
        Ok(b) => b,
        Err(_) => CreateBotRequest { model: None, team_id: None, owner_user_id: None },
    };
    let db = ctx.env.d1("DB")?;
    let requested_team = body.team_id.unwrap_or_default();
    let team_id = if requested_team.trim().is_empty() {
        store::ensure_personal_team(&db, &user_id).await.map(|t| t.id).unwrap_or_default()
    } else {
        requested_team
    };
    let preset = provider::preset_for_team(&db, &team_id).await;
    let model = body
        .model
        .filter(|m| provider::valid_for(&preset, m))
        .unwrap_or_else(|| provider::effective_model(&preset, ""));
    let owner = body.owner_user_id.unwrap_or_default();
    let bot = match store::create_bot(&db, &user_id, &team_id, &model, &owner).await {
        Ok(b) => b,
        Err(e) => return util::err(403, &e.to_string()),
    };
    let greeting = format!(
        "Hi, I'm {name}! Before we start — what should my job be? Tell me my role in a sentence or two, \
        for example \"You are my sales manager — track my leads and remind me to follow up\". \
        You can also set it anytime in the Bot tab, and I can grow my own little team later with /spawn.",
        name = bot.name,
    );
    store::insert_message(&db, &bot.id, "assistant", &greeting).await?;
    let bot = store::get_bot(&db, &user_id, &bot.id)
        .await?
        .unwrap_or(bot);
    util::json(201, &serde_json::json!({ "slavebot": bot }))
}

#[derive(Deserialize)]
struct SpawnBody {
    name: Option<String>,
    role: Option<String>,
    model: Option<String>,
}

/// POST /api/slavebots/:id/spawn — a manager bot grows a sub-bot for one
/// specific task. Body: {name?, role?, model?}.
pub async fn spawn_sub_bot(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Unauthorized."),
    };
    let body: SpawnBody = match req.json().await {
        Ok(b) => b,
        Err(_) => return util::err(400, "Invalid JSON body."),
    };
    let manager_id = ctx.param("id").cloned().unwrap_or_default();
    let db = ctx.env.d1("DB")?;
    let manager = match store::get_bot(&db, &user_id, &manager_id).await? {
        Some(m) => m,
        None => return util::err(404, "SlaveBot not found."),
    };
    let preset = provider::preset_for_team(&db, &manager.team_id).await;
    let model = body
        .model
        .filter(|m| provider::valid_for(&preset, m))
        .unwrap_or_else(|| provider::effective_model(&preset, &manager.model));
    let child = match store::spawn_bot(
        &db,
        &user_id,
        &manager_id,
        &body.name.unwrap_or_default(),
        &body.role.unwrap_or_default(),
        &model,
    )
    .await
    {
        Ok(c) => c,
        Err(e) => return util::err(400, &e.to_string()),
    };
    let task = if child.role.trim().is_empty() {
        "My specific task is not set yet — tell me what to focus on.".to_string()
    } else {
        format!("My task: {}.", child.role.trim())
    };
    let greeting = format!(
        "Hi, I'm {name}! I report to {manager}. {task} What should I do first?",
        name = child.name,
        manager = manager.name,
    );
    store::insert_message(&db, &child.id, "assistant", &greeting).await?;
    let child = store::get_bot_any(&db, &child.id)
        .await?
        .unwrap_or(child);
    util::json(201, &serde_json::json!({ "slavebot": child, "manager_id": manager_id }))
}

/// GET /api/slavebots/:id — one bot with its full message history.
pub async fn bot_detail(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Unauthorized."),
    };
    let bot_id = ctx.param("id").cloned().unwrap_or_default();
    let db = ctx.env.d1("DB")?;
    match store::bot_messages(&db, &user_id, &bot_id).await? {
        Some((bot, messages)) => util::json(200, &serde_json::json!({ "slavebot": bot, "messages": messages })),
        None => util::err(404, "SlaveBot not found."),
    }
}

pub struct SendAsResult {
    pub reply: String,
    pub from_bot_id: String,
    pub to_bot_id: String,
    pub cost_usd: f64,
}

/// Shared core: the acting user directs bot A to message bot B as a partner.
/// Recorded in both histories (labeled), billed to B's team provider.
pub async fn deliver_as(
    db: &D1Database,
    user_id: &str,
    from_id: &str,
    to_id: &str,
    message: &str,
) -> Result<SendAsResult, String> {
    let message = message.trim();
    if message.is_empty() || message.len() > 8000 {
        return Err("message must be 1..8000 characters.".to_string());
    }
    if from_id == to_id {
        return Err("Pick a different bot to message.".to_string());
    }
    let from = store::get_bot(db, user_id, from_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Sender bot not found.".to_string())?;
    let to = store::get_bot(db, user_id, to_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Target bot not found.".to_string())?;
    if to.archived != 0 {
        return Err("That bot is archived.".to_string());
    }
    let prov = provider::provider_for(db, &to.team_id).await.map_err(|e| e.to_string())?;
    let model = provider::effective_model(&prov.preset, &to.model);
    store::insert_message(db, &to.id, "user", &format!("[From {}]: {}", from.name, message))
        .await
        .map_err(|e| e.to_string())?;
    let recaps = crate::summarize::context_block(db, &to.id).await.unwrap_or_default();
    let history = with_memory(&to.memory, &recaps, store::recent_messages(db, &to.id, 20).await.map_err(|e| e.to_string())?);
    let done = complete_with_usage(&prov, &model, &history).await?;
    store::insert_message(db, &to.id, "assistant", &done.text).await.map_err(|e| e.to_string())?;
    store::touch_bot(db, &to.id).await.map_err(|e| e.to_string())?;
    let (cost, _) = store::record_usage(
        db,
        user_id,
        Some(&to.id),
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
    // Partnership trail in the sender's own history, clearly labeled.
    store::insert_message(db, &from.id, "user", &format!("(to {}) {}", to.name, message))
        .await
        .map_err(|e| e.to_string())?;
    store::insert_message(db, &from.id, "assistant", &format!("[{} replied] {}", to.name, done.text))
        .await
        .map_err(|e| e.to_string())?;
    Ok(SendAsResult { reply: done.text, from_bot_id: from.id, to_bot_id: to.id, cost_usd: cost })
}

#[derive(Deserialize)]
struct SendBody {
    to_bot_id: Option<String>,
    message: Option<String>,
}

/// POST /api/slavebots/:id/send — chat as this bot to another bot.
/// Body: {to_bot_id, message}. Non-streaming; billed to the target's team.
pub async fn send_as(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Unauthorized."),
    };
    let body: SendBody = match req.json().await {
        Ok(b) => b,
        Err(_) => return util::err(400, "Invalid JSON body."),
    };
    let from_id = ctx.param("id").cloned().unwrap_or_default();
    let db = ctx.env.d1("DB")?;
    match deliver_as(&db, &user_id, &from_id, &body.to_bot_id.unwrap_or_default(), &body.message.unwrap_or_default()).await {
        Ok(r) => util::json(200, &serde_json::json!({
            "reply": r.reply, "from_bot_id": r.from_bot_id,
            "to_bot_id": r.to_bot_id, "cost_usd": r.cost_usd,
        })),
        Err(e) => util::err(400, &e),
    }
}

#[derive(Deserialize)]
struct TransferBody {
    owner_user_id: Option<String>,
}

/// POST /api/slavebots/:id/transfer — reassign a bot's partnership.
/// Body: {owner_user_id}. Only the team's owner/admin may do this.
pub async fn transfer(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Unauthorized."),
    };
    let body: TransferBody = match req.json().await {
        Ok(b) => b,
        Err(_) => return util::err(400, "Invalid JSON body."),
    };
    let bot_id = ctx.param("id").cloned().unwrap_or_default();
    let db = ctx.env.d1("DB")?;
    match store::set_bot_owner(&db, &user_id, &bot_id, &body.owner_user_id.unwrap_or_default()).await {
        Ok(bot) => util::json(200, &serde_json::json!({ "slavebot": bot })),
        Err(e) => util::err(403, &e),
    }
}

/// GET /api/slavebots/:id/children — direct sub-bots spawned under this manager.
pub async fn sub_bot_children(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Unauthorized."),
    };
    let bot_id = ctx.param("id").cloned().unwrap_or_default();
    let db = ctx.env.d1("DB")?;
    if store::get_bot(&db, &user_id, &bot_id).await?.is_none() {
        return util::err(404, "SlaveBot not found.");
    }
    let children = store::children_of(&db, &user_id, &bot_id).await?;
    util::json(200, &serde_json::json!({ "slavebots": children }))
}

/// PUT /api/slavebots/:id — rename, set memory/model/voice, archive, or set
/// active hours. Body: {name?, memory?, model?, voice?, archived?, active_days?, active_start?, active_end?}.
pub async fn update_bot(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Unauthorized."),
    };
    let body: UpdateBotRequest = match req.json().await {
        Ok(b) => b,
        Err(_) => return util::err(400, "Invalid JSON body."),
    };
    let bot_id = ctx.param("id").cloned().unwrap_or_default();
    let db = ctx.env.d1("DB")?;
    let preset = match store::get_bot(&db, &user_id, &bot_id).await? {
        Some(b) => provider::preset_for_team(&db, &b.team_id).await,
        None => "meta".to_string(),
    };
    let model = match body.model {
        Some(m) if provider::valid_for(&preset, &m) => Some(m),
        Some(_) => return util::err(400, "That model is not available on your provider."),
        None => None,
    };
    if let Some(archived) = body.archived {
        return match store::set_archived(&db, &user_id, &bot_id, archived).await? {
            Some(bot) => util::json(200, &serde_json::json!({ "slavebot": bot })),
            None => util::err(404, "SlaveBot not found."),
        };
    }
    if let Some(pinned) = body.pinned {
        return match store::set_pinned(&db, &user_id, &bot_id, pinned).await {
            Ok(Some(bot)) => util::json(200, &serde_json::json!({ "slavebot": bot })),
            Ok(None) => util::err(404, "SlaveBot not found."),
            Err(e) => util::err(400, &e.to_string()),
        };
    }
    match store::update_bot(
        &db,
        &user_id,
        &bot_id,
        body.name.as_deref(),
        body.memory.as_deref(),
        model.as_deref(),
        body.voice.as_deref(),
        body.active_days.as_deref(),
        body.active_start.as_deref(),
        body.active_end.as_deref(),
        body.role.as_deref(),
        body.relay,
    )
    .await?
    {
        Some(bot) => util::json(200, &serde_json::json!({ "slavebot": bot })),
        None => util::err(404, "SlaveBot not found."),
    }
}

/// A peer consult the model requested, parsed out of the relay decision call.
#[derive(Debug, PartialEq)]
struct Consult {
    bot_id: String,
    message: String,
}

/// Pull `{...}` JSON objects carrying bot_id+message out of a decision reply.
/// Pure (no I/O), so it unit-tests on the host. Caps at two consults.
fn parse_consults(text: &str) -> Vec<Consult> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() && out.len() < 2 {
        if bytes[i] == b'{' {
            let mut depth = 0i32;
            let mut j = i;
            while j < bytes.len() {
                if bytes[j] == b'{' {
                    depth += 1;
                } else if bytes[j] == b'}' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                j += 1;
            }
            if depth == 0 {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text[i..=j]) {
                    let bot_id = v.get("bot_id").and_then(|x| x.as_str()).unwrap_or("").trim();
                    let message = v.get("message").and_then(|x| x.as_str()).unwrap_or("").trim();
                    if !bot_id.is_empty() && !message.is_empty() {
                        out.push(Consult { bot_id: bot_id.to_string(), message: message.to_string() });
                    }
                }
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Agent-initiated relay: before replying, the bot may consult peer bots on
/// its own (max 2, one hop — consulted bots do not relay further). Returns
/// ephemeral context notes; `deliver_as` already records both sides and bills
/// the target's team. Disabled per bot via the relay flag.
async fn consult_peers(
    db: &D1Database,
    prov: &provider::Provider,
    model: &str,
    bot: &store::BotRow,
    user_id: &str,
    message: &str,
) -> Vec<ChatMessage> {
    if bot.relay == 0 {
        return Vec::new();
    }
    let peers: Vec<store::BotRow> = match store::list_bots(db, user_id, false).await {
        Ok(list) => list
            .into_iter()
            .filter(|b| b.team_id == bot.team_id && b.id != bot.id)
            .take(12)
            .collect(),
        Err(_) => return Vec::new(),
    };
    if peers.is_empty() {
        return Vec::new();
    }
    let roster = peers
        .iter()
        .map(|b| {
            let role = if b.role.trim().is_empty() { b.title.clone() } else { b.role.clone() };
            format!("- {} (id {}): {}", b.name, b.id, role.trim())
        })
        .collect::<Vec<_>>()
        .join("\n");
    let who = if bot.role.trim().is_empty() { bot.name.clone() } else { format!("{} ({})", bot.name, bot.role.trim()) };
    let prompt = format!(
        "You are the router for {who}. The user just wrote: \"{message}\"\n\nTeammate bots you may consult (only when you genuinely need their expertise to answer well, max 2):\n{roster}\n\nReply with ONLY a JSON array like [{{\"bot_id\": \"<id>\", \"message\": \"<what to ask them>\"}}], or [] when no consult is needed. No other text."
    );
    let decision = match complete_with_usage(
        prov,
        model,
        &[ChatMessage { role: "user".to_string(), content: prompt }],
    )
    .await
    {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let _ = store::record_usage(
        db,
        user_id,
        Some(&bot.id),
        &store::UsageInput {
            model: format!("{model} (relay decision)"),
            prompt_tokens: decision.prompt_tokens,
            cached_tokens: decision.cached_tokens,
            completion_tokens: decision.completion_tokens,
            estimated: decision.estimated,
            audio_seconds: 0.0,
            cost_override: None,
            own_key: prov.own,
        },
    )
    .await;
    let mut notes = Vec::new();
    for c in parse_consults(&decision.text) {
        if c.bot_id == bot.id {
            continue;
        }
        if let Ok(r) = deliver_as(db, user_id, &bot.id, &c.bot_id, &c.message).await {
            let peer = peers
                .iter()
                .find(|b| b.id == r.to_bot_id)
                .map(|b| b.name.clone())
                .unwrap_or_else(|| "teammate".to_string());
            notes.push(ChatMessage {
                role: "user".to_string(),
                content: format!("[{peer}'s answer for you]: {}", r.reply),
            });
        }
    }
    notes
}

/// Slash commands handled without calling the model. Returns the same shape
/// as a non-streaming /api/chat reply so the client renders it as a bot message.
async fn handle_command(
    _env: &Env,
    db: &D1Database,
    user_id: &str,
    bot: &store::BotRow,
    message: &str,
) -> Result<Response> {
    let credit = store::get_user(db, user_id)
        .await?
        .map(|u| u.credit_usd)
        .unwrap_or(0.0);
    let reply = if message.starts_with("/remind") {
        match schedule::parse_remind(message) {
            Ok((kind, time_hhmm, days, interval_minutes, prompt)) => {
                match store::create_schedule(
                    db, user_id, &bot.id, "Chat reminder", &kind, &time_hhmm, &days,
                    interval_minutes, &prompt,
                )
                .await
                {
                    Ok(s) => {
                        let when = if s.kind == "interval" {
                            format!("every {} minutes", s.interval_minutes)
                        } else {
                            format!("at {} ({})", s.time_hhmm, s.days)
                        };
                        format!("⏰ Reminder set — I will run \"{}\" {}.", s.prompt, when)
                    }
                    Err(e) => format!("Could not set the reminder: {e}"),
                }
            }
            Err(e) => e,
        }
    } else if message.starts_with("/schedules") {
        match store::list_schedules(db, user_id, Some(&bot.id)).await {
            Ok(list) if list.is_empty() => {
                "No schedules yet. Try: /remind daily 07:00 Good morning briefing".to_string()
            }
            Ok(list) => {
                let mut out = String::from("Schedules for this bot:\n");
                for (i, s) in list.iter().enumerate() {
                    let state = if s.active == 1 { "on" } else { "off" };
                    let when = if s.kind == "interval" {
                        format!("every {}m", s.interval_minutes)
                    } else {
                        format!("{} {}", s.time_hhmm, s.days)
                    };
                    out.push_str(&format!("{}. [{}] {} — {} (next {})  id:{}\n", i + 1, state, s.name, when, s.next_run_at, s.id));
                }
                out.push_str("Pause: /unschedule <id> · Full list: Bot tab → Schedules");
                out
            }
            Err(e) => format!("Could not list schedules: {e}"),
        }
    } else if message.starts_with("/unschedule") {
        let id = message.strip_prefix("/unschedule").unwrap_or("").trim();
        if id.is_empty() {
            "Usage: /unschedule <schedule-id> (see /schedules).".to_string()
        } else {
            // Accept either the full id or the list number from /schedules.
            let target = if id.len() < 8 {
                match store::list_schedules(db, user_id, Some(&bot.id)).await {
                    Ok(list) => id
                        .parse::<usize>()
                        .ok()
                        .and_then(|n| list.get(n.saturating_sub(1)))
                        .map(|s| s.id.clone())
                        .unwrap_or_else(|| id.to_string()),
                    Err(_) => id.to_string(),
                }
            } else {
                id.to_string()
            };
            match store::delete_schedule(db, user_id, &target).await {
                Ok(true) => "Schedule removed.".to_string(),
                _ => "Schedule not found. See /schedules for ids.".to_string(),
            }
        }
    } else if message.starts_with("/archive") {
        match store::set_archived(db, user_id, &bot.id, true).await {
            Ok(_) => format!("{} archived. Restore it anytime from the Bot tab.", bot.name),
            Err(e) => format!("Could not archive: {e}"),
        }
    } else if message.starts_with("/spawn") {
        let rest = message.strip_prefix("/spawn").unwrap_or("").trim();
        let (name, role) = match rest.split_once(" - ") {
            Some((n, r)) => (n.trim(), r.trim()),
            None => (rest, ""),
        };
        if name.is_empty() {
            "Usage: /spawn <name> - <task or role>. Example: /spawn Scout - track competitor prices every morning.".to_string()
        } else {
            match store::spawn_bot(db, user_id, &bot.id, name, role, &bot.model).await {
                Ok(child) => {
                    let task = if child.role.trim().is_empty() {
                        "My specific task is not set yet — tell me what to focus on.".to_string()
                    } else {
                        format!("My task: {}.", child.role.trim())
                    };
                    let greeting = format!(
                        "Hi, I'm {name}! I report to {manager}. {task} What should I do first?",
                        name = child.name,
                        manager = bot.name,
                    );
                    let _ = store::insert_message(db, &child.id, "assistant", &greeting).await;
                    format!("Spawned {} under {}. {}", child.name, bot.name, task)
                }
                Err(e) => format!("Could not spawn a sub-bot: {e}"),
            }
        }
    } else if message.starts_with("/help") {
        "Commands:\n/remind daily HH:MM text — daily reminder (HH:MM Jakarta time)\n/remind weekdays|weekends|mon,wed HH:MM text\n/remind every N text — every N minutes (N ≥ 5)\n/remind once HH:MM text — one-time\n/schedules — list this bot's schedules\n/unschedule <id> — delete a schedule\n/archive — archive this bot\n/spawn <name> - <task> — grow a sub-bot under this one".to_string()
    } else {
        "Unknown command. Try /help.".to_string()
    };
    util::json(
        200,
        &serde_json::json!({
            "slavebot_id": bot.id,
            "reply": reply,
            "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
            "cost_usd": 0.0,
            "credit_usd": credit,
        }),
    )
}

/// GET /api/usage?limit=50 — token/cost ledger for the Logs view.
pub async fn usage(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Unauthorized."),
    };
    let db = ctx.env.d1("DB")?;
    let user = store::get_user(&db, &user_id).await?;
    let credit = user.map(|u| u.credit_usd).unwrap_or(0.0);
    let (logs, spent) = store::list_usage(&db, &user_id, 100).await?;
    util::json(
        200,
        &serde_json::json!({ "credit_usd": credit, "spent_usd": spent, "logs": logs }),
    )
}

pub struct Completion {
    pub text: String,
    pub prompt_tokens: u64,
    pub cached_tokens: u64,
    pub completion_tokens: u64,
    pub estimated: bool,
}

/// Shared helper used by the MCP `chat` tool (and reuse-safe elsewhere):
/// non-streaming completion with usage attached. `prov` is the resolved
/// provider (personal settings or shared server key).
pub async fn complete_with_usage(
    prov: &provider::Provider,
    model: &str,
    messages: &[ChatMessage],
) -> Result<Completion, String> {
    let mut upstream =
        provider::post_chat_completions(prov, model, messages, false)
            .await
            .map_err(|e| format!("fetch failed: {e}"))?;
    if upstream.status_code() != 200 {
        let status = upstream.status_code();
        let text = upstream.text().await.unwrap_or_default();
        return Err(describe_upstream_error(status, &text));
    }
    let data: serde_json::Value = upstream
        .json()
        .await
        .map_err(|e| format!("bad json: {e}"))?;
    let text = data
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "no content in response".to_string())?;
    let usage = data.get("usage");
    let prompt = usage
        .and_then(|u| u.get("prompt_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or_else(|| {
            messages.iter().map(|m| m.role.len() + m.content.len()).sum::<usize>() as u64 / 4
        });
    let cached = usage
        .and_then(|u| u.get("prompt_tokens_details"))
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let completion = usage
        .and_then(|u| u.get("completion_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or_else(|| pricing::estimate_tokens(&text));
    Ok(Completion {
        text,
        prompt_tokens: prompt,
        cached_tokens: cached,
        completion_tokens: completion,
        estimated: usage.is_none(),
    })
}

/// Pull a human-readable message out of an upstream error body, e.g.
/// `{"error":{"message":"Unauthorized"}}` -> "Unauthorized".
fn upstream_message(text: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    v.pointer("/error/message")
        .and_then(|m| m.as_str())
        .or_else(|| v.get("message").and_then(|m| m.as_str()))
        .map(|s| s.to_string())
}

pub(crate) fn describe_upstream_error(status: u16, text: &str) -> String {
    let hint = match status {
        401 => " Check that the team API key is valid (Teams settings).",
        404 => " The model or endpoint may not exist.",
        429 => " Rate limited — wait a bit and retry.",
        500..=599 => " The provider had an internal error — retry later.",
        _ => "",
    };
    match upstream_message(text) {
        Some(m) => format!("Model API error ({status}): {m}.{hint}"),
        None => format!("Model API error ({status}).{hint}"),
    }
}

#[cfg(test)]
mod tests {
    use super::parse_consults;

    #[test]
    fn parses_single_consult() {
        let out = parse_consults(r#"[{"bot_id": "abc", "message": "review this PR"}]"#);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].bot_id, "abc");
        assert_eq!(out[0].message, "review this PR");
    }

    #[test]
    fn ignores_prose_and_caps_at_two() {
        let out = parse_consults(
            r#"Sure, I'll ask around. {"bot_id": "a", "message": "one"} then {"bot_id": "b", "message": "two"} and {"bot_id": "c", "message": "three"}"#,
        );
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].bot_id, "a");
        assert_eq!(out[1].bot_id, "b");
    }

    #[test]
    fn empty_when_no_valid_objects() {
        assert!(parse_consults("[]").is_empty());
        assert!(parse_consults("no json here").is_empty());
        assert!(parse_consults(r#"{"bot_id": "", "message": "x"}"#).is_empty());
        assert!(parse_consults(r#"{"bot_id": "a"}"#).is_empty());
    }
}
