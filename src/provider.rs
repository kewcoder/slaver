use wasm_bindgen::JsValue;
use worker::*;

use crate::{chat::ChatMessage, store};

/// Pluggable AI providers. Every supported backend speaks OpenAI-compatible
/// chat completions, so only the base URL, key, and model list change.
/// Default is Meta (hackathon); OpenRouter is the last-resort preset with a
/// curated model list; Baseten/Modal/custom take the user's own URL + key
/// and free-form model ids.
pub struct Provider {
    pub preset: String,
    pub base_url: String,
    pub api_key: String,
    /// True when the call runs on the user's own key (their key pays).
    pub own: bool,
}

pub struct Preset {
    pub id: &'static str,
    pub label: &'static str,
    pub default_base: &'static str,
    pub server_key_env: Option<&'static str>,
    pub key_hint: &'static str,
}

pub const PRESETS: &[Preset] = &[
    Preset { id: "meta", label: "Meta (default)", default_base: "https://api.meta.ai/v1", server_key_env: Some("META_API_KEY"), key_hint: "Key from dev.meta.ai" },
    Preset { id: "baseten", label: "Baseten", default_base: "https://inference.baseten.co/v1", server_key_env: None, key_hint: "Your Baseten API key" },
    Preset { id: "modal", label: "Modal", default_base: "", server_key_env: None, key_hint: "Your Modal key + your deployed function URL below" },
    Preset { id: "openrouter", label: "OpenRouter (last resort)", default_base: "https://openrouter.ai/api/v1", server_key_env: Some("OPENROUTER_API_KEY"), key_hint: "Key from openrouter.ai/keys (sk-or-v1-...)" },
    Preset { id: "custom", label: "Custom OpenAI-compatible", default_base: "", server_key_env: None, key_hint: "Your API key" },
];

pub fn preset_of(id: &str) -> &'static Preset {
    PRESETS.iter().find(|p| p.id == id).unwrap_or(&PRESETS[0])
}

pub struct ModelInfo {
    pub id: &'static str,
    pub label: &'static str,
}

const META_MODELS: &[ModelInfo] = &[
    ModelInfo { id: "muse-spark-1.3", label: "Muse Spark 1.3 (default)" },
    ModelInfo { id: "muse-wonder-1.0", label: "Muse Wonder (marathon / agent)" },
];

