use anyhow::anyhow;
use std::sync::LazyLock;

use crate::{chat::ChatMessage, db::Db, store};

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .expect("http client builds")
});

/// Eager upstream response with the old worker::Response call shape
/// (`status_code()`, `text()`, `json()`), backed by reqwest.
pub struct Upstream {
    status: u16,
    text: String,
}

impl Upstream {
    async fn from_reqwest(resp: reqwest::Response) -> anyhow::Result<Self> {
        let status = resp.status().as_u16();
        let text = resp.text().await?;
        Ok(Self { status, text })
    }

    pub fn status_code(&self) -> u16 {
        self.status
    }

    pub fn text(&self) -> String {
        self.text.clone()
    }

    pub fn json<T: serde::de::DeserializeOwned>(&self) -> anyhow::Result<T> {
        Ok(serde_json::from_str(&self.text)?)
    }
}

fn upstream_headers(prov: &Provider, session: Option<&str>) -> reqwest::header::HeaderMap {
    let mut h = reqwest::header::HeaderMap::new();
    h.insert(
        reqwest::header::CONTENT_TYPE,
        reqwest::header::HeaderValue::from_static("application/json"),
    );
    if !prov.api_key.trim().is_empty() {
        if let Ok(v) = reqwest::header::HeaderValue::from_str(&format!("Bearer {}", prov.api_key.trim())) {
            h.insert(reqwest::header::AUTHORIZATION, v);
        }
    }
    h.insert("http-referer", reqwest::header::HeaderValue::from_static("https://slaver.app"));
    h.insert("x-title", reqwest::header::HeaderValue::from_static("Slaver"));
    // OpenCode Go routes on a stable per-conversation session id; without it
    // the gateway rejects the request (400). Only OpenCode reads this header.
    if normalize_base_url(&prov.base_url).contains("opencode.ai") {
        if let Some(s) = session.map(str::trim).filter(|s| !s.is_empty()) {
            if let Ok(v) = reqwest::header::HeaderValue::from_str(&s.chars().take(128).collect::<String>()) {
                h.insert("x-opencode-session", v);
            }
        }
    }
    h
}

