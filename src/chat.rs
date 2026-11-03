use serde::{Deserialize, Serialize};
use worker::*;

use crate::{auth, meta, pricing, store, util};

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
}

#[derive(Deserialize)]
struct UpdateBotRequest {
    name: Option<String>,
    memory: Option<String>,
    model: Option<String>,
}

pub fn valid_model(model: &str) -> bool {
    model == "muse-spark-1.3" || model == "muse-wonder-1.0"
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
    if credit <= 0.0 {
        return util::err(402, "Out of credit (balance $0.00). Demo credit is $10 per user.");
    }

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
    let model = body
        .model
        .filter(|m| valid_model(m))
        .unwrap_or(bot.model.clone());
    let stream = body.stream.unwrap_or(true);

    store::insert_message(&db, &bot_id, "user", &message).await?;
    store::maybe_title_bot(&db, &bot_id, &message).await?;
    let recaps = crate::summarize::context_block(&db, &bot_id)
        .await
        .unwrap_or_default();
    let history = with_memory(&bot.memory, &recaps, store::recent_messages(&db, &bot_id, 20).await?);

    let mut upstream =
        match meta::post_chat_completions(&ctx.env, &model, &history, stream).await {
            Ok(r) => r,
            Err(e) => {
                console_error!("chat upstream fetch failed: {e}");
                return util::err(502, "Could not reach the Meta Model API.");
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
            &store::UsageInput { model: model.clone(), prompt_tokens: prompt, cached_tokens: cached, completion_tokens: completion, estimated, audio_seconds: 0.0, cost_override: None },
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
    let (cost, remaining) = store::record_usage(
        &db,
        &user_id,
        Some(&bot_id),
        &store::UsageInput { model: bot.model.clone(), prompt_tokens: prompt, cached_tokens: 0, completion_tokens: completion, estimated, audio_seconds: 0.0, cost_override: None },
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
    let bots = store::list_bots(&db, &user_id).await?;
    util::json(200, &serde_json::json!({ "slavebots": bots }))
}

/// POST /api/slavebots — create a new bot. Body: {model?}.
pub async fn create_bot(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Unauthorized."),
    };
    let body: CreateBotRequest = match req.json().await {
        Ok(b) => b,
        Err(_) => CreateBotRequest { model: None },
    };
    let model = body
        .model
        .filter(|m| valid_model(m))
        .unwrap_or_else(|| meta::default_model(&ctx.env));
    let db = ctx.env.d1("DB")?;
    let bot = store::create_bot(&db, &user_id, &model).await?;
    util::json(201, &serde_json::json!({ "slavebot": bot }))
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

/// PUT /api/slavebots/:id — rename, set memory, or change model. Body: {name?, memory?, model?}.
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
    match store::update_bot(
        &db,
        &user_id,
        &bot_id,
        body.name.as_deref(),
        body.memory.as_deref(),
        body.model.as_deref(),
    )
    .await?
    {
        Some(bot) => util::json(200, &serde_json::json!({ "slavebot": bot })),
        None => util::err(404, "SlaveBot not found."),
    }
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
/// non-streaming completion with usage attached.
pub async fn complete_with_usage(
    env: &Env,
    model: &str,
    messages: &[ChatMessage],
) -> Result<Completion, String> {
    let mut upstream =
        meta::post_chat_completions(env, model, messages, false)
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
        401 => " Check that META_API_KEY is valid.",
        404 => " The model or endpoint may not exist.",
        429 => " Rate limited — wait a bit and retry.",
        500..=599 => " The provider had an internal error — retry later.",
        _ => "",
    };
    match upstream_message(text) {
        Some(m) => format!("Meta Model API error ({status}): {m}.{hint}"),
        None => format!("Meta Model API error ({status}).{hint}"),
    }
}
