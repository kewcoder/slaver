//! Team-level OAuth ("Login with Slaver") for apps deployed on user VPSes.
//!
//! Flow: app -> GET /oauth/authorize -> (login) -> consent -> redirect with
//! code -> app POST /oauth/token -> access token -> GET /oauth/userinfo.
//! The userinfo carries the user's Slaver team role, so the deployed app can
//! enforce the same roles without its own user database.

use serde::{Deserialize, Serialize};

use crate::db::{v_int, v_text, Db};

fn rand_hex(nbytes: usize) -> String {
    let mut b = vec![0u8; nbytes];
    if getrandom::getrandom(&mut b).is_err() {
        let t = crate::db::now_millis();
        for (i, byte) in b.iter_mut().enumerate() {
            *byte = ((t >> (8 * (i % 8))) & 0xff) as u8;
        }
    }
    hex::encode(b)
}

fn sha_hex(s: &str) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(s.as_bytes()))
}

pub fn now_secs() -> i64 {
    (crate::db::now_millis() / 1000) as i64
}

#[derive(Deserialize, Serialize, Clone)]
pub struct OAuthClient {
    pub id: String,
    pub team_id: String,
    pub name: String,
    pub redirect_uris: String,
    pub created_at: String,
}

pub async fn create_client(
    db: &Db,
    team_id: &str,
    user_id: &str,
    name: &str,
    redirect_uris: &[String],
) -> anyhow::Result<(OAuthClient, String)> {
    match crate::store::membership(db, team_id, user_id).await? {
        Some(r) if r == "owner" || r == "admin" => {}
        _ => anyhow::bail!("Only owners and admins can create OAuth clients."),
    }
    let name = name.trim().chars().take(80).collect::<String>();
    if name.is_empty() {
        anyhow::bail!("Client name is required.");
    }
    let clean: Vec<String> = redirect_uris
        .iter()
        .map(|u| u.trim().to_string())
        .filter(|u| u.starts_with("https://") || u.starts_with("http://localhost"))
        .take(10)
        .collect();
    if clean.is_empty() {
        anyhow::bail!("At least one https:// (or http://localhost) redirect URI is required.");
    }
    let id = format!("slv_{}", rand_hex(12));
    let secret = format!("slvsk_{}", rand_hex(32));
    db.prepare("INSERT INTO oauth_clients (id, team_id, name, secret_hash, redirect_uris, created_by) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&[v_text(&id), v_text(team_id), v_text(&name), v_text(&sha_hex(&secret)), v_text(&serde_json::to_string(&clean).unwrap_or_default()), v_text(user_id)])?
        .run()
        .await?;
    let row: Option<OAuthClient> = db
        .prepare("SELECT id, team_id, name, redirect_uris, created_at FROM oauth_clients WHERE id = ?")
        .bind(&[v_text(&id)])?
        .first(None)
        .await?;
    row.map(|r| (r, secret)).ok_or_else(|| anyhow::anyhow!("client insert failed"))
}

pub async fn list_clients(db: &Db, team_id: &str, user_id: &str) -> anyhow::Result<Vec<OAuthClient>> {
    match crate::store::membership(db, team_id, user_id).await? {
        Some(r) if r == "owner" || r == "admin" => {}
        _ => anyhow::bail!("Only owners and admins can view OAuth clients."),
    }
    db.prepare("SELECT id, team_id, name, redirect_uris, created_at FROM oauth_clients WHERE team_id = ? ORDER BY created_at DESC LIMIT 50")
        .bind(&[v_text(team_id)])?
        .all()
        .await?
        .results()
        .map_err(Into::into)
}

pub async fn revoke_client(db: &Db, team_id: &str, user_id: &str, client_id: &str) -> anyhow::Result<()> {
    match crate::store::membership(db, team_id, user_id).await? {
        Some(r) if r == "owner" || r == "admin" => {}
        _ => anyhow::bail!("Only owners and admins can revoke OAuth clients."),
    }
    db.prepare("UPDATE oauth_tokens SET revoked = 1 WHERE client_id = ?")
        .bind(&[v_text(client_id)])?
        .run()
        .await?;
    db.prepare("DELETE FROM oauth_codes WHERE client_id = ?")
        .bind(&[v_text(client_id)])?
        .run()
        .await?;
    db.prepare("DELETE FROM oauth_clients WHERE id = ? AND team_id = ?")
        .bind(&[v_text(client_id), v_text(team_id)])?
        .run()
        .await?;
    Ok(())
}

#[derive(Clone)]
pub struct ClientRow {
    pub id: String,
    pub team_id: String,
    pub secret_hash: String,
    pub redirect_uris: Vec<String>,
    pub name: String,
}

pub async fn get_client(db: &Db, client_id: &str) -> anyhow::Result<Option<ClientRow>> {
    #[derive(serde::Deserialize)]
    struct R {
        id: String,
        team_id: String,
        secret_hash: String,
        redirect_uris: String,
        name: String,
    }
    let row: Option<R> = db
        .prepare("SELECT id, team_id, secret_hash, redirect_uris, name FROM oauth_clients WHERE id = ?")
        .bind(&[v_text(client_id)])?
        .first(None)
        .await?;
    Ok(row.map(|r| ClientRow {
        id: r.id,
        team_id: r.team_id,
        secret_hash: r.secret_hash,
        redirect_uris: serde_json::from_str(&r.redirect_uris).unwrap_or_default(),
        name: r.name,
    }))
}

pub fn valid_redirect(client: &ClientRow, uri: &str) -> bool {
    client.redirect_uris.iter().any(|u| u == uri)
}

/// Short-lived login ticket binding a user to an authorize request.
pub fn mint_login_ticket(jwt_secret: &str, user_id: &str, client_id: &str, team_id: &str, scope: &str) -> String {
    use hmac::Mac;
    let exp = now_secs() + 600;
    let payload = serde_json::json!({ "sub": user_id, "client": client_id, "team": team_id, "scope": scope, "exp": exp, "purpose": "oauth-consent" }).to_string();
    use base64::Engine as _;
    const B: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let h = B.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let p = B.encode(payload.as_bytes());
    let msg = format!("{h}.{p}");
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(jwt_secret.as_bytes()).expect("hmac");
    mac.update(msg.as_bytes());
    format!("{msg}.{}", B.encode(mac.finalize().into_bytes()))
}

pub fn verify_login_ticket(jwt_secret: &str, token: &str) -> Option<(String, String, String, String)> {
    use base64::Engine as _;
    use hmac::Mac;
    const B: base64::engine::general_purpose::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let mut parts = token.split('.');
    let (h, p, s) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let msg = format!("{h}.{p}");
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(jwt_secret.as_bytes()).ok()?;
    mac.update(msg.as_bytes());
    let sig = B.decode(s).ok()?;
    mac.verify_slice(&sig).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&B.decode(p).ok()?).ok()?;
    if v.get("purpose")?.as_str()? != "oauth-consent" {
        return None;
    }
    if v.get("exp")?.as_i64()? < now_secs() {
        return None;
    }
    Some((
        v.get("sub")?.as_str()?.to_string(),
        v.get("client")?.as_str()?.to_string(),
        v.get("team")?.as_str()?.to_string(),
        v.get("scope")?.as_str().unwrap_or("").to_string(),
    ))
}

