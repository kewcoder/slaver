pub mod ai;
pub mod auth;
pub mod db;
pub mod fly;
pub mod git;
pub mod github;
pub mod git_http;
pub mod hosting;
pub mod hitpay;
pub mod mcp;
pub mod oauth;
pub mod oauth_http;
pub mod platform;
pub mod platform_api;
pub mod provider;
pub mod review;
pub mod seed;
pub mod store;
pub mod teams;
pub mod util;

use std::path::PathBuf;

/// Shared server state (replaces the Cloudflare `Env`).
#[derive(Clone)]
pub struct AppState {
    pub db: db::Db,
    pub jwt_secret: String,
    pub avatar_dir: PathBuf,
    pub workspace_dir: PathBuf,
    pub git_root: PathBuf,
    pub frontend_dir: PathBuf,
}
