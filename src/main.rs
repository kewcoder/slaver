use slaver::{db::Db, AppState};

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
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
    slaver::seed::seed_templates(&db, &git_root, &env_or("APPS_DIR", "./apps")).await;
    slaver::customize::recover(&db).await;

    let state = AppState { db, jwt_secret, avatar_dir, workspace_dir, git_root, frontend_dir: std::path::PathBuf::from(&frontend_dir) };
    tokio::spawn(slaver::github::sync_loop(state.clone()));

    let app = slaver::serve::build_router(state);
    let addr = format!("0.0.0.0:{port}");
    eprintln!("slaver listening on {addr} (frontend: {frontend_dir})");
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind port");
    axum::serve(listener, app).await.expect("serve");
}
