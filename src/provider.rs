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
    pub key_hint: &'static str,
}

pub const PRESETS: &[Preset] = &[
    Preset { id: "meta", label: "Meta (default)", default_base: "https://api.meta.ai/v1", key_hint: "Key from dev.meta.ai" },
    Preset { id: "baseten", label: "Baseten", default_base: "https://inference.baseten.co/v1", key_hint: "Your Baseten API key" },
    Preset { id: "modal", label: "Modal", default_base: "", key_hint: "Your Modal key + your deployed function URL below" },
    Preset { id: "openrouter", label: "OpenRouter (last resort)", default_base: "https://openrouter.ai/api/v1", key_hint: "Key from openrouter.ai/keys (sk-or-v1-...)" },
    Preset { id: "opencode", label: "OpenCode / local gateway (OpenAI-compatible)", default_base: "http://localhost:4096/v1", key_hint: "Key if your gateway needs one — leave empty for keyless local servers" },
    Preset { id: "ollama", label: "Ollama (local)", default_base: "http://localhost:11434/v1", key_hint: "Ollama needs no key — leave empty (any value also works)" },
    Preset { id: "custom", label: "Custom OpenAI-compatible", default_base: "", key_hint: "Your API key (leave empty only for keyless local servers)" },
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

/// Example model ids shown in the UI for free-form providers.
pub fn example_models_for(preset: &str) -> &'static str {
    match preset {
        "ollama" => "e.g. qwen3:8b, llama3.3:70b, mistral-small3.1 (ollama list)",
        "opencode" => "e.g. the model id your gateway exposes (must match /v1/models)",
        "baseten" => "e.g. your deployed Baseten model id",
        "modal" => "e.g. your deployed Modal model id",
        _ => "e.g. gpt-4o-mini, qwen3:8b — must exist on your server",
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

/// Human-friendly error when no model id is configured (the most common
/// cause of a confusing upstream 404 on custom providers).
pub fn require_model(preset: &str, model: &str) -> Result<String, String> {
    let m = model.trim().to_string();
    if !m.is_empty() {
        return Ok(m);
    }
    Err(match preset {
        "ollama" => "No model is set for this bot. Run `ollama list`, then set the exact id in Bot settings (e.g. qwen3:8b).".to_string(),
        "opencode" => "No model is set for this bot. Check what your gateway exposes (its /v1/models list) and set that exact id in Bot settings.".to_string(),
        _ if custom_allowed_for(preset) => "No model is set for this bot. Set the exact model id your server exposes in Bot settings.".to_string(),
        _ => format!("No model is set for this bot (preset {preset}). Pick one in Bot settings."),
    })
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

/// Normalize a user-supplied base URL: trim whitespace, drop a pasted
/// `/chat/completions` suffix (we append that ourselves), drop trailing `/`.
pub fn normalize_base_url(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    // Allow "host/v1/chat/completions" pastes — strip the endpoint suffix.
    loop {
        let t = s.trim_end_matches('/').to_string();
        if let Some(prefix) = t.strip_suffix("/chat/completions") {
            s = prefix.to_string();
            continue;
        }
        s = t;
        break;
    }
    s
}

/// True for loopback / LAN hosts where a keyless server (Ollama, OpenCode
/// gateway, LM Studio, vLLM) is expected.
pub fn is_local_url(base_url: &str) -> bool {
    let lower = base_url.trim().to_lowercase();
    // Strip scheme for host matching.
    let host_part = lower
        .split("://")
        .last()
        .unwrap_or(&lower)
        .split('/')
        .next()
        .unwrap_or("");
    let host = host_part.split(':').next().unwrap_or("");
    host == "localhost"
        || host == "127.0.0.1"
        || host == "0.0.0.0"
        || host == "::1"
        || host == "[::1]"
        || host.ends_with(".local")
        || host.starts_with("192.168.")
        || host.starts_with("10.")
        || {
            // 172.16.0.0/12
            if let Some(rest) = host.strip_prefix("172.") {
                rest.split('.')
                    .next()
                    .and_then(|o| o.parse::<u8>().ok())
                    .map(|o| (16..=31).contains(&o))
                    .unwrap_or(false)
            } else {
                false
            }
        }
}

/// Presets that accept any model id (free-form). Everything else has a fixed list.
pub fn custom_allowed_for(preset: &str) -> bool {
    matches!(preset, "custom" | "opencode" | "ollama" | "baseten" | "modal")
}

/// A key may be omitted for keyless local servers; everywhere else it is required.
pub fn key_optional_for(preset: &str, base_url: &str) -> bool {
    matches!(preset, "ollama" | "opencode" | "custom" | "modal") && is_local_url(base_url)
}

pub fn key_prefix_ok(preset: &str, key: &str) -> bool {
    match preset {
        "openrouter" => key.starts_with("sk-or-"),
        _ => !key.is_empty(),
    }
}

/// Resolve the preset id for a team without needing its key (used for
/// default-model selection when creating bots).
pub async fn preset_for_team(db: &D1Database, team_id: &str) -> String {
    match store::get_team(db, team_id).await {
        Ok(Some(t)) if !t.provider.trim().is_empty() => t.provider.trim().to_string(),
        _ => "meta".to_string(),
    }
}

/// Resolve the effective provider for a team: the team's own key always
/// pays (own: true), so team usage is logged but never touches demo credit.
/// There is no server fallback — every team configures its key in team settings.
/// Keyless local servers (Ollama / OpenCode gateway on localhost) may omit the key.
pub async fn provider_for(db: &D1Database, team_id: &str) -> Result<Provider, Error> {
    let team = store::get_team(db, team_id)
        .await?
        .ok_or_else(|| Error::RustError("Team not found.".to_string()))?;
    let def = preset_of(if team.provider.trim().is_empty() { "meta" } else { team.provider.trim() });
    let raw_base = team.provider_base_url.trim();
    let base_url = if raw_base.is_empty() {
        def.default_base.to_string()
    } else {
        normalize_base_url(raw_base)
    };
    let key = team.provider_api_key.trim().to_string();
    if key.is_empty() && !key_optional_for(def.id, &base_url) {
        return Err(Error::RustError(format!(
            "No model key is set for this team: an owner or admin must add the {} key in Teams settings.",
            def.label,
        )));
    }
    Ok(Provider { preset: def.id.to_string(), base_url, api_key: key, own: true })
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
        "models": models,
        "custom_allowed": custom_allowed,
        "default": dflt,
        "example_models": example_models_for(def.id),
        "default_base": def.default_base,
    })
}

pub async fn post_chat_completions(
    prov: &Provider,
    model: &str,
    messages: &[ChatMessage],
    stream: bool,
) -> Result<Response, Error> {
    if !prov.api_key.trim().is_empty() {
        // ok
    } else if !key_optional_for(&prov.preset, &prov.base_url) {
        return Err(Error::RustError("No model key is set.".to_string()));
    }
    let base = normalize_base_url(&prov.base_url);
    if base.is_empty() {
        return Err(Error::RustError("This provider needs a base URL — an owner or admin must set it in Teams settings.".to_string()));
    }
    if model.trim().is_empty() {
        return Err(Error::RustError(require_model(&prov.preset, model).unwrap_err()));
    }
    let url = format!("{base}/chat/completions");
    // usage.include makes usage-reporting providers (OpenRouter) attach exact
    // token usage to the final SSE chunk; others ignore it.
    let mut payload = serde_json::json!({ "model": model.trim(), "messages": messages, "stream": stream });
    if stream {
        payload["usage"] = serde_json::json!({ "include": true });
    }

    let headers = Headers::new();
    headers.set("Content-Type", "application/json")?;
    if !prov.api_key.trim().is_empty() {
        headers.set("Authorization", &format!("Bearer {}", prov.api_key.trim()))?;
    }
    headers.set("HTTP-Referer", "https://slaver.app")?;
    headers.set("X-Title", "Slaver")?;

    let mut init = RequestInit::new();
    init.with_method(Method::Post);
    init.with_headers(headers);
    init.with_body(Some(JsValue::from_str(&payload.to_string())));

    let req = Request::new_with_init(&url, &init)?;
    Fetch::Request(req).send().await
}

/// Connectivity check used by `teams_test_provider`: lists `/models` (when the
/// server exposes it) and sends a 1-token `ping` chat completion. Returns a
/// diagnostics object; never includes the key.
pub async fn test_provider(prov: &Provider, model: &str) -> serde_json::Value {
    let base = normalize_base_url(&prov.base_url);
    let mut notes: Vec<String> = Vec::new();
    if base.is_empty() {
        return serde_json::json!({ "ok": false, "error": "Base URL is empty — set it in Teams settings.", "endpoint": "", "model": model });
    }
    let endpoint = format!("{base}/chat/completions");
    let headers = || {
        let h = Headers::new();
        if h.set("Content-Type", "application/json").is_err() {
            return None;
        }
        if !prov.api_key.trim().is_empty()
            && h.set("Authorization", &format!("Bearer {}", prov.api_key.trim())).is_err()
        {
            return None;
        }
        Some(h)
    };

    // 1) Optional: GET /models — supported by Ollama, vLLM, LM Studio,
    // OpenCode gateways and most OpenAI-compatible servers.
    let mut listed_models: Vec<String> = Vec::new();
    {
        let url = format!("{base}/models");
        let mut ok = false;
        if let Some(h) = headers() {
            let mut init = RequestInit::new();
            init.with_method(Method::Get);
            init.with_headers(h);
            if let Ok(r) = Request::new_with_init(&url, &init) {
                if let Ok(mut resp) = Fetch::Request(r).send().await {
                    if resp.status_code() == 200 {
                        if let Ok(v) = resp.json::<serde_json::Value>().await {
                            if let Some(arr) = v.get("data").and_then(|d| d.as_array()) {
                                for m in arr.iter().take(50) {
                                    if let Some(id) = m.get("id").and_then(|x| x.as_str()) {
                                        listed_models.push(id.to_string());
                                    }
                                }
                            }
                            ok = true;
                        }
                    } else {
                        let s = resp.status_code();
                        let t = resp.text().await.unwrap_or_default();
                        notes.push(format!("/models returned {s}{}.", if t.trim().is_empty() { String::new() } else { format!(": {}", t.trim().chars().take(160).collect::<String>()) }));
                    }
                }
            }
        }
        if !ok && listed_models.is_empty() {
            notes.push("Could not list /models (some servers disable it — continuing with a ping).".to_string());
        }
    }

    // 2) Tiny ping completion to prove model + key + endpoint actually work.
    let ping_model = if model.trim().is_empty() {
        listed_models.first().cloned().unwrap_or_default()
    } else {
        model.trim().to_string()
    };
    if ping_model.is_empty() {
        return serde_json::json!({
            "ok": false,
            "error": "No model id to test — set the exact model id in Bot settings first.",
            "endpoint": endpoint, "models": listed_models, "notes": notes,
        });
    }
    let payload = serde_json::json!({
        "model": ping_model,
        "messages": [{ "role": "user", "content": "ping" }],
        "max_tokens": 1,
    });
    let mut init = RequestInit::new();
    init.with_method(Method::Post);
    let Some(h) = headers() else {
        return serde_json::json!({ "ok": false, "error": "Could not build request headers.", "endpoint": endpoint });
    };
    init.with_headers(h);
    init.with_body(Some(JsValue::from_str(&payload.to_string())));
    let reply_text: Result<String, String> = match Request::new_with_init(&endpoint, &init) {
        Err(e) => Err(format!("Could not reach {endpoint}: {e}")),
        Ok(r) => match Fetch::Request(r).send().await {
            Err(e) => Err(format!("Could not reach {endpoint}: {e}")),
            Ok(mut resp) => {
                let status = resp.status_code();
                let text = resp.text().await.unwrap_or_default();
                if status != 200 {
                    Err(crate::chat::describe_upstream_error(status, &text))
                } else {
                    Ok(text.chars().take(200).collect())
                }
            }
        },
    };
    match reply_text {
        Ok(_) => serde_json::json!({ "ok": true, "endpoint": endpoint, "model": ping_model, "models": listed_models, "notes": notes }),
        Err(e) => serde_json::json!({ "ok": false, "error": e, "endpoint": endpoint, "model": ping_model, "models": listed_models, "notes": notes }),
    }
}
