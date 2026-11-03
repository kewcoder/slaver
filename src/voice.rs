use wasm_bindgen::JsValue;
use worker::*;

use crate::{auth, chat, pricing, store, util};

/// Muse Voice Transcribe over the Meta Model API.
const MODEL: &str = "muse-voice-transcribe-1.0";
const TRANSCRIBE_URL: &str = "https://api.meta.ai/v1/asr/transcribe";
/// Matches the provider's 32 MB cap so we never buffer more than it accepts.
const MAX_AUDIO_BYTES: usize = 32 * 1024 * 1024;

/// POST /api/voice/transcribe — multipart form with an `audio` file field
/// (mono 16-bit WAV, 16 or 24 kHz — the frontend converts before upload).
/// Returns {transcript, audio_seconds, cost_usd, credit_usd}. Auto-detects
/// the spoken language, so Indonesian and mixed speech just work.
pub async fn transcribe(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Log in before using voice."),
    };
    let db = ctx.env.d1("DB")?;
    let credit = store::get_user(&db, &user_id)
        .await?
        .map(|u| u.credit_usd)
        .unwrap_or(0.0);
    if credit <= 0.0 {
        return util::err(402, "Out of credit (balance $0.00). Demo credit is $10 per user.");
    }
    let key = ctx.env.secret("META_API_KEY")?.to_string();
    if key.is_empty() {
        return util::err(500, "META_API_KEY is not set on the server.");
    }

    let form = req.form_data().await?;
    let audio: Vec<u8> = match form.get("audio") {
        Some(FormEntry::File(f)) => f.bytes().await?,
        _ => return util::err(400, "Missing audio file (multipart field \"audio\")."),
    };
    if audio.is_empty() {
        return util::err(400, "Audio is empty.");
    }
    if audio.len() > MAX_AUDIO_BYTES {
        return util::err(413, "Audio is over the 32 MB limit. Send a shorter clip.");
    }
    if !looks_like_wav(&audio) {
        return util::err(400, "Audio must be mono 16-bit WAV (16 or 24 kHz).");
    }

    let boundary: String = {
        let mut b = [0u8; 16];
        getrandom::getrandom(&mut b).map_err(|e| Error::RustError(e.to_string()))?;
        hex::encode(b)
    };
    let request_json = serde_json::json!({
        "mode": "PUSH_TO_TALK",
        "model": MODEL,
        "audioEncoding": "WAV",
    })
    .to_string();
    let mut body: Vec<u8> = Vec::with_capacity(audio.len() + 512);
    push_part(&mut body, &boundary, "request", None, "application/json", request_json.as_bytes());
    push_part(&mut body, &boundary, "audio", Some("audio.wav"), "audio/wav", &audio);
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

    let headers = Headers::new();
    headers.set("Authorization", &format!("Bearer {key}"))?;
    headers.set(
        "Content-Type",
        &format!("multipart/form-data; boundary={boundary}"),
    )?;

    let mut init = RequestInit::new();
    init.with_method(Method::Post);
    init.with_headers(headers);
    let js_body: JsValue = js_sys::Uint8Array::from(body.as_slice()).into();
    init.with_body(Some(js_body));

    let request = Request::new_with_init(TRANSCRIBE_URL, &init)?;
    let mut upstream = Fetch::Request(request).send().await.map_err(|e| {
        console_error!("voice upstream fetch failed: {e}");
        Error::RustError("Could not reach the Meta Model API.".to_string())
    })?;

    if upstream.status_code() != 200 {
        let status = upstream.status_code();
        let text = upstream.text().await.unwrap_or_default();
        console_error!(
            "voice upstream status={} body={}",
            status,
            util::truncate(&text, 300)
        );
        return util::json(
            502,
            &serde_json::json!({
                "error": chat::describe_upstream_error(status, &text),
                "detail": util::truncate(&text, 500),
            }),
        );
    }

    let data: serde_json::Value = upstream.json().await.unwrap_or(serde_json::Value::Null);
    let transcript = data
        .get("transcript")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    if transcript.trim().is_empty() {
        return util::err(502, "Transcription came back empty. Try speaking closer to the mic.");
    }
    let (seconds, estimated) = match data.get("audioDurationMs").and_then(|v| v.as_f64()) {
        Some(ms) if ms > 0.0 => (ms / 1000.0, false),
        // Fallback: 16 kHz mono 16-bit ~= 32_000 bytes/sec past the 44-byte header.
        _ => (audio.len().saturating_sub(44) as f64 / 32_000.0, true),
    };
    let cost = pricing::stt_cost_usd(seconds);
    let (cost, remaining) = store::record_usage(
        &db,
        &user_id,
        None,
        &store::UsageInput {
            model: MODEL.to_string(),
            prompt_tokens: 0,
            cached_tokens: 0,
            completion_tokens: 0,
            estimated,
            audio_seconds: seconds,
            cost_override: Some(cost),
        },
    )
    .await?;
    util::json(
        200,
        &serde_json::json!({
            "transcript": transcript,
            "audio_seconds": seconds,
            "estimated": estimated,
            "cost_usd": cost,
            "credit_usd": remaining,
        }),
    )
}

