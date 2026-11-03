use serde_json::{json, Value};
use worker::*;

use crate::{auth, chat, provider, store, util};

/// GET /mcp — human-readable pointer (real MCP clients use POST /mcp).
pub fn info() -> Result<Response> {
    util::json(
        200,
        &json!({
            "name": "slaver-mcp",
            "transport": "streamable-http",
            "endpoint": "/mcp",
            "methods": ["initialize", "tools/list", "tools/call"],
            "tools": ["chat", "models", "bot_archive", "bot_pin", "bot_set_role", "bot_spawn", "team_create", "team_list", "team_invite", "schedule_create", "schedule_list", "schedule_delete", "huddle_start", "huddle_list", "huddle_chat"],
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
        "description": "Chat completion via OpenRouter (many models). Returns assistant text.",
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

fn bot_pin_tool_def() -> Value {
    json!({
        "name": "bot_pin",
        "description": "Pin a slaveBot so it auto-opens on visit (only one pin per user; pinning unpins the previous one), or unpin it.",
        "inputSchema": {
            "type": "object",
            "required": ["slavebot_id", "pinned"],
            "properties": {
                "slavebot_id": { "type": "string" },
                "pinned": { "type": "boolean" }
            }
        }
    })
}

fn bot_set_role_tool_def() -> Value {
    json!({
        "name": "bot_set_role",
        "description": "Set a slaveBot's personal identity/role (e.g. sales manager). The role guides huddle join decisions and is shown in the Bot tab.",
        "inputSchema": {
            "type": "object",
            "required": ["slavebot_id", "role"],
            "properties": {
                "slavebot_id": { "type": "string" },
                "role": { "type": "string" }
            }
        }
    })
}

fn bot_spawn_tool_def() -> Value {
    json!({
        "name": "bot_spawn",
        "description": "Grow a sub-bot under a manager bot for one specific task. The child inherits the manager's model unless overridden.",
        "inputSchema": {
            "type": "object",
            "required": ["manager_id"],
            "properties": {
                "manager_id": { "type": "string" },
                "name": { "type": "string" },
                "role": { "type": "string" },
                "model": { "type": "string" }
            }
        }
    })
}

fn huddle_start_tool_def() -> Value {
    json!({
        "name": "huddle_start",
        "description": "Start a Slack-style huddle: notify bots about a topic; each bot decides by itself (from its role) whether to join. Notifies up to 8 active team bots, or the given slavebot_ids. team_id defaults to the personal team.",
        "inputSchema": {
            "type": "object",
            "required": ["topic"],
            "properties": {
                "topic": { "type": "string" },
                "slavebot_ids": { "type": "array", "items": { "type": "string" } }
            }
        }
    })
}

fn team_create_tool_def() -> Value {
    json!({
        "name": "team_create",
        "description": "Create a team for shared slaveBots. The creator becomes owner.",
        "inputSchema": {
            "type": "object",
            "properties": { "name": { "type": "string" } }
        }
    })
}

fn team_list_tool_def() -> Value {
    json!({
        "name": "team_list",
        "description": "List my teams with my role on each.",
        "inputSchema": { "type": "object", "properties": {} }
    })
}

fn team_invite_tool_def() -> Value {
    json!({
        "name": "team_invite",
        "description": "Invite a registered user to a team by email as admin or staff (owner-only for admin). Staff only see bots explicitly granted to them.",
        "inputSchema": {
            "type": "object",
            "required": ["team_id", "email"],
            "properties": {
                "team_id": { "type": "string" },
                "email": { "type": "string" },
                "role": { "type": "string", "enum": ["admin", "staff"] }
            }
        }
    })
}

fn huddle_list_tool_def() -> Value {
    json!({
        "name": "huddle_list",
        "description": "List huddles with their join/decline participants.",
        "inputSchema": { "type": "object", "properties": {} }
    })
}

fn huddle_chat_tool_def() -> Value {
    json!({
        "name": "huddle_chat",
        "description": "Send a message into a huddle; every bot that joined replies. Replies are saved and billed per bot.",
        "inputSchema": {
            "type": "object",
            "required": ["huddle_id", "message"],
            "properties": {
                "huddle_id": { "type": "string" },
                "message": { "type": "string" }
            }
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
        "tools/list" => rpc_ok(id, json!({ "tools": [chat_tool_def(), models_tool_def(), bot_archive_tool_def(), bot_pin_tool_def(), bot_set_role_tool_def(), bot_spawn_tool_def(), team_create_tool_def(), team_list_tool_def(), team_invite_tool_def(), schedule_create_tool_def(), schedule_list_tool_def(), schedule_delete_tool_def(), huddle_start_tool_def(), huddle_list_tool_def(), huddle_chat_tool_def()] })),
        "tools/call" => {
            let user_id = match auth::bearer_sub(&req, &ctx.env)? {
                Some(uid) => uid,
                None => return rpc_err(id, -32000, "Unauthorized: send an Authorization: Bearer <jwt> header from /api/auth/login."),
            };
            let params = body.get("params").cloned().unwrap_or(Value::Null);
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(Value::Null);
            match name {
                "models" => {
                    let db = match ctx.env.d1("DB") {
                        Ok(db) => db,
                        Err(e) => return rpc_err(id, -32000, &format!("Database unavailable: {e}")),
                    };
                    let team = store::ensure_personal_team(&db, &user_id).await.ok();
                    let preset = match team {
                        Some(t) => provider::preset_for_team(&db, &t.id).await,
                        None => "meta".to_string(),
                    };
                    rpc_ok(id, json!({ "content": [{ "type": "text", "text": provider::model_list(&preset).to_string() }] }))
                }
                "chat" => call_chat(id, &ctx.env, &user_id, &args).await,
                "bot_archive" => call_bot_archive(id, &ctx.env, &user_id, &args).await,
                "bot_pin" => call_bot_pin(id, &ctx.env, &user_id, &args).await,
                "bot_set_role" => call_bot_set_role(id, &ctx.env, &user_id, &args).await,
                "bot_spawn" => call_bot_spawn(id, &ctx.env, &user_id, &args).await,
                "schedule_create" => call_schedule_create(id, &ctx.env, &user_id, &args).await,
                "schedule_list" => call_schedule_list(id, &ctx.env, &user_id, &args).await,
                "schedule_delete" => call_schedule_delete(id, &ctx.env, &user_id, &args).await,
                "huddle_start" => call_huddle_start(id, &ctx.env, &user_id, &args).await,
                "team_create" => call_team_create(id, &ctx.env, &user_id, &args).await,
                "team_list" => call_team_list(id, &ctx.env, &user_id, &args).await,
                "team_invite" => call_team_invite(id, &ctx.env, &user_id, &args).await,
                "huddle_list" => call_huddle_list(id, &ctx.env, &user_id, &args).await,
                "huddle_chat" => call_huddle_chat(id, &ctx.env, &user_id, &args).await,
                _ => rpc_err(id, -32602, "Unknown tool. Run tools/list for the current catalogue."),
            }
        }
        "" => rpc_err(id, -32600, "Invalid Request: missing method field."),
        _ => rpc_err(id, -32601, "Unknown method."),
    }
}

fn mcp_text(id: Value, text: String) -> Result<Response> {
    rpc_ok(id, json!({ "content": [{ "type": "text", "text": text }] }))
}

async fn call_bot_pin(id: Value, env: &Env, user_id: &str, args: &Value) -> Result<Response> {
    let bot_id = args.get("slavebot_id").and_then(|v| v.as_str()).unwrap_or("");
    let pinned = args.get("pinned").and_then(|v| v.as_bool()).unwrap_or(true);
    if bot_id.is_empty() {
        return rpc_err(id, -32602, "The slavebot_id argument is required.");
    }
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(e) => return rpc_err(id, -32000, &format!("Database unavailable: {e}")),
    };
    match store::set_pinned(&db, user_id, bot_id, pinned).await {
        Ok(Some(bot)) => mcp_text(id, format!("{} is now {}.", bot.name, if pinned { "pinned" } else { "unpinned" })),
        Ok(None) => rpc_err(id, -32602, "SlaveBot not found."),
        Err(e) => rpc_err(id, -32602, &format!("Pin failed: {e}")),
    }
}

async fn call_bot_set_role(id: Value, env: &Env, user_id: &str, args: &Value) -> Result<Response> {
    let bot_id = args.get("slavebot_id").and_then(|v| v.as_str()).unwrap_or("");
    let role = args.get("role").and_then(|v| v.as_str()).unwrap_or("");
    if bot_id.is_empty() {
        return rpc_err(id, -32602, "The slavebot_id argument is required.");
    }
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(e) => return rpc_err(id, -32000, &format!("Database unavailable: {e}")),
    };
    match store::update_bot(&db, user_id, bot_id, None, None, None, None, None, None, None, Some(role)).await {
        Ok(Some(bot)) => mcp_text(id, format!("{} is now: {}.", bot.name, if bot.role.is_empty() { "no role" } else { &bot.role })),
        Ok(None) => rpc_err(id, -32602, "SlaveBot not found."),
        Err(e) => rpc_err(id, -32000, &format!("Set role failed: {e}")),
    }
}

async fn call_bot_spawn(id: Value, env: &Env, user_id: &str, args: &Value) -> Result<Response> {
    let manager_id = args.get("manager_id").and_then(|v| v.as_str()).unwrap_or("");
    if manager_id.is_empty() {
        return rpc_err(id, -32602, "The manager_id argument is required.");
    }
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(e) => return rpc_err(id, -32000, &format!("Database unavailable: {e}")),
    };
    let manager = match store::get_bot(&db, user_id, manager_id).await {
        Ok(Some(m)) => m,
        Ok(None) => return rpc_err(id, -32602, "Manager bot not found."),
        Err(e) => return rpc_err(id, -32000, &format!("Database error: {e}")),
    };
    let preset = provider::preset_for_team(&db, &manager.team_id).await;
    let requested = args.get("model").and_then(|v| v.as_str()).unwrap_or("");
    let model = if provider::valid_for(&preset, requested) {
        requested.to_string()
    } else {
        provider::effective_model(&preset, &manager.model)
    };
    let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let role = args.get("role").and_then(|v| v.as_str()).unwrap_or("");
    match store::spawn_bot(&db, user_id, manager_id, name, role, &model).await {
        Ok(child) => mcp_text(id, format!("Spawned {} (id {}) under {}.", child.name, child.id, manager.name)),
        Err(e) => rpc_err(id, -32602, &format!("Spawn failed: {e}")),
    }
}

async fn call_team_create(id: Value, env: &Env, user_id: &str, args: &Value) -> Result<Response> {
    let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("Team");
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(e) => return rpc_err(id, -32000, &format!("Database unavailable: {e}")),
    };
    match store::create_team(&db, user_id, name, false).await {
        Ok(t) => mcp_text(id, format!("Team {} created (id {}). You are the owner.", t.name, t.id)),
        Err(e) => rpc_err(id, -32000, &format!("Create failed: {e}")),
    }
}

async fn call_team_list(id: Value, env: &Env, user_id: &str, _args: &Value) -> Result<Response> {
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(e) => return rpc_err(id, -32000, &format!("Database unavailable: {e}")),
    };
    match store::list_user_teams(&db, user_id).await {
        Ok(list) => mcp_text(id, serde_json::to_string(&list).unwrap_or_else(|_| "[]".to_string())),
        Err(e) => rpc_err(id, -32000, &format!("List failed: {e}")),
    }
}

async fn call_team_invite(id: Value, env: &Env, user_id: &str, args: &Value) -> Result<Response> {
    let team_id = args.get("team_id").and_then(|v| v.as_str()).unwrap_or("");
    let email = args.get("email").and_then(|v| v.as_str()).unwrap_or("");
    let role = args.get("role").and_then(|v| v.as_str()).unwrap_or("staff");
    if team_id.is_empty() || email.is_empty() {
        return rpc_err(id, -32602, "The team_id and email arguments are required.");
    }
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(e) => return rpc_err(id, -32000, &format!("Database unavailable: {e}")),
    };
    match store::add_member_by_email(&db, team_id, user_id, email, role).await {
        Ok(m) => mcp_text(id, format!("{} joined as {}.", m.user_id, m.role)),
        Err(e) => rpc_err(id, -32602, &e),
    }
}