/// Pluggable AI providers. Every supported backend speaks OpenAI-compatible
/// chat completions, so only the base URL, key, and model list change.
/// Default is Meta (hackathon); OpenRouter is the last-resort preset with a
/// curated model list; Baseten/Modal/custom take the user's own URL + key
/// and free-form model ids.
pub struct Provider {
    pub preset: String,
    pub base_url: String,
    pub api_key: String,
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
    Preset { id: "opencode", label: "OpenCode (Go subscription or Console credits)", default_base: "https://opencode.ai/inference/go/openai/v1", key_hint: "Your opencode.ai API key (oc_sk-...). Go subscribers use the /go/ endpoint; pay-as-you-go uses /inference/openai/v1" },
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
        "opencode" => "Go via chat/completions, e.g. glm-5.3-flash, kimi-k2.7-code, deepseek-v4.1-flash, muse-spark-1.3-contributor (full list: opencode.ai inference /v1/models)",
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
pub async fn preset_for_team(db: &Db, team_id: &str) -> String {
    match store::get_team(db, team_id).await {
        Ok(Some(t)) if !t.provider.trim().is_empty() => t.provider.trim().to_string(),
        _ => "meta".to_string(),
    }
}

/// Resolve the effective provider for a team: every team brings its own key
/// (Slaver sells no credit). There is no server fallback — every team
/// configures its key in team settings.
/// Keyless local servers (Ollama / OpenCode gateway on localhost) may omit the key.
pub async fn provider_for(db: &Db, team_id: &str) -> anyhow::Result<Provider> {
    let team = store::get_team(db, team_id)
        .await?
        .ok_or_else(|| anyhow!("Team not found."))?;
    let def = preset_of(if team.provider.trim().is_empty() { "meta" } else { team.provider.trim() });
    let raw_base = team.provider_base_url.trim();
    let base_url = if raw_base.is_empty() {
        def.default_base.to_string()
    } else {
        normalize_base_url(raw_base)
    };
    let key = team.provider_api_key.trim().to_string();
    if key.is_empty() && !key_optional_for(def.id, &base_url) {
        return Err(anyhow!(
            "No model key is set for this team: an owner or admin must add the {} key in Teams settings.",
            def.label,
        ));
    }
    Ok(Provider { preset: def.id.to_string(), base_url, api_key: key })
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
    session: Option<&str>,
) -> anyhow::Result<Upstream> {
    if !prov.api_key.trim().is_empty() {
        // ok
    } else if !key_optional_for(&prov.preset, &prov.base_url) {
        return Err(anyhow!("No model key is set."));
    }
    let base = normalize_base_url(&prov.base_url);
    if base.is_empty() {
        return Err(anyhow!("This provider needs a base URL — an owner or admin must set it in Teams settings."));
    }
    if model.trim().is_empty() {
        return Err(anyhow!(require_model(&prov.preset, model).unwrap_err()));
    }
    let url = format!("{base}/chat/completions");
    // usage.include makes usage-reporting providers (OpenRouter) attach exact
    // token usage to the final SSE chunk; others ignore it.
    let mut payload = serde_json::json!({ "model": model.trim(), "messages": messages, "stream": stream });
    if stream {
        payload["usage"] = serde_json::json!({ "include": true });
    }

    let resp = CLIENT
        .post(&url)
        .headers(upstream_headers(prov, session))
        .json(&payload)
        .send()
        .await?;
    let upstream = Upstream::from_reqwest(resp).await?;
    // Some OpenCode models (e.g. muse-spark-*) are only served via the
    // Responses API — a 400/404 on chat/completions means "wrong API for this
    // model", so retry there transparently. Other providers are untouched.
    if (upstream.status_code() == 400 || upstream.status_code() == 404) && base.contains("opencode.ai") {
        if let Ok(retry) = post_responses(prov, model.trim(), messages, session).await {
            if retry.status_code() == 200 {
                return Ok(retry);
            }
        }
    }
    Ok(upstream)
}

/// POST to the Responses API (`{base}/responses`, OpenAI shape). Used as a
/// fallback for OpenCode models that have no chat/completions binding.
async fn post_responses(
    prov: &Provider,
    model: &str,
    messages: &[ChatMessage],
    session: Option<&str>,
) -> anyhow::Result<Upstream> {
    let base = normalize_base_url(&prov.base_url);
    let url = format!("{base}/responses");
    let input: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
        .collect();
    let payload = serde_json::json!({ "model": model, "input": input });

    let resp = CLIENT
        .post(&url)
        .headers(upstream_headers(prov, session))
        .json(&payload)
        .send()
        .await?;
    Upstream::from_reqwest(resp).await
}

/// Tool call in a normalized shape across both OpenAI APIs.
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub args: String,
}

