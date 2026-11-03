use serde::{Deserialize, Serialize};
use worker::*;

use crate::{pricing, provider, schedule, store};

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
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

pub struct SendAsResult {
    pub reply: String,
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
    let model = provider::effective_model(&prov.preset, &to.model).trim().to_string();
    provider::require_model(&prov.preset, &model)?;
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
    Ok(SendAsResult { reply: done.text, to_bot_id: to.id, cost_usd: cost })
}

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
pub(crate) async fn send_message(
    db: &D1Database,
    user_id: &str,
    bot_id: &str,
    message: &str,
    model_override: Option<&str>,
) -> Result<serde_json::Value, String> {
    let message = message.trim();
    if message.is_empty() || message.len() > 8000 {
        return Err("message must be 1..8000 characters.".to_string());
    }
    let bot = store::get_bot(db, user_id, bot_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "SlaveBot not found.".to_string())?;
    if message.starts_with('/') {
        return command_reply(db, user_id, &bot, message)
            .await
            .map_err(|e| e.to_string());
    }
    let prov = provider::provider_for(db, &bot.team_id)
        .await
        .map_err(|e| e.to_string())?;
    let credit = store::get_user(db, user_id)
        .await
        .map_err(|e| e.to_string())?
        .map(|u| u.credit_usd)
        .unwrap_or(0.0);
    if !prov.own && credit <= 0.0 {
        return Err("Out of credit (balance $0.00). Demo credit is $10 per user.".to_string());
    }
    let model = match model_override.filter(|m| provider::valid_for(&prov.preset, m)) {
        Some(m) => m.trim().to_string(),
        None => provider::effective_model(&prov.preset, &bot.model).trim().to_string(),
    };
    if let Err(e) = provider::require_model(&prov.preset, &model) {
        return Err(e);
    }
    // The agent may consult peer bots itself before replying (one hop max).
    let relay_notes = consult_peers(db, &prov, &model, &bot, user_id, message).await;
    store::insert_message(db, bot_id, "user", message)
        .await
        .map_err(|e| e.to_string())?;
    store::maybe_title_bot(db, bot_id, message)
        .await
        .map_err(|e| e.to_string())?;
    let recaps = crate::summarize::context_block(db, bot_id).await.unwrap_or_default();
    let mut history = with_memory(&bot.memory, &recaps, store::recent_messages(db, bot_id, 20).await.map_err(|e| e.to_string())?);
    history.extend(relay_notes);
    let done = complete_with_usage(&prov, &model, &history)
        .await
        .map_err(|e| e.to_string())?;
    store::insert_message(db, bot_id, "assistant", &done.text)
        .await
        .map_err(|e| e.to_string())?;
    store::touch_bot(db, bot_id).await.map_err(|e| e.to_string())?;
    let (cost, remaining) = store::record_usage(
        db,
        user_id,
        Some(bot_id),
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
    Ok(serde_json::json!({
        "slavebot_id": bot_id,
        "reply": done.text,
        "usage": { "prompt_tokens": done.prompt_tokens, "completion_tokens": done.completion_tokens, "estimated": done.estimated },
        "cost_usd": cost,
        "credit_usd": remaining,
    }))
}

/// Slash commands without a model call. Returns the reply payload value
/// (same shape the app renders as a bot message).
pub(crate) async fn command_reply(
    db: &D1Database,
    user_id: &str,
    bot: &store::BotRow,
    message: &str,
) -> Result<serde_json::Value, Error> {
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
    Ok(serde_json::json!({
        "slavebot_id": bot.id,
        "reply": reply,
        "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
        "cost_usd": 0.0,
        "credit_usd": credit,
    }))
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
    provider::require_model(&prov.preset, model)?;
    let mut upstream =
        provider::post_chat_completions(prov, model.trim(), messages, false)
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
