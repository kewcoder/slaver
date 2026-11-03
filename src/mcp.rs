use serde_json::{json, Value};
use worker::*;

use crate::{auth, chat, meta, util};

/// GET /mcp — human-readable pointer (real MCP clients use POST /mcp).
pub fn info() -> Result<Response> {
    util::json(
        200,
        &json!({
            "name": "slaver-mcp",
            "transport": "streamable-http",
            "endpoint": "/mcp",
            "methods": ["initialize", "tools/list", "tools/call"],
            "tools": ["chat", "models"],
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
        "tools/list" => rpc_ok(id, json!({ "tools": [chat_tool_def(), models_tool_def()] })),
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
                _ => rpc_err(id, -32602, "Unknown tool. Available: chat, models."),
            }
        }
        "" => rpc_err(id, -32600, "Invalid Request: missing method field."),
        _ => rpc_err(id, -32601, "Unknown method."),
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
