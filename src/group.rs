use serde::Deserialize;
use worker::*;

use crate::{auth, chat, store, util};

/// Group missions: one task fans out to many slaveBots, and info can be
/// broadcast into the shared thread and saved into bot memories.

#[derive(Deserialize)]
struct GroupNameBody {
    name: Option<String>,
}

#[derive(Deserialize)]
struct MemberBody {
    slavebot_id: Option<String>,
}

#[derive(Deserialize)]
struct GroupChatBody {
    message: Option<String>,
    model: Option<String>,
}

#[derive(Deserialize)]
struct BroadcastBody {
    text: Option<String>,
    save_to_memory: Option<bool>,
}

#[derive(Deserialize)]
struct MemoryBody {
    text: Option<String>,
}

fn authed(req: &Request, env: &Env) -> Result<Option<(String, D1Database)>> {
    let user_id = match auth::bearer_sub(req, env)? {
        Some(id) => id,
        None => return Ok(None),
    };
    Ok(Some((user_id, env.d1("DB")?)))
}

macro_rules! need_auth {
    ($req:expr, $env:expr) => {
        match authed($req, $env)? {
            Some(v) => v,
            None => return util::err(401, "Unauthorized."),
        }
    };
}

/// GET /api/groups
pub async fn list(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let (user_id, db) = need_auth!(&req, &ctx.env);
    let groups = store::list_groups(&db, &user_id).await?;
    util::json(200, &serde_json::json!({ "groups": groups }))
}

/// POST /api/groups {name?}
pub async fn create(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let (user_id, db) = need_auth!(&req, &ctx.env);
    let body: GroupNameBody = match req.json().await {
        Ok(b) => b,
        Err(_) => GroupNameBody { name: None },
    };
    let group = store::create_group(&db, &user_id, body.name.as_deref().unwrap_or("")).await?;
    util::json(201, &serde_json::json!({ "group": group }))
}

/// GET /api/groups/:id — group with members and recent messages.
pub async fn detail(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let (user_id, db) = need_auth!(&req, &ctx.env);
    let group_id = ctx.param("id").cloned().unwrap_or_default();
    let group = match store::get_group(&db, &user_id, &group_id).await? {
        Some(g) => g,
        None => return util::err(404, "Group not found."),
    };
    let members = store::group_members(&db, &user_id, &group_id).await?;
    let messages = store::group_history(&db, &group_id, 100).await?;
    util::json(200, &serde_json::json!({ "group": group, "members": members, "messages": messages }))
}

/// PUT /api/groups/:id {name?}
pub async fn rename(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let (user_id, db) = need_auth!(&req, &ctx.env);
    let body: GroupNameBody = match req.json().await {
        Ok(b) => b,
        Err(_) => return util::err(400, "Invalid JSON body."),
    };
    let group_id = ctx.param("id").cloned().unwrap_or_default();
    match store::rename_group(&db, &user_id, &group_id, body.name.as_deref().unwrap_or("")).await? {
        Some(g) => util::json(200, &serde_json::json!({ "group": g })),
        None => util::err(404, "Group not found."),
    }
}

/// DELETE /api/groups/:id
pub async fn delete(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let (user_id, db) = need_auth!(&req, &ctx.env);
    let group_id = ctx.param("id").cloned().unwrap_or_default();
    if store::delete_group(&db, &user_id, &group_id).await? {
        util::json(200, &serde_json::json!({ "deleted": true }))
    } else {
        util::err(404, "Group not found.")
    }
}

/// POST /api/groups/:id/members {slavebot_id}
pub async fn add_member(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let (user_id, db) = need_auth!(&req, &ctx.env);
    let body: MemberBody = match req.json().await {
        Ok(b) => b,
        Err(_) => return util::err(400, "Invalid JSON body."),
    };
    let group_id = ctx.param("id").cloned().unwrap_or_default();
    let bot_id = body.slavebot_id.unwrap_or_default();
    match store::add_group_member(&db, &user_id, &group_id, &bot_id).await {
        Ok(Some(bot)) => util::json(200, &serde_json::json!({ "member": bot })),
        Ok(None) => util::err(404, "Group or slaveBot not found."),
        Err(e) => util::err(400, &e.to_string()),
    }
}

/// DELETE /api/groups/:id/members/:botId
pub async fn remove_member(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let (user_id, db) = need_auth!(&req, &ctx.env);
    let group_id = ctx.param("id").cloned().unwrap_or_default();
    let bot_id = ctx.param("botId").cloned().unwrap_or_default();
    if store::remove_group_member(&db, &user_id, &group_id, &bot_id).await? {
        util::json(200, &serde_json::json!({ "removed": true }))
    } else {
        util::err(404, "Group not found.")
    }
}

