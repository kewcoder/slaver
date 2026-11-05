//! MCP tools for the Slaver platform layer: projects/kanban, git repos,
//! marketplace licenses, installs to Fly, listing reviews. Dispatched from mcp.rs.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

use crate::{platform, store, AppState};

fn rpc_ok(id: Value, result: Value) -> Response {
    use axum::{http::StatusCode, response::IntoResponse, Json};
    (StatusCode::OK, Json(json!({ "jsonrpc": "2.0", "id": id, "result": result }))).into_response()
}

fn rpc_err(id: Value, code: i32, message: &str) -> Response {
    use axum::{http::StatusCode, response::IntoResponse, Json};
    (
        StatusCode::OK,
        Json(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })),
    )
        .into_response()
}

fn mcp_data(id: Value, summary: String, data: Value) -> Response {
    rpc_ok(id, json!({ "content": [{ "type": "text", "text": summary }], "data": data }))
}

fn arg_str(args: &Value, key: &str) -> String {
    args.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

pub fn tool_defs() -> Vec<Value> {
    vec![
        json!({ "name": "projects_create", "description": "Create a project (app under development) on a team.", "inputSchema": { "type": "object", "required": ["team_id", "name"], "properties": { "team_id": { "type": "string" }, "name": { "type": "string" }, "description": { "type": "string" } } } }),
        json!({ "name": "projects_list", "description": "List projects on a team with progress stats.", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" } } } }),
        json!({ "name": "projects_get", "description": "One project with progress stats.", "inputSchema": { "type": "object", "required": ["project_id"], "properties": { "project_id": { "type": "string" } } } }),
        json!({ "name": "project_set_repo", "description": "Attach a git repo to a project. Owner/admin only.", "inputSchema": { "type": "object", "required": ["project_id", "repo_id"], "properties": { "project_id": { "type": "string" }, "repo_id": { "type": "string" } } } }),
        json!({ "name": "repos_create", "description": "Create a git repo on a team.", "inputSchema": { "type": "object", "required": ["team_id", "name"], "properties": { "team_id": { "type": "string" }, "name": { "type": "string" }, "description": { "type": "string" } } } }),
        json!({ "name": "repos_list", "description": "List git repos on a team.", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" } } } }  ),
        json!({ "name": "repos_templates", "description": "List public marketplace template repos.", "inputSchema": { "type": "object", "properties": { } } } ),
        json!({ "name": "repos_get", "description": "One repo with branch list and recent log.", "inputSchema": { "type": "object", "required": ["repo_id"], "properties": { "repo_id": { "type": "string" } } } }),
        json!({ "name": "repos_log", "description": "Commit log of a repo.", "inputSchema": { "type": "object", "required": ["repo_id"], "properties": { "repo_id": { "type": "string" }, "limit": { "type": "integer" } } } }),
        json!({ "name": "repos_diff", "description": "Show a commit (or working diff vs HEAD).", "inputSchema": { "type": "object", "required": ["repo_id"], "properties": { "repo_id": { "type": "string" }, "commit": { "type": "string" } } } }),
        json!({ "name": "repos_fork", "description": "Fork a template repo into your team.", "inputSchema": { "type": "object", "required": ["repo_id", "team_id"], "properties": { "repo_id": { "type": "string" }, "team_id": { "type": "string" } } } }),
        json!({ "name": "repos_publish", "description": "Publish/unpublish a team repo as a marketplace template. Owner/admin only.", "inputSchema": { "type": "object", "required": ["repo_id", "template"], "properties": { "repo_id": { "type": "string" }, "template": { "type": "boolean" } } } }),
        json!({ "name": "listing_review_run", "description": "Request a marketplace listing: a Meta model reviews the repo's current code (plus static checks for secrets/README) and returns a score, strengths, must-fix items and suggestions. The listing can go live only when the review is approved. Owner/admin only.", "inputSchema": { "type": "object", "required": ["repo_id"], "properties": { "repo_id": { "type": "string" }, "lang": { "type": "string", "enum": ["id", "en"] } } } }),
        json!({ "name": "listing_review_get", "description": "Latest listing review of a repo (current=true when it matches the current version), or null.", "inputSchema": { "type": "object", "required": ["repo_id"], "properties": { "repo_id": { "type": "string" } } } }),
        json!({ "name": "customize_status", "description": "Staging sandbox (URL) and AI change history for an owned app.", "inputSchema": { "type": "object", "required": ["project_id"], "properties": { "project_id": { "type": "string" } } } }),
        json!({ "name": "customize_send", "description": "Ask the Meta model to customize an owned app (e.g. 'make the primary color red'). Edits land on the staging branch and the staging sandbox is rebuilt. Runs in background; poll customize_status. Owner/admin only.", "inputSchema": { "type": "object", "required": ["project_id", "prompt"], "properties": { "project_id": { "type": "string" }, "prompt": { "type": "string" } } } }),
        json!({ "name": "customize_promote", "description": "Apply staging to production: merge the staging branch into main. Redeploy production afterwards with install_start. Owner/admin only.", "inputSchema": { "type": "object", "required": ["project_id"], "properties": { "project_id": { "type": "string" } } } }),
        json!({ "name": "repos_delete", "description": "Delete a team repo and its data. Owner/admin only; templates cannot be deleted.", "inputSchema": { "type": "object", "required": ["repo_id"], "properties": { "repo_id": { "type": "string" } } } }),
        json!({ "name": "licenses_buy", "description": "Buy a perpetual license for a template (mock checkout), auto-forks the repo and creates a project. Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id", "repo_id"], "properties": { "team_id": { "type": "string" }, "repo_id": { "type": "string" }, "provider": { "type": "string" } } } }),
        json!({ "name": "licenses_checkout", "description": "Start a HitPay checkout for a template license. Returns a payment URL (or instant mock license when HitPay is not configured). Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id", "repo_id"], "properties": { "team_id": { "type": "string" }, "repo_id": { "type": "string" } } } }),
        json!({ "name": "payments_status", "description": "Live status of a checkout payment (refreshes from HitPay when pending).", "inputSchema": { "type": "object", "required": ["payment_id"], "properties": { "payment_id": { "type": "string" } } } }),
        json!({ "name": "licenses_activate", "description": "Verify a paid checkout and mint the license + fork + project. Idempotent.", "inputSchema": { "type": "object", "required": ["payment_id"], "properties": { "payment_id": { "type": "string" } } } }),
        json!({ "name": "projects_set_urls", "description": "Set a project's production and/or dev URL (used for the Apps home iframe + custom domains). Owner/admin only.", "inputSchema": { "type": "object", "required": ["project_id"], "properties": { "project_id": { "type": "string" }, "prod_url": { "type": "string" }, "dev_url": { "type": "string" } } } }),
        json!({ "name": "licenses_list", "description": "List a team's licenses.", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" } } } }),
        json!({ "name": "oauth_clients_create", "description": "Create a Login with Slaver OAuth client for deployed apps. Owner/admin only; secret is shown once.", "inputSchema": { "type": "object", "required": ["team_id", "name", "redirect_uris"], "properties": { "team_id": { "type": "string" }, "name": { "type": "string" }, "redirect_uris": { "type": "string", "description": "Comma-separated https:// URLs (or http://localhost)" } } } }),
        json!({ "name": "oauth_clients_list", "description": "List a team’s OAuth clients (no secrets). Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" } } } }),
        json!({ "name": "oauth_clients_revoke", "description": "Delete an OAuth client and all its tokens. Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id", "client_id"], "properties": { "team_id": { "type": "string" }, "client_id": { "type": "string" } } } }),
        json!({ "name": "repos_update", "description": "Edit a marketplace listing: name, description, price (cents), category. Owner/admin only.", "inputSchema": { "type": "object", "required": ["repo_id"], "properties": { "repo_id": { "type": "string" }, "name": { "type": "string" }, "description": { "type": "string" }, "price_cents": { "type": "integer" }, "category": { "type": "string" } } } }),
        json!({ "name": "repos_upload", "description": "Upload a project archive (.zip / .tar.gz, base64) as the repo's new HEAD commit. For large files use POST /api/repos/{repo_id}/upload with the raw archive body. Owner/admin only.", "inputSchema": { "type": "object", "required": ["repo_id", "archive_base64"], "properties": { "repo_id": { "type": "string" }, "archive_base64": { "type": "string" }, "message": { "type": "string" } } } }),
        json!({ "name": "repos_import", "description": "Import a public https git repo (e.g. GitHub) into a Slaver repo, replacing its main branch. Owner/admin only.", "inputSchema": { "type": "object", "required": ["repo_id", "url"], "properties": { "repo_id": { "type": "string" }, "url": { "type": "string" } } } }),
        json!({ "name": "hosting_connect", "description": "Connect the team's own hosting account: provider vercel | netlify | cloudflare | fly, with an API token (validated). Cloudflare needs account_ref = Account ID; Vercel account_ref = optional team id; Fly account_ref = optional org slug. Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id", "provider", "api_token"], "properties": { "team_id": { "type": "string" }, "provider": { "type": "string" }, "api_token": { "type": "string" }, "name": { "type": "string" }, "account_ref": { "type": "string" } } } }),
        json!({ "name": "hosting_accounts", "description": "List the team's connected hosting accounts (tokens never leave the server).", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" } } } }),
        json!({ "name": "hosting_disconnect", "description": "Remove a hosting account (remote sites stay). Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id", "provider", "account_id"], "properties": { "team_id": { "type": "string" }, "provider": { "type": "string" }, "account_id": { "type": "string" } } } }),
        json!({ "name": "install_start", "description": "Install (deploy) an owned app's source onto the team's hosting account. Runs in background; poll installs_list. Re-running updates the same site. Owner/admin only.", "inputSchema": { "type": "object", "required": ["project_id", "provider", "account_id"], "properties": { "project_id": { "type": "string" }, "provider": { "type": "string" }, "account_id": { "type": "string" }, "site_name": { "type": "string" } } } }),
        json!({ "name": "installs_list", "description": "Recent installs for a team (optionally one app) with status, URL and log.", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" }, "project_id": { "type": "string" } } } }),
        json!({ "name": "github_status", "description": "GitHub connector status for a team: whether OAuth is available and which accounts are connected.", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" } } } }),
        json!({ "name": "github_oauth_start", "description": "Start GitHub OAuth for a team; returns the authorize URL to open. Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" } } } }),
        json!({ "name": "github_connect", "description": "Connect GitHub with a personal access token (fine-grained: Contents read-only). Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id", "token"], "properties": { "team_id": { "type": "string" }, "token": { "type": "string" } } } }),
        json!({ "name": "github_disconnect", "description": "Disconnect a GitHub account (linked listings are unlinked; code already synced stays). Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id", "account_id"], "properties": { "team_id": { "type": "string" }, "account_id": { "type": "string" } } } }),
        json!({ "name": "github_repos", "description": "List repositories (incl. private) visible to a connected GitHub account.", "inputSchema": { "type": "object", "required": ["team_id", "account_id"], "properties": { "team_id": { "type": "string" }, "account_id": { "type": "string" } } } }),
        json!({ "name": "github_link", "description": "Link a listing to a GitHub repo+branch and sync it now. Slaver then mirrors it every 10 minutes. Owner/admin only.", "inputSchema": { "type": "object", "required": ["repo_id", "account_id", "full_name"], "properties": { "repo_id": { "type": "string" }, "account_id": { "type": "string" }, "full_name": { "type": "string" }, "branch": { "type": "string" } } } }),
        json!({ "name": "github_unlink", "description": "Stop syncing a listing from GitHub (code stays). Owner/admin only.", "inputSchema": { "type": "object", "required": ["repo_id"], "properties": { "repo_id": { "type": "string" } } } }),
        json!({ "name": "github_sync", "description": "Pull the latest commits from the linked GitHub branch into Slaver now. Owner/admin only.", "inputSchema": { "type": "object", "required": ["repo_id"], "properties": { "repo_id": { "type": "string" } } } }),
        json!({ "name": "github_link_get", "description": "GitHub link of a listing (repo, branch, last sync, error), or null.", "inputSchema": { "type": "object", "required": ["repo_id"], "properties": { "repo_id": { "type": "string" } } } }),
        json!({ "name": "updates_list", "description": "Owned apps with a newer version from the creator. Nothing changes until updates_apply.", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" } } } }),
        json!({ "name": "updates_apply", "description": "Merge the creator's latest version into the team's own copy (repo_id). On conflict the copy is untouched and the update is parked on branch slaver-update. Then redeploy. Owner/admin only.", "inputSchema": { "type": "object", "required": ["repo_id"], "properties": { "repo_id": { "type": "string" } } } }),
    ]
}