const OPENROUTER_MODELS: &[ModelInfo] = &[
    ModelInfo { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B (default)" },
    ModelInfo { id: "qwen/qwen3.7-flash", label: "Qwen 3.7 Flash (cheapest)" },
    ModelInfo { id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5 (fast)" },
    ModelInfo { id: "deepseek/deepseek-chat", label: "DeepSeek V3" },
    ModelInfo { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    ModelInfo { id: "openai/gpt-5-mini", label: "GPT-5 Mini" },
    ModelInfo { id: "mistralai/mistral-medium-3-5", label: "Mistral Medium 3.5" },
    ModelInfo { id: "x-ai/grok-4.5", label: "Grok 4.5" },
    ModelInfo { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5 (strongest)" },
];

pub fn models_for(preset: &str) -> (&'static [ModelInfo], bool) {
    match preset {
        "openrouter" => (OPENROUTER_MODELS, false),
        "meta" => (META_MODELS, false),
        _ => (&[], true),
    }
}

pub fn default_model_for(preset: &str) -> &'static str {
    match preset {
        "openrouter" => "meta-llama/llama-3.3-70b-instruct",
        "meta" => "muse-spark-1.3",
        _ => "",
    }
}

pub fn valid_for(preset: &str, model: &str) -> bool {
    let model = model.trim();
    if model.is_empty() {
        return false;
    }
    match preset {
        "meta" | "openrouter" => models_for(preset).0.iter().any(|m| m.id == model),
        _ => true,
    }
}

/// Resolve the stored model id for this provider: keep it when valid,
/// otherwise fall back to the provider default (custom providers pass the
/// stored id through — only the provider itself can judge it).
pub fn effective_model(preset: &str, stored: &str) -> String {
    let stored = stored.trim();
    if valid_for(preset, stored) {
        return stored.to_string();
    }
    let def = default_model_for(preset);
    if !def.is_empty() {
        return def.to_string();
    }
    stored.to_string()
}

pub fn key_prefix_ok(preset: &str, key: &str) -> bool {
    match preset {
        "openrouter" => key.starts_with("sk-or-"),
        _ => !key.is_empty(),
    }
}

/// Resolve the effective provider for a user: their own settings win,
/// otherwise the server key for that preset (Meta/OpenRouter only).
pub async fn provider_for(db: &D1Database, env: &Env, user_id: &str) -> Result<Provider, Error> {
    let user = store::get_user(db, user_id).await?;
    let (preset, base_cfg, key_cfg) = match user {
        Some(u) => (u.provider, u.provider_base_url, u.provider_api_key),
        None => (String::new(), String::new(), String::new()),
    };
    let def = preset_of(if preset.trim().is_empty() { "meta" } else { preset.trim() });
    let base_url = if base_cfg.trim().is_empty() {
        def.default_base.to_string()
    } else {
        base_cfg.trim().trim_end_matches('/').to_string()
    };
    let key_cfg = key_cfg.trim().to_string();
    if !key_cfg.is_empty() {
        return Ok(Provider { preset: def.id.to_string(), base_url, api_key: key_cfg, own: true });
    }
    let server = def
        .server_key_env
        .and_then(|name| env.secret(name).ok())
        .map(|s| s.to_string())
        .unwrap_or_default();
    if server.trim().is_empty() {
        return Err(Error::RustError(format!(
            "No model key is set: add your {} key in the sidebar{}.",
            def.label,
            def.server_key_env.map(|_| " or set it on the server").unwrap_or(""),
        )));
    }
    Ok(Provider { preset: def.id.to_string(), base_url, api_key: server, own: false })
}

pub fn model_list(preset: &str) -> serde_json::Value {
    let def = preset_of(preset);
    let (models, custom_allowed) = models_for(def.id);
    let dflt = default_model_for(def.id);
    let models: Vec<serde_json::Value> = models
        .iter()
        .map(|m| serde_json::json!({ "id": m.id, "label": m.label, "default": m.id == dflt }))
        .collect();
    serde_json::json!({
        "provider": def.id,
        "provider_label": def.label,
        "key_hint": def.key_hint,
        "server_key": def.server_key_env.is_some(),
        "models": models,
        "custom_allowed": custom_allowed,
        "default": dflt,
    })
}

pub async fn post_chat_completions(
    prov: &Provider,
    model: &str,
    messages: &[ChatMessage],
    stream: bool,
) -> Result<Response, Error> {
    if prov.api_key.trim().is_empty() {
        return Err(Error::RustError("No model key is set.".to_string()));
    }
    if prov.base_url.trim().is_empty() {
        return Err(Error::RustError("This provider needs a base URL — set it in the sidebar.".to_string()));
    }
    let url = format!("{}/chat/completions", prov.base_url.trim_end_matches('/'));
    // usage.include makes usage-reporting providers (OpenRouter) attach exact
    // token usage to the final SSE chunk; others ignore it.
    let mut payload = serde_json::json!({ "model": model, "messages": messages, "stream": stream });
    if stream {
        payload["usage"] = serde_json::json!({ "include": true });
    }

    let headers = Headers::new();
    headers.set("Content-Type", "application/json")?;
    headers.set("Authorization", &format!("Bearer {}", prov.api_key.trim()))?;
    headers.set("HTTP-Referer", "https://slaver.app")?;
    headers.set("X-Title", "Slaver")?;

    let mut init = RequestInit::new();
    init.with_method(Method::Post);
    init.with_headers(headers);
    init.with_body(Some(JsValue::from_str(&payload.to_string())));

    let req = Request::new_with_init(&url, &init)?;
    Fetch::Request(req).send().await
}
