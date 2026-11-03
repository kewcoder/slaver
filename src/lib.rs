pub mod auth;
pub mod avatar;
pub mod chat;
pub mod db;
pub mod deploy;
pub mod git;
pub mod git_http;
pub mod group;
pub mod harness;
pub mod huddle;
pub mod hitpay;
pub mod mcp;
pub mod oauth;
pub mod oauth_http;
pub mod platform;
pub mod platform_api;
pub mod pricing;
pub mod provider;
pub mod schedule;
pub mod seed;
pub mod store;
pub mod summarize;
pub mod teams;
pub mod util;
pub mod voice;

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
