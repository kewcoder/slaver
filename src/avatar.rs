use worker::*;

use crate::{auth, store, util};

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

/// POST /api/slavebots/:id/avatar — multipart form with an `avatar` image
/// field (png/jpeg/webp/gif, max 2 MB). Replaces any previous avatar.
pub async fn upload(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Unauthorized."),
    };
    let bot_id = ctx.param("id").cloned().unwrap_or_default();
    let db = ctx.env.d1("DB")?;
    let bot = match store::get_bot(&db, &user_id, &bot_id).await? {
        Some(b) => b,
        None => return util::err(404, "SlaveBot not found."),
    };

    let form = req.form_data().await?;
    let (bytes, content_type) = match form.get("avatar") {
        Some(FormEntry::File(f)) => {
            let t = f.type_();
            (f.bytes().await?, t)
        }
        _ => return util::err(400, "Missing avatar image (multipart field \"avatar\")."),
    };
    if bytes.is_empty() {
        return util::err(400, "Avatar is empty.");
    }
    if bytes.len() > MAX_AVATAR_BYTES {
        return util::err(413, "Avatar is over the 2 MB limit.");
    }
    let ext = match ext_for(content_type.as_str()) {
        Some(e) => e,
        None => return util::err(400, "Avatar must be png, jpeg, webp, or gif."),
    };

    let key = format!("bots/{}/{}.{}", bot_id, new_uuid(), ext);
    ctx.env
        .bucket("AVATARS")?
        .put(key.clone(), bytes)
        .http_metadata(HttpMetadata {
            content_type: Some(content_type),
            ..Default::default()
        })
        .execute()
        .await?;

    if !bot.avatar_key.is_empty() {
        let _ = ctx.env.bucket("AVATARS")?.delete(bot.avatar_key).await;
    }
    db.prepare("UPDATE slavebots SET avatar_key = ? WHERE id = ? AND user_id = ?")
        .bind(&[
            wasm_bindgen::JsValue::from_str(&key),
            wasm_bindgen::JsValue::from_str(&bot_id),
            wasm_bindgen::JsValue::from_str(&user_id),
        ])?
        .run()
        .await?;
    util::json(200, &serde_json::json!({ "avatar_key": key }))
}

/// GET /api/slavebots/:id/avatar — serve the stored avatar image.
pub async fn serve(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Unauthorized."),
    };
    let bot_id = ctx.param("id").cloned().unwrap_or_default();
    let db = ctx.env.d1("DB")?;
    let bot = match store::get_bot(&db, &user_id, &bot_id).await? {
        Some(b) => b,
        None => return util::err(404, "SlaveBot not found."),
    };
    if bot.avatar_key.is_empty() {
        return util::err(404, "No avatar set.");
    }
    let obj = ctx
        .env
        .bucket("AVATARS")?
        .get(bot.avatar_key)
        .execute()
        .await?;
    let obj = match obj {
        Some(o) => o,
        None => return util::err(404, "Avatar file missing."),
    };
    let content_type = obj
        .http_metadata()
        .content_type
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let stream = match obj.body() {
        Some(b) => b.stream()?,
        None => return util::err(404, "Avatar file empty."),
    };
    let mut resp = Response::from_stream(stream)?;
    resp.headers_mut().set("Content-Type", &content_type)?;
    resp.headers_mut().set("Cache-Control", "public, max-age=86400")?;
    util::cors(&mut resp)?;
    Ok(resp)
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
