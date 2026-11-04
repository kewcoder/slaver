use axum::{middleware::{self, Next}, http::Request, response::Response, routing::{get, post}, Router};
use chrono::Datelike;
use slaver::{db::Db, git_http, inbox, mcp, oauth_http, platform_api, schedule, store, summarize, AppState};
use std::{collections::HashMap, time::Duration};
use tower_http::{cors::CorsLayer, services::{ServeDir, ServeFile}};

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

/// Background scheduler (replaces Cloudflare cron triggers):
/// - every 60s tick: fire due bot schedules (at most once per 15 min)
/// - 00:05 Jakarta daily: yesterday's recap per bot
/// - Monday 00:10 Jakarta: weekly rollup
/// - 1st of month 00:15 Jakarta: monthly rollup
/// Summary jobs upsert by period key, so a restart re-fire is harmless.
async fn scheduler(state: AppState) {
    let mut last_due = std::time::Instant::now() - Duration::from_secs(3600);
    let mut fired: HashMap<String, String> = HashMap::new();
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        // Due schedules (15-min cadence like the old */15 cron).
        if last_due.elapsed() >= Duration::from_secs(15 * 60) {
            last_due = std::time::Instant::now();
            let n = schedule::run_due(&state.db).await;
            if n > 0 {
                eprintln!("scheduled: fired {n} due schedules");
            }
        }
        // Jakarta wall clock for the summary jobs.
        let now = chrono::Utc::now() + chrono::Duration::hours(7);
        let date = now.format("%Y-%m-%d").to_string();
        let hhmm = now.format("%H:%M").to_string();
        let should_daily = hhmm.as_str() >= "00:05";
        let should_weekly = now.date_naive().weekday() == chrono::Weekday::Mon && hhmm.as_str() >= "00:10";
        let should_monthly = now.date_naive().day() == 1 && hhmm.as_str() >= "00:15";
        let scopes = match store::all_bot_scopes(&state.db).await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("scheduled: list bots failed: {e}");
                continue;
            }
        };
        for scope in scopes {
            let bot = match store::get_bot(&state.db, &scope.user_id, &scope.id).await {
                Ok(Some(b)) => b,
                Ok(None) => continue,
                Err(e) => {
                    eprintln!("scheduled: get bot failed: {e}");
                    continue;
                }
            };
            if should_daily && fired.get(&format!("d:{}", bot.id)).map(|d| d != &date).unwrap_or(true) {
                match summarize::run_daily(&state.db, &bot, &scope.user_id).await {
                    Ok(_) => {
                        fired.insert(format!("d:{}", bot.id), date.clone());
                    }
                    Err(e) => eprintln!("scheduled: daily summary failed for {}: {e}", bot.id),
                }
            }
            if should_weekly {
                let week = now.iso_week();
                let key = format!("{:04}-W{:02}", week.year(), week.week());
                if fired.get(&format!("w:{}", bot.id)).map(|k| k != &key).unwrap_or(true) {
                    match summarize::run_weekly(&state.db, &bot, &scope.user_id).await {
                        Ok(_) => {
                            fired.insert(format!("w:{}", bot.id), key);
                        }
                        Err(e) => eprintln!("scheduled: weekly summary failed for {}: {e}", bot.id),
                    }
                }
            }
            if should_monthly {
                let key = if now.month() == 1 {
                    format!("{:04}-12", now.year() - 1)
                } else {
                    format!("{:04}-{:02}", now.year(), now.month() - 1)
                };
                if fired.get(&format!("m:{}", bot.id)).map(|k| k != &key).unwrap_or(true) {
                    match summarize::run_monthly(&state.db, &bot, &scope.user_id).await {
                        Ok(_) => {
                            fired.insert(format!("m:{}", bot.id), key);
                        }
                        Err(e) => eprintln!("scheduled: monthly summary failed for {}: {e}", bot.id),
                    }
                }
            }
        }
    }
}

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

async fn git_receive_pack(
    state: axum::extract::State<AppState>,
    headers: axum::http::HeaderMap,
    axum::extract::Path(repo): axum::extract::Path<String>,
    query: axum::extract::Query<std::collections::HashMap<String, String>>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    git_http::handle_at(state, headers, repo, "git-receive-pack".to_string(), query, body).await
}

#[tokio::main]
async fn main() {
    let jwt_secret = std::env::var("JWT_SECRET").unwrap_or_default();
    if jwt_secret.trim().is_empty() {
        eprintln!("FATAL: JWT_SECRET env var is required (min 32 random chars).");
        std::process::exit(1);
    }
    let db_path = env_or("DB_PATH", "data/slaver.db");
    let avatar_dir = std::path::PathBuf::from(env_or("AVATAR_DIR", "data/avatars"));
    let workspace_dir = std::path::PathBuf::from(env_or("WORK_DIR", "data/workspaces"));
    let git_root = std::path::PathBuf::from(env_or("GIT_ROOT", "data/git"));
    let frontend_dir = env_or("FRONTEND_DIR", "frontend/dist");
    let port: u16 = env_or("PORT", "8080").parse().unwrap_or(8080);

    let db = Db::open(&db_path).expect("open sqlite db");
    db.run_migrations(&env_or("MIGRATIONS_DIR", "migrations"))
        .expect("run db migrations");
    std::fs::create_dir_all(&avatar_dir).ok();
    std::fs::create_dir_all(&workspace_dir).ok();
    std::fs::create_dir_all(&git_root).ok();
    slaver::seed::seed_templates(&db, &git_root, &env_or("SEEDS_DIR", "./seeds")).await;

    let state = AppState { db, jwt_secret, avatar_dir, workspace_dir, git_root, frontend_dir: std::path::PathBuf::from(&frontend_dir) };
    tokio::spawn(scheduler(state.clone()));

    let index = state.frontend_dir.join("index.html");
    let app = Router::new()
        .route("/mcp", post(mcp::rpc))
        .route("/ping", get(|| async { "ok" }))
        .route("/api/inbox/stream", get(inbox::inbox_stream))
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
        .route(
            "/api/repos/:repo/upload",
            post(slaver::hosting::upload_http).layer(axum::extract::DefaultBodyLimit::max(200 * 1024 * 1024)),
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
        .with_state(state);

    let addr = format!("0.0.0.0:{port}");
    eprintln!("slaver listening on {addr} (frontend: {frontend_dir})");
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind port");
    axum::serve(listener, app).await.expect("serve");
}
