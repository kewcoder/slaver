use worker::*;

use crate::store;

/// Avatar storage in R2. Keys look like `bots/<bot-id>/<uuid>.<ext>`.
const MAX_AVATAR_BYTES: usize = 2 * 1024 * 1024;

fn ext_for(content_type: &str) -> Option<&'static str> {
    match content_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

/// Core avatar upload: raw image bytes in, avatar key out. Replaces any
/// previous avatar. The app sends base64 through the bots.set_avatar tool.
pub(crate) async fn upload_core(
    env: &Env,
    db: &D1Database,
    user_id: &str,
    bot_id: &str,
    bytes: Vec<u8>,
    content_type: &str,
) -> Result<serde_json::Value, String> {
    let bot = store::get_bot(db, user_id, bot_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "SlaveBot not found.".to_string())?;
    if bytes.is_empty() {
        return Err("Avatar is empty.".to_string());
    }
    if bytes.len() > MAX_AVATAR_BYTES {
        return Err("Avatar is over the 2 MB limit.".to_string());
    }
    let ext = ext_for(content_type).ok_or_else(|| "Avatar must be png, jpeg, webp, or gif.".to_string())?;
    let key = format!("bots/{}/{}.{}", bot_id, new_uuid(), ext);
    env.bucket("AVATARS")
        .map_err(|e| e.to_string())?
        .put(key.clone(), bytes)
        .http_metadata(HttpMetadata {
            content_type: Some(content_type.to_string()),
            ..Default::default()
        })
        .execute()
        .await
        .map_err(|e| e.to_string())?;
    if !bot.avatar_key.is_empty() {
        let _ = env.bucket("AVATARS").map_err(|e| e.to_string())?.delete(bot.avatar_key).await;
    }
    db.prepare("UPDATE slavebots SET avatar_key = ? WHERE id = ? AND user_id = ?")
        .bind(&[
            wasm_bindgen::JsValue::from_str(&key),
            wasm_bindgen::JsValue::from_str(bot_id),
            wasm_bindgen::JsValue::from_str(user_id),
        ])
        .map_err(|e| e.to_string())?
        .run()
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "avatar_key": key }))
}

/// Core avatar fetch: stored bytes out as base64 + content type, so the app
/// can render a data: URL through the single /mcp endpoint.
pub(crate) async fn read_core(
    env: &Env,
    db: &D1Database,
    user_id: &str,
    bot_id: &str,
) -> Result<serde_json::Value, String> {
    let bot = store::get_bot(db, user_id, bot_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "SlaveBot not found.".to_string())?;
    if bot.avatar_key.is_empty() {
        return Err("No avatar set.".to_string());
    }
    let obj = env
        .bucket("AVATARS")
        .map_err(|e| e.to_string())?
        .get(bot.avatar_key)
        .execute()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Avatar file missing.".to_string())?;
    let content_type = obj
        .http_metadata()
        .content_type
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let bytes = obj
        .body()
        .ok_or_else(|| "Avatar file empty.".to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "content_type": content_type, "image_base64": crate::voice::base64_encode(&bytes) }))
}

fn new_uuid() -> String {
    let mut b = [0u8; 16];
    if getrandom::getrandom(&mut b).is_err() {
        let t = Date::now().as_millis();
        b[..8].copy_from_slice(&t.to_be_bytes());
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex::encode(b);
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}
