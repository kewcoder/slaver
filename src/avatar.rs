use std::path::{Path, PathBuf};

use crate::{db::Db, store};

/// Avatar storage on a local volume. Files live under
/// `<dir>/bots/<bot-id>/<uuid>.<ext>` and the key is the relative path.
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

fn content_type_for(key: &str) -> &'static str {
    match Path::new(key).extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("jpg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "application/octet-stream",
    }
}

fn new_uuid() -> String {
    let mut b = [0u8; 16];
    if getrandom::getrandom(&mut b).is_err() {
        let t = crate::db::now_millis();
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

/// Core avatar upload: raw image bytes in, avatar key out. Replaces any
/// previous avatar. The app sends base64 through the bots.set_avatar tool.
pub(crate) async fn upload_core(
    avatar_dir: &Path,
    db: &Db,
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
    let key = format!("bots/{bot_id}/{}.{ext}", new_uuid());
    let full = avatar_dir.join(&key);
    if let Some(parent) = full.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    tokio::fs::write(&full, &bytes)
        .await
        .map_err(|e| e.to_string())?;
    if !bot.avatar_key.is_empty() {
        let _ = tokio::fs::remove_file(avatar_dir.join(&bot.avatar_key)).await;
    }
    store::set_avatar_key(db, user_id, bot_id, &key)
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "avatar_key": key }))
}

/// Core avatar fetch: stored bytes out as base64 + content type, so the app
/// can render a data: URL through the single /mcp endpoint.
pub(crate) async fn read_core(
    avatar_dir: &Path,
    db: &Db,
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
    // Confine reads to the avatar dir (keys are server-generated, but be safe).
    let full: PathBuf = avatar_dir.join(&bot.avatar_key);
    if !full.starts_with(avatar_dir) {
        return Err("Avatar file missing.".to_string());
    }
    let bytes = tokio::fs::read(&full).await.map_err(|_| "Avatar file missing.".to_string())?;
    Ok(serde_json::json!({ "content_type": content_type_for(&bot.avatar_key), "image_base64": crate::voice::base64_encode(&bytes) }))
}