/// Meta has no TTS model (STT only), so spoken replies use a common
/// third-party voice model through Cloudflare Workers AI instead:
/// POST /api/voice/speak {text, voice?} -> audio/mpeg (Aura voice).
/// Needs CF_ACCOUNT_ID + CF_AI_TOKEN secrets; model via TTS_MODEL var.
pub async fn speak(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Log in before using voice."),
    };
    let db = ctx.env.d1("DB")?;
    let credit = store::get_user(&db, &user_id)
        .await?
        .map(|u| u.credit_usd)
        .unwrap_or(0.0);
    if credit <= 0.0 {
        return util::err(402, "Out of credit (balance $0.00). Demo credit is $10 per user.");
    }
    #[derive(serde::Deserialize)]
    struct SpeakBody {
        text: Option<String>,
        voice: Option<String>,
    }
    let body: SpeakBody = match req.json().await {
        Ok(b) => b,
        Err(_) => return util::err(400, "Invalid JSON body."),
    };
    let text = body.text.unwrap_or_default();
    let chars = text.chars().count();
    if chars == 0 || chars > 2000 {
        return util::err(400, "text must be 1..2000 characters.");
    }
    let speaker = body
        .voice
        .as_deref()
        .map(str::trim)
        .filter(|v| ["luna", "athena", "orion", "zeus", "hera", "perseus", "angus", "stella"].contains(v))
        .unwrap_or("luna");
    let account = ctx.env.secret("CF_ACCOUNT_ID").map(|s| s.to_string()).unwrap_or_default();
    let token = ctx.env.secret("CF_AI_TOKEN").map(|s| s.to_string()).unwrap_or_default();
    if account.is_empty() || token.is_empty() {
        return util::err(501, "Server voice is not configured yet (missing Cloudflare AI credentials). Use the built-in browser voice instead.");
    }
    let model = ctx.env.var("TTS_MODEL").map(|v| v.to_string()).unwrap_or_else(|_| "@cf/deepgram/aura-1".to_string());
    let url = format!("https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{model}");
    let headers = Headers::new();
    headers.set("Authorization", &format!("Bearer {token}"))?;
    headers.set("Content-Type", "application/json")?;
    let payload = serde_json::json!({ "text": text, "speaker": speaker }).to_string();
    let mut init = RequestInit::new();
    init.with_method(Method::Post);
    init.with_headers(headers);
    let js_body: JsValue = js_sys::Uint8Array::from(payload.as_bytes()).into();
    init.with_body(Some(js_body));
    let request = Request::new_with_init(&url, &init)?;
    let mut upstream = Fetch::Request(request).send().await.map_err(|e| {
        console_error!("tts upstream fetch failed: {e}");
        Error::RustError("Could not reach the voice model.".to_string())
    })?;
    if upstream.status_code() != 200 {
        let status = upstream.status_code();
        let text = upstream.text().await.unwrap_or_default();
        console_error!("tts upstream status={} body={}", status, util::truncate(&text, 300));
        return util::json(502, &serde_json::json!({ "error": chat::describe_upstream_error(status, &text) }));
    }
    let content_type = upstream.headers().get("content-type").unwrap_or_default().unwrap_or_default();
    let audio: Vec<u8> = if content_type.contains("json") {
        let data: serde_json::Value = upstream.json().await.unwrap_or(serde_json::Value::Null);
        let b64 = data.pointer("/result/audio").and_then(|v| v.as_str()).unwrap_or("");
        match base64_decode(b64) {
            Some(bytes) if !bytes.is_empty() => bytes,
            _ => return util::err(502, "Voice model returned no audio."),
        }
    } else {
        upstream.bytes().await.unwrap_or_default()
    };
    if audio.is_empty() {
        return util::err(502, "Voice model returned no audio.");
    }
    let cost = pricing::tts_cost_usd(chars);
    let (_, remaining) = store::record_usage(
        &db,
        &user_id,
        None,
        &store::UsageInput {
            model: "workers-ai-tts".to_string(),
            prompt_tokens: 0,
            cached_tokens: 0,
            completion_tokens: 0,
            estimated: false,
            audio_seconds: 0.0,
            cost_override: Some(cost),
        },
    )
    .await?;
    let mut resp = Response::from_bytes(audio)?;
    resp.headers_mut().set("Content-Type", "audio/mpeg")?;
    resp.headers_mut().set("X-TTS-Cost-Usd", &format!("{cost:.6}"))?;
    resp.headers_mut().set("X-TTS-Credit-Usd", &format!("{remaining:.4}"))?;
    util::cors(&mut resp)?;
    Ok(resp)
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}

fn looks_like_wav(audio: &[u8]) -> bool {
    audio.len() > 44 && &audio[0..4] == b"RIFF" && &audio[8..12] == b"WAVE"
}

fn push_part(
    out: &mut Vec<u8>,
    boundary: &str,
    name: &str,
    filename: Option<&str>,
    content_type: &str,
    data: &[u8],
) {
    out.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    match filename {
        Some(f) => out.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"{name}\"; filename=\"{f}\"\r\n").as_bytes(),
        ),
        None => out.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"{name}\"\r\n").as_bytes(),
        ),
    }
    out.extend_from_slice(format!("Content-Type: {content_type}\r\n\r\n").as_bytes());
    out.extend_from_slice(data);
    out.extend_from_slice(b"\r\n");
}
