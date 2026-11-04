use anyhow::anyhow;
use serde::{Deserialize, Serialize};

use crate::db::{now_millis, v_text, Db};

const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;

#[derive(Deserialize, Serialize)]
struct UserRow {
    id: String,
    email: String,
    name: String,
    password_salt: String,
    password_hash: String,
    #[serde(default)]
    lang: String,
}

/// UI language codes supported by the app. Anything else falls back to English.
pub fn norm_lang(raw: &str) -> String {
    match raw.trim().to_lowercase().as_str() {
        "id" | "id-id" | "in" => "id".to_string(),
        _ => "en".to_string(),
    }
}

fn b64url(data: &[u8]) -> String {
    use base64::Engine as _;
    B64.encode(data)
}

fn salt() -> anyhow::Result<String> {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).map_err(|e| anyhow!("{e}"))?;
    Ok(hex::encode(b))
}

fn hash_password(password: &str, salt: &str) -> String {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    h.update(salt.as_bytes());
    h.update(b":");
    h.update(password.as_bytes());
    hex::encode(h.finalize())
}

fn sign_jwt(secret: &str, sub: &str, email: &str) -> anyhow::Result<String> {
    let exp = now_millis() / 1000 + 7 * 24 * 3600;
    let header = b64url(br#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = b64url(
        serde_json::json!({ "sub": sub, "email": email, "exp": exp })
            .to_string()
            .as_bytes(),
    );
    let msg = format!("{header}.{payload}");
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|e| anyhow!("{e}"))?;
    use hmac::Mac;
    mac.update(msg.as_bytes());
    Ok(format!("{msg}.{}", b64url(&mac.finalize().into_bytes())))
}

fn verify_jwt(secret: &str, token: &str) -> Option<String> {
    use base64::Engine as _;
    use hmac::Mac;
    let mut parts = token.split('.');
    let (h, p, s) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let msg = format!("{h}.{p}");
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(msg.as_bytes());
    let sig = B64.decode(s).ok()?;
    mac.verify_slice(&sig).ok()?;
    let payload: serde_json::Value =
        serde_json::from_slice(&B64.decode(p).ok()?).ok()?;
    let exp = payload.get("exp")?.as_u64()?;
    if exp < now_millis() / 1000 {
        return None;
    }
    Some(payload.get("sub")?.as_str()?.to_string())
}

/// Returns the user id from an `Authorization: Bearer <jwt>` header value,
/// or None if missing/invalid.
pub fn bearer_sub_from_header(secret: &str, auth: Option<&str>) -> Option<String> {
    let auth = auth?;
    let token = auth.strip_prefix("Bearer ")?;
    verify_jwt(secret, token.trim())
}

/// Returns the user id from a raw JWT (already stripped of any scheme).
pub fn verify_bearer_token(secret: &str, token: &str) -> Option<String> {
    verify_jwt(secret, token.trim())
}

fn valid_email(s: &str) -> bool {
    if s.contains(' ') || s.len() > 254 {
        return false;
    }
    let mut parts = s.split('@');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(local), Some(domain), None) => !local.is_empty() && domain.contains('.') && domain.len() > 3,
        _ => false,
    }
}

pub struct AuthUser {
    pub token: String,
    pub user: serde_json::Value,
}

fn user_json(id: &str, email: &str, name: &str, lang: &str) -> serde_json::Value {
    serde_json::json!({ "id": id, "email": email, "name": name, "lang": norm_lang(lang) })
}

/// Core registration (used by the auth.register MCP tool).
pub async fn register_core(
    db: &Db,
    secret: &str,
    email: &str,
    password: &str,
    name: &str,
) -> Result<AuthUser, String> {
    let email = email.trim().to_lowercase();
    let name = name.trim().to_string();
    if !valid_email(&email) {
        return Err("Invalid email.".to_string());
    }
    if password.len() < 8 {
        return Err("Password must be at least 8 characters.".to_string());
    }
    let existing: Option<UserRow> = db
        .prepare("SELECT id, email, name, password_salt, password_hash, lang FROM users WHERE email = ?")
        .bind(&[v_text(&email)])
        .map_err(|e| e.to_string())?
        .first(None)
        .await
        .map_err(|e| e.to_string())?;
    if existing.is_some() {
        return Err("Email already registered. Please log in.".to_string());
    }
    let id = uuid();
    let s = salt().map_err(|e| e.to_string())?;
    let password_hash = hash_password(password, &s);
    db.prepare("INSERT INTO users (id, email, name, password_salt, password_hash) VALUES (?, ?, ?, ?, ?)")
        .bind(&[
            v_text(&id),
            v_text(&email),
            v_text(&name),
            v_text(&s),
            v_text(&password_hash),
        ])
        .map_err(|e| e.to_string())?
        .run()
        .await
        .map_err(|e| e.to_string())?;
    let token = sign_jwt(secret, &id, &email).map_err(|e| e.to_string())?;
    Ok(AuthUser { token, user: user_json(&id, &email, &name, "en") })
}

/// Core login (used by the auth.login MCP tool).
pub async fn login_core(
    db: &Db,
    secret: &str,
    email: &str,
    password: &str,
) -> Result<AuthUser, String> {
    let email = email.trim().to_lowercase();
    if email.is_empty() || password.is_empty() {
        return Err("Email and password are required.".to_string());
    }
    let row: Option<UserRow> = db
        .prepare("SELECT id, email, name, password_salt, password_hash, lang FROM users WHERE email = ?")
        .bind(&[v_text(&email)])
        .map_err(|e| e.to_string())?
        .first(None)
        .await
        .map_err(|e| e.to_string())?;
    let row = row.ok_or_else(|| "Wrong email or password.".to_string())?;
    if hash_password(password, &row.password_salt) != row.password_hash {
        return Err("Wrong email or password.".to_string());
    }
    let token = sign_jwt(secret, &row.id, &row.email).map_err(|e| e.to_string())?;
    Ok(AuthUser { token, user: user_json(&row.id, &row.email, &row.name, &row.lang) })
}

/// Core profile fetch (used by the auth.me MCP tool).
pub async fn me_core(db: &Db, user_id: &str) -> Result<serde_json::Value, String> {
    let row: Option<crate::store::UserRecord> = db
        .prepare("SELECT id, email, name, lang FROM users WHERE id = ?")
        .bind(&[v_text(user_id)])
        .map_err(|e| e.to_string())?
        .first(None)
        .await
        .map_err(|e| e.to_string())?;
    row.map(|v| user_json(&v.id, &v.email, &v.name, &v.lang))
        .ok_or_else(|| "User not found.".to_string())
}

/// Core UI-language update (used by the user_set_lang MCP tool).
pub async fn set_lang_core(db: &Db, user_id: &str, lang: &str) -> Result<serde_json::Value, String> {
    let lang = norm_lang(lang);
    db.prepare("UPDATE users SET lang = ? WHERE id = ?")
        .bind(&[v_text(&lang), v_text(user_id)])
        .map_err(|e| e.to_string())?
        .run()
        .await
        .map_err(|e| e.to_string())?;
    me_core(db, user_id).await
}

fn uuid() -> String {
    // 128-bit random id, hex-encoded (no extra deps).
    let mut b = [0u8; 16];
    if getrandom::getrandom(&mut b).is_err() {
        let t = now_millis();
        b[..8].copy_from_slice(&t.to_be_bytes());
    }
    // version 4 markers
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
