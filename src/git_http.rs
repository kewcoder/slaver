//! Git Smart HTTP transport backed by `git http-backend` (CGI).
//!
//! Routes (mounted under /git):
//!   GET  /git/:repo/info/refs?service=git-upload-pack|git-receive-pack
//!   POST /git/:repo/git-upload-pack
//!   POST /git/:repo/git-receive-pack
//! Auth: `Authorization: Bearer <jwt>` or Basic `:<jwt>` (i.e. clone with
//! `https://token:<JWT>@host/git/<repo-id>`). Reads need team membership
//! (templates are public); pushes need owner/admin.

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
};
use std::collections::HashMap;

use crate::{platform, store, AppState};

fn bearer_from(headers: &HeaderMap) -> Option<String> {
    let v = headers.get("authorization")?.to_str().ok()?;
    if let Some(t) = v.strip_prefix("Bearer ") {
        return Some(t.trim().to_string());
    }
    if let Some(b64) = v.strip_prefix("Basic ") {
        let decoded = base64_decode(b64.trim())?;
        let s = String::from_utf8(decoded).ok()?;
        let token = s.split_once(':').map(|(_, p)| p).unwrap_or(&s);
        if !token.is_empty() {
            return Some(token.to_string());
        }
    }
    None
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}

pub async fn handle(
    state: State<AppState>,
    headers: HeaderMap,
    Path((repo, rest)): Path<(String, String)>,
    query: Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    handle_at(state, headers, repo, rest, query, body).await
}

pub async fn handle_at(
    State(state): State<AppState>,
    headers: HeaderMap,
    repo_id: String,
    rest: String,
    Query(query): Query<HashMap<String, String>>,
    body: Bytes,
) -> Response {
    // Accept `Bearer <jwt>` or Basic `user:<jwt>` (git clone with the JWT as password).
    let token = match bearer_from(&headers) {
        Some(t) => t,
        None => return unauthorized(),
    };
    let user_id = match crate::auth::verify_bearer_token(&state.jwt_secret, &token) {
        Some(u) => u,
        None => return unauthorized(),
    };
    if repo_id.is_empty() || repo_id.contains('/') || repo_id == "." || repo_id == ".." {
        return plain(400, "Bad repo id.");
    }
    let repo = match platform::get_repo(&state.db, &user_id, &repo_id).await {
        Ok(Some(r)) => r,
        Ok(None) => return plain(404, "Repo not found."),
        Err(e) => return plain(500, &format!("DB error: {e}")),
    };
    let is_write = rest == "git-receive-pack"
        || (rest == "info/refs" && query.get("service").map(|s| s.as_str()) == Some("git-receive-pack"));
    if !is_write && !platform::can_read_source(&state.db, &user_id, &repo).await.unwrap_or(false) {
        return plain(403, "Buy this app in the Slaver marketplace to get your own copy of the source.");
    }
    if is_write && crate::github::linked_repo(&state.db, &repo_id).await.is_some() {
        return plain(409, "This repo is synced from GitHub — push to GitHub instead (Slaver mirrors it).");
    }
    if is_write && repo.template != 0 {
        return plain(403, "Templates are read-only — fork first, then push to your fork.");
    }
    if is_write {
        // Push needs owner/admin on the repo's team.
        match store::membership(&state.db, &repo.team_id, &user_id).await {
            Ok(Some(r)) if r == "owner" || r == "admin" => {}
            _ => return plain(403, "Only owners and admins can push."),
        }
    }
    let git_root = state.git_root.to_string_lossy().to_string();
    if let Err(e) = platform::ensure_bare_repo(&git_root, &repo_id).await {
        return plain(500, &format!("Repo unavailable: {e}"));
    }
    let path_info = format!("/{repo_id}.git/{rest}");
    let query_string = query
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");
    let content_type = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let mut cmd = tokio::process::Command::new("git");
    cmd.arg("http-backend")
        .env("GIT_PROJECT_ROOT", &git_root)
        .env("GIT_HTTP_EXPORT_ALL", "1")
        .env("PATH_INFO", &path_info)
        .env("REQUEST_METHOD", if body.is_empty() { "GET" } else { "POST" })
        .env("QUERY_STRING", &query_string)
        .env("CONTENT_TYPE", &content_type)
        .env("REMOTE_USER", &user_id)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return plain(500, &format!("git backend unavailable: {e}")),
    };
    if !body.is_empty() {
        use tokio::io::AsyncWriteExt;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(&body).await;
        }
    }
    let out = match child.wait_with_output().await {
        Ok(o) => o,
        Err(e) => return plain(500, &format!("git backend failed: {e}")),
    };
    if !out.status.success() && out.stdout.is_empty() {
        return plain(502, &format!("git backend error: {}", String::from_utf8_lossy(&out.stderr)));
    }
    // Parse CGI headers (headers, blank line, body).
    let raw = out.stdout;
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| (i, 4))
        .or_else(|| raw.windows(2).position(|w| w == b"\n\n").map(|i| (i, 2)));
    let (mut status, mut ctype, mut body_bytes) = (200u16, "application/octet-stream".to_string(), raw.as_slice());
    if let Some((i, sep)) = split {
        let head = String::from_utf8_lossy(&raw[..i]).to_string();
        body_bytes = &raw[i + sep..];
        for line in head.lines() {
            if let Some(v) = line.strip_prefix("Status:") {
                if let Ok(code) = v.trim().split_whitespace().next().unwrap_or("").parse::<u16>() {
                    status = code;
                }
            } else if let Some(v) = line.strip_prefix("Content-Type:") {
                ctype = v.trim().to_string();
            }
        }
    }
    let code = axum::http::StatusCode::from_u16(status).unwrap_or(axum::http::StatusCode::OK);
    let mut headermap = axum::http::HeaderMap::new();
    headermap.insert(axum::http::header::CONTENT_TYPE, ctype.parse().unwrap_or(axum::http::header::HeaderValue::from_static("application/octet-stream")));
    headermap.insert("cache-control", axum::http::header::HeaderValue::from_static("no-cache"));
    (code, headermap, body_bytes.to_vec()).into_response()
}

fn unauthorized() -> Response {
    (
        axum::http::StatusCode::from_u16(401).unwrap(),
        [(axum::http::header::WWW_AUTHENTICATE, "Basic realm=\"slaver-git\"")],
        "Unauthorized: use https://token:<JWT>@host/git/<repo>.",
    )
        .into_response()
}

fn plain(status: u16, msg: &str) -> Response {
    (
        axum::http::StatusCode::from_u16(status).unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR),
        msg.to_string(),
    )
        .into_response()
}
