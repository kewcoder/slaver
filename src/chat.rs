use serde::{Deserialize, Serialize};
use worker::*;

use crate::{auth, meta, util};

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
struct ChatRequest {
    messages: Option<Vec<ChatMessage>>,
    model: Option<String>,
    stream: Option<bool>,
}

fn valid_messages(messages: &[ChatMessage]) -> bool {
    !messages.is_empty()
        && messages.iter().all(|m| {
            (m.role == "system" || m.role == "user" || m.role == "assistant")
                && !m.content.is_empty()
                && m.content.len() <= 32_000
        })
}

/// POST /api/chat — forwards to Meta Model API, streams SSE bytes straight
/// through without buffering (Worker memory stays flat).
pub async fn chat(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    if auth::bearer_sub(&req, &ctx.env)?.is_none() {
        return util::err(401, "Log in before chatting.");
    }

    let body: ChatRequest = match req.json().await {
        Ok(b) => b,
        Err(_) => return util::err(400, "Invalid JSON body."),
    };
    let mut messages = body.messages.unwrap_or_default();
    if !valid_messages(&messages) {
        return util::err(400, "messages is empty or invalid.");
    }
    if messages.len() > 30 {
        messages = messages[messages.len() - 30..].to_vec();
    }

    let model = body
        .model
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| meta::default_model(&ctx.env));
    let stream = body.stream.unwrap_or(true);

    let mut upstream =
        match meta::post_chat_completions(&ctx.env, &model, &messages, stream).await {
            Ok(r) => r,
            Err(e) => {
                console_error!("chat upstream fetch failed: {e}");
                return util::err(502, "Could not reach the Meta Model API.");
            }
        };

    if upstream.status_code() != 200 {
        let text = upstream.text().await.unwrap_or_default();
        console_error!(
            "chat upstream status={} body={}",
            upstream.status_code(),
            util::truncate(&text, 300)
        );
        return util::json(
            502,
            &serde_json::json!({
                "error": "Meta Model API error.",
                "detail": util::truncate(&text, 500),
            }),
        );
    }

    if !stream {
        let data: serde_json::Value = upstream.json().await.unwrap_or(serde_json::Value::Null);
        return util::json(200, &data);
    }

    let body_stream = upstream.stream()?;
    let mut resp = Response::from_stream(body_stream)?;
    {
        let h = resp.headers_mut();
        h.set("Content-Type", "text/event-stream; charset=utf-8")?;
        h.set("Cache-Control", "no-cache, no-transform")?;
        h.set("Connection", "keep-alive")?;
        h.set("X-Accel-Buffering", "no")?;
    }
    util::cors(&mut resp)?;
    Ok(resp)
}

/// Shared helper used by the MCP `chat` tool: non-streaming completion text.
pub async fn complete_text(
    env: &Env,
    model: &str,
    messages: &[ChatMessage],
) -> Result<String, String> {
    let mut upstream =
        meta::post_chat_completions(env, model, messages, false)
            .await
            .map_err(|e| format!("fetch failed: {e}"))?;
    if upstream.status_code() != 200 {
        let text = upstream.text().await.unwrap_or_default();
        return Err(format!("upstream {}", util::truncate(&text, 300)));
    }
    let data: serde_json::Value = upstream
        .json()
        .await
        .map_err(|e| format!("bad json: {e}"))?;
    data.pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "no content in response".to_string())
}
