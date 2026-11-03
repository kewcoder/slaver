use crate::{chat, pricing, store, util};
use crate::db::Db;

/// Muse Voice Transcribe over the Meta Model API (chat models moved to
/// OpenRouter, which exposes no transcription endpoint — so STT stays here).
const MODEL: &str = "muse-voice-transcribe-1.0";
const TRANSCRIBE_URL: &str = "https://api.meta.ai/v1/asr/transcribe";
/// Matches the provider's 32 MB cap so we never buffer more than it accepts.
const MAX_AUDIO_BYTES: usize = 32 * 1024 * 1024;

/// Core transcription: WAV bytes in, transcript payload out. Uses the current
/// team's Meta key (transcription only exists on Meta). The app sends audio
/// as base64 through the voice.transcribe tool (single /mcp endpoint).
pub(crate) async fn transcribe_core(
    db: &Db,
    user_id: &str,
    team_id: &str,
    audio: Vec<u8>,
) -> Result<serde_json::Value, String> {
    if audio.is_empty() {
        return Err("Audio is empty.".to_string());
    }
    if audio.len() > MAX_AUDIO_BYTES {
        return Err("Audio is over the 32 MB limit. Send a shorter clip.".to_string());
    }
    if !looks_like_wav(&audio) {
        return Err("Audio must be mono 16-bit WAV (16 or 24 kHz).".to_string());
    }
    let team_id = if team_id.trim().is_empty() {
        store::ensure_personal_team(db, user_id)
            .await
            .map(|t| t.id)
            .unwrap_or_default()
    } else {
        team_id.to_string()
    };
    let prov = crate::provider::provider_for(db, &team_id)
        .await
        .map_err(|e| e.to_string())?;
    if prov.preset != "meta" {
        return Err("Voice transcription needs Meta: set this team's provider to Meta in Teams settings.".to_string());
    }
    let key = prov.api_key.clone();
    let boundary: String = {
        let mut b = [0u8; 16];
        getrandom::getrandom(&mut b).map_err(|e| e.to_string())?;
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

    let client = reqwest::Client::new();
    let mut upstream = client
        .post(TRANSCRIBE_URL)
        .header("Authorization", format!("Bearer {key}"))
        .header("Content-Type", format!("multipart/form-data; boundary={boundary}"))
        .body(body)
        .send()
        .await
        .map_err(|e| {
            eprintln!("voice upstream fetch failed: {e}");
            "Could not reach the transcription API.".to_string()
        })?;
    if upstream.status().as_u16() != 200 {
        let status = upstream.status().as_u16();
        let text = upstream.text().await.unwrap_or_default();
        eprintln!("voice upstream status={} body={}", status, util::truncate(&text, 300));
        return Err(chat::describe_upstream_error(status, &text));
    }
    let data: serde_json::Value = upstream.json().await.unwrap_or(serde_json::Value::Null);
    let transcript = data
        .get("transcript")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    if transcript.trim().is_empty() {
        return Err("Transcription came back empty. Try speaking closer to the mic.".to_string());
    }
    let (seconds, estimated) = match data.get("audioDurationMs").and_then(|v| v.as_f64()) {
        Some(ms) if ms > 0.0 => (ms / 1000.0, false),
        _ => (audio.len().saturating_sub(44) as f64 / 32_000.0, true),
    };
    let cost = pricing::stt_cost_usd(seconds);
    let cost = store::record_usage(
        db,
        user_id,
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
    .await
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "transcript": transcript,
        "audio_seconds": seconds,
        "estimated": estimated,
        "cost_usd": cost,
    }))
}


fn base64_decode(s: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}

pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
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