pub async fn issue_code(
    db: &Db,
    client_id: &str,
    user_id: &str,
    team_id: &str,
    redirect_uri: &str,
    scope: &str,
) -> anyhow::Result<String> {
    let code = format!("slvc_{}", rand_hex(32));
    db.prepare("INSERT INTO oauth_codes (code_hash, client_id, user_id, team_id, redirect_uri, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(&[
            v_text(&sha_hex(&code)),
            v_text(client_id),
            v_text(user_id),
            v_text(team_id),
            v_text(redirect_uri),
            v_text(scope),
            v_int(now_secs() + 600),
        ])?
        .run()
        .await?;
    Ok(code)
}

pub struct CodeGrant {
    pub user_id: String,
    pub team_id: String,
    pub scope: String,
}

pub async fn redeem_code(db: &Db, client: &ClientRow, code: &str, redirect_uri: &str) -> anyhow::Result<CodeGrant> {
    #[derive(serde::Deserialize)]
    struct R {
        user_id: String,
        team_id: String,
        scope: String,
        expires_at: i64,
        used: i64,
        redirect_uri: String,
    }
    let row: Option<R> = db
        .prepare("SELECT user_id, team_id, scope, expires_at, used, redirect_uri FROM oauth_codes WHERE code_hash = ? AND client_id = ?")
        .bind(&[v_text(&sha_hex(code)), v_text(&client.id)])?
        .first(None)
        .await?;
    let r = row.ok_or_else(|| anyhow::anyhow!("invalid_grant"))?;
    if r.used != 0 || r.expires_at < now_secs() || r.redirect_uri != redirect_uri {
        return Err(anyhow::anyhow!("invalid_grant"));
    }
    db.prepare("UPDATE oauth_codes SET used = 1 WHERE code_hash = ?")
        .bind(&[v_text(&sha_hex(code))])?
        .run()
        .await?;
    Ok(CodeGrant { user_id: r.user_id, team_id: r.team_id, scope: r.scope })
}

pub async fn issue_token(db: &Db, client_id: &str, user_id: &str, team_id: &str, scope: &str) -> anyhow::Result<(String, i64)> {
    let token = format!("slvt_{}", rand_hex(32));
    let ttl: i64 = 30 * 24 * 3600;
    db.prepare("INSERT INTO oauth_tokens (token_hash, client_id, user_id, team_id, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&[
            v_text(&sha_hex(&token)),
            v_text(client_id),
            v_text(user_id),
            v_text(team_id),
            v_text(scope),
            v_int(now_secs() + ttl),
        ])?
        .run()
        .await?;
    Ok((token, ttl))
}

pub struct TokenInfo {
    pub user_id: String,
    pub team_id: String,
    pub client_id: String,
    pub scope: String,
}

pub async fn verify_token(db: &Db, token: &str) -> anyhow::Result<Option<TokenInfo>> {
    #[derive(serde::Deserialize)]
    struct R {
        user_id: String,
        team_id: String,
        client_id: String,
        scope: String,
        expires_at: i64,
        revoked: i64,
    }
    let row: Option<R> = db
        .prepare("SELECT user_id, team_id, client_id, scope, expires_at, revoked FROM oauth_tokens WHERE token_hash = ?")
        .bind(&[v_text(&sha_hex(token))])?
        .first(None)
        .await?;
    Ok(match row {
        Some(r) if r.revoked == 0 && r.expires_at >= now_secs() => Some(TokenInfo {
            user_id: r.user_id,
            team_id: r.team_id,
            client_id: r.client_id,
            scope: r.scope,
        }),
        _ => None,
    })
}

pub fn parse_scope(s: &str) -> Vec<String> {
    s.split_whitespace().map(|x| x.to_string()).filter(|x| !x.is_empty()).collect()
}
