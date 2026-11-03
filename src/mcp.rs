use serde_json::{json, Value};
use worker::*;

use crate::{auth, chat, meta, store, util};

/// GET /mcp — human-readable pointer (real MCP clients use POST /mcp).
pub fn info() -> Result<Response> {
    util::json(
        200,
        &json!({
            "name": "slaver-mcp",
            "transport": "streamable-http",
            "endpoint": "/mcp",
            "methods": ["initialize", "tools/list", "tools/call"],
            "tools": ["chat", "models", "bot_archive", "schedule_create", "schedule_list", "schedule_delete"],
        }),
    )
}

fn rpc_ok(id: Value, result: Value) -> Result<Response> {
    util::json(200, &json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn rpc_err(id: Value, code: i32, message: &str) -> Result<Response> {
    util::json(
        200,
        &json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
    )
}

fn chat_tool_def() -> Value {
    json!({
        "name": "chat",
        "description": "Chat completion via Meta Model API (Muse Spark/Wonder). Returns assistant text.",
        "inputSchema": {
            "type": "object",
            "required": ["messages"],
            "properties": {
                "messages": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["role", "content"],
                        "properties": {
                            "role": { "type": "string", "enum": ["system", "user", "assistant"] },
                            "content": { "type": "string" }
                        }
                    }
                },
                "model": { "type": "string" }
            }
        }
    })
}

fn models_tool_def() -> Value {
    json!({
        "name": "models",
        "description": "List available Meta models.",
        "inputSchema": { "type": "object", "properties": {} }
    })
}

fn bot_archive_tool_def() -> Value {
    json!({
        "name": "bot_archive",
        "description": "Archive (deactivate) or restore a slaveBot. Archived bots are hidden from lists, groups, and crons.",
        "inputSchema": {
            "type": "object",
            "required": ["slavebot_id", "archived"],
            "properties": {
                "slavebot_id": { "type": "string" },
                "archived": { "type": "boolean" }
            }
        }
    })
}

fn schedule_create_tool_def() -> Value {
    json!({
        "name": "schedule_create",
        "description": "Create a bot-managed schedule: the bot runs `prompt` by itself on a timer (daily HH:MM Jakarta time, or every N minutes). Times are Asia/Jakarta wall-clock.",
        "inputSchema": {
            "type": "object",
            "required": ["slavebot_id", "prompt"],
            "properties": {
                "slavebot_id": { "type": "string" },
                "prompt": { "type": "string" },
                "name": { "type": "string" },
                "kind": { "type": "string", "enum": ["once", "daily", "interval"] },
                "time_hhmm": { "type": "string", "description": "HH:MM 24-hour, for once/daily. Default 07:00." },
                "days": { "type": "string", "description": "all, weekdays, weekends, or comma list like mon,wed,fri. Default all." },
                "interval_minutes": { "type": "integer", "description": "For kind=interval, minutes between runs (>= 5). Default 60." }
            }
        }
    })
}

fn schedule_list_tool_def() -> Value {
    json!({
        "name": "schedule_list",
        "description": "List a slaveBot's schedules.",
        "inputSchema": {
            "type": "object",
            "required": ["slavebot_id"],
            "properties": { "slavebot_id": { "type": "string" } }
        }
    })
}

fn schedule_delete_tool_def() -> Value {
    json!({
        "name": "schedule_delete",
        "description": "Delete a schedule by id.",
        "inputSchema": {
            "type": "object",
            "required": ["schedule_id"],
            "properties": { "schedule_id": { "type": "string" } }
        }
    })
}

