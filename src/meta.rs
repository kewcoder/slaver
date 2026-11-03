use wasm_bindgen::JsValue;
use worker::*;

use crate::chat::ChatMessage;

/// Thin client for the OpenAI-compatible Meta Model API.
fn var_or(env: &Env, name: &str, default: &str) -> String {
    env.var(name)
        .ok()
        .and_then(|b| b.as_ref().as_string())
        .unwrap_or_else(|| default.to_string())
}

pub fn base_url(env: &Env) -> String {
    var_or(env, "META_API_BASE_URL", "https://api.meta.ai/v1")
        .trim_end_matches('/')
        .to_string()
}

pub fn default_model(env: &Env) -> String {
    var_or(env, "DEFAULT_MODEL", "muse-spark-1.3")
}

pub fn model_list(env: &Env) -> serde_json::Value {
    let default = default_model(env);
    serde_json::json!({
        "models": [
            { "id": "muse-spark-1.3", "label": "Muse Spark 1.3 (default, murah)", "default": default == "muse-spark-1.3" },
            { "id": "muse-wonder-1.0", "label": "Muse Wonder (marathon / agent)", "default": default == "muse-wonder-1.0" },
        ]
    })
}

pub async fn post_chat_completions(
    env: &Env,
    model: &str,
    messages: &[ChatMessage],
    stream: bool,
) -> Result<Response> {
    let key = env.secret("META_API_KEY")?.to_string();
    if key.is_empty() {
        return Err(Error::RustError("META_API_KEY is empty".to_string()));
    }
    let url = format!("{}/chat/completions", base_url(env));
    let payload = serde_json::json!({ "model": model, "messages": messages, "stream": stream });

    let headers = Headers::new();
    headers.set("Content-Type", "application/json")?;
    headers.set("Authorization", &format!("Bearer {key}"))?;

    let mut init = RequestInit::new();
    init.with_method(Method::Post);
    init.with_headers(headers);
    init.with_body(Some(JsValue::from_str(&payload.to_string())));

    let req = Request::new_with_init(&url, &init)?;
    Fetch::Request(req).send().await
}
