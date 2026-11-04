//! Calling the team's model API (Meta by default): message types and a
//! non-streaming completion helper. Used by listing review and app customize.

use serde::{Deserialize, Serialize};
use crate::provider;

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ToolCallMsg {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub function: FunctionCall,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallMsg>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl Default for ChatMessage {
    fn default() -> Self {
        Self { role: String::new(), content: String::new(), tool_calls: None, tool_call_id: None }
    }
}

impl ChatMessage {
    pub fn text(role: &str, content: String) -> Self {
        Self { role: role.to_string(), content, tool_calls: None, tool_call_id: None }
    }
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
/// provider (personal settings or shared server key). `session` is a stable
/// per-conversation id, forwarded as `x-opencode-session` on OpenCode
/// endpoints (the Go gateway rejects requests without it).
pub async fn complete_with_usage(
    prov: &provider::Provider,
    model: &str,
    messages: &[ChatMessage],
    session: Option<&str>,
) -> Result<Completion, String> {
    provider::require_model(&prov.preset, model)?;
    let upstream =
        provider::post_chat_completions(prov, model.trim(), messages, false, session)
            .await
            .map_err(|e| format!("fetch failed: {e}"))?;
    if upstream.status_code() != 200 {
        let status = upstream.status_code();
        let text = upstream.text();
        return Err(describe_upstream_error(status, &text));
    }
    let data: serde_json::Value = upstream
        .json()
        .map_err(|e| format!("bad json: {e}"))?;
    // Chat Completions shape first, Responses-API shape as fallback
    // (OpenCode serves some models, e.g. muse-spark-*, only via /responses).
    let text = data
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| extract_responses_text(&data))
        .ok_or_else(|| "no content in response".to_string())?;
    let usage = data.get("usage");
    let prompt = usage
        .and_then(|u| u.get("prompt_tokens").or_else(|| u.get("input_tokens")))
        .and_then(|v| v.as_u64())
        .unwrap_or_else(|| {
            messages.iter().map(|m| m.role.len() + m.content.len()).sum::<usize>() as u64 / 4
        });
    let cached = usage
        .and_then(|u| {
            u.get("prompt_tokens_details")
                .and_then(|d| d.get("cached_tokens"))
                .or_else(|| {
                    u.get("input_token_details")
                        .and_then(|d| d.get("cached_tokens"))
                })
        })
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let completion = usage
        .and_then(|u| u.get("completion_tokens").or_else(|| u.get("output_tokens")))
        .and_then(|v| v.as_u64())
        .unwrap_or_else(|| (text.len() as u64) / 4);
    Ok(Completion {
        text,
        prompt_tokens: prompt,
        cached_tokens: cached,
        completion_tokens: completion,
        estimated: usage.is_none(),
    })
}

/// Pull the assistant text out of a Responses-API payload:
/// `output: [{type: "message", content: [{type: "output_text", text}]}]`.
/// Reasoning/tool items are skipped — only the visible message counts.
fn extract_responses_text(v: &serde_json::Value) -> Option<String> {
    let items = v.get("output")?.as_array()?;
    let mut out = String::new();
    for item in items {
        if item.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        let contents = match item.get("content").and_then(|c| c.as_array()) {
            Some(c) => c,
            None => continue,
        };
        for c in contents {
            let kind = c.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if kind == "output_text" || kind == "text" {
                if let Some(t) = c.get("text").and_then(|x| x.as_str()) {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(t);
                }
            }
        }
    }
    if out.trim().is_empty() {
        None
    } else {
        Some(out)
    }
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
    // OpenCode Go rejects requests without a routing session id — Slaver sends
    // one automatically, so seeing this means the header was dropped upstream.
    if text.contains("x-opencode-session") {
        return format!("Model API error ({status}): OpenCode Go needs an x-opencode-session header — Slaver sends one automatically, so please retry. If it persists, report it. Body: {}.", text.trim().chars().take(200).collect::<String>());
    }
    let hint = match status {
        400 => " The request was rejected — often a bad model id or bad `max_tokens`/params for this server.",
        401 => " Check that the team API key is valid (Teams settings). For keyless local servers (Ollama / OpenCode gateway), leave the key empty.",
        403 => " The key was rejected or lacks access to this model.",
        404 => " The model id or endpoint path was not found. Check: (1) base URL ends with `/v1` and NOT `/chat/completions` (we append it), (2) the model id exactly matches one entry of the server's `/v1/models` list — use Teams → Test connection to verify.",
        429 => " Rate limited — wait a bit and retry.",
        500..=599 => " The provider had an internal error — retry later.",
        _ => "",
    };
    match upstream_message(text) {
        Some(m) => format!("Model API error ({status}): {m}.{hint}"),
        None => {
            let body = text.trim();
            if body.is_empty() {
                format!("Model API error ({status}).{hint}")
            } else {
                format!("Model API error ({status}): {}.{hint}", body.chars().take(300).collect::<String>())
            }
        }
    }
}

