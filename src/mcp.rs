use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

use crate::{auth, provider, store, AppState};


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

fn models_tool_def() -> Value {
    json!({
        "name": "models",
        "description": "List available Meta models.",
        "inputSchema": { "type": "object", "properties": {} }
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
        "description": "Invite a registered user to a team by email as admin or staff (owner-only for admin). Staff can use the team's apps; owners and admins also manage them.",
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
            let mut tools = vec![auth_register_tool_def(), auth_login_tool_def(), auth_me_tool_def(), user_set_lang_tool_def(), models_tool_def(), team_create_tool_def(), team_list_tool_def(), teams_get_tool_def(), teams_delete_tool_def(), team_invite_tool_def(), teams_set_member_tool_def(), teams_remove_member_tool_def(), teams_set_provider_tool_def(), teams_test_provider_tool_def(), teams_clear_provider_tool_def()];
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
                "team_create" => call_team_create(id, &state, &user_id, &args).await,
                "team_list" => call_team_list(id, &state, &user_id, &args).await,
                "team_invite" => call_team_invite(id, &state, &user_id, &args).await,
                    "auth_me" => call_auth_me(id, &state, &user_id).await,
                    "user_set_lang" => {
                        let lang = args.get("lang").and_then(|v| v.as_str()).unwrap_or("");
                        match crate::auth::set_lang_core(&state.db, &user_id, lang).await {
                            Ok(u) => mcp_data(id, "Language updated.".to_string(), json!({ "user": u })),
                            Err(e) => rpc_err(id, -32602, &e),
                        }
                    }
                "teams_get" => call_teams_get(id, &state, &user_id, &args).await,
                "teams_delete" => call_teams_delete(id, &state, &user_id, &args).await,
                "teams_set_member" => call_teams_set_member(id, &state, &user_id, &args).await,
                "teams_remove_member" => call_teams_remove_member(id, &state, &user_id, &args).await,
                "teams_set_provider" => call_teams_set_provider(id, &state, &user_id, &args).await,
                "teams_test_provider" => call_teams_test_provider(id, &state, &user_id, &args).await,
                "teams_clear_provider" => call_teams_clear_provider(id, &state, &user_id, &args).await,
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

fn arg_str(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
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
        "description": "Current user profile (id, email, name, lang).",
        "inputSchema": { "type": "object", "properties": {} }
    })
}

fn user_set_lang_tool_def() -> Value {
    json!({
        "name": "user_set_lang",
        "description": "Set the app UI language for the current user ('en' or 'id'). Returns the updated profile.",
        "inputSchema": { "type": "object", "required": ["lang"], "properties": { "lang": { "type": "string", "enum": ["en", "id"] } } }
    })
}

fn teams_get_tool_def() -> Value {
    json!({ "name": "teams_get", "description": "Team detail: team (AI key hidden), your role, members.", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" } } } })
}

fn teams_delete_tool_def() -> Value {
    json!({ "name": "teams_delete", "description": "Delete a team. Owner/admin only; personal team cannot be deleted.", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" } } } })
}

fn teams_set_member_tool_def() -> Value {
    json!({ "name": "teams_set_member", "description": "Change a member's role (admin/staff). Owner only.", "inputSchema": { "type": "object", "required": ["team_id", "user_id"], "properties": { "team_id": { "type": "string" }, "user_id": { "type": "string" }, "role": { "type": "string" } } } })
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