async fn call_huddle_start(id: Value, env: &Env, user_id: &str, args: &Value) -> Result<Response> {
    let topic = args.get("topic").and_then(|v| v.as_str()).unwrap_or("");
    let team_id = args.get("team_id").and_then(|v| v.as_str()).unwrap_or("");
    let ids: Option<Vec<String>> = args.get("slavebot_ids").and_then(|v| {
        v.as_array().map(|a| {
            a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()
        })
    });
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(e) => return rpc_err(id, -32000, &format!("Database unavailable: {e}")),
    };
    match crate::huddle::start_huddle(env, &db, user_id, team_id, topic, ids).await {
        Ok((huddle, participants)) => mcp_text(
            id,
            format!(
                "Huddle {} started on \"{}\": {}",
                huddle.id,
                huddle.topic,
                serde_json::to_string(&participants).unwrap_or_else(|_| "[]".to_string())
            ),
        ),
        Err(e) => rpc_err(id, -32000, &e),
    }
}

async fn call_huddle_list(id: Value, env: &Env, user_id: &str, _args: &Value) -> Result<Response> {
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(e) => return rpc_err(id, -32000, &format!("Database unavailable: {e}")),
    };
    match store::list_huddles(&db, user_id).await {
        Ok(list) => mcp_text(id, serde_json::to_string(&list).unwrap_or_else(|_| "[]".to_string())),
        Err(e) => rpc_err(id, -32000, &format!("List failed: {e}")),
    }
}