/// POST /mcp — JSON-RPC 2.0 over Streamable HTTP (plain JSON responses).
pub async fn rpc(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let body: Value = match req.json().await {
        Ok(b) => b,
        Err(_) => return rpc_err(Value::Null, -32700, "Parse error: body must be JSON."),
    };
    let id = body.get("id").cloned().unwrap_or(Value::Null);
    let method = body.get("method").and_then(|m| m.as_str()).unwrap_or("");

    match method {
        "initialize" => rpc_ok(
            id,
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "slaver", "version": "0.1.0" },
            }),
        ),
        "notifications/initialized" | "notifications/cancelled" => {
            Ok(Response::empty()?.with_status(202))
        }
        "ping" => rpc_ok(id, json!({})),
        "tools/list" => rpc_ok(id, json!({ "tools": [chat_tool_def(), models_tool_def(), bot_archive_tool_def(), schedule_create_tool_def(), schedule_list_tool_def(), schedule_delete_tool_def()] })),
        "tools/call" => {
            let user_id = match auth::bearer_sub(&req, &ctx.env)? {
                Some(uid) => uid,
                None => return rpc_err(id, -32000, "Unauthorized: send an Authorization: Bearer <jwt> header from /api/auth/login."),
            };
            let params = body.get("params").cloned().unwrap_or(Value::Null);
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(Value::Null);
            match name {
                "models" => rpc_ok(id, json!({ "content": [{ "type": "text", "text": meta::model_list(&ctx.env).to_string() }] })),
                "chat" => call_chat(id, &ctx.env, &user_id, &args).await,
                "bot_archive" => call_bot_archive(id, &ctx.env, &user_id, &args).await,
                "schedule_create" => call_schedule_create(id, &ctx.env, &user_id, &args).await,
                "schedule_list" => call_schedule_list(id, &ctx.env, &user_id, &args).await,
                "schedule_delete" => call_schedule_delete(id, &ctx.env, &user_id, &args).await,
                _ => rpc_err(id, -32602, "Unknown tool. Available: chat, models, bot_archive, schedule_create, schedule_list, schedule_delete."),
            }
        }
        "" => rpc_err(id, -32600, "Invalid Request: missing method field."),
        _ => rpc_err(id, -32601, "Unknown method."),
    }
}

fn mcp_text(id: Value, text: String) -> Result<Response> {
    rpc_ok(id, json!({ "content": [{ "type": "text", "text": text }] }))
}

async fn call_bot_archive(id: Value, env: &Env, user_id: &str, args: &Value) -> Result<Response> {
    let bot_id = args.get("slavebot_id").and_then(|v| v.as_str()).unwrap_or("");
    let archived = args.get("archived").and_then(|v| v.as_bool()).unwrap_or(true);
    if bot_id.is_empty() {
        return rpc_err(id, -32602, "The slavebot_id argument is required.");
    }
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(e) => return rpc_err(id, -32000, &format!("Database unavailable: {e}")),
    };
    match store::set_archived(&db, user_id, bot_id, archived).await {
        Ok(Some(bot)) => mcp_text(id, format!("{} is now {}.", bot.name, if archived { "archived" } else { "active" })),
        Ok(None) => rpc_err(id, -32602, "SlaveBot not found."),
        Err(e) => rpc_err(id, -32000, &format!("Archive failed: {e}")),
    }
}

async fn call_schedule_create(id: Value, env: &Env, user_id: &str, args: &Value) -> Result<Response> {
    let bot_id = args.get("slavebot_id").and_then(|v| v.as_str()).unwrap_or("");
    let prompt = args.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
    if bot_id.is_empty() || prompt.is_empty() {
        return rpc_err(id, -32602, "The slavebot_id and prompt arguments are required.");
    }
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(e) => return rpc_err(id, -32000, &format!("Database unavailable: {e}")),
    };
    if store::get_bot(&db, user_id, bot_id).await.map(|b| b.is_none()).unwrap_or(true) {
        return rpc_err(id, -32602, "SlaveBot not found.");
    }
    let kind = args.get("kind").and_then(|v| v.as_str()).unwrap_or("daily");
    let time_hhmm = args.get("time_hhmm").and_then(|v| v.as_str()).unwrap_or("07:00");
    let days = args.get("days").and_then(|v| v.as_str()).unwrap_or("all");
    let interval = args.get("interval_minutes").and_then(|v| v.as_i64()).unwrap_or(60);
    let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("MCP schedule");
    match store::create_schedule(&db, user_id, bot_id, name, kind, time_hhmm, days, interval, prompt).await {
        Ok(s) => mcp_text(id, format!("Schedule {} created, next run {}.", s.id, s.next_run_at)),
        Err(e) => rpc_err(id, -32602, &format!("Invalid schedule: {e}")),
    }
}