/// POST /api/groups/:id/chat — fan one task out to every member bot.
/// Body: {message, model?}. Each bot replies with its own memory + recaps +
/// the shared thread as context. Replies are saved and billed per bot.
pub async fn chat(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let (user_id, db) = need_auth!(&req, &ctx.env);
    let credit = store::get_user(&db, &user_id)
        .await?
        .map(|u| u.credit_usd)
        .unwrap_or(0.0);
    if credit <= 0.0 {
        return util::err(402, "Out of credit (balance $0.00). Demo credit is $10 per user.");
    }
    let body: GroupChatBody = match req.json().await {
        Ok(b) => b,
        Err(_) => return util::err(400, "Invalid JSON body."),
    };
    let message = body.message.unwrap_or_default();
    if message.is_empty() || message.len() > 8000 {
        return util::err(400, "message must be 1..8000 characters.");
    }
    let group_id = ctx.param("id").cloned().unwrap_or_default();
    if store::get_group(&db, &user_id, &group_id).await?.is_none() {
        return util::err(404, "Group not found.");
    }
    let members = store::group_members(&db, &user_id, &group_id).await?;
    if members.is_empty() {
        return util::err(400, "Add slaveBots to the group first.");
    }

    store::insert_group_message(&db, &group_id, None, "user", &message).await?;
    let thread = store::group_history(&db, &group_id, 20).await?;

    let mut replies = Vec::new();
    let mut total_cost = 0.0;
    let mut remaining = credit;
    for bot in &members {
        let model = body
            .model
            .clone()
            .filter(|m| chat::valid_model(m))
            .unwrap_or_else(|| bot.model.clone());
        let mut history = vec![
            chat::ChatMessage {
                role: "user".to_string(),
                content: format!(
                    "You are {name}, one of several slaveBots discussing a shared task. Reply as yourself.",
                    name = bot.name
                ),
            },
            // Shared thread: other bots' turns are labeled so this bot can respond to them.
        ];
        for row in &thread {
            let content = match (&row.slavebot_id, &row.bot_name) {
                (Some(id), Some(name)) if id != &bot.id => format!("[{name}]: {}", row.content),
                (Some(id), _) if id != &bot.id => format!("[teammate]: {}", row.content),
                _ => row.content.clone(),
            };
            let role = if row.role == "assistant" { "assistant" } else { "user" };
            history.push(chat::ChatMessage { role: role.to_string(), content });
        }
        let recaps = crate::summarize::context_block(&db, &bot.id)
            .await
            .unwrap_or_default();
        let memory_block = bot.memory.trim();
        let mut with_context = Vec::with_capacity(history.len() + 2);
        if !memory_block.is_empty() {
            with_context.push(chat::ChatMessage {
                role: "system".to_string(),
                content: format!("Bot memory set by the owner (treat as persistent facts):\n{memory_block}"),
            });
        }
        if !recaps.trim().is_empty() {
            with_context.push(chat::ChatMessage {
                role: "system".to_string(),
                content: recaps,
            });
        }
        with_context.extend(history);

        let done = match chat::complete_with_usage(&ctx.env, &model, &with_context).await {
            Ok(d) => d,
            Err(e) => {
                console_error!("group chat bot {} failed: {e}", bot.id);
                replies.push(serde_json::json!({
                    "slavebot_id": bot.id, "name": bot.name,
                    "error": chat::describe_upstream_error(502, &e),
                }));
                continue;
            }
        };
        store::insert_group_message(&db, &group_id, Some(&bot.id), "assistant", &done.text).await?;
        let (cost, credit_left) = store::record_usage(
            &db,
            &user_id,
            Some(&bot.id),
            &store::UsageInput {
                model: model.clone(),
                prompt_tokens: done.prompt_tokens,
                cached_tokens: done.cached_tokens,
                completion_tokens: done.completion_tokens,
                estimated: done.estimated,
                audio_seconds: 0.0,
                cost_override: None,
            },
        )
        .await?;
        total_cost += cost;
        remaining = credit_left;
        replies.push(serde_json::json!({
            "slavebot_id": bot.id, "name": bot.name, "reply": done.text,
            "usage": { "prompt_tokens": done.prompt_tokens, "completion_tokens": done.completion_tokens, "estimated": done.estimated },
            "cost_usd": cost,
        }));
    }
    store::touch_group(&db, &group_id).await?;
    util::json(
        200,
        &serde_json::json!({ "replies": replies, "total_cost_usd": total_cost, "credit_usd": remaining }),
    )
}

/// POST /api/groups/:id/broadcast — post one info message to the shared thread,
/// optionally appending it to every member's memory. Body: {text, save_to_memory?}.
pub async fn broadcast(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let (user_id, db) = need_auth!(&req, &ctx.env);
    let body: BroadcastBody = match req.json().await {
        Ok(b) => b,
        Err(_) => return util::err(400, "Invalid JSON body."),
    };
    let text = body.text.unwrap_or_default();
    if text.is_empty() || text.len() > 2000 {
        return util::err(400, "text must be 1..2000 characters.");
    }
    let group_id = ctx.param("id").cloned().unwrap_or_default();
    if store::get_group(&db, &user_id, &group_id).await?.is_none() {
        return util::err(404, "Group not found.");
    }
    store::insert_group_message(&db, &group_id, None, "user", &text).await?;
    let mut saved_to = Vec::new();
    if body.save_to_memory.unwrap_or(false) {
        for member in store::group_members(&db, &user_id, &group_id).await? {
            if store::append_memory(&db, &user_id, &member.id, &text).await?.is_some() {
                saved_to.push(member.name);
            }
        }
    }
    store::touch_group(&db, &group_id).await?;
    util::json(200, &serde_json::json!({ "posted": true, "saved_to_memory": saved_to }))
}

/// POST /api/slavebots/:id/memory — append one fact to a bot's memory. Body: {text}.
pub async fn append_memory(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let (user_id, db) = need_auth!(&req, &ctx.env);
    let body: MemoryBody = match req.json().await {
        Ok(b) => b,
        Err(_) => return util::err(400, "Invalid JSON body."),
    };
    let bot_id = ctx.param("id").cloned().unwrap_or_default();
    let text = body.text.unwrap_or_default();
    match store::append_memory(&db, &user_id, &bot_id, &text).await {
        Ok(Some(memory)) => util::json(200, &serde_json::json!({ "memory": memory })),
        Ok(None) => util::err(404, "SlaveBot not found."),
        Err(e) => util::err(400, &e.to_string()),
    }
}