async fn call_huddle_chat(id: Value, env: &Env, user_id: &str, args: &Value) -> Result<Response> {
    let huddle_id = args.get("huddle_id").and_then(|v| v.as_str()).unwrap_or("");
    let message = args.get("message").and_then(|v| v.as_str()).unwrap_or("");
    if huddle_id.is_empty() || message.is_empty() {
        return rpc_err(id, -32602, "The huddle_id and message arguments are required.");
    }
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(e) => return rpc_err(id, -32000, &format!("Database unavailable: {e}")),
    };
    match crate::huddle::post_message(env, &db, user_id, huddle_id, message, None).await {
        Ok(r) => mcp_text(
            id,
            format!(
                "{} replie(s), total ${:.6}, credit ${:.4}: {}",
                r.replies.len(),
                r.total_cost,
                r.credit,
                serde_json::to_string(&r.replies).unwrap_or_else(|_| "[]".to_string())
            ),
        ),
        Err(e) => rpc_err(id, -32000, &e),
    }
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
    let requested = args.get("model").and_then(|m| m.as_str()).unwrap_or("");
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
    let team_id = store::ensure_personal_team(&db, user_id)
        .await
        .map(|t| t.id)
        .unwrap_or_default();
    let prov = match provider::provider_for(&db, &team_id).await {
        Ok(v) => v,
        Err(e) => return rpc_err(id, -32000, &e.to_string()),
    };
    let model = if provider::valid_for(&prov.preset, requested) {
        requested.to_string()
    } else {
        provider::effective_model(&prov.preset, "")
    };
    let credit = crate::store::get_user(&db, user_id)
        .await
        .map(|u| u.map(|u| u.credit_usd).unwrap_or(0.0))
        .unwrap_or(0.0);
    if !prov.own && credit <= 0.0 {
        return rpc_err(id, -32000, "Out of credit (balance $0.00). Demo credit is $10 per user.");
    }
    match chat::complete_with_usage(&prov, &model, &messages).await {
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
                    own_key: prov.own,
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
        Err(e) => rpc_err(id, -32000, &format!("Model API error: {e}")),
    }
}