pub async fn dispatch(state: &AppState, user_id: &str, name: &str, id: Value, args: &Value) -> Option<Response> {
    let db = &state.db;
    let out = match name {
        "projects_create" => {
            let (team_id, n, d) = (arg_str(args, "team_id"), arg_str(args, "name"), arg_str(args, "description"));
            if team_id.is_empty() || n.trim().is_empty() {
                return Some(rpc_err(id, -32602, "team_id and name are required."));
            }
            match platform::create_project(db, &team_id, user_id, &n, &d).await {
                Ok(p) => mcp_data(id, format!("Project {} created.", p.name), json!({ "project": p })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "projects_list" => {
            let team_id = arg_str(args, "team_id");
            if team_id.is_empty() {
                return Some(rpc_err(id, -32602, "team_id is required."));
            }
            match platform::list_projects(db, &team_id, user_id).await {
                Ok(list) => {
                    let out: Vec<Value> = list.into_iter().map(|p| json!({ "project": p })).collect();
                    mcp_data(id, format!("{} app(s).", out.len()), json!({ "projects": out }))
                }
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "projects_get" => {
            let pid = arg_str(args, "project_id");
            if pid.is_empty() {
                return Some(rpc_err(id, -32602, "project_id is required."));
            }
            match platform::get_project(db, user_id, &pid).await {
                Ok(Some(p)) => mcp_data(id, p.name.clone(), json!({ "project": p })),
                Ok(None) => rpc_err(id, -32602, "Project not found."),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "project_set_repo" => {
            let (pid, rid) = (arg_str(args, "project_id"), arg_str(args, "repo_id"));
            if pid.is_empty() {
                return Some(rpc_err(id, -32602, "project_id is required."));
            }
            match platform::set_project_repo(db, user_id, &pid, &rid).await {
                Ok(p) => mcp_data(id, "Repo attached.".to_string(), json!({ "project": p })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "repos_create" => {
            let (team_id, n) = (arg_str(args, "team_id"), arg_str(args, "name"));
            if team_id.is_empty() || n.trim().is_empty() {
                return Some(rpc_err(id, -32602, "team_id and name are required."));
            }
            match platform::create_repo(db, &team_id, user_id, &n, &arg_str(args, "description")).await {
                Ok(r) => {
                    let _ = platform::ensure_bare_repo(&state.git_root.to_string_lossy(), &r.id).await;
                    mcp_data(id, format!("Repo {} created.", r.name), json!({ "repo": r, "clone_url": format!("/git/{}", r.id) }))
                }
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "repos_list" => {
            let team_id = arg_str(args, "team_id");
            if team_id.is_empty() {
                return Some(rpc_err(id, -32602, "team_id is required."));
            }
            match platform::list_repos(db, &team_id, user_id, false).await {
                Ok(rows) => mcp_data(id, format!("{} repo(s).", rows.len()), json!({ "repos": rows })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "repos_templates" => match platform::list_repos(db, "", user_id, true).await {
            Ok(rows) => mcp_data(id, format!("{} template(s).", rows.len()), json!({ "repos": rows })),
            Err(e) => rpc_err(id, -32000, &e.to_string()),
        },
        "repos_get" => {
            let rid = arg_str(args, "repo_id");
            if rid.is_empty() {
                return Some(rpc_err(id, -32602, "repo_id is required."));
            }
            match platform::get_repo(db, user_id, &rid).await {
                Ok(Some(r)) => {
                    let git_root = state.git_root.to_string_lossy().to_string();
                    let readable = platform::can_read_source(db, user_id, &r).await.unwrap_or(false);
                    let branches = if readable { crate::git::git_branches(&git_root, &rid).await.unwrap_or_default() } else { vec![] };
                    let log = if readable { crate::git::git_log(&git_root, &rid, 10).await.unwrap_or_default() } else { vec![] };
                    mcp_data(id, r.name.clone(), json!({ "repo": r, "branches": branches, "log": log, "clone_url": format!("/git/{rid}") }))
                }
                Ok(None) => rpc_err(id, -32602, "Repo not found."),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "repos_log" => {
            let rid = arg_str(args, "repo_id");
            if rid.is_empty() {
                return Some(rpc_err(id, -32602, "repo_id is required."));
            }
            match platform::get_repo(db, user_id, &rid).await {
                Ok(Some(r)) if !platform::can_read_source(db, user_id, &r).await.unwrap_or(false) => rpc_err(id, -32602, "Buy this app to read its source."),
                Ok(Some(_)) => {
                    let limit = args.get("limit").and_then(|v| v.as_i64()).unwrap_or(20).clamp(1, 100) as usize;
                    match crate::git::git_log(&state.git_root.to_string_lossy(), &rid, limit).await {
                        Ok(log) => mcp_data(id, format!("{} commit(s).", log.len()), json!({ "log": log })),
                        Err(e) => rpc_err(id, -32000, &e),
                    }
                }
                Ok(None) => rpc_err(id, -32602, "Repo not found."),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "repos_diff" => {
            let rid = arg_str(args, "repo_id");
            if rid.is_empty() {
                return Some(rpc_err(id, -32602, "repo_id is required."));
            }
            match platform::get_repo(db, user_id, &rid).await {
                Ok(Some(r)) if !platform::can_read_source(db, user_id, &r).await.unwrap_or(false) => rpc_err(id, -32602, "Buy this app to read its source."),
                Ok(Some(_)) => {
                    let commit = args.get("commit").and_then(|v| v.as_str()).unwrap_or("");
                    match crate::git::git_show(&state.git_root.to_string_lossy(), &rid, commit).await {
                        Ok(diff) => mcp_data(id, "Diff below.".to_string(), json!({ "diff": diff })),
                        Err(e) => rpc_err(id, -32000, &e),
                    }
                }
                Ok(None) => rpc_err(id, -32602, "Repo not found."),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "repos_fork" => {
            let (rid, team_id) = (arg_str(args, "repo_id"), arg_str(args, "team_id"));
            if rid.is_empty() || team_id.is_empty() {
                return Some(rpc_err(id, -32602, "repo_id and team_id are required."));
            }
            // Forking = getting the source: owning team, or a team with a license.
            let allowed = match platform::get_repo(db, user_id, &rid).await {
                Ok(Some(r)) => r.team_id == team_id || platform::license_for_repo(db, &team_id, &rid).await.ok().flatten().is_some(),
                _ => false,
            };
            if !allowed {
                return Some(rpc_err(id, -32602, "Buy this app first — purchases include your own private copy."));
            }
            match platform::fork_repo(db, user_id, &team_id, &rid, &state.git_root.to_string_lossy()).await {
                Ok(r) => mcp_data(id, format!("Forked as {}.", r.name), json!({ "repo": r, "clone_url": format!("/git/{}", r.id) })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "customize_status" | "customize_send" | "customize_promote" => {
            let pid = arg_str(args, "project_id");
            if pid.is_empty() {
                return Some(rpc_err(id, -32602, "project_id is required."));
            }
            let r = match name {
                "customize_status" => crate::customize::status(state, user_id, &pid).await,
                "customize_send" => crate::customize::send(state, user_id, &pid, &arg_str(args, "prompt")).await,
                _ => crate::customize::promote(state, user_id, &pid).await,
            };
            match r {
                Ok(v) => mcp_data(id, "OK.".to_string(), v),
                Err(e) => rpc_err(id, -32602, &e),
            }
        }
        "listing_review_run" | "listing_review_get" => {
            let rid = arg_str(args, "repo_id");
            if rid.is_empty() {
                return Some(rpc_err(id, -32602, "repo_id is required."));
            }
            let git_root = state.git_root.to_string_lossy().to_string();
            let r = match platform::get_repo(db, user_id, &rid).await {
                Ok(Some(r)) => r,
                Ok(None) => return Some(rpc_err(id, -32602, "Repo not found.")),
                Err(e) => return Some(rpc_err(id, -32602, &e.to_string())),
            };
            if name == "listing_review_get" {
                return Some(match crate::review::latest(db, &git_root, &rid).await {
                    Ok(rev) => mcp_data(id, "Latest listing review.".to_string(), json!({ "review": rev })),
                    Err(e) => rpc_err(id, -32602, &e),
                });
            }
            match store::membership(db, &r.team_id, user_id).await {
                Ok(Some(role)) if role == "owner" || role == "admin" => {}
                _ => return Some(rpc_err(id, -32602, "Only owners and admins can request a listing.")),
            }
            let lang = if arg_str(args, "lang") == "en" { "en" } else { "id" };
            match crate::review::run(db, &git_root, &rid, &r.team_id, &r.name, &r.description, lang).await {
                Ok(rev) => mcp_data(id, format!("Review done: {}.", rev.verdict), json!({ "review": rev })),
                Err(e) => rpc_err(id, -32602, &e),
            }
        }
        "repos_publish" => {
            let rid = arg_str(args, "repo_id");
            if rid.is_empty() {
                return Some(rpc_err(id, -32602, "repo_id is required."));
            }
            let tpl = args.get("template").and_then(|v| v.as_bool()).unwrap_or(true);
            match platform::get_repo(db, user_id, &rid).await {
                Ok(Some(r)) => {
                    match store::membership(db, &r.team_id, user_id).await {
                        Ok(Some(role)) if role == "owner" || role == "admin" => {}
                        _ => return Some(rpc_err(id, -32602, "Only owners and admins can publish.")),
                    }
                    if tpl && r.template == 0 {
                        if let Err(e) = crate::review::ensure_approved(db, &state.git_root.to_string_lossy(), &rid).await {
                            return Some(rpc_err(id, -32602, &e));
                        }
                    }
                    match platform::mark_template(db, &rid, tpl).await {
                        Ok(()) => mcp_data(id, if tpl { "Published as template.".to_string() } else { "Unpublished.".to_string() }, json!({ "published": tpl })),
                        Err(e) => rpc_err(id, -32602, &e.to_string()),
                    }
                }
                Ok(None) => rpc_err(id, -32602, "Repo not found."),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "repos_delete" => {
            let rid = arg_str(args, "repo_id");
            if rid.is_empty() {
                return Some(rpc_err(id, -32602, "repo_id is required."));
            }
            match platform::delete_repo(db, user_id, &rid, &state.git_root.to_string_lossy()).await {
                Ok(true) => mcp_data(id, "Repo deleted.".to_string(), json!({ "deleted": true })),
                Ok(false) => rpc_err(id, -32602, "Repo not found or not allowed."),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "licenses_buy" => {
            // Mock/instant checkout (tests, demos). Real money goes through
            // licenses_checkout + HitPay + licenses_activate.
            let (team_id, rid) = (arg_str(args, "team_id"), arg_str(args, "repo_id"));
            if team_id.is_empty() || rid.is_empty() {
                return Some(rpc_err(id, -32602, "team_id and repo_id are required."));
            }
            match platform::buy_bundle(db, &state.git_root.to_string_lossy(), &team_id, user_id, &rid, "mock", 0).await {
                Ok((lic, fork, project)) => mcp_data(id, "License active — repo forked and project created.".to_string(), json!({ "license": lic, "repo": fork, "project": project })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "licenses_checkout" => {
            let (team_id, rid) = (arg_str(args, "team_id"), arg_str(args, "repo_id"));
            if team_id.is_empty() || rid.is_empty() {
                return Some(rpc_err(id, -32602, "team_id and repo_id are required."));
            }
            if !crate::hitpay::configured() {
                // No HitPay key configured: fall back to instant mock checkout.
                match platform::buy_bundle(db, &state.git_root.to_string_lossy(), &team_id, user_id, &rid, "mock", 0).await {
                    Ok((lic, fork, project)) => mcp_data(id, "License active (mock checkout — no HitPay key configured).".to_string(), json!({ "license": lic, "repo": fork, "project": project, "mock": true })),
                    Err(e) => rpc_err(id, -32602, &e.to_string()),
                }
            } else {
                match checkout_start(&state, db, user_id, &team_id, &rid).await {
                    Ok(v) => mcp_data(id, "Complete your payment with HitPay to activate the license.".to_string(), v),
                    Err(e) => rpc_err(id, -32602, &e),
                }
            }
        }
        "payments_status" => {
            let pid = arg_str(args, "payment_id");
            if pid.is_empty() {
                return Some(rpc_err(id, -32602, "payment_id is required."));
            }
            match payment_status_live(&state, db, &pid).await {
                Ok(v) => mcp_data(id, "Payment status.".to_string(), v),
                Err(e) => rpc_err(id, -32602, &e),
            }
        }
        "licenses_activate" => {
            let pid = arg_str(args, "payment_id");
            if pid.is_empty() {
                return Some(rpc_err(id, -32602, "payment_id is required."));
            }
            match activate_paid(&state, db, user_id, &pid).await {
                Ok(v) => mcp_data(id, "License active — repo forked and project created.".to_string(), v),
                Err(e) => rpc_err(id, -32602, &e),
            }
        }
        "licenses_list" => {
            let team_id = arg_str(args, "team_id");
            if team_id.is_empty() {
                return Some(rpc_err(id, -32602, "team_id is required."));
            }
            match platform::list_licenses(db, &team_id, user_id).await {
                Ok(rows) => mcp_data(id, format!("{} license(s).", rows.len()), json!({ "licenses": rows })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "oauth_clients_create" => {
            let (tid, name) = (arg_str(args, "team_id"), arg_str(args, "name"));
            let uris: Vec<String> = arg_str(args, "redirect_uris")
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if tid.is_empty() || name.trim().is_empty() {
                return Some(rpc_err(id, -32602, "team_id and name are required."));
            }
            match crate::oauth::create_client(db, &tid, user_id, &name, &uris).await {
                Ok((c, secret)) => mcp_data(
                    id,
                    "OAuth client created. Copy the secret now — it is shown only once.".to_string(),
                    json!({ "client": c, "client_secret": secret }),
                ),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "oauth_clients_list" => {
            let tid = arg_str(args, "team_id");
            if tid.is_empty() {
                return Some(rpc_err(id, -32602, "team_id is required."));
            }
            match crate::oauth::list_clients(db, &tid, user_id).await {
                Ok(rows) => mcp_data(id, format!("{} client(s).", rows.len()), json!({ "clients": rows })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "oauth_clients_revoke" => {
            let (tid, cid) = (arg_str(args, "team_id"), arg_str(args, "client_id"));
            if tid.is_empty() || cid.is_empty() {
                return Some(rpc_err(id, -32602, "team_id and client_id are required."));
            }
            match crate::oauth::revoke_client(db, &tid, user_id, &cid).await {
                Ok(()) => mcp_data(id, "Client revoked.".to_string(), json!({ "revoked": true })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "projects_set_urls" => {
            let pid = arg_str(args, "project_id");
            if pid.is_empty() {
                return Some(rpc_err(id, -32602, "project_id is required."));
            }
            let prod = args.get("prod_url").and_then(|v| v.as_str());
            let dev = args.get("dev_url").and_then(|v| v.as_str());
            match platform::set_project_urls(db, user_id, &pid, prod, dev).await {
                Ok(p) => mcp_data(id, "URLs updated.".to_string(), json!({ "project": p })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "repos_update" => {
            let rid = arg_str(args, "repo_id");
            if rid.is_empty() {
                return Some(rpc_err(id, -32602, "repo_id is required."));
            }
            let opt = |k: &str| args.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
            let price = args.get("price_cents").and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));
            let (n, d, c) = (opt("name"), opt("description"), opt("category"));
            match platform::update_repo(db, user_id, &rid, n.as_deref(), d.as_deref(), price, c.as_deref()).await {
                Ok(r) => mcp_data(id, format!("Listing {} saved.", r.name), json!({ "repo": r })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "repos_upload" => {
            use base64::Engine;
            let rid = arg_str(args, "repo_id");
            let raw = arg_str(args, "archive_base64");
            let raw = raw.split_once("base64,").map(|(_, b)| b.to_string()).unwrap_or(raw);
            let bytes = match base64::engine::general_purpose::STANDARD.decode(raw.trim()) {
                Ok(b) => b,
                Err(_) => return Some(rpc_err(id, -32602, "archive_base64 is not valid base64.")),
            };
            match crate::hosting::upload_archive(state, user_id, &rid, &bytes, &arg_str(args, "message")).await {
                Ok(sha) => mcp_data(id, format!("Uploaded as {}.", &sha.chars().take(8).collect::<String>()), json!({ "sha": sha })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "repos_import" => {
            match crate::hosting::import_git(state, user_id, &arg_str(args, "repo_id"), &arg_str(args, "url")).await {
                Ok(sha) => mcp_data(id, format!("Imported at {}.", &sha.chars().take(8).collect::<String>()), json!({ "sha": sha })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "hosting_connect" => {
            match crate::hosting::connect(db, &arg_str(args, "team_id"), user_id, &arg_str(args, "provider"), &arg_str(args, "name"), &arg_str(args, "account_ref"), &arg_str(args, "api_token")).await {
                Ok(a) => mcp_data(id, format!("{} connected.", a.provider), json!({ "account": a })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "hosting_accounts" => {
            match crate::hosting::list_accounts(db, &arg_str(args, "team_id"), user_id).await {
                Ok(rows) => mcp_data(id, format!("{} hosting account(s).", rows.len()), json!({ "accounts": rows })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "hosting_disconnect" => {
            match crate::hosting::disconnect(db, &arg_str(args, "team_id"), user_id, &arg_str(args, "provider"), &arg_str(args, "account_id")).await {
                Ok(()) => mcp_data(id, "Hosting account removed.".to_string(), json!({ "removed": true })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "install_start" => {
            match crate::hosting::start_install(state.clone(), user_id, &arg_str(args, "project_id"), &arg_str(args, "provider"), &arg_str(args, "account_id"), &arg_str(args, "site_name")).await {
                Ok(row) => mcp_data(id, "Install started.".to_string(), json!({ "install": row })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "installs_list" => {
            match crate::hosting::list_installs(db, &arg_str(args, "team_id"), user_id, &arg_str(args, "project_id")).await {
                Ok(rows) => mcp_data(id, format!("{} install(s).", rows.len()), json!({ "installs": rows })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "github_status" => {
            match crate::github::list_accounts(db, &arg_str(args, "team_id"), user_id).await {
                Ok(a) => mcp_data(id, format!("{} GitHub account(s).", a.len()), json!({ "oauth": crate::github::oauth_available(), "accounts": a })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "github_oauth_start" => match crate::github::oauth_start(state, &arg_str(args, "team_id"), user_id).await {
            Ok(url) => mcp_data(id, "Open the URL to authorize.".to_string(), json!({ "url": url })),
            Err(e) => rpc_err(id, -32602, &e.to_string()),
        },
        "github_connect" => match crate::github::connect_token(db, &arg_str(args, "team_id"), user_id, &arg_str(args, "token")).await {
            Ok(a) => mcp_data(id, format!("GitHub {} connected.", a.login), json!({ "account": a })),
            Err(e) => rpc_err(id, -32602, &e.to_string()),
        },
        "github_disconnect" => match crate::github::disconnect(db, &arg_str(args, "team_id"), user_id, &arg_str(args, "account_id")).await {
            Ok(()) => mcp_data(id, "GitHub disconnected.".to_string(), json!({ "removed": true })),
            Err(e) => rpc_err(id, -32602, &e.to_string()),
        },
        "github_repos" => match crate::github::list_github_repos(db, &arg_str(args, "team_id"), user_id, &arg_str(args, "account_id")).await {
            Ok(r) => mcp_data(id, format!("{} repo(s).", r.len()), json!({ "repos": r })),
            Err(e) => rpc_err(id, -32602, &e.to_string()),
        },
        "github_link" => match crate::github::link(state, user_id, &arg_str(args, "repo_id"), &arg_str(args, "account_id"), &arg_str(args, "full_name"), &arg_str(args, "branch")).await {
            Ok(l) => mcp_data(id, format!("Linked to {}.", l.github_repo), json!({ "link": l })),
            Err(e) => rpc_err(id, -32602, &e.to_string()),
        },
        "github_unlink" => match crate::github::unlink(db, user_id, &arg_str(args, "repo_id")).await {
            Ok(()) => mcp_data(id, "Unlinked.".to_string(), json!({ "unlinked": true })),
            Err(e) => rpc_err(id, -32602, &e.to_string()),
        },
        "github_sync" => match crate::github::sync_checked(state, user_id, &arg_str(args, "repo_id")).await {
            Ok(sha) => mcp_data(id, format!("Synced at {}.", &sha.chars().take(8).collect::<String>()), json!({ "sha": sha })),
            Err(e) => rpc_err(id, -32602, &e.to_string()),
        },
        "github_link_get" => match crate::github::get_link(db, user_id, &arg_str(args, "repo_id")).await {
            Ok(l) => mcp_data(id, "GitHub link.".to_string(), json!({ "link": l })),
            Err(e) => rpc_err(id, -32602, &e.to_string()),
        },
        "updates_list" => match crate::github::list_updates(state, &arg_str(args, "team_id"), user_id).await {
            Ok(u) => mcp_data(id, format!("{} update(s) available.", u.len()), json!({ "updates": u })),
            Err(e) => rpc_err(id, -32602, &e.to_string()),
        },
        "updates_apply" => match crate::github::apply_update(state, user_id, &arg_str(args, "repo_id")).await {
            Ok(v) => mcp_data(id, format!("Update: {}.", v["status"].as_str().unwrap_or("")), v),
            Err(e) => rpc_err(id, -32602, &e.to_string()),
        },
        _ => return None,
    };
    Some(out)
}

/// Create a HitPay payment request for a template license. Returns checkout
/// details; the license is only minted after payment (see activate_paid).
async fn checkout_start(
    _state: &AppState,
    db: &crate::db::Db,
    user_id: &str,
    team_id: &str,
    repo_id: &str,
) -> Result<Value, String> {
    if platform::license_for_repo(db, team_id, repo_id).await.map_err(|e| e.to_string())?.is_some() {
        return Err("Your team already owns an active license for this app.".to_string());
    }
    let tpl = platform::get_repo(db, user_id, repo_id).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "Template not found.".to_string())?;
    if tpl.template == 0 {
        return Err("That repo is not a published template.".to_string());
    }
    let price_cents = platform::repo_price_cents(db, repo_id).await.map_err(|e| e.to_string())?;
    let currency = "USD";
    let reference = format!("slv-{}", &crate::db::now_millis());
    let app_base = crate::hitpay::app_base_url();
    let webhook = format!("{app_base}/hooks/hitpay");
    let (hitpay_id, checkout_url) = crate::hitpay::create_payment_request(
        price_cents as f64 / 100.0,
        currency,
        &tpl.name,
        "",
        &reference,
        &format!("Slaver license: {}", tpl.name),
        "",
        &webhook,
    )
    .await
    .map_err(|e| e.to_string())?;
    let pay = platform::create_payment(db, team_id, user_id, repo_id, price_cents, currency, &reference, &hitpay_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!({
        "payment_id": pay.id,
        "hitpay_request_id": hitpay_id,
        "checkout_url": checkout_url,
        "redirect_url": format!("{app_base}/market?payment={}", pay.id),
        "amount_cents": price_cents,
        "currency": currency,
        "sandbox": crate::hitpay::is_sandbox(),
    }))
}

/// Live status of a payment (refreshes from HitPay when still pending).
async fn payment_status_live(
    _state: &AppState,
    db: &crate::db::Db,
    payment_id: &str,
) -> Result<Value, String> {
    let pay = platform::get_payment(db, payment_id).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "Payment not found.".to_string())?;
    let mut status = pay.status.clone();
    if status == "pending" && !pay.hitpay_request_id.is_empty() && crate::hitpay::configured() {
        match crate::hitpay::payment_status(&pay.hitpay_request_id).await {
            Ok((s, paid)) => {
                if paid {
                    status = "paid".to_string();
                } else if ["failed", "expired", "canceled", "cancelled"].contains(&s.as_str()) {
                    let _ = platform::mark_payment_failed(db, payment_id).await;
                    status = "failed".to_string();
                }
            }
            Err(_) => {}
        }
    }
    let pay = platform::get_payment(db, payment_id).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "Payment not found.".to_string())?;
    Ok(json!({ "payment": pay, "hitpay_status": status }))
}

/// Verify payment with HitPay and mint license + fork + project. Idempotent:
/// re-running returns the already-provisioned bundle.
async fn activate_paid(
    state: &AppState,
    db: &crate::db::Db,
    user_id: &str,
    payment_id: &str,
) -> Result<Value, String> {
    let pay = platform::get_payment(db, payment_id).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "Payment not found.".to_string())?;
    store::membership(db, &pay.team_id, user_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "You are not on that team.".to_string())?;
    if pay.status == "paid" && !pay.license_id.is_empty() {
        return existing_bundle(db, user_id, &pay).await;
    }
    if pay.hitpay_request_id.is_empty() {
        return Err("This payment has no HitPay request — use mock checkout instead.".to_string());
    }
    if !crate::hitpay::configured() {
        return Err("HitPay is not configured.".to_string());
    }
    let (status, paid) = crate::hitpay::payment_status(&pay.hitpay_request_id).await.map_err(|e| e.to_string())?;
    if !paid {
        if ["failed", "expired", "canceled", "cancelled"].contains(&status.as_str()) {
            let _ = platform::mark_payment_failed(db, payment_id).await;
        }
        return Err(format!("Payment is not completed yet (HitPay status: {status})."));
    }
    let (lic, fork, project) = platform::buy_bundle(
        db,
        &state.git_root.to_string_lossy(),
        &pay.team_id,
        user_id,
        &pay.repo_id,
        "hitpay",
        pay.amount_cents,
    )
    .await
    .map_err(|e| e.to_string())?;
    platform::mark_payment_paid(db, payment_id, &lic.id, &fork.id, &project.id).await.map_err(|e| e.to_string())?;
    Ok(json!({ "license": lic, "repo": fork, "project": project }))
}

async fn existing_bundle(db: &crate::db::Db, user_id: &str, pay: &platform::PaymentRow) -> Result<Value, String> {
    let lic: Option<platform::LicenseRow> = db
        .prepare("SELECT id, team_id, repo_id, kind, support_until, status, provider, amount_cents, created_at FROM licenses WHERE id = ?")
        .bind(&[crate::db::v_text(&pay.license_id)])
        .map_err(|e| e.to_string())?
        .first(None)
        .await
        .map_err(|e| e.to_string())?;
    let lic = lic.ok_or_else(|| "License record missing.".to_string())?;
    let fork = platform::get_repo(db, user_id, &pay.fork_repo_id).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "Forked repo not found.".to_string())?;
    let project = platform::get_project(db, user_id, &pay.project_id).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "Project not found.".to_string())?;
    Ok(json!({ "license": lic, "repo": fork, "project": project, "already_active": true }))
}

/// HitPay webhook receiver. Never trusts the payload alone: the configured
/// salt is checked when present, and the payment is ALWAYS re-verified
/// server-side before anything is minted.
pub async fn hitpay_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let raw = body.to_vec();
    let v: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
    // Candidate HitPay request ids across payload shapes.
    let mut candidates: Vec<String> = Vec::new();
    for key in ["id", "payment_request_id", "payment_request"] {
        if let Some(x) = v.get(key).and_then(|x| x.as_str()) {
            if !x.is_empty() {
                candidates.push(x.to_string());
            }
        }
    }
    if let Some(o) = v.get("payment_request").and_then(|x| x.as_object()) {
        for k in ["id", "payment_request_id"] {
            if let Some(x) = o.get(k).and_then(|x| x.as_str()) {
                if !x.is_empty() {
                    candidates.push(x.to_string());
                }
            }
        }
    }
    // Our own payment reference (set as reference_number at creation).
    let mut reference = v.get("reference_number").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if reference.is_empty() {
        reference = v
            .get("payment_request")
            .and_then(|o| o.get("reference_number"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
    }
    let salt = crate::hitpay::webhook_salt();
    if !salt.is_empty() {
        let sig = headers
            .get("hitpay-signature")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("");
        if !crate::hitpay::verify_event_signature(&raw, sig, &salt) {
            return (StatusCode::UNAUTHORIZED, Json(json!({ "ok": false }))).into_response();
        }
    }
    let db = &state.db;
    // Resolve the local payment row.
    let mut pay: Option<platform::PaymentRow> = None;
    for cand in &candidates {
        if let Ok(Some(p)) = platform::find_payment_by_hitpay(db, cand).await {
            pay = Some(p);
            break;
        }
    }
    if pay.is_none() && !reference.is_empty() {
        pay = platform::find_payment_by_reference(db, &reference).await.unwrap_or(None);
    }
    let pay = match pay {
        Some(p) => p,
        None => return (StatusCode::OK, Json(json!({ "ok": true, "ignored": true }))).into_response(),
    };
    if pay.status == "paid" {
        return (StatusCode::OK, Json(json!({ "ok": true, "already": true }))).into_response();
    }
    // Server-side truth: only a completed upstream payment mints a license.
    let verified = if pay.hitpay_request_id.is_empty() || !crate::hitpay::configured() {
        false
    } else {
        match crate::hitpay::payment_status(&pay.hitpay_request_id).await {
            Ok((_, true)) => true,
            Ok((s, false)) => {
                if ["failed", "expired", "canceled", "cancelled"].contains(&s.as_str()) {
                    let _ = platform::mark_payment_failed(db, &pay.id).await;
                }
                false
            }
            Err(_) => false,
        }
    };
    if !verified {
        return (StatusCode::OK, Json(json!({ "ok": true, "pending": true }))).into_response();
    }
    // Activate as the payment creator (owner/admin at checkout time).
    let creator = if pay.created_by.is_empty() { String::new() } else { pay.created_by.clone() };
    let _ = creator;
    match activate_paid_internal(&state, db, &pay).await {
        Ok(_) => (StatusCode::OK, Json(json!({ "ok": true, "activated": true }))).into_response(),
        Err(e) => (StatusCode::OK, Json(json!({ "ok": false, "error": e }))).into_response(),
    }
}

/// Activation used by the webhook (no caller user): the payment creator acts.
async fn activate_paid_internal(
    state: &AppState,
    db: &crate::db::Db,
    pay: &platform::PaymentRow,
) -> Result<(), String> {
    if pay.created_by.is_empty() {
        return Err("Payment has no creator; activate manually via licenses_activate.".to_string());
    }
    // Idempotent: a previous webhook (or manual activation) may have finished already.
    if pay.status == "paid" && !pay.license_id.is_empty() {
        return Ok(());
    }
    let user_id = pay.created_by.clone();
    let (lic, fork, project) = platform::buy_bundle(
        db,
        &state.git_root.to_string_lossy(),
        &pay.team_id,
        &user_id,
        &pay.repo_id,
        "hitpay",
        pay.amount_cents,
    )
    .await
    .map_err(|e| e.to_string())?;
    platform::mark_payment_paid(db, &pay.id, &lic.id, &fork.id, &project.id).await.map_err(|e| e.to_string())?;
    Ok(())
}
