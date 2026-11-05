//! HTTP router for the Slaver platform server.
//!
//! Extracted from `main.rs` so the same router can be embedded elsewhere
//! (e.g. the Tauri desktop app, which serves the platform on localhost).
//! Behavior is identical: MCP endpoint, git service, OAuth, webhooks,
//! and the web frontend as a fallback.

use axum::{
    middleware::{self, Next},
    http::Request,
    response::Response,
    routing::{get, post},
    Router,
};
use tower_http::{cors::CorsLayer, services::{ServeDir, ServeFile}};

use crate::{git_http, mcp, oauth_http, platform_api, AppState};

async fn git_info_refs(
    state: axum::extract::State<AppState>,
    headers: axum::http::HeaderMap,
    axum::extract::Path(repo): axum::extract::Path<String>,
    query: axum::extract::Query<std::collections::HashMap<String, String>>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    git_http::handle_at(state, headers, repo, "info/refs".to_string(), query, body).await
}

async fn git_upload_pack(
    state: axum::extract::State<AppState>,
    headers: axum::http::HeaderMap,
    axum::extract::Path(repo): axum::extract::Path<String>,
    query: axum::extract::Query<std::collections::HashMap<String, String>>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    git_http::handle_at(state, headers, repo, "git-upload-pack".to_string(), query, body).await
}

async fn git_receive_pack(
    state: axum::extract::State<AppState>,
    headers: axum::http::HeaderMap,
    axum::extract::Path(repo): axum::extract::Path<String>,
    query: axum::extract::Query<std::collections::HashMap<String, String>>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    git_http::handle_at(state, headers, repo, "git-receive-pack".to_string(), query, body).await
}

/// Cache policy for browsers and any downstream cache.
/// Static bundles are content-hashed by Vite, so they are immutable;
/// every dynamic surface (API, auth, git, webhooks, SPA shell) must never
/// be cached, otherwise one user could be served another's content.
async fn cache_headers(req: Request<axum::body::Body>, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let mut res = next.run(req).await;
    let value = if path.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else if path == "/mcp"
        || path.starts_with("/api/")
        || path.starts_with("/git/")
        || path.starts_with("/oauth/")
        || path.starts_with("/hooks/")
    {
        "no-store"
    } else {
        "no-cache"
    };
    if let Ok(v) = value.parse() {
        res.headers_mut()
            .insert(axum::http::header::CACHE_CONTROL, v);
    }
    res
}

pub fn build_router(state: AppState) -> Router {    let index = state.frontend_dir.join("index.html");
    Router::new()
        .route("/mcp", post(mcp::rpc))
        .route("/ping", get(|| async { "ok" }))
        .route(
            "/git/:repo/info/refs",
            get(git_info_refs).post(git_info_refs),
        )
        .route(
            "/git/:repo/git-upload-pack",
            post(git_upload_pack),
        )
        .route(
            "/git/:repo/git-receive-pack",
            post(git_receive_pack).layer(axum::extract::DefaultBodyLimit::max(512 * 1024 * 1024)),
        )
        .route("/api/github/callback", get(crate::github::oauth_callback))
        .route(
            "/api/repos/:repo/upload",
            post(crate::hosting::upload_http).layer(axum::extract::DefaultBodyLimit::max(200 * 1024 * 1024)),
        )
        .route("/oauth/authorize", get(oauth_http::authorize_get).post(oauth_http::authorize_post))
        .route("/oauth/approve", post(oauth_http::approve_post))
        .route("/oauth/deny", post(oauth_http::deny_post))
        .route("/oauth/token", post(oauth_http::token_post))
        .route("/oauth/userinfo", get(oauth_http::userinfo_get))
        .route("/hooks/hitpay", post(platform_api::hitpay_webhook))
        .fallback_service(
            ServeDir::new(&state.frontend_dir)
                .not_found_service(ServeFile::new(&index)),
        )
        .layer(CorsLayer::permissive())
        .layer(middleware::from_fn(cache_headers))
        .with_state(state)
}

/// Serve a built router on an already-bound localhost listener.
/// Used by the desktop app, which picks an ephemeral port.
pub async fn serve(listener: tokio::net::TcpListener, app: Router) -> Result<(), std::io::Error> {
    axum::serve(listener, app).await
}