pub struct ToolCompletion {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

/// Which OpenAI API shapes a model supports, from the server's /models
/// catalogue (`api` object). Empty when the catalogue is unreachable.
pub async fn model_apis(prov: &Provider, model: &str) -> Vec<String> {
    let base = normalize_base_url(&prov.base_url);
    let url = if base.contains("opencode.ai/inference") {
        if base.contains("/inference/go") {
            "https://opencode.ai/inference/go/v1/models".to_string()
        } else {
            "https://opencode.ai/inference/v1/models".to_string()
        }
    } else {
        format!("{base}/models")
    };
    let mut headers = upstream_headers(prov, Some("slaver-models"));
    headers.remove(reqwest::header::CONTENT_TYPE);
    let resp = match CLIENT.get(&url).headers(headers).send().await {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    if resp.status().as_u16() != 200 {
        return vec![];
    }
    let v: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    v.get("data")
        .and_then(|d| d.as_array())
        .and_then(|arr| {
            arr.iter().find(|m| {
                m.get("id").and_then(|x| x.as_str()) == Some(model)
                    || m.get("canonical_id").and_then(|x| x.as_str()) == Some(model)
            })
        })
        .and_then(|m| m.get("api"))
        .and_then(|a| a.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default()
}

/// Chat/completions call with tools. Returns normalized text + tool calls.
/// Responses-only models are NOT retried here — use `post_tools_responses`
/// for those (see `model_apis`).
pub async fn post_chat_tools(
    prov: &Provider,
    model: &str,
    messages: &[ChatMessage],
    tools: &serde_json::Value,
    session: Option<&str>,
) -> anyhow::Result<ToolCompletion> {
    require_model(&prov.preset, model).map_err(anyhow::Error::msg)?;
    let base = normalize_base_url(&prov.base_url);
    if base.is_empty() {
        anyhow::bail!("This provider needs a base URL.");
    }
    let payload = serde_json::json!({
        "model": model.trim(),
        "messages": messages,
        "tools": tools,
        "tool_choice": "auto",
    });
    let resp = CLIENT
        .post(format!("{base}/chat/completions"))
        .headers(upstream_headers(prov, session))
        .json(&payload)
        .send()
        .await?;
    let status = resp.status().as_u16();
    let text = resp.text().await?;
    if status != 200 {
        anyhow::bail!("{}", crate::chat::describe_upstream_error(status, &text));
    }
    let v: serde_json::Value = serde_json::from_str(&text)?;
    parse_chat_tools(&v)
}

fn parse_chat_tools(v: &serde_json::Value) -> anyhow::Result<ToolCompletion> {
    let msg = v.pointer("/choices/0/message");
    let text = msg
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    let mut tool_calls = Vec::new();
    if let Some(tcs) = msg.and_then(|m| m.get("tool_calls")).and_then(|t| t.as_array()) {
        for tc in tcs {
            let id = tc.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let name = tc
                .pointer("/function/name")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let args = tc
                .pointer("/function/arguments")
                .and_then(|x| x.as_str())
                .unwrap_or("{}")
                .to_string();
            if !name.is_empty() {
                tool_calls.push(ToolCall { id, name, args });
            }
        }
    }
    let usage = v.get("usage");
    Ok(ToolCompletion {
        text,
        tool_calls,
        prompt_tokens: usage
            .and_then(|u| u.get("prompt_tokens"))
            .and_then(|x| x.as_u64())
            .unwrap_or(0),
        completion_tokens: usage
            .and_then(|u| u.get("completion_tokens"))
            .and_then(|x| x.as_u64())
            .unwrap_or(0),
    })
}

/// Responses-API call with function tools. `input` is the full input array
/// (caller carries prior outputs + function_call_output items across turns).
/// Returns the completion plus the raw `output` items to append to `input`.
pub async fn post_tools_responses(
    prov: &Provider,
    model: &str,
    input: &serde_json::Value,
    tools: &serde_json::Value,
    session: Option<&str>,
) -> anyhow::Result<(ToolCompletion, serde_json::Value)> {
    require_model(&prov.preset, model).map_err(anyhow::Error::msg)?;
    let base = normalize_base_url(&prov.base_url);
    if base.is_empty() {
        anyhow::bail!("This provider needs a base URL.");
    }
    let fn_tools: Vec<serde_json::Value> = tools
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|t| {
            let f = t.get("function")?;
            Some(serde_json::json!({
                "type": "function",
                "name": f.get("name"),
                "description": f.get("description"),
                "parameters": f.get("parameters"),
            }))
        })
        .collect();
    let payload = serde_json::json!({ "model": model.trim(), "input": input, "tools": fn_tools });
    let resp = CLIENT
        .post(format!("{base}/responses"))
        .headers(upstream_headers(prov, session))
        .json(&payload)
        .send()
        .await?;
    let status = resp.status().as_u16();
    let text = resp.text().await?;
    if status != 200 {
        anyhow::bail!("{}", crate::chat::describe_upstream_error(status, &text));
    }
    let v: serde_json::Value = serde_json::from_str(&text)?;
    let mut completion_text = String::new();
    let mut tool_calls = Vec::new();
    let mut outputs = Vec::new();
    if let Some(items) = v.get("output").and_then(|o| o.as_array()) {
        for item in items {
            outputs.push(item.clone());
            let kind = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if kind == "message" {
                if let Some(s) = extract_responses_text_item(item) {
                    if !completion_text.is_empty() {
                        completion_text.push('\n');
                    }
                    completion_text.push_str(&s);
                }
            } else if kind == "function_call" {
                let name = item.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
                if !name.is_empty() {
                    tool_calls.push(ToolCall {
                        id: item.get("call_id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                        name,
                        args: item.get("arguments").and_then(|x| x.as_str()).unwrap_or("{}").to_string(),
                    });
                }
            }
        }
    }
    let usage = v.get("usage");
    Ok((
        ToolCompletion {
            text: completion_text,
            tool_calls,
            prompt_tokens: usage
                .and_then(|u| u.get("input_tokens"))
                .and_then(|x| x.as_u64())
                .unwrap_or(0),
            completion_tokens: usage
                .and_then(|u| u.get("output_tokens"))
                .and_then(|x| x.as_u64())
                .unwrap_or(0),
        },
        serde_json::Value::Array(outputs),
    ))
}

fn extract_responses_text_item(item: &serde_json::Value) -> Option<String> {
    let contents = item.get("content")?.as_array()?;
    let mut out = String::new();
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
    if out.trim().is_empty() {
        None
    } else {
        Some(out)
    }
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
    // The connection test is its own stable session.
    let headers = upstream_headers(prov, Some("slaver-connection-test"));

    // 1) Optional: GET /models — supported by Ollama, vLLM, LM Studio
    // and most OpenAI-compatible servers. OpenCode hosts its catalogue at
    // /inference[/go]/v1/models instead of under the OpenAI base, so map it.
    let models_url = if base.contains("opencode.ai/inference") {
        if base.contains("/inference/go") {
            "https://opencode.ai/inference/go/v1/models".to_string()
        } else {
            "https://opencode.ai/inference/v1/models".to_string()
        }
    } else {
        format!("{base}/models")
    };
    let mut listed_models: Vec<String> = Vec::new();
    {
        let mut ok = false;
        match CLIENT.get(&models_url).headers(headers.clone()).send().await {
            Err(_) => {}
            Ok(resp) => {
                let status = resp.status().as_u16();
                let text = resp.text().await.unwrap_or_default();
                if status == 200 {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
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
                    notes.push(format!("/models returned {status}{}.", if text.trim().is_empty() { String::new() } else { format!(": {}", text.trim().chars().take(160).collect::<String>()) }));
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
    let reply_text: Result<String, String> = match CLIENT.post(&endpoint).headers(headers).json(&payload).send().await {
        Err(e) => Err(format!("Could not reach {endpoint}: {e}")),
        Ok(resp) => {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            if status == 200 {
                Ok(text.chars().take(200).collect())
            } else if (status == 400 || status == 404) && base.contains("opencode.ai") {
                // Responses-only models (e.g. muse-spark-*) need /responses.
                match post_responses_ping(&base, prov, &ping_model).await {
                    Ok(t) => Ok(t),
                    Err(_) => Err(crate::chat::describe_upstream_error(status, &text)),
                }
            } else {
                Err(crate::chat::describe_upstream_error(status, &text))
            }
        }
    };
    match reply_text {
        Ok(_) => serde_json::json!({ "ok": true, "endpoint": endpoint, "model": ping_model, "models": listed_models, "notes": notes }),
        Err(e) => serde_json::json!({ "ok": false, "error": e, "endpoint": endpoint, "model": ping_model, "models": listed_models, "notes": notes }),
    }
}

/// One-shot Responses-API ping for the connection test (same shape as the
/// chat fallback, but self-contained so the test stays a single function).
async fn post_responses_ping(base: &str, prov: &Provider, model: &str) -> Result<String, String> {
    let url = format!("{base}/responses");
    let payload = serde_json::json!({
        "model": model,
        "input": [{ "role": "user", "content": "ping" }],
    });
    let headers = upstream_headers(prov, Some("slaver-connection-test"));
    let resp = CLIENT
        .post(&url)
        .headers(headers)
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            eprintln!("responses ping failed: {e}");
            e.to_string()
        })?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if status != 200 {
        return Err(crate::chat::describe_upstream_error(status, &text));
    }
    Ok(text.chars().take(200).collect())
}
