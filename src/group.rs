use crate::{chat, db::Db, provider, store};

/// Group missions: one task fans out to many slaveBots, and info can be
/// broadcast into the shared thread and saved into bot memories.
/// Core group chat: one message fans out to every member bot (each billed).
/// Returns the payload value the app renders as the round of replies.
pub(crate) async fn post_chat(
    db: &Db,
    user_id: &str,
    group_id: &str,
    message: &str,
    model_override: Option<&str>,
    save_memory: bool,
) -> Result<serde_json::Value, String> {
    let message = message.trim();
    if message.is_empty() || message.len() > 8000 {
        return Err("message must be 1..8000 characters.".to_string());
    }
    let group = store::get_group(db, user_id, group_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Group not found.".to_string())?;
    // Save the message first so customer questions are never lost, even when
    // the provider is misconfigured or no agent can reply right now.
    store::insert_group_message(db, group_id, None, Some(user_id), "user", message)
        .await
        .map_err(|e| e.to_string())?;
    let prov = provider::provider_for(db, &group.team_id)
        .await
        .map_err(|e| e.to_string())?;
    let members = store::group_members(db, user_id, group_id)
        .await
        .map_err(|e| e.to_string())?;
    if members.is_empty() {
        return Err("Add slaveBots to the group first.".to_string());
    }
    let thread = store::group_history(db, group_id, 20)
        .await
        .map_err(|e| e.to_string())?;
    let mut replies = Vec::new();
    let mut total_cost = 0.0;
    // Public support groups: every member bot replies, even though the
    // poster is from another team (the owning team's key pays, since own=true).
    let is_public = group.is_public != 0;
    for bot in &members {
        if !is_public && store::bot_access(db, user_id, &bot.id).await.map_err(|e| e.to_string())?.is_none() {
            continue;
        }
        let model = match model_override.filter(|m| provider::valid_for(&prov.preset, m)) {
            Some(m) => m.to_string(),
            None => provider::effective_model(&prov.preset, &bot.model),
        };
        let mut history = vec![chat::ChatMessage {
            role: "user".to_string(),
            content: format!("You are {name}, one of several slaveBots discussing a shared task. Reply as yourself.", name = bot.name),
            ..Default::default()
        }];
        for row in &thread {
            let content = match (&row.slavebot_id, &row.bot_name) {
                (Some(id), Some(name)) if id != &bot.id => format!("[{name}]: {}", row.content),
                (Some(id), _) if id != &bot.id => format!("[teammate]: {}", row.content),
                _ => row.content.clone(),
            };
            let role = if row.role == "assistant" { "assistant" } else { "user" };
            history.push(chat::ChatMessage { role: role.to_string(), content, ..Default::default() });
        }
        let recaps = crate::summarize::context_block(db, &bot.id).await.unwrap_or_default();
        let memory_block = bot.memory.trim();
        let mut with_context = Vec::with_capacity(history.len() + 2);
        if !memory_block.is_empty() {
            with_context.push(chat::ChatMessage {
                role: "system".to_string(),
                content: format!("Bot memory set by the owner (treat as persistent facts):\n{memory_block}"),
                ..Default::default()
            });
        }
        if !recaps.trim().is_empty() {
            with_context.push(chat::ChatMessage { role: "system".to_string(), content: recaps, ..Default::default() });
        }
        with_context.extend(history);
        let done = match chat::complete_with_usage(&prov, &model, &with_context, Some(group_id)).await {
            Ok(d) => d,
            Err(e) => {
                // Friendly validation errors (missing model/key) are shown as-is;
                // only wrap genuine upstream failures.
                let msg = if e.starts_with("No model") || e.starts_with("No model key") || e.starts_with("This provider") {
                    e
                } else {
                    chat::describe_upstream_error(502, &e)
                };
                replies.push(serde_json::json!({
                    "slavebot_id": bot.id, "name": bot.name,
                    "error": msg,
                }));
                continue;
            }
        };
        store::insert_group_message(db, group_id, Some(&bot.id), None, "assistant", &done.text)
            .await
            .map_err(|e| e.to_string())?;
        let cost = store::record_usage(
            db,
            user_id,
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
        .await
        .map_err(|e| e.to_string())?;
        total_cost += cost;
        replies.push(serde_json::json!({
            "slavebot_id": bot.id, "name": bot.name, "reply": done.text,
            "usage": { "prompt_tokens": done.prompt_tokens, "completion_tokens": done.completion_tokens, "estimated": done.estimated },
            "cost_usd": cost,
        }));
    }
    let mut saved_to_memory = Vec::new();
    if save_memory {
        for bot in &members {
            if store::append_memory(db, user_id, &bot.id, message).await.unwrap_or(None).is_some() {
                saved_to_memory.push(bot.name.clone());
            }
        }
    }
    store::touch_group(db, group_id).await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "replies": replies, "total_cost_usd": total_cost, "saved_to_memory": saved_to_memory }))
}

/// Core broadcast: post one info message to the shared thread, optionally
/// appending it to every member's memory.
pub(crate) async fn post_broadcast(
    db: &Db,
    user_id: &str,
    group_id: &str,
    text: &str,
    save_to_memory: bool,
) -> Result<serde_json::Value, String> {
    let text = text.trim();
    if text.is_empty() || text.len() > 2000 {
        return Err("text must be 1..2000 characters.".to_string());
    }
    store::get_group(db, user_id, group_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Group not found.".to_string())?;
    store::insert_group_message(db, group_id, None, Some(user_id), "user", text)
        .await
        .map_err(|e| e.to_string())?;
    let mut saved_to = Vec::new();
    if save_to_memory {
        for member in store::group_members(db, user_id, group_id).await.map_err(|e| e.to_string())? {
            if store::append_memory(db, user_id, &member.id, text).await.unwrap_or(None).is_some() {
                saved_to.push(member.name.clone());
            }
        }
    }
    Ok(serde_json::json!({ "posted": true, "saved_to_memory": saved_to }))
}
