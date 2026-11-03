//! HTTP endpoints for team-level OAuth ("Login with Slaver").
//!
//! - GET  /oauth/authorize?client_id&redirect_uri&scope&state -> login form
//! - POST /oauth/authorize                                     -> login, then consent screen
//! - POST /oauth/approve                                       -> issue code, 302 to app
//! - POST /oauth/deny                                          -> 302 with access_denied
//! - POST /oauth/token                                         -> code <-> access token
//! - GET  /oauth/userinfo                                      -> profile + team role

use axum::{
    body::Body,
    extract::{Form, Query, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    Json,
};
use serde_json::json;
use std::collections::HashMap;

use crate::{auth, oauth, store, AppState};

fn page(title: &str, inner: &str) -> String {
    format!(
        r#"<!doctype html><html lang="id"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>{title} — Slaver</title>
<style>body{{background:#09090b;color:#e4e4e7;font-family:system-ui,sans-serif;display:flex;justify-content:center;padding:32px 16px;margin:0}}
.card{{width:100%;max-width:420px;background:#18181b;border:1px solid#27272a;border-radius:12px;padding:24px}}
h1{{font-size:18px;margin:0 0 4px}}.sub{{color:#a1a1aa;font-size:13px;margin-bottom:16px}}
label{{display:block;font-size:12px;font-weight:600;color:#d4d4d8;margin:10px 0 4px}}
input{{width:100%;box-sizing:border-box;background:#27272a;border:1px solid#3f3f46;color:#fff;border-radius:8px;padding:10px;font-size:14px}}
input:focus{{outline:none;border-color:#10b981}}
button{{width:100%;margin-top:16px;background:#059669;color:#fff;border:0;border-radius:8px;padding:11px;font-size:15px;font-weight:700;cursor:pointer}}
button.ghost{{background:transparent;border:1px solid#3f3f46}}
.err{{background:#450a0a;border:1px solid#7f1d1d;color:#fca5a5;border-radius:8px;padding:10px;font-size:13px;margin-bottom:8px}}
ul{{font-size:13px;color:#d4d4d8;padding-left:18px}}.li{{margin:2px 0}}
.logo{{font-weight:800;letter-spacing:-.5px;margin-bottom:16px}}.logo span{{color:#10b981}}</style></head>
<body><div class="card"><div class="logo">Slaver <span>connect</span></div>{inner}</div></body></html>"#,
        title = title,
        inner = inner
    )
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn login_form(q: &HashMap<String, String>, err: Option<&str>) -> String {
    let hidden = ["client_id", "redirect_uri", "scope", "state"]
        .iter()
        .map(|k| {
            format!(
                r#"<input type="hidden" name="{k}" value="{v}" />"#,
                k = k,
                v = esc(q.get(*k).unwrap_or(&String::new()))
            )
        })
        .collect::<Vec<_>>()
        .join("");
    page(
        "Log in",
        &format!(
            r#"<h1>Log in to Slaver</h1><div class="sub">Continue to authorize the app.</div>{err}<form method="post" action="/oauth/authorize">{hidden}<label>Email<input type="email" name="email" required autocomplete="email" /></label><label>Password<input type="password" name="password" required autocomplete="current-password" /></label><button type="submit">Log in</button></form>"#,
            err = err.map(|e| format!(r#"<div class="err">{}</div>"#, esc(e))).unwrap_or_default(),
            hidden = hidden,
        ),
    )
}

fn consent_form(ticket: &str, app_name: &str, team_name: &str, email: &str, redirect_uri: &str, state: &str) -> String {
    page(
        "Authorize",
        &format!(
            r#"<h1>Authorize {app}</h1><div class="sub">{email} · team {team}</div><p style="font-size:13px;color:#d4d4d8">This app will receive:</p><ul class="li"><li>Your name and email</li><li>Your team (<b>{team}</b>) and role in it</li></ul><form method="post" action="/oauth/approve"><input type="hidden" name="ticket" value="{ticket}" /><input type="hidden" name="redirect_uri" value="{ru}" /><input type="hidden" name="state" value="{st}" /><button type="submit">Allow</button></form><form method="post" action="/oauth/deny"><input type="hidden" name="redirect_uri" value="{ru}" /><input type="hidden" name="state" value="{st}" /><button class="ghost" type="submit">Deny</button></form>"#,
            app = esc(app_name),
            team = esc(team_name),
            email = esc(email),
            ticket = esc(ticket),
            ru = esc(redirect_uri),
            st = esc(state),
        ),
    )
}

fn redirect_with(to: &str, params: &str) -> Response {
    let sep = if to.contains('?') { "&" } else { "?" };
    (
        StatusCode::FOUND,
        [(axum::http::header::LOCATION, format!("{to}{sep}{params}"))],
    )
        .into_response()
}

async fn client_or_err(state: &AppState, client_id: &str, redirect_uri: &str) -> Result<oauth::ClientRow, Response> {
    let fail = |msg: &str| (StatusCode::BAD_REQUEST, Html(page("Error", &format!("<div class=\"err\">{}</div>", esc(msg))))).into_response();
    let client = oauth::get_client(&state.db, client_id).await.map_err(|_| fail("Unknown app (client)."))?;
    let client = client.ok_or_else(|| fail("Unknown app (client)."))?;
    if !oauth::valid_redirect(&client, redirect_uri) {
        return Err(fail("Redirect URI not registered for this app."));
    }
    Ok(client)
}

pub async fn authorize_get(State(state): State<AppState>, Query(q): Query<HashMap<String, String>>) -> Response {
    let client_id = q.get("client_id").cloned().unwrap_or_default();
    let redirect_uri = q.get("redirect_uri").cloned().unwrap_or_default();
    if client_or_err(&state, &client_id, &redirect_uri).await.is_err() {
        // client_or_err already built the error page; rebuild minimal variant:
        return (StatusCode::BAD_REQUEST, Html(page("Error", "<div class=\"err\">Invalid authorize request (unknown app or redirect URI).</div>"))).into_response();
    }
    (StatusCode::OK, Html(login_form(&q, None))).into_response()
}

pub async fn authorize_post(State(state): State<AppState>, Form(f): Form<HashMap<String, String>>) -> Response {
    let get = |k: &str| f.get(k).cloned().unwrap_or_default();
    let (client_id, redirect_uri, scope, st) = (get("client_id"), get("redirect_uri"), get("scope"), get("state"));
    if client_or_err(&state, &client_id, &redirect_uri).await.is_err() {
        return (StatusCode::BAD_REQUEST, Html(page("Error", "<div class=\"err\">Invalid authorize request.</div>"))).into_response();
    }
    let email = get("email");
    let password = get("password");
    let user = match auth::login_core(&state.db, &state.jwt_secret, &email, &password).await {
        Ok(u) => u,
        Err(e) => {
            let mut q = HashMap::new();
            q.insert("client_id".into(), client_id);
            q.insert("redirect_uri".into(), redirect_uri);
            q.insert("scope".into(), scope);
            q.insert("state".into(), st);
            return (StatusCode::OK, Html(login_form(&q, Some(&e)))).into_response();
        }
    };
    let user_id: String = user.user.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let client = match oauth::get_client(&state.db, &client_id).await {
        Ok(Some(c)) => c,
        _ => return (StatusCode::BAD_REQUEST, Html(page("Error", "<div class=\"err\">Unknown app.</div>"))).into_response(),
    };
    // The user must belong to the client's team to log in as a team member.
    let role = match store::membership(&state.db, &client.team_id, &user_id).await {
        Ok(Some(r)) => r,
        _ => {
            return (StatusCode::OK, Html(page("No access", "<div class=\"err\">Your Slaver account is not on this team. Ask the team owner for an invite first.</div>"))).into_response();
        }
    };
    let _ = role;
    let team_name = store::get_team(&state.db, &client.team_id)
        .await
        .ok()
        .flatten()
        .map(|t| t.name)
        .unwrap_or_else(|| "team".to_string());
    let email_shown = user.user.get("email").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let scope = if scope.trim().is_empty() { "openid profile email team".to_string() } else { scope };
    let ticket = oauth::mint_login_ticket(&state.jwt_secret, &user_id, &client_id, &client.team_id, &scope);
    (StatusCode::OK, Html(consent_form(&ticket, &client.name, &team_name, &email_shown, &redirect_uri, &st))).into_response()
}

pub async fn approve_post(State(state): State<AppState>, Form(f): Form<HashMap<String, String>>) -> Response {
    let get = |k: &str| f.get(k).cloned().unwrap_or_default();
    let (ticket, redirect_uri, st) = (get("ticket"), get("redirect_uri"), get("state"));
    let (user_id, client_id, team_id, scope) = match oauth::verify_login_ticket(&state.jwt_secret, &ticket) {
        Some(t) => t,
        None => return (StatusCode::BAD_REQUEST, Html(page("Error", "<div class=\"err\">Session expired. Start login again.</div>"))).into_response(),
    };
    let client = match oauth::get_client(&state.db, &client_id).await {
        Ok(Some(c)) if oauth::valid_redirect(&c, &redirect_uri) && c.team_id == team_id => c,
        _ => return (StatusCode::BAD_REQUEST, Html(page("Error", "<div class=\"err\">Invalid app or redirect.</div>"))).into_response(),
    };
    let _ = client;
    let code = match oauth::issue_code(&state.db, &client_id, &user_id, &team_id, &redirect_uri, &scope).await {
        Ok(c) => c,
        Err(_) => return (StatusCode::BAD_REQUEST, Html(page("Error", "<div class=\"err\">Could not issue code.</div>"))).into_response(),
    };
    redirect_with(&redirect_uri, &format!("code={}&state={}", urlenc(&code), urlenc(&st)))
}

pub async fn deny_post(Form(f): Form<HashMap<String, String>>) -> Response {
    let get = |k: &str| f.get(k).cloned().unwrap_or_default();
    let (redirect_uri, st) = (get("redirect_uri"), get("state"));
    if redirect_uri.is_empty() {
        return (StatusCode::BAD_REQUEST, Html(page("Error", "<div class=\"err\">Missing redirect.</div>"))).into_response();
    }
    redirect_with(&redirect_uri, &format!("error=access_denied&state={}", urlenc(&st)))
}

fn urlenc(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{b:02X}"));
        }
    }
    o
}

#[derive(serde::Deserialize, Default)]
pub struct TokenReq {
    pub grant_type: Option<String>,
    pub code: Option<String>,
    pub redirect_uri: Option<String>,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
}

pub async fn token_post(State(state): State<AppState>, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    // Accept JSON or form.
    let ctype = headers.get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let mut map: HashMap<String, String> = HashMap::new();
    let mut client_id = String::new();
    let mut client_secret = String::new();
    if let Some(auth) = headers.get("authorization").and_then(|v| v.to_str().ok()) {
        if let Some(b64) = auth.strip_prefix("Basic ") {
            use base64::Engine as _;
            if let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
                if let Ok(s) = String::from_utf8(raw) {
                    if let Some((u, p)) = s.split_once(':') {
                        client_id = u.to_string();
                        client_secret = p.to_string();
                    }
                }
            }
        }
    }
    if ctype.contains("application/json") {
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&body) {
            let g = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
            map.insert("grant_type".into(), g("grant_type"));
            map.insert("code".into(), g("code"));
            map.insert("redirect_uri".into(), g("redirect_uri"));
            if client_id.is_empty() {
                client_id = g("client_id");
            }
            if client_secret.is_empty() {
                client_secret = g("client_secret");
            }
        }
    } else {
        let s = String::from_utf8_lossy(&body).to_string();
        for pair in s.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                map.insert(urldec(k).unwrap_or_default(), urldec(v).unwrap_or_default());
            }
        }
        if client_id.is_empty() {
            client_id = map.get("client_id").cloned().unwrap_or_default();
        }
        if client_secret.is_empty() {
            client_secret = map.get("client_secret").cloned().unwrap_or_default();
        }
    }
    let err = |code: &str, desc: &str| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": code, "error_description": desc })),
        )
            .into_response()
    };
    if map.get("grant_type").map(|s| s.as_str()) != Some("authorization_code") {
        return err("unsupported_grant_type", "Only authorization_code is supported.");
    }
    let client = match oauth::get_client(&state.db, &client_id).await {
        Ok(Some(c)) => c,
        _ => return err("invalid_client", "Unknown client."),
    };
    if sha256_hex(&client_secret) != client.secret_hash {
        return err("invalid_client", "Bad client secret.");
    }
    let code = map.get("code").cloned().unwrap_or_default();
    let redirect_uri = map.get("redirect_uri").cloned().unwrap_or_default();
    let grant = match oauth::redeem_code(&state.db, &client, &code, &redirect_uri).await {
        Ok(g) => g,
        Err(_) => return err("invalid_grant", "Bad, used, or expired code."),
    };
    let (token, ttl) = match oauth::issue_token(&state.db, &client.id, &grant.user_id, &grant.team_id, &grant.scope).await {
        Ok(t) => t,
        Err(_) => return err("server_error", "Could not issue token."),
    };
    (
        StatusCode::OK,
        Json(json!({ "access_token": token, "token_type": "Bearer", "expires_in": ttl, "scope": grant.scope })),
    )
        .into_response()
}

fn sha256_hex(s: &str) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(s.as_bytes()))
}

fn urldec(s: &str) -> Option<String> {
    let mut out = Vec::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                let h = std::str::from_utf8(&b[i + 1..i + 3]).ok()?;
                out.push(u8::from_str_radix(h, 16).ok()?);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

pub async fn userinfo_get(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("")
        .trim()
        .to_string();
    let info = match oauth::verify_token(&state.db, &token).await {
        Ok(Some(i)) => i,
        _ => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "invalid_token" })),
            )
                .into_response()
        }
    };
    let user = match crate::auth::me_core(&state.db, &info.user_id).await {
        Ok(u) => u,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "invalid_token" })),
            )
                .into_response()
        }
    };
    let role = crate::store::membership(&state.db, &info.team_id, &info.user_id)
        .await
        .unwrap_or(None)
        .unwrap_or_default();
    let team_name = crate::store::get_team(&state.db, &info.team_id)
        .await
        .ok()
        .flatten()
        .map(|t| t.name)
        .unwrap_or_default();
    (
        StatusCode::OK,
        Json(json!({
            "sub": info.user_id,
            "email": user.get("email"),
            "name": user.get("name"),
            "team_id": info.team_id,
            "team_name": team_name,
            "role": role,
            "scope": info.scope,
        })),
    )
        .into_response()
}