async fn call_schedule_list(id: Value, env: &Env, user_id: &str, args: &Value) -> Result<Response> {
    let bot_id = args.get("slavebot_id").and_then(|v| v.as_str()).unwrap_or("");
    if bot_id.is_empty() {
        return rpc_err(id, -32602, "The slavebot_id argument is required.");
    }
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(e) => return rpc_err(id, -32000, &format!("Database unavailable: {e}")),
    };
    match store::list_schedules(&db, user_id, Some(bot_id)).await {
        Ok(list) => mcp_text(id, serde_json::to_string(&list).unwrap_or_else(|_| "[]".to_string())),
        Err(e) => rpc_err(id, -32000, &format!("List failed: {e}")),
    }
}

async fn call_schedule_delete(id: Value, env: &Env, user_id: &str, args: &Value) -> Result<Response> {
    let sid = args.get("schedule_id").and_then(|v| v.as_str()).unwrap_or("");
    if sid.is_empty() {
        return rpc_err(id, -32602, "The schedule_id argument is required.");
    }
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(e) => return rpc_err(id, -32000, &format!("Database unavailable: {e}")),
    };
    match store::delete_schedule(&db, user_id, sid).await {
        Ok(true) => mcp_text(id, "Schedule deleted.".to_string()),
        Ok(false) => rpc_err(id, -32602, "Schedule not found."),
        Err(e) => rpc_err(id, -32000, &format!("Delete failed: {e}")),
    }
}

async fn call_chat(id: Value, env: &Env, user_id: &str, args: &Value) -> Result<Response> {
    let model = args
        .get("model")
        .and_then(|m| m.as_str())
        .filter(|m| !m.trim().is_empty())
        .unwrap_or("muse-spark-1.3")
        .to_string();
    let messages: Vec<chat::ChatMessage> = match args.get("messages") {
        Some(v) => match serde_json::from_value(v.clone()) {
            Ok(m) => m,
            Err(_) => return rpc_err(id, -32602, "Invalid messages argument."),
        },
        None => return rpc_err(id, -32602, "The messages argument is required."),
    };
    if messages.is_empty() || messages.len() > 30 {
        return rpc_err(id, -32602, "messages must have 1..30 items.");
    }
    let db = env.d1("DB")?;
    let credit = crate::store::get_user(&db, user_id)
        .await
        .map(|u| u.map(|u| u.credit_usd).unwrap_or(0.0))
        .unwrap_or(0.0);
    if credit <= 0.0 {
        return rpc_err(id, -32000, "Out of credit (balance $0.00). Demo credit is $10 per user.");
    }
    match chat::complete_with_usage(env, &model, &messages).await {
        Ok(done) => {
            let (cost, _) = crate::store::record_usage(
                &db,
                user_id,
                None,
                &crate::store::UsageInput {
                    model: model.clone(),
                    prompt_tokens: done.prompt_tokens,
                    cached_tokens: done.cached_tokens,
                    completion_tokens: done.completion_tokens,
                    estimated: done.estimated,
                    audio_seconds: 0.0,
                    cost_override: None,
                },
            )
            .await
            .unwrap_or((0.0, credit));
            rpc_ok(
                id,
                json!({ "content": [
                    { "type": "text", "text": done.text },
                    { "type": "text", "text": format!("(tokens: {} in / {} out · cost ${:.6} · demo credit)", done.prompt_tokens, done.completion_tokens, cost) },
                ] }),
            )
        }
        Err(e) => rpc_err(id, -32000, &format!("Meta API error: {e}")),
    }
}
