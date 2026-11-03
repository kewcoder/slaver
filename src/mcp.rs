use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

use crate::{auth, chat, provider, store, AppState};


fn rpc_ok(id: Value, result: Value) -> Response {
    (
        StatusCode::OK,
        Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })),
    )
        .into_response()
}

fn rpc_err(id: Value, code: i32, message: &str) -> Response {
    (
        StatusCode::OK,
        Json(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })),
    )
        .into_response()
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
        "description": "Set a slaveBot's personal identity/role (e.g. sales manager). The role guides meeting join decisions and is shown in the Bot tab.",
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

fn bot_send_tool_def() -> Value {
    json!({
        "name": "bot_send",
        "description": "Chat as one bot to another: deliver a message from a sender bot to a target bot and get the target's reply. Recorded in both histories, billed to the target's team.",
        "inputSchema": {
            "type": "object",
            "required": ["from_bot_id", "to_bot_id", "message"],
            "properties": {
                "from_bot_id": { "type": "string" },
                "to_bot_id": { "type": "string" },
                "message": { "type": "string" }
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

fn meeting_start_tool_def() -> Value {
    json!({
        "name": "meeting_start",
        "description": "Start a Slack-style meeting: notify bots about a topic; each bot decides by itself (from its role) whether to join. Notifies up to 8 active team bots, or the given slavebot_ids. team_id defaults to the personal team.",
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

fn meeting_list_tool_def() -> Value {
    json!({
        "name": "meeting_list",
        "description": "List meetings with their join/decline participants.",
        "inputSchema": { "type": "object", "properties": {} }
    })
}

fn meeting_chat_tool_def() -> Value {
    json!({
        "name": "meeting_chat",
        "description": "Send a message into a meeting; every bot that joined replies. Replies are saved and billed per bot.",
        "inputSchema": {
            "type": "object",
            "required": ["meeting_id", "message"],
            "properties": {
                "meeting_id": { "type": "string" },
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
pub async fn rpc(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let body: Value = match serde_json::from_slice(&body) {
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
            return (StatusCode::ACCEPTED, "").into_response();
        }
        "ping" => rpc_ok(id, json!({})),
        "tools/list" => {
            let mut tools = vec![auth_register_tool_def(), auth_login_tool_def(), auth_me_tool_def(), models_tool_def(), chat_tool_def(), chat_send_tool_def(), bots_list_tool_def(), bots_create_tool_def(), bots_get_tool_def(), bots_update_tool_def(), bots_children_tool_def(), bots_transfer_tool_def(), bots_append_memory_tool_def(), bots_set_avatar_tool_def(), bots_get_avatar_tool_def(), bot_archive_tool_def(), bot_pin_tool_def(), bot_set_role_tool_def(), bot_spawn_tool_def(), bot_send_tool_def(), groups_list_tool_def(), groups_create_tool_def(), groups_get_tool_def(), groups_rename_tool_def(), groups_delete_tool_def(), groups_add_member_tool_def(), groups_remove_member_tool_def(), groups_chat_tool_def(), groups_broadcast_tool_def(), meeting_list_tool_def(), meeting_get_tool_def(), meeting_start_tool_def(), meeting_chat_tool_def(), meeting_delete_tool_def(), schedules_update_tool_def(), schedule_create_tool_def(), schedule_list_tool_def(), schedule_delete_tool_def(), summaries_get_tool_def(), summaries_run_tool_def(), team_create_tool_def(), team_list_tool_def(), teams_get_tool_def(), teams_delete_tool_def(), team_invite_tool_def(), teams_set_member_tool_def(), teams_remove_member_tool_def(), teams_set_provider_tool_def(), teams_test_provider_tool_def(), teams_clear_provider_tool_def(), teams_activity_tool_def(), usage_get_tool_def(), harness_config_tool_def(), voice_transcribe_tool_def(), voice_speak_tool_def()];
            tools.extend(crate::platform_api::tool_defs());
            rpc_ok(id, json!({ "tools": tools }))
        },
        "tools/call" => {
            let params = body.get("params").cloned().unwrap_or(Value::Null);
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(Value::Null);
            if name == "auth_register" {
                return call_auth_register(id, &state, &args).await;
            }
            if name == "auth_login" {
                return call_auth_login(id, &state, &args).await;
            }
            let auth_header = headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let user_id = match auth::bearer_sub_from_header(&state.jwt_secret, Some(&auth_header)) {
                Some(uid) => uid,
                None => return rpc_err(id, -32000, "Unauthorized: send an Authorization: Bearer <jwt> header from the auth_login tool."),
            };
            match name {
                "models" => {
                    let db = &state.db;
                    let requested = args.get("team_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let preset = if requested.trim().is_empty() {
                        let team = store::ensure_personal_team(&db, &user_id).await.ok();
                        match team {
                            Some(t) => provider::preset_for_team(&db, &t.id).await,
                            None => "meta".to_string(),
                        }
                    } else {
                        provider::preset_for_team(&db, &requested).await
                    };
                    let list = provider::model_list(&preset);
                    mcp_data(id, format!("{} model(s) on {preset}.", list.get("models").and_then(|m| m.as_array()).map(|a| a.len()).unwrap_or(0)), list)
                }
                "chat" => call_chat(id, &state, &user_id, &args).await,
                "bot_archive" => call_bot_archive(id, &state, &user_id, &args).await,
                "bot_pin" => call_bot_pin(id, &state, &user_id, &args).await,
                "bot_set_role" => call_bot_set_role(id, &state, &user_id, &args).await,
                "bot_spawn" => call_bot_spawn(id, &state, &user_id, &args).await,
                "bot_send" => call_bot_send(id, &state, &user_id, &args).await,
                "schedule_create" => call_schedule_create(id, &state, &user_id, &args).await,
                "schedule_list" => call_schedule_list(id, &state, &user_id, &args).await,
                "schedule_delete" => call_schedule_delete(id, &state, &user_id, &args).await,
                "meeting_start" => call_meeting_start(id, &state, &user_id, &args).await,
                "team_create" => call_team_create(id, &state, &user_id, &args).await,
                "team_list" => call_team_list(id, &state, &user_id, &args).await,
                "team_invite" => call_team_invite(id, &state, &user_id, &args).await,
                "meeting_list" => call_meeting_list(id, &state, &user_id, &args).await,
                "meeting_chat" => call_meeting_chat(id, &state, &user_id, &args).await,
                "auth_me" => call_auth_me(id, &state, &user_id).await,
                "chat_send" => call_chat_send(id, &state, &user_id, &args).await,
                "bots_list" => call_bots_list(id, &state, &user_id).await,
                "bots_create" => call_bots_create(id, &state, &user_id, &args).await,
                "bots_get" => call_bots_get(id, &state, &user_id, &args).await,
                "bots_update" => call_bots_update(id, &state, &user_id, &args).await,
                "bots_children" => call_bots_children(id, &state, &user_id, &args).await,
                "bots_transfer" => call_bots_transfer(id, &state, &user_id, &args).await,
                "bots_append_memory" => call_bots_append_memory(id, &state, &user_id, &args).await,
                "bots_set_avatar" => call_bots_set_avatar(id, &state, &user_id, &args).await,
                "bots_get_avatar" => call_bots_get_avatar(id, &state, &user_id, &args).await,
                "groups_list" => call_groups_list(id, &state, &user_id).await,
                "groups_create" => call_groups_create(id, &state, &user_id, &args).await,
                "groups_get" => call_groups_get(id, &state, &user_id, &args).await,
                "groups_rename" => call_groups_rename(id, &state, &user_id, &args).await,
                "groups_delete" => call_groups_delete(id, &state, &user_id, &args).await,
                "groups_add_member" => call_groups_add_member(id, &state, &user_id, &args).await,
                "groups_remove_member" => call_groups_remove_member(id, &state, &user_id, &args).await,
                "groups_chat" => call_groups_chat(id, &state, &user_id, &args).await,
                "groups_broadcast" => call_groups_broadcast(id, &state, &user_id, &args).await,
                "meeting_get" => call_meeting_get(id, &state, &user_id, &args).await,
                "meeting_delete" => call_meeting_delete(id, &state, &user_id, &args).await,
                "schedules_update" => call_schedules_update(id, &state, &user_id, &args).await,
                "summaries_get" => call_summaries_get(id, &state, &user_id, &args).await,
                "summaries_run" => call_summaries_run(id, &state, &user_id, &args).await,
                "teams_get" => call_teams_get(id, &state, &user_id, &args).await,
                "teams_delete" => call_teams_delete(id, &state, &user_id, &args).await,
                "teams_set_member" => call_teams_set_member(id, &state, &user_id, &args).await,
                "teams_remove_member" => call_teams_remove_member(id, &state, &user_id, &args).await,
                "teams_set_provider" => call_teams_set_provider(id, &state, &user_id, &args).await,
                "teams_test_provider" => call_teams_test_provider(id, &state, &user_id, &args).await,
                "teams_clear_provider" => call_teams_clear_provider(id, &state, &user_id, &args).await,
                "teams_activity" => call_teams_activity(id, &state, &user_id, &args).await,
                "usage_get" => call_usage_get(id, &state, &user_id).await,
                "harness_config" => call_harness_config(id, &state),
                "voice_transcribe" => call_voice_transcribe(id, &state, &user_id, &args).await,
                "voice_speak" => call_voice_speak(id, &state, &user_id, &args).await,
                _ => match crate::platform_api::dispatch(&state, &user_id, name, id.clone(), &args).await {
                    Some(r) => r,
                    None => rpc_err(id, -32602, "Unknown tool. Run tools/list for the current catalogue."),
                },
            }
        }
        "" => rpc_err(id, -32600, "Invalid Request: missing method field."),
        _ => rpc_err(id, -32601, "Unknown method."),
    }
}

fn mcp_text(id: Value, text: String) -> Response {
    rpc_ok(id, json!({ "content": [{ "type": "text", "text": text }] }))
}

async fn call_bot_pin(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let bot_id = args.get("slavebot_id").and_then(|v| v.as_str()).unwrap_or("");
    let pinned = args.get("pinned").and_then(|v| v.as_bool()).unwrap_or(true);
    if bot_id.is_empty() {
        return rpc_err(id, -32602, "The slavebot_id argument is required.");
    }
    let db = &state.db;
    match store::set_pinned(&db, user_id, bot_id, pinned).await {
        Ok(Some(bot)) => mcp_text(id, format!("{} is now {}.", bot.name, if pinned { "pinned" } else { "unpinned" })),
        Ok(None) => rpc_err(id, -32602, "SlaveBot not found."),
        Err(e) => rpc_err(id, -32602, &format!("Pin failed: {e}")),
    }
}

async fn call_bot_set_role(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let bot_id = args.get("slavebot_id").and_then(|v| v.as_str()).unwrap_or("");
    let role = args.get("role").and_then(|v| v.as_str()).unwrap_or("");
    if bot_id.is_empty() {
        return rpc_err(id, -32602, "The slavebot_id argument is required.");
    }
    let db = &state.db;
    match store::update_bot(&db, user_id, bot_id, None, None, None, None, None, None, None, Some(role), None).await {
        Ok(Some(bot)) => mcp_text(id, format!("{} is now: {}.", bot.name, if bot.role.is_empty() { "no role" } else { &bot.role })),
        Ok(None) => rpc_err(id, -32602, "SlaveBot not found."),
        Err(e) => rpc_err(id, -32000, &format!("Set role failed: {e}")),
    }
}

async fn call_bot_spawn(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let manager_id = args.get("manager_id").and_then(|v| v.as_str()).unwrap_or("");
    if manager_id.is_empty() {
        return rpc_err(id, -32602, "The manager_id argument is required.");
    }
    let db = &state.db;
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
        Ok(child) => {
            let greeting = format!(
                "Hi, I'm {name}! I report to {manager}. {task} What should I do first?",
                name = child.name,
                manager = manager.name,
                task = if child.role.trim().is_empty() {
                    "My specific task is not set yet \u{2014} tell me what to focus on.".to_string()
                } else {
                    format!("My task: {}.", child.role.trim())
                },
            );
            let _ = store::insert_message(&db, &child.id, "assistant", &greeting).await;
            let child = store::get_bot(&db, user_id, &child.id).await.unwrap_or(None).unwrap_or(child);
            mcp_data(
                id,
                format!("Spawned {} under {}.", child.name, manager.name),
                json!({ "slavebot": child, "manager_id": manager_id }),
            )
        }
        Err(e) => rpc_err(id, -32602, &format!("Spawn failed: {e}")),
    }
}

async fn call_bot_send(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let from_id = args.get("from_bot_id").and_then(|v| v.as_str()).unwrap_or("");
    let to_id = args.get("to_bot_id").and_then(|v| v.as_str()).unwrap_or("");
    let message = args.get("message").and_then(|v| v.as_str()).unwrap_or("");
    if from_id.is_empty() || to_id.is_empty() || message.is_empty() {
        return rpc_err(id, -32602, "from_bot_id, to_bot_id, and message are required.");
    }
    let db = &state.db;
    match crate::chat::deliver_as(&db, user_id, from_id, to_id, message).await {
        Ok(r) => mcp_data(
            id,
            format!("Delivered to {} (${:.6}).", to_id, r.cost_usd),
            json!({ "reply": r.reply, "from_bot_id": from_id, "to_bot_id": to_id, "cost_usd": r.cost_usd }),
        ),
        Err(e) => rpc_err(id, -32602, &format!("Send failed: {e}")),
    }
}

async fn call_team_create(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("Team");
    let db = &state.db;
    match store::create_team(&db, user_id, name, false).await {
        Ok(t) => {
            let mut team = crate::teams::safe_team(&t);
            team["role"] = serde_json::Value::String("owner".to_string());
            mcp_data(id, format!("Team {} created. You are the owner.", t.name), json!({ "team": team }))
        }
        Err(e) => rpc_err(id, -32000, &format!("Create failed: {e}")),
    }
}

async fn call_team_list(id: Value, state: &AppState, user_id: &str, _args: &Value) -> Response {
    let db = &state.db;
    match store::list_user_teams(&db, user_id).await {
        Ok(list) => mcp_data(id, format!("{} team(s).", list.len()), json!({ "teams": list })),
        Err(e) => rpc_err(id, -32000, &format!("List failed: {e}")),
    }
}

async fn call_team_invite(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let team_id = args.get("team_id").and_then(|v| v.as_str()).unwrap_or("");
    let email = args.get("email").and_then(|v| v.as_str()).unwrap_or("");
    let role = args.get("role").and_then(|v| v.as_str()).unwrap_or("staff");
    if team_id.is_empty() || email.is_empty() {
        return rpc_err(id, -32602, "The team_id and email arguments are required.");
    }
    let db = &state.db;
    match store::add_member_by_email(&db, team_id, user_id, email, role).await {
        Ok(m) => mcp_data(id, format!("{} joined as {}.", m.user_id, m.role), json!({ "member": m })),
        Err(e) => rpc_err(id, -32602, &e),
    }
}

async fn call_meeting_start(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let topic = args.get("topic").and_then(|v| v.as_str()).unwrap_or("");
    let team_id = args.get("team_id").and_then(|v| v.as_str()).unwrap_or("");
    let ids: Option<Vec<String>> = args.get("slavebot_ids").and_then(|v| {
        v.as_array().map(|a| {
            a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()
        })
    });
    let db = &state.db;
    match crate::meeting::start_meeting(db, user_id, team_id, topic, ids).await {
        Ok((meeting, participants)) => mcp_data(
            id,
            format!("Meeting started on \"{}\".", meeting.topic),
            json!({ "meeting": meeting, "participants": participants, "messages": [] }),
        ),
        Err(e) => rpc_err(id, -32000, &e),
    }
}

async fn call_meeting_list(id: Value, state: &AppState, user_id: &str, _args: &Value) -> Response {
    let db = &state.db;
    match store::list_meetings(&db, user_id).await {
        Ok(list) => mcp_data(id, format!("{} meeting(s).", list.len()), json!({ "meetings": list })),
        Err(e) => rpc_err(id, -32000, &format!("List failed: {e}")),
    }
}

async fn call_meeting_chat(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let meeting_id = args.get("meeting_id").and_then(|v| v.as_str()).unwrap_or("");
    let message = args.get("message").and_then(|v| v.as_str()).unwrap_or("");
    if meeting_id.is_empty() || message.is_empty() {
        return rpc_err(id, -32602, "The meeting_id and message arguments are required.");
    }
    let db = &state.db;
    match crate::meeting::post_message(db, user_id, meeting_id, message, None).await {
        Ok(r) => mcp_data(
            id,
            format!("{} replie(s), total ${:.6}.", r.replies.len(), r.total_cost),
            json!({ "replies": r.replies, "total_cost_usd": r.total_cost, "credit_usd": r.credit }),
        ),
        Err(e) => rpc_err(id, -32000, &e),
    }
}

fn arg_str(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn arg_bool(args: &Value, key: &str) -> Option<bool> {
    args.get(key).and_then(|v| v.as_bool())
}

/// Tool result carrying a short human summary plus the full JSON payload.
/// The app reads `data`; other MCP clients read the content text.
fn mcp_data(id: Value, summary: String, data: Value) -> Response {
    rpc_ok(
        id,
        json!({ "content": [{ "type": "text", "text": summary }], "data": data }),
    )
}

fn auth_register_tool_def() -> Value {
    json!({
        "name": "auth_register",
        "description": "Create an account. Returns a token and the user.",
        "inputSchema": {
            "type": "object",
            "required": ["email", "password"],
            "properties": {
                "email": { "type": "string" },
                "password": { "type": "string" },
                "name": { "type": "string" }
            }
        }
    })
}

fn auth_login_tool_def() -> Value {
    json!({
        "name": "auth_login",
        "description": "Log in. Returns a token and the user.",
        "inputSchema": {
            "type": "object",
            "required": ["email", "password"],
            "properties": {
                "email": { "type": "string" },
                "password": { "type": "string" }
            }
        }
    })
}

fn auth_me_tool_def() -> Value {
    json!({
        "name": "auth_me",
        "description": "Current user profile (id, email, name, credit).",
        "inputSchema": { "type": "object", "properties": {} }
    })
}

fn chat_send_tool_def() -> Value {
    json!({
        "name": "chat_send",
        "description": "Chat with a slaveBot. Slash commands (/remind, /spawn, /pin, /role) run locally; otherwise the bot may consult peer bots itself before the model replies. Returns the reply plus usage.",
        "inputSchema": {
            "type": "object",
            "required": ["slavebot_id", "message"],
            "properties": {
                "slavebot_id": { "type": "string" },
                "message": { "type": "string" },
                "model": { "type": "string" }
            }
        }
    })
}

fn bots_list_tool_def() -> Value {
    json!({
        "name": "bots_list",
        "description": "SlaveBots the caller may use (owner/admin see all team bots, staff see granted bots).",
        "inputSchema": { "type": "object", "properties": {} }
    })
}

fn bots_create_tool_def() -> Value {
    json!({
        "name": "bots_create",
        "description": "Create a slaveBot on a team (defaults to the personal team). Owner defaults to the creator; staff may only pick themselves.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "model": { "type": "string" },
                "team_id": { "type": "string" },
                "owner_user_id": { "type": "string" }
            }
        }
    })
}

fn bots_get_tool_def() -> Value {
    json!({
        "name": "bots_get",
        "description": "One slaveBot the caller may use.",
        "inputSchema": {
            "type": "object",
            "required": ["slavebot_id"],
            "properties": { "slavebot_id": { "type": "string" } }
        }
    })
}

fn bots_update_tool_def() -> Value {
    json!({
        "name": "bots_update",
        "description": "Update a slaveBot: name, memory, role, model, voice, pinned, archived, active days/start/end, relay (let it consult peers itself).",
        "inputSchema": {
            "type": "object",
            "required": ["slavebot_id"],
            "properties": {
                "slavebot_id": { "type": "string" },
                "name": { "type": "string" },
                "memory": { "type": "string" },
                "role": { "type": "string" },
                "model": { "type": "string" },
                "voice": { "type": "string" },
                "pinned": { "type": "boolean" },
                "archived": { "type": "boolean" },
                "active_days": { "type": "string" },
                "active_start": { "type": "string" },
                "active_end": { "type": "string" },
                "relay": { "type": "boolean" }
            }
        }
    })
}

fn bots_children_tool_def() -> Value {
    json!({
        "name": "bots_children",
        "description": "Direct sub-bots spawned under a manager bot.",
        "inputSchema": {
            "type": "object",
            "required": ["slavebot_id"],
            "properties": { "slavebot_id": { "type": "string" } }
        }
    })
}

fn bots_transfer_tool_def() -> Value {
    json!({
        "name": "bots_transfer",
        "description": "Transfer a bot's partnership to another team member. Only the team's owner/admin may do this.",
        "inputSchema": {
            "type": "object",
            "required": ["slavebot_id", "owner_user_id"],
            "properties": {
                "slavebot_id": { "type": "string" },
                "owner_user_id": { "type": "string" }
            }
        }
    })
}

fn bots_append_memory_tool_def() -> Value {
    json!({
        "name": "bots_append_memory",
        "description": "Append a fact to a slaveBot's persistent memory.",
        "inputSchema": {
            "type": "object",
            "required": ["slavebot_id", "text"],
            "properties": {
                "slavebot_id": { "type": "string" },
                "text": { "type": "string" }
            }
        }
    })
}

fn bots_set_avatar_tool_def() -> Value {
    json!({
        "name": "bots_set_avatar",
        "description": "Upload a slaveBot avatar (base64 png/jpeg/webp/gif, max 2 MB). Replaces any previous avatar.",
        "inputSchema": {
            "type": "object",
            "required": ["slavebot_id", "image_base64"],
            "properties": {
                "slavebot_id": { "type": "string" },
                "image_base64": { "type": "string" },
                "content_type": { "type": "string" }
            }
        }
    })
}

fn bots_get_avatar_tool_def() -> Value {
    json!({
        "name": "bots_get_avatar",
        "description": "Fetch a slaveBot avatar as base64 + content type (render as a data: URL).",
        "inputSchema": {
            "type": "object",
            "required": ["slavebot_id"],
            "properties": { "slavebot_id": { "type": "string" } }
        }
    })
}

fn groups_list_tool_def() -> Value {
    json!({ "name": "groups_list", "description": "Channels (groups) the caller may use.", "inputSchema": { "type": "object", "properties": {} } })
}

fn groups_create_tool_def() -> Value {
    json!({ "name": "groups_create", "description": "Create a channel, optionally on a team.", "inputSchema": { "type": "object", "properties": { "name": { "type": "string" }, "team_id": { "type": "string" } } } })
}

fn groups_get_tool_def() -> Value {
    json!({ "name": "groups_get", "description": "Channel detail: group, members, recent messages.", "inputSchema": { "type": "object", "required": ["group_id"], "properties": { "group_id": { "type": "string" } } } })
}

fn groups_rename_tool_def() -> Value {
    json!({ "name": "groups_rename", "description": "Rename a channel.", "inputSchema": { "type": "object", "required": ["group_id", "name"], "properties": { "group_id": { "type": "string" }, "name": { "type": "string" } } } })
}

fn groups_delete_tool_def() -> Value {
    json!({ "name": "groups_delete", "description": "Delete a channel and its messages.", "inputSchema": { "type": "object", "required": ["group_id"], "properties": { "group_id": { "type": "string" } } } })
}

fn groups_add_member_tool_def() -> Value {
    json!({ "name": "groups_add_member", "description": "Add one or more slaveBots to a channel.", "inputSchema": { "type": "object", "required": ["group_id"], "properties": { "group_id": { "type": "string" }, "slavebot_id": { "type": "string" }, "slavebot_ids": { "type": "array", "items": { "type": "string" } } } } })
}

fn groups_remove_member_tool_def() -> Value {
    json!({ "name": "groups_remove_member", "description": "Remove a slaveBot from a channel.", "inputSchema": { "type": "object", "required": ["group_id", "slavebot_id"], "properties": { "group_id": { "type": "string" }, "slavebot_id": { "type": "string" } } } })
}

fn groups_chat_tool_def() -> Value {
    json!({ "name": "groups_chat", "description": "Post a task to a channel: every member bot replies (each billed, access-checked). Optionally also appends the message to each member's memory.", "inputSchema": { "type": "object", "required": ["group_id", "message"], "properties": { "group_id": { "type": "string" }, "message": { "type": "string" }, "model": { "type": "string" }, "save_memory": { "type": "boolean" } } } })
}

fn groups_broadcast_tool_def() -> Value {
    json!({ "name": "groups_broadcast", "description": "Post one info message to a channel thread, optionally saving it into every member's memory.", "inputSchema": { "type": "object", "required": ["group_id", "text"], "properties": { "group_id": { "type": "string" }, "text": { "type": "string" }, "save_to_memory": { "type": "boolean" } } } })
}

fn meeting_get_tool_def() -> Value {
    json!({ "name": "meeting_get", "description": "Meeting detail: meeting, participants, messages.", "inputSchema": { "type": "object", "required": ["meeting_id"], "properties": { "meeting_id": { "type": "string" } } } })
}

fn meeting_delete_tool_def() -> Value {
    json!({ "name": "meeting_delete", "description": "Delete a meeting.", "inputSchema": { "type": "object", "required": ["meeting_id"], "properties": { "meeting_id": { "type": "string" } } } })
}

fn schedules_update_tool_def() -> Value {
    json!({ "name": "schedules_update", "description": "Enable or disable a bot schedule.", "inputSchema": { "type": "object", "required": ["schedule_id"], "properties": { "schedule_id": { "type": "string" }, "active": { "type": "boolean" } } } })
}

fn summaries_get_tool_def() -> Value {
    json!({ "name": "summaries_get", "description": "Daily/weekly/monthly summaries for a slaveBot.", "inputSchema": { "type": "object", "required": ["slavebot_id"], "properties": { "slavebot_id": { "type": "string" } } } })
}

fn summaries_run_tool_def() -> Value {
    json!({ "name": "summaries_run", "description": "Generate the daily recap for a slaveBot now.", "inputSchema": { "type": "object", "required": ["slavebot_id"], "properties": { "slavebot_id": { "type": "string" } } } })
}

fn teams_get_tool_def() -> Value {
    json!({ "name": "teams_get", "description": "Team detail: team (key hidden), your role, members with staff grants, bots.", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" } } } })
}

fn teams_delete_tool_def() -> Value {
    json!({ "name": "teams_delete", "description": "Delete a team (bots archived, groups and meetings removed). Owner/admin only; personal team cannot be deleted.", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" } } } })
}

fn teams_set_member_tool_def() -> Value {
    json!({ "name": "teams_set_member", "description": "Change a member's role (admin/staff) and/or their per-bot grants. Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id", "user_id"], "properties": { "team_id": { "type": "string" }, "user_id": { "type": "string" }, "role": { "type": "string" }, "bot_ids": { "type": "array", "items": { "type": "string" } } } } })
}

fn teams_remove_member_tool_def() -> Value {
    json!({ "name": "teams_remove_member", "description": "Remove a member from a team. Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id", "user_id"], "properties": { "team_id": { "type": "string" }, "user_id": { "type": "string" } } } })
}

fn teams_set_provider_tool_def() -> Value {
    json!({ "name": "teams_set_provider", "description": "Set a team's AI provider (meta/baseten/modal/openrouter/opencode/ollama/custom) with base URL and key. Owner/admin only; empty key keeps the stored one. For keyless local servers (Ollama/OpenCode on localhost) the key may stay empty. Base URL must be the API root ending in /v1 — do NOT append /chat/completions.", "inputSchema": { "type": "object", "required": ["team_id", "preset"], "properties": { "team_id": { "type": "string" }, "preset": { "type": "string", "enum": ["meta", "baseten", "modal", "openrouter", "opencode", "ollama", "custom"] }, "base_url": { "type": "string" }, "api_key": { "type": "string" } } } })
}

fn teams_test_provider_tool_def() -> Value {
    json!({ "name": "teams_test_provider", "description": "Test a team's AI provider: lists /v1/models when exposed and sends a 1-token ping with the given (or first listed) model. Returns endpoint, models, and diagnostics. Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" }, "model": { "type": "string" } } } })
}

fn teams_clear_provider_tool_def() -> Value {
    json!({ "name": "teams_clear_provider", "description": "Remove a team's API key. Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" } } } })
}

fn teams_activity_tool_def() -> Value {
    json!({ "name": "teams_activity", "description": "Recent bot conversations across a team (owner oversight). Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" } } } })
}

fn usage_get_tool_def() -> Value {
    json!({ "name": "usage_get", "description": "Demo credit balance, total spent, and the usage log.", "inputSchema": { "type": "object", "properties": {} } })
}

fn harness_config_tool_def() -> Value {
    json!({ "name": "harness_config", "description": "Base URL of the Slaver harness worker (Codex-like agent runs in Sandbox containers). The app calls its /api/runs endpoints there.", "inputSchema": { "type": "object", "properties": {} } })
}

fn voice_transcribe_tool_def() -> Value {
    json!({ "name": "voice_transcribe", "description": "Transcribe mono 16-bit WAV audio (base64) via the team's Meta provider. Needs the team's provider set to Meta.", "inputSchema": { "type": "object", "required": ["audio_base64"], "properties": { "audio_base64": { "type": "string" }, "team_id": { "type": "string" } } } })
}

fn voice_speak_tool_def() -> Value {
    json!({ "name": "voice_speak", "description": "Speak text via the Workers AI voice (base64 MP3 out). Billed per character against demo credit.", "inputSchema": { "type": "object", "required": ["text"], "properties": { "text": { "type": "string" }, "voice": { "type": "string" } } } })
}

async fn call_bot_archive(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let bot_id = args.get("slavebot_id").and_then(|v| v.as_str()).unwrap_or("");
    let archived = args.get("archived").and_then(|v| v.as_bool()).unwrap_or(true);
    if bot_id.is_empty() {
        return rpc_err(id, -32602, "The slavebot_id argument is required.");
    }
    let db = &state.db;
    match store::set_archived(&db, user_id, bot_id, archived).await {
        Ok(Some(bot)) => mcp_text(id, format!("{} is now {}.", bot.name, if archived { "archived" } else { "active" })),
        Ok(None) => rpc_err(id, -32602, "SlaveBot not found."),
        Err(e) => rpc_err(id, -32000, &format!("Archive failed: {e}")),
    }
}

async fn call_schedule_create(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let bot_id = args.get("slavebot_id").and_then(|v| v.as_str()).unwrap_or("");
    let prompt = args.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
    if bot_id.is_empty() || prompt.is_empty() {
        return rpc_err(id, -32602, "The slavebot_id and prompt arguments are required.");
    }
    let db = &state.db;
    if store::get_bot(&db, user_id, bot_id).await.map(|b| b.is_none()).unwrap_or(true) {
        return rpc_err(id, -32602, "SlaveBot not found.");
    }
    let kind = args.get("kind").and_then(|v| v.as_str()).unwrap_or("daily");
    let time_hhmm = args.get("time_hhmm").and_then(|v| v.as_str()).unwrap_or("07:00");
    let days = args.get("days").and_then(|v| v.as_str()).unwrap_or("all");
    let interval = args.get("interval_minutes").and_then(|v| v.as_i64()).unwrap_or(60);
    let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("MCP schedule");
    match store::create_schedule(&db, user_id, bot_id, name, kind, time_hhmm, days, interval, prompt).await {
        Ok(s) => mcp_data(id, format!("Schedule {} created, next run {}.", s.id, s.next_run_at), json!({ "schedule": s })),
        Err(e) => rpc_err(id, -32602, &format!("Invalid schedule: {e}")),
    }
}

async fn call_schedule_list(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let bot_id = args.get("slavebot_id").and_then(|v| v.as_str()).unwrap_or("");
    if bot_id.is_empty() {
        return rpc_err(id, -32602, "The slavebot_id argument is required.");
    }
    let db = &state.db;
    match store::list_schedules(&db, user_id, Some(bot_id)).await {
        Ok(list) => mcp_data(id, format!("{} schedule(s).", list.len()), json!({ "schedules": list })),
        Err(e) => rpc_err(id, -32000, &format!("List failed: {e}")),
    }
}

async fn call_schedule_delete(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let sid = args.get("schedule_id").and_then(|v| v.as_str()).unwrap_or("");
    if sid.is_empty() {
        return rpc_err(id, -32602, "The schedule_id argument is required.");
    }
    let db = &state.db;
    match store::delete_schedule(&db, user_id, sid).await {
        Ok(true) => mcp_text(id, "Schedule deleted.".to_string()),
        Ok(false) => rpc_err(id, -32602, "Schedule not found."),
        Err(e) => rpc_err(id, -32000, &format!("Delete failed: {e}")),
    }
}

async fn call_chat(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
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
    let db = &state.db;
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
    match chat::complete_with_usage(&prov, &model, &messages, Some(user_id)).await {
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

async fn call_auth_register(id: Value, state: &AppState, args: &Value) -> Response {
    let (email, password, name) = (arg_str(args, "email"), arg_str(args, "password"), arg_str(args, "name"));
    if email.is_empty() || password.is_empty() {
        return rpc_err(id, -32602, "email and password are required.");
    }
    let db = &state.db;
    let secret = state.jwt_secret.clone();
    match crate::auth::register_core(&db, &secret, &email, &password, &name).await {
        Ok(u) => mcp_data(id, format!("Registered {}.", email), json!({ "token": u.token, "user": u.user })),
        Err(e) => rpc_err(id, -32602, &e),
    }
}

async fn call_auth_login(id: Value, state: &AppState, args: &Value) -> Response {
    let (email, password) = (arg_str(args, "email"), arg_str(args, "password"));
    if email.is_empty() || password.is_empty() {
        return rpc_err(id, -32602, "email and password are required.");
    }
    let db = &state.db;
    let secret = state.jwt_secret.clone();
    match crate::auth::login_core(&db, &secret, &email, &password).await {
        Ok(u) => mcp_data(id, format!("Logged in as {}.", email), json!({ "token": u.token, "user": u.user })),
        Err(e) => rpc_err(id, -32602, &e),
    }
}

async fn call_auth_me(id: Value, state: &AppState, user_id: &str) -> Response {
    let db = &state.db;
    match crate::auth::me_core(&db, user_id).await {
        Ok(user) => mcp_data(id, "Profile.".to_string(), json!({ "user": user })),
        Err(e) => rpc_err(id, -32602, &e),
    }
}

async fn call_chat_send(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let (bot_id, message, model) = (arg_str(args, "slavebot_id"), arg_str(args, "message"), arg_str(args, "model"));
    if bot_id.is_empty() || message.is_empty() {
        return rpc_err(id, -32602, "slavebot_id and message are required.");
    }
    let db = &state.db;
    let model_opt = if model.is_empty() { None } else { Some(model.as_str()) };
    match crate::chat::send_message(&db, user_id, &bot_id, &message, model_opt).await {
        Ok(v) => mcp_data(id, v.get("reply").and_then(|r| r.as_str()).unwrap_or("Done.").to_string(), v),
        Err(e) => rpc_err(id, -32000, &e),
    }
}

async fn call_bots_list(id: Value, state: &AppState, user_id: &str) -> Response {
    let db = &state.db;
    match store::list_bots(&db, user_id, false).await {
        Ok(bots) => mcp_data(id, format!("{} slaveBot(s).", bots.len()), json!({ "slavebots": bots })),
        Err(e) => rpc_err(id, -32000, &format!("List failed: {e}")),
    }
}

async fn call_bots_create(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let (model, team_id, owner) = (arg_str(args, "model"), arg_str(args, "team_id"), arg_str(args, "owner_user_id"));
    let db = &state.db;
    let team_id = if team_id.trim().is_empty() {
        match store::ensure_personal_team(&db, user_id).await {
            Ok(t) => t.id,
            Err(e) => return rpc_err(id, -32000, &format!("Team failed: {e}")),
        }
    } else {
        team_id
    };
    let preset = provider::preset_for_team(&db, &team_id).await;
    let model = if provider::valid_for(&preset, &model) && !model.is_empty() {
        model
    } else {
        provider::effective_model(&preset, "")
    };
    match store::create_bot(&db, user_id, &team_id, &model, &owner).await {
        Ok(bot) => {
            let greeting = format!(
                "Hi, I'm {name}! Before we start \u{2014} what should my job be? Tell me my role in a sentence or two, \
                for example \"You are my sales manager \u{2014} track my leads and remind me to follow up\". \
                You can also set it anytime in the Bot tab, and I can grow my own little team later with /spawn.",
                name = bot.name,
            );
            let _ = store::insert_message(&db, &bot.id, "assistant", &greeting).await;
            let bot = store::get_bot(&db, user_id, &bot.id).await.unwrap_or(None).unwrap_or(bot);
            mcp_data(
                id,
                format!("Created {}. Ask it about its role first.", bot.name),
                json!({ "slavebot": bot }),
            )
        }
        Err(e) => rpc_err(id, -32602, &format!("Create failed: {e}")),
    }
}

async fn call_bots_get(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let bot_id = arg_str(args, "slavebot_id");
    if bot_id.is_empty() {
        return rpc_err(id, -32602, "The slavebot_id argument is required.");
    }
    let db = &state.db;
    match store::bot_messages(&db, user_id, &bot_id).await {
        Ok(Some((bot, messages))) => mcp_data(id, format!("{} ({} messages).", bot.name, messages.len()), json!({ "slavebot": bot, "messages": messages })),
        Ok(None) => rpc_err(id, -32602, "SlaveBot not found."),
        Err(e) => rpc_err(id, -32000, &format!("Database error: {e}")),
    }
}

async fn call_bots_update(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let bot_id = arg_str(args, "slavebot_id");
    if bot_id.is_empty() {
        return rpc_err(id, -32602, "The slavebot_id argument is required.");
    }
    let db = &state.db;
    if let Some(archived) = arg_bool(args, "archived") {
        return match store::set_archived(&db, user_id, &bot_id, archived).await {
            Ok(Some(bot)) => mcp_data(id, format!("{} is now {}.", bot.name, if archived { "archived" } else { "active" }), json!({ "slavebot": bot })),
            Ok(None) => rpc_err(id, -32602, "SlaveBot not found."),
            Err(e) => rpc_err(id, -32000, &format!("Update failed: {e}")),
        };
    }
    if let Some(pinned) = arg_bool(args, "pinned") {
        return match store::set_pinned(&db, user_id, &bot_id, pinned).await {
            Ok(Some(bot)) => mcp_data(id, format!("{} pin updated.", bot.name), json!({ "slavebot": bot })),
            Ok(None) => rpc_err(id, -32602, "SlaveBot not found."),
            Err(e) => rpc_err(id, -32000, &format!("Update failed: {e}")),
        };
    }
    let opt = |k: &str| {
        let v = arg_str(args, k);
        if v.is_empty() { None } else { Some(v) }
    };
    let owned: Vec<Option<String>> = ["name", "memory", "model", "voice", "active_days", "active_start", "active_end"]
        .iter()
        .map(|k| opt(k))
        .collect();
    let ref_of = |i: usize| owned[i].as_deref();
    let role = opt("role");
    let relay = arg_bool(args, "relay");
    match store::update_bot(
        &db, user_id, &bot_id,
        ref_of(0), ref_of(1), ref_of(2), ref_of(3),
        ref_of(4), ref_of(5), ref_of(6),
        role.as_deref(), relay,
    )
    .await
    {
        Ok(Some(bot)) => mcp_data(id, format!("{} updated.", bot.name), json!({ "slavebot": bot })),
        Ok(None) => rpc_err(id, -32602, "SlaveBot not found."),
        Err(e) => rpc_err(id, -32000, &format!("Update failed: {e}")),
    }
}

async fn call_bots_children(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let bot_id = arg_str(args, "slavebot_id");
    if bot_id.is_empty() {
        return rpc_err(id, -32602, "The slavebot_id argument is required.");
    }
    let db = &state.db;
    match store::children_of(&db, user_id, &bot_id).await {
        Ok(kids) => mcp_data(id, format!("{} sub-bot(s).", kids.len()), json!({ "children": kids })),
        Err(e) => rpc_err(id, -32000, &format!("Database error: {e}")),
    }
}

async fn call_bots_transfer(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let (bot_id, owner) = (arg_str(args, "slavebot_id"), arg_str(args, "owner_user_id"));
    if bot_id.is_empty() || owner.is_empty() {
        return rpc_err(id, -32602, "slavebot_id and owner_user_id are required.");
    }
    let db = &state.db;
    match store::set_bot_owner(&db, user_id, &bot_id, &owner).await {
        Ok(bot) => mcp_data(id, format!("{} is now partnered with a teammate.", bot.name), json!({ "slavebot": bot })),
        Err(e) => rpc_err(id, -32602, &e),
    }
}

async fn call_bots_append_memory(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let (bot_id, text) = (arg_str(args, "slavebot_id"), arg_str(args, "text"));
    if bot_id.is_empty() || text.trim().is_empty() {
        return rpc_err(id, -32602, "slavebot_id and text are required.");
    }
    let db = &state.db;
    match store::append_memory(&db, user_id, &bot_id, text.trim()).await {
        Ok(Some(bot)) => mcp_data(id, "Memory saved.".to_string(), json!({ "slavebot": bot })),
        Ok(None) => rpc_err(id, -32602, "SlaveBot not found or not editable."),
        Err(e) => rpc_err(id, -32000, &format!("Database error: {e}")),
    }
}

async fn call_bots_set_avatar(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    use base64::Engine;
    let (bot_id, image_b64, content_type) = (arg_str(args, "slavebot_id"), arg_str(args, "image_base64"), arg_str(args, "content_type"));
    if bot_id.is_empty() || image_b64.is_empty() {
        return rpc_err(id, -32602, "slavebot_id and image_base64 are required.");
    }
    let bytes = match base64::engine::general_purpose::STANDARD.decode(image_b64.trim()) {
        Ok(b) => b,
        Err(_) => return rpc_err(id, -32602, "image_base64 is not valid base64."),
    };
    let ct = if content_type.trim().is_empty() { "image/png" } else { content_type.trim() };
    let db = &state.db;
    match crate::avatar::upload_core(&state.avatar_dir, db, user_id, &bot_id, bytes, ct).await {
        Ok(v) => mcp_data(id, "Avatar updated.".to_string(), v),
        Err(e) => rpc_err(id, -32602, &e),
    }
}

async fn call_bots_get_avatar(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let bot_id = arg_str(args, "slavebot_id");
    if bot_id.is_empty() {
        return rpc_err(id, -32602, "The slavebot_id argument is required.");
    }
    let db = &state.db;
    match crate::avatar::read_core(&state.avatar_dir, db, user_id, &bot_id).await {
        Ok(mut v) => {
            let summary = "Avatar below as a data: URL.".to_string();
            if let Some(ct) = v.get("content_type").and_then(|c| c.as_str()).map(|s| s.to_string()) {
                if let Some(b64) = v.get("image_base64").and_then(|c| c.as_str()).map(|s| s.to_string()) {
                    v["data_url"] = json!(format!("data:{ct};base64,{b64}"));
                }
            }
            mcp_data(id, summary, v)
        }
        Err(e) => rpc_err(id, -32602, &e),
    }
}

async fn call_groups_list(id: Value, state: &AppState, user_id: &str) -> Response {
    let db = &state.db;
    match store::list_groups(&db, user_id).await {
        Ok(groups) => mcp_data(id, format!("{} group(s).", groups.len()), json!({ "groups": groups })),
        Err(e) => rpc_err(id, -32000, &format!("List failed: {e}")),
    }
}

async fn call_groups_create(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let (name, team_id) = (arg_str(args, "name"), arg_str(args, "team_id"));
    let db = &state.db;
    let name = if name.trim().is_empty() { "Group".to_string() } else { name.trim().chars().take(60).collect() };
    match store::create_group(&db, user_id, &team_id, &name).await {
        Ok(group) => mcp_data(id, format!("Created group {}.", name), json!({ "group": group })),
        Err(e) => rpc_err(id, -32602, &format!("Create failed: {e}")),
    }
}

async fn call_groups_get(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let group_id = arg_str(args, "group_id");
    if group_id.is_empty() {
        return rpc_err(id, -32602, "The group_id argument is required.");
    }
    let db = &state.db;
    let group = match store::get_group(&db, user_id, &group_id).await {
        Ok(Some(g)) => g,
        Ok(None) => return rpc_err(id, -32602, "Group not found."),
        Err(e) => return rpc_err(id, -32000, &format!("Database error: {e}")),
    };
    let members = match store::group_members(&db, user_id, &group_id).await {
        Ok(m) => m,
        Err(e) => return rpc_err(id, -32000, &format!("Database error: {e}")),
    };
    let user_members = match store::group_user_members(&db, &group_id).await {
        Ok(m) => m,
        Err(e) => return rpc_err(id, -32000, &format!("Database error: {e}")),
    };
    let messages = match store::group_history(&db, &group_id, 100).await {
        Ok(m) => m,
        Err(e) => return rpc_err(id, -32000, &format!("Database error: {e}")),
    };
    mcp_data(id, format!("Group {}.", group.name), json!({ "group": group, "members": members, "user_members": user_members, "messages": messages }))
}

async fn call_groups_rename(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let (group_id, name) = (arg_str(args, "group_id"), arg_str(args, "name"));
    if group_id.is_empty() || name.trim().is_empty() {
        return rpc_err(id, -32602, "group_id and name are required.");
    }
    let db = &state.db;
    match store::rename_group(&db, user_id, &group_id, name.trim()).await {
        Ok(Some(group)) => mcp_data(id, format!("Renamed to {}.", group.name), json!({ "group": group })),
        Ok(None) => rpc_err(id, -32602, "Group not found."),
        Err(e) => rpc_err(id, -32000, &format!("Rename failed: {e}")),
    }
}

async fn call_groups_delete(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let group_id = arg_str(args, "group_id");
    if group_id.is_empty() {
        return rpc_err(id, -32602, "The group_id argument is required.");
    }
    let db = &state.db;
    match store::delete_group(&db, user_id, &group_id).await {
        Ok(true) => mcp_data(id, "Group deleted.".to_string(), json!({ "deleted": true })),
        Ok(false) => rpc_err(id, -32602, "Group not found."),
        Err(e) => rpc_err(id, -32000, &format!("Delete failed: {e}")),
    }
}

async fn do_groups_add(db: &crate::db::Db, user_id: &str, group_id: &str, bot_ids: &[String]) -> Result<Vec<String>, String> {
    let mut added = Vec::new();
    for bot_id in bot_ids {
        if store::bot_access(db, user_id, bot_id).await.map_err(|e| e.to_string())?.is_none() {
            continue;
        }
        store::add_group_member(db, user_id, group_id, bot_id)
            .await
            .map_err(|e| e.to_string())?;
        added.push(bot_id.clone());
    }
    Ok(added)
}

async fn call_groups_add_member(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let group_id = arg_str(args, "group_id");
    let single = arg_str(args, "slavebot_id");
    let mut bot_ids: Vec<String> = args
        .get("slavebot_ids")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str()).map(|s| s.to_string()).collect())
        .unwrap_or_default();
    if !single.is_empty() {
        bot_ids.push(single);
    }
    if group_id.is_empty() || bot_ids.is_empty() {
        return rpc_err(id, -32602, "group_id and slavebot_id (or slavebot_ids) are required.");
    }
    let db = &state.db;
    match do_groups_add(&db, user_id, &group_id, &bot_ids).await {
        Ok(added) => mcp_data(id, format!("Added {} bot(s).", added.len()), json!({ "added": added })),
        Err(e) => rpc_err(id, -32602, &e),
    }
}

async fn call_groups_remove_member(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let (group_id, bot_id) = (arg_str(args, "group_id"), arg_str(args, "slavebot_id"));
    if group_id.is_empty() || bot_id.is_empty() {
        return rpc_err(id, -32602, "group_id and slavebot_id are required.");
    }
    let db = &state.db;
    match store::remove_group_member(&db, user_id, &group_id, &bot_id).await {
        Ok(true) => mcp_data(id, "Member removed.".to_string(), json!({ "removed": true })),
        Ok(false) => rpc_err(id, -32602, "Group not found."),
        Err(e) => rpc_err(id, -32602, &format!("Database error: {e}")),
    }
}

async fn call_groups_chat(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let (group_id, message, model) = (arg_str(args, "group_id"), arg_str(args, "message"), arg_str(args, "model"));
    let save_memory = args.get("save_memory").and_then(|v| v.as_bool()).unwrap_or(false);
    if group_id.is_empty() || message.trim().is_empty() {
        return rpc_err(id, -32602, "group_id and message are required.");
    }
    let db = &state.db;
    let model_opt = if model.is_empty() { None } else { Some(model.as_str()) };
    match crate::group::post_chat(&db, user_id, &group_id, &message, model_opt, save_memory).await {
        Ok(v) => {
            let n = v.get("replies").and_then(|r| r.as_array()).map(|a| a.len()).unwrap_or(0);
            mcp_data(id, format!("{n} replie(s)."), v)
        }
        Err(e) => rpc_err(id, -32000, &e),
    }
}

async fn call_groups_broadcast(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let (group_id, text) = (arg_str(args, "group_id"), arg_str(args, "text"));
    let save = args.get("save_to_memory").and_then(|v| v.as_bool()).unwrap_or(false);
    if group_id.is_empty() || text.trim().is_empty() {
        return rpc_err(id, -32602, "group_id and text are required.");
    }
    let db = &state.db;
    match crate::group::post_broadcast(&db, user_id, &group_id, &text, save).await {
        Ok(v) => mcp_data(id, "Posted to the group.".to_string(), v),
        Err(e) => rpc_err(id, -32602, &e),
    }
}

async fn call_meeting_get(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let meeting_id = arg_str(args, "meeting_id");
    if meeting_id.is_empty() {
        return rpc_err(id, -32602, "The meeting_id argument is required.");
    }
    let db = &state.db;
    let meeting = match store::get_meeting(&db, user_id, &meeting_id).await {
        Ok(Some(h)) => h,
        Ok(None) => return rpc_err(id, -32602, "Meeting not found."),
        Err(e) => return rpc_err(id, -32000, &format!("Database error: {e}")),
    };
    let participants = store::meeting_participants(&db, &meeting_id).await.unwrap_or_default();
    let messages = store::meeting_history(&db, &meeting_id, 100).await.unwrap_or_default();
    mcp_data(
        id,
        format!("Meeting: {}.", meeting.topic),
        json!({ "meeting": meeting, "participants": participants, "messages": messages }),
    )
}

async fn call_meeting_delete(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let meeting_id = arg_str(args, "meeting_id");
    if meeting_id.is_empty() {
        return rpc_err(id, -32602, "The meeting_id argument is required.");
    }
    let db = &state.db;
    match store::delete_meeting(&db, user_id, &meeting_id).await {
        Ok(true) => mcp_data(id, "Meeting deleted.".to_string(), json!({ "deleted": true })),
        Ok(false) => rpc_err(id, -32602, "Meeting not found."),
        Err(e) => rpc_err(id, -32000, &format!("Delete failed: {e}")),
    }
}

async fn call_schedules_update(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let schedule_id = arg_str(args, "schedule_id");
    if schedule_id.is_empty() {
        return rpc_err(id, -32602, "The schedule_id argument is required.");
    }
    let db = &state.db;
    if let Some(active) = arg_bool(args, "active") {
        return match store::set_schedule_active(&db, user_id, &schedule_id, active).await {
            Ok(Some(row)) => mcp_data(id, format!("Schedule {}.", if active { "enabled" } else { "disabled" }), json!({ "schedule": row })),
            Ok(None) => rpc_err(id, -32602, "Schedule not found."),
            Err(e) => rpc_err(id, -32000, &format!("Update failed: {e}")),
        };
    }
    rpc_err(id, -32602, "Nothing to update (pass active).")
}

async fn call_summaries_get(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let bot_id = arg_str(args, "slavebot_id");
    if bot_id.is_empty() {
        return rpc_err(id, -32602, "The slavebot_id argument is required.");
    }
    let db = &state.db;
    match store::get_bot(&db, user_id, &bot_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return rpc_err(id, -32602, "SlaveBot not found."),
        Err(e) => return rpc_err(id, -32000, &format!("Database error: {e}")),
    }
    let mut grouped = serde_json::Map::new();
    let mut total = 0usize;
    for period in ["daily", "weekly", "monthly"] {
        match store::list_summaries(&db, &bot_id, period, 30).await {
            Ok(rows) => {
                total += rows.len();
                grouped.insert(period.to_string(), serde_json::to_value(rows).unwrap_or(serde_json::Value::Null));
            }
            Err(e) => return rpc_err(id, -32000, &format!("Database error: {e}")),
        }
    }
    mcp_data(id, format!("{total} summarie(s)."), serde_json::Value::Object(grouped))
}

async fn call_summaries_run(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let bot_id = arg_str(args, "slavebot_id");
    if bot_id.is_empty() {
        return rpc_err(id, -32602, "The slavebot_id argument is required.");
    }
    let db = &state.db;
    let bot = match store::get_bot(&db, user_id, &bot_id).await {
        Ok(Some(b)) => b,
        Ok(None) => return rpc_err(id, -32602, "SlaveBot not found."),
        Err(e) => return rpc_err(id, -32000, &format!("Database error: {e}")),
    };
    match crate::summarize::run_daily(&db, &bot, user_id).await {
        Ok(Some(row)) => mcp_data(id, "Daily summary generated.".to_string(), json!({ "summary": row })),
        Ok(None) => mcp_data(id, "Nothing new to summarize.".to_string(), json!({ "summary": null })),
        Err(e) => rpc_err(id, -32000, &format!("Summarize failed: {e}")),
    }
}

async fn call_teams_get(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let team_id = arg_str(args, "team_id");
    if team_id.is_empty() {
        return rpc_err(id, -32602, "The team_id argument is required.");
    }
    let db = &state.db;
    match crate::teams::team_detail(&db, user_id, &team_id).await {
        Ok(v) => mcp_data(id, "Team.".to_string(), v),
        Err(e) => rpc_err(id, -32602, &e),
    }
}

async fn call_teams_delete(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let team_id = arg_str(args, "team_id");
    if team_id.is_empty() {
        return rpc_err(id, -32602, "The team_id argument is required.");
    }
    let db = &state.db;
    match store::delete_team(&db, &team_id, user_id).await {
        Ok(()) => mcp_data(id, "Team deleted.".to_string(), json!({ "deleted": true })),
        Err(e) => rpc_err(id, -32602, &e),
    }
}

async fn call_teams_set_member(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let (team_id, target) = (arg_str(args, "team_id"), arg_str(args, "user_id"));
    if team_id.is_empty() || target.is_empty() {
        return rpc_err(id, -32602, "team_id and user_id are required.");
    }
    let db = &state.db;
    if let Some(role) = args.get("role").and_then(|v| v.as_str()) {
        if let Err(e) = store::set_member_role(&db, &team_id, user_id, &target, role).await {
            return rpc_err(id, -32602, &e);
        }
    }
    if let Some(bot_ids) = args.get("bot_ids").and_then(|v| v.as_array()) {
        let ids: Vec<String> = bot_ids.iter().filter_map(|v| v.as_str()).map(|s| s.to_string()).collect();
        if let Err(e) = store::set_grants(&db, &team_id, user_id, &target, &ids).await {
            return rpc_err(id, -32602, &e);
        }
    }
    mcp_data(id, "Member updated.".to_string(), json!({ "updated": true }))
}

async fn call_teams_remove_member(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let (team_id, target) = (arg_str(args, "team_id"), arg_str(args, "user_id"));
    if team_id.is_empty() || target.is_empty() {
        return rpc_err(id, -32602, "team_id and user_id are required.");
    }
    let db = &state.db;
    match store::remove_member(&db, &team_id, user_id, &target).await {
        Ok(()) => mcp_data(id, "Member removed.".to_string(), json!({ "removed": true })),
        Err(e) => rpc_err(id, -32602, &e),
    }
}

async fn call_teams_set_provider(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let team_id = arg_str(args, "team_id");
    let preset = arg_str(args, "preset").trim().to_lowercase();
    if team_id.is_empty() || preset.is_empty() {
        return rpc_err(id, -32602, "team_id and preset are required.");
    }
    if !["meta", "baseten", "modal", "openrouter", "opencode", "ollama", "custom"].contains(&preset.as_str()) {
        return rpc_err(id, -32602, "Unknown provider preset. Use meta, baseten, modal, openrouter, opencode, ollama, or custom.");
    }
    let (base_url_raw, api_key) = (arg_str(args, "base_url"), arg_str(args, "api_key"));
    let needs_url = matches!(preset.as_str(), "modal" | "custom" | "opencode" | "ollama" | "baseten");
    let db = &state.db;
    let stored = store::get_team(&db, &team_id).await.map(|t| t.map(|x| (x.provider_base_url, x.provider_api_key)).unwrap_or_default()).unwrap_or_default();
    let (stored_base, stored_key) = stored;
    // Switching to a hosted preset clears a stale custom URL; switching to a
    // URL preset keeps the stored URL when the caller sends none.
    let base_url = if base_url_raw.trim().is_empty() {
        if needs_url { stored_base } else { String::new() }
    } else {
        provider::normalize_base_url(&base_url_raw)
    };
    if needs_url && base_url.trim().is_empty() {
        return rpc_err(id, -32602, "This provider needs a base URL like http://localhost:11434/v1 (do not append /chat/completions).");
    }
    if !api_key.is_empty() && !provider::key_prefix_ok(&preset, &api_key) {
        return rpc_err(id, -32602, "That key does not look like a valid key for this provider.");
    }
    let api_key = if api_key.is_empty() { stored_key } else { api_key };
    // Non-local servers must have a key; local ones (Ollama/OpenCode) may be keyless.
    if api_key.trim().is_empty() && !provider::key_optional_for(&preset, &base_url) && provider::preset_of(&preset).default_base.is_empty() == false {
        // Hosted presets with a default base still need a key unless local.
        if !provider::is_local_url(&base_url) && base_url.is_empty() {
            // base empty + hosted default -> still needs key (checked in provider_for)
        } else if !provider::is_local_url(&base_url) {
            return rpc_err(id, -32602, "This provider needs an API key (or use a keyless local server URL).");
        }
    }
    match store::set_team_provider(&db, &team_id, user_id, &preset, &base_url, &api_key).await {
        Ok(()) => match crate::teams::team_detail(&db, user_id, &team_id).await {
            Ok(v) => mcp_data(id, "Team provider updated.".to_string(), v),
            Err(e) => rpc_err(id, -32602, &e),
        },
        Err(e) => rpc_err(id, -32602, &e),
    }
}

async fn call_teams_test_provider(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let team_id = arg_str(args, "team_id");
    let model = arg_str(args, "model");
    if team_id.is_empty() {
        return rpc_err(id, -32602, "team_id is required.");
    }
    let db = &state.db;
    // Owner/admin only — same rule as set_team_provider.
    match store::membership(&db, &team_id, user_id).await {
        Ok(Some(r)) if r == "owner" || r == "admin" => {}
        Ok(_) => return rpc_err(id, -32602, "Only owners and admins can test the team provider."),
        Err(e) => return rpc_err(id, -32000, &format!("Database error: {e}")),
    }
    let prov = match provider::provider_for(&db, &team_id).await {
        Ok(p) => p,
        Err(e) => return rpc_err(id, -32000, &e.to_string()),
    };
    let diag = provider::test_provider(&prov, &model).await;
    let ok = diag.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let summary = if ok {
        format!("Provider OK: {} with model {}.", diag.get("endpoint").and_then(|v| v.as_str()).unwrap_or(""), diag.get("model").and_then(|v| v.as_str()).unwrap_or(""))
    } else {
        format!("Provider test failed: {}", diag.get("error").and_then(|v| v.as_str()).unwrap_or("unknown error"))
    };
    mcp_data(id, summary, diag)
}

async fn call_teams_clear_provider(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let team_id = arg_str(args, "team_id");
    if team_id.is_empty() {
        return rpc_err(id, -32602, "The team_id argument is required.");
    }
    let db = &state.db;
    let preset = store::get_team(&db, &team_id).await.map(|t| t.map(|x| x.provider).unwrap_or_else(|| "meta".to_string())).unwrap_or_else(|_| "meta".to_string());
    match store::set_team_provider(&db, &team_id, user_id, &preset, "", "").await {
        Ok(()) => mcp_data(id, "Team key removed.".to_string(), json!({ "cleared": true })),
        Err(e) => rpc_err(id, -32602, &e),
    }
}

async fn call_teams_activity(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    let team_id = arg_str(args, "team_id");
    if team_id.is_empty() {
        return rpc_err(id, -32602, "The team_id argument is required.");
    }
    let db = &state.db;
    match store::membership(&db, &team_id, user_id).await {
        Ok(Some(r)) if r == "owner" || r == "admin" => {}
        _ => return rpc_err(id, -32602, "Only owners and admins can view team activity."),
    }
    match store::team_activity(&db, &team_id, 100).await {
        Ok(items) => mcp_data(id, format!("{} activitie(s).", items.len()), json!({ "activity": items })),
        Err(e) => rpc_err(id, -32000, &format!("Activity failed: {e}")),
    }
}

async fn call_usage_get(id: Value, state: &AppState, user_id: &str) -> Response {
    let db = &state.db;
    let credit = store::get_user(&db, user_id).await.map(|u| u.map(|x| x.credit_usd).unwrap_or(0.0)).unwrap_or(0.0);
    match store::list_usage(&db, user_id, 100).await {
        Ok((logs, spent)) => mcp_data(id, format!("Spent ${spent:.4}."), json!({ "credit_usd": credit, "spent_usd": spent, "logs": logs })),
        Err(e) => rpc_err(id, -32000, &format!("Usage failed: {e}")),
    }
}

fn call_harness_config(id: Value, _state: &AppState) -> Response {
    // Self-hosted: the harness lives on this same server under /api.
    mcp_data(id, "Harness runs on this server.".to_string(), json!({ "url": "" }))
}

async fn call_voice_transcribe(id: Value, state: &AppState, user_id: &str, args: &Value) -> Response {
    use base64::Engine;
    let (audio_b64, team_id) = (arg_str(args, "audio_base64"), arg_str(args, "team_id"));
    if audio_b64.trim().is_empty() {
        return rpc_err(id, -32602, "audio_base64 is required (mono 16-bit WAV).");
    }
    let bytes = match base64::engine::general_purpose::STANDARD.decode(audio_b64.trim()) {
        Ok(b) => b,
        Err(_) => return rpc_err(id, -32602, "audio_base64 is not valid base64."),
    };
    let db = &state.db;
    match crate::voice::transcribe_core(&db, user_id, &team_id, bytes).await {
        Ok(v) => mcp_data(id, v.get("transcript").and_then(|t| t.as_str()).unwrap_or("Transcribed.").to_string(), v),
        Err(e) => rpc_err(id, -32000, &e),
    }
}

async fn call_voice_speak(id: Value, _state: &AppState, _user_id: &str, _args: &Value) -> Response {
    // No server TTS voice on self-hosted builds; the app falls back to the
    // built-in browser voice automatically.
    rpc_err(id, -32000, "Server voice is not configured (no TTS provider) — using the built-in browser voice instead.")
}
