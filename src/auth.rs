use base64::Engine as _;
use hmac::Mac;
use serde::{Deserialize, Serialize};
use wasm_bindgen::JsValue;
use worker::*;

use crate::util;

const B64: base64::engine::general_purpose::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;

#[derive(Deserialize)]
struct RegisterBody {
    email: Option<String>,
    password: Option<String>,
    name: Option<String>,
}

#[derive(Deserialize)]
struct LoginBody {
    email: Option<String>,
    password: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct UserRow {
    id: String,
    email: String,
    name: String,
    password_salt: String,
    password_hash: String,
    credit_usd: f64,
}

fn b64url(data: &[u8]) -> String {
    B64.encode(data)
}

fn salt() -> Result<String> {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).map_err(|e| Error::RustError(e.to_string()))?;
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

fn sign_jwt(secret: &str, sub: &str, email: &str) -> Result<String> {
    let exp = Date::now().as_millis() / 1000 + 7 * 24 * 3600;
    let header = b64url(br#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = b64url(
        serde_json::json!({ "sub": sub, "email": email, "exp": exp })
            .to_string()
            .as_bytes(),
    );
    let msg = format!("{header}.{payload}");
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|e| Error::RustError(e.to_string()))?;
    mac.update(msg.as_bytes());
    Ok(format!("{msg}.{}", b64url(&mac.finalize().into_bytes())))
}

fn verify_jwt(secret: &str, token: &str) -> Option<String> {
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
    if exp < Date::now().as_millis() / 1000 {
        return None;
    }
    Some(payload.get("sub")?.as_str()?.to_string())
}

/// Returns the user id from `Authorization: Bearer <jwt>`, or None if missing/invalid.
pub fn bearer_sub(req: &Request, env: &Env) -> Result<Option<String>> {
    let secret = env.secret("JWT_SECRET")?.to_string();
    let auth = match req.headers().get("Authorization")? {
        Some(v) => v,
        None => return Ok(None),
    };
    let token = match auth.strip_prefix("Bearer ") {
        Some(t) => t,
        None => return Ok(None),
    };
    Ok(verify_jwt(&secret, token))
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

pub async fn register(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let body: RegisterBody = match req.json().await {
        Ok(b) => b,
        Err(_) => return util::err(400, "Invalid JSON body."),
    };
    let email = body.email.unwrap_or_default().trim().to_lowercase();
    let password = body.password.unwrap_or_default();
    let name = body.name.unwrap_or_default().trim().to_string();

    if !valid_email(&email) {
        return util::err(400, "Invalid email.");
    }
    if password.len() < 8 {
        return util::err(400, "Password must be at least 8 characters.");
    }

    let db = ctx.env.d1("DB")?;
    let existing: Option<UserRow> = db
        .prepare("SELECT id, email, name, password_salt, password_hash, credit_usd FROM users WHERE email = ?")
        .bind(&[JsValue::from_str(&email)])?
        .first(None)
        .await?;
    if existing.is_some() {
        return util::err(409, "Email already registered. Please log in.");
    }

    let id = uuid();
    let s = salt()?;
    let password_hash = hash_password(&password, &s);
    db.prepare("INSERT INTO users (id, email, name, password_salt, password_hash) VALUES (?, ?, ?, ?, ?)")
        .bind(&[
            JsValue::from_str(&id),
            JsValue::from_str(&email),
            JsValue::from_str(&name),
            JsValue::from_str(&s),
            JsValue::from_str(&password_hash),
        ])?
        .run()
        .await?;

    let secret = ctx.env.secret("JWT_SECRET")?.to_string();
    let token = sign_jwt(&secret, &id, &email)?;
    util::json(
        201,
        &serde_json::json!({ "token": token, "user": { "id": id, "email": email, "name": name, "credit_usd": 10.0 } }),
    )
}

pub async fn login(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let body: LoginBody = match req.json().await {
        Ok(b) => b,
        Err(_) => return util::err(400, "Invalid JSON body."),
    };
    let email = body.email.unwrap_or_default().trim().to_lowercase();
    let password = body.password.unwrap_or_default();
    if email.is_empty() || password.is_empty() {
        return util::err(400, "Email and password are required.");
    }

    let db = ctx.env.d1("DB")?;
    let row: Option<UserRow> = db
        .prepare("SELECT id, email, name, password_salt, password_hash, credit_usd FROM users WHERE email = ?")
        .bind(&[JsValue::from_str(&email)])?
        .first(None)
        .await?;
    let row = match row {
        Some(r) => r,
        None => return util::err(401, "Wrong email or password."),
    };
    if hash_password(&password, &row.password_salt) != row.password_hash {
        return util::err(401, "Wrong email or password.");
    }

    let secret = ctx.env.secret("JWT_SECRET")?.to_string();
    let token = sign_jwt(&secret, &row.id, &row.email)?;
    util::json(
        200,
        &serde_json::json!({ "token": token, "user": { "id": row.id, "email": row.email, "name": row.name, "credit_usd": row.credit_usd } }),
    )
}

pub async fn me(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Unauthorized."),
    };
    let db = ctx.env.d1("DB")?;
    let row: Option<crate::store::UserRecord> = db
        .prepare("SELECT id, email, name, credit_usd FROM users WHERE id = ?")
        .bind(&[JsValue::from_str(&user_id)])?
        .first(None)
        .await?;
    match row {
        Some(v) => util::json(
            200,
            &serde_json::json!({ "user": { "id": v.id, "email": v.email, "name": v.name, "credit_usd": v.credit_usd } }),
        ),
        None => util::err(404, "User not found."),
    }
}

fn uuid() -> String {
    // 128-bit random id, hex-encoded (no extra deps).
    let mut b = [0u8; 16];
    if getrandom::getrandom(&mut b).is_err() {
        let t = Date::now().as_millis();
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
