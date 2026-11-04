//! MCP tools for the Slaver platform layer: projects/kanban, git repos,
//! marketplace licenses, VPS targets, deployments. Dispatched from mcp.rs.

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
        json!({ "name": "issues_create", "description": "Create a kanban issue on a project, optionally assigned to a slaveBot.", "inputSchema": { "type": "object", "required": ["project_id", "title"], "properties": { "project_id": { "type": "string" }, "title": { "type": "string" }, "body": { "type": "string" }, "assignee_bot_id": { "type": "string" } } } }),
        json!({ "name": "issues_list", "description": "List kanban issues on a project.", "inputSchema": { "type": "object", "required": ["project_id"], "properties": { "project_id": { "type": "string" } } } }),
        json!({ "name": "issues_update", "description": "Update an issue's title/body/priority/labels.", "inputSchema": { "type": "object", "required": ["issue_id"], "properties": { "issue_id": { "type": "string" }, "title": { "type": "string" }, "body": { "type": "string" }, "priority": { "type": "string" }, "labels": { "type": "string" } } } }),
        json!({ "name": "issues_assign", "description": "Assign an issue to a slaveBot (empty bot_id unassigns).", "inputSchema": { "type": "object", "required": ["issue_id"], "properties": { "issue_id": { "type": "string" }, "bot_id": { "type": "string"   } } } }),
        json!({ "name": "issues_move", "description": "Move an issue: backlog, todo, in_progress, in_review, done.", "inputSchema": { "type": "object", "required": ["issue_id", "state"], "properties": { "issue_id": { "type": "string" }, "state": { "type": "string" } } } }),
        json!({ "name": "repos_create", "description": "Create a git repo on a team.", "inputSchema": { "type": "object", "required": ["team_id", "name"], "properties": { "team_id": { "type": "string" }, "name": { "type": "string" }, "description": { "type": "string" } } } }),
        json!({ "name": "repos_list", "description": "List git repos on a team.", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" } } } }  ),
        json!({ "name": "repos_templates", "description": "List public marketplace template repos.", "inputSchema": { "type": "object", "properties": { } } } ),
        json!({ "name": "repos_get", "description": "One repo with branch list and recent log.", "inputSchema": { "type": "object", "required": ["repo_id"], "properties": { "repo_id": { "type": "string" } } } }),
        json!({ "name": "repos_log", "description": "Commit log of a repo.", "inputSchema": { "type": "object", "required": ["repo_id"], "properties": { "repo_id": { "type": "string" }, "limit": { "type": "integer" } } } }),
        json!({ "name": "repos_diff", "description": "Show a commit (or working diff vs HEAD).", "inputSchema": { "type": "object", "required": ["repo_id"], "properties": { "repo_id": { "type": "string" }, "commit": { "type": "string" } } } }),
        json!({ "name": "repos_fork", "description": "Fork a template repo into your team.", "inputSchema": { "type": "object", "required": ["repo_id", "team_id"], "properties": { "repo_id": { "type": "string" }, "team_id": { "type": "string" } } } }),
        json!({ "name": "repos_publish", "description": "Publish/unpublish a team repo as a marketplace template. Owner/admin only.", "inputSchema": { "type": "object", "required": ["repo_id", "template"], "properties": { "repo_id": { "type": "string" }, "template": { "type": "boolean" } } } }),
        json!({ "name": "repos_delete", "description": "Delete a team repo and its data. Owner/admin only; templates cannot be deleted.", "inputSchema": { "type": "object", "required": ["repo_id"], "properties": { "repo_id": { "type": "string" } } } }),
        json!({ "name": "licenses_buy", "description": "Buy a perpetual license for a template (mock checkout), auto-forks the repo and creates a project. Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id", "repo_id"], "properties": { "team_id": { "type": "string" }, "repo_id": { "type": "string" }, "provider": { "type": "string" } } } }),
        json!({ "name": "licenses_checkout", "description": "Start a HitPay checkout for a template license. Returns a payment URL (or instant mock license when HitPay is not configured). Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id", "repo_id"], "properties": { "team_id": { "type": "string" }, "repo_id": { "type": "string" } } } }),
        json!({ "name": "payments_status", "description": "Live status of a checkout payment (refreshes from HitPay when pending).", "inputSchema": { "type": "object", "required": ["payment_id"], "properties": { "payment_id": { "type": "string" } } } }),
        json!({ "name": "licenses_activate", "description": "Verify a paid checkout and mint the license + fork + project. Idempotent.", "inputSchema": { "type": "object", "required": ["payment_id"], "properties": { "payment_id": { "type": "string" } } } }),
        json!({ "name": "dm_history", "description": "Direct messages with a teammate (same team).", "inputSchema": { "type": "object", "required": ["team_id", "user_id"], "properties": { "team_id": { "type": "string" }, "user_id": { "type": "string" } } } }),
        json!({ "name": "unread_list", "description": "Conversations with unread messages (sidebar badges): DMs, channels, meetings, bots. Only activity from the last 7 days.", "inputSchema": { "type": "object", "properties": {} } }),
        json!({ "name": "read_mark", "description": "Mark a conversation read up to a message id (clears its badge). kind: dm|group|meeting|bot.", "inputSchema": { "type": "object", "required": ["kind", "ref_id", "last_id"], "properties": { "kind": { "type": "string" }, "team_id": { "type": "string" }, "ref_id": { "type": "string" }, "last_id": { "type": "integer" } } } }),
        json!({ "name": "dm_send", "description": "Send a direct message to a teammate.", "inputSchema": { "type": "object", "required": ["team_id", "to_user_id", "message"], "properties": { "team_id": { "type": "string" }, "to_user_id": { "type": "string" }, "message": { "type": "string" } } } }),
        json!({ "name": "groups_add_user", "description": "Add a teammate to a channel (mixed human + AI channels).", "inputSchema": { "type": "object", "required": ["group_id", "user_id"], "properties": { "group_id": { "type": "string" }, "user_id": { "type": "string" } } } }),
        json!({ "name": "groups_remove_user", "description": "Remove a teammate from a channel.", "inputSchema": { "type": "object", "required": ["group_id", "user_id"], "properties": { "group_id": { "type": "string" }, "user_id": { "type": "string" } } } }),
        json!({ "name": "groups_set_project", "description": "Attach a kanban project to a channel (empty project_id detaches). The board then lives inside the channel. Owner/admin only.", "inputSchema": { "type": "object", "required": ["group_id"], "properties": { "group_id": { "type": "string" }, "project_id": { "type": "string" } } } }),
        json!({ "name": "projects_set_urls", "description": "Set a project's production and/or dev URL (used for the Apps home iframe + custom domains). Owner/admin only.", "inputSchema": { "type": "object", "required": ["project_id"], "properties": { "project_id": { "type": "string" }, "prod_url": { "type": "string" }, "dev_url": { "type": "string" } } } }),
        json!({ "name": "fly_connect", "description": "Connect the team's own Fly.io account with an API token (validated). Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id", "api_token"], "properties": { "team_id": { "type": "string" }, "name": { "type": "string" }, "org": { "type": "string" }, "api_token": { "type": "string" } } } }),
        json!({ "name": "fly_accounts", "description": "List connected Fly.io accounts.", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" } } } }),
        json!({ "name": "fly_disconnect", "description": "Remove a connected Fly.io account (does not delete remote resources). Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id", "account_id"], "properties": { "team_id": { "type": "string" }, "account_id": { "type": "string" } } } }),
        json!({ "name": "fly_provision", "description": "Provision 1 PROD + 1 DEV machine on the team's Fly account (isolated dev runs its own agent sandbox). Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" }, "account_id": { "type": "string" }, "name": { "type": "string" }, "prod_image": { "type": "string" }, "dev_image": { "type": "string" }, "dev_cpus": { "type": "integer" }, "dev_memory": { "type": "integer" } } } }),
        json!({ "name": "fly_machines", "description": "List provisioned Fly machines for the team (with live state when reachable).", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" } } } }),
        json!({ "name": "fly_destroy", "description": "Destroy a provisioned Fly machine (and optionally its app). Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id", "machine_id"], "properties": { "team_id": { "type": "string" }, "machine_id": { "type": "string" }, "delete_app": { "type": "boolean" } } } }),
        json!({ "name": "domains_add", "description": "Record a custom domain mapping ({uuid}.slaver.app or custom subdomain) to a Fly app hostname or IP. You create the DNS record yourself (manual). Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id", "project_id", "target"], "properties": { "team_id": { "type": "string" }, "project_id": { "type": "string" }, "subdomain": { "type": "string" }, "target": { "type": "string" }, "kind": { "type": "string" } } } }),
        json!({ "name": "domains_list", "description": "List custom domains for a team.", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" } } } }),
        json!({ "name": "domains_remove", "description": "Remove a custom domain record (delete the DNS record yourself too). Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id", "domain_id"], "properties": { "team_id": { "type": "string" }, "domain_id": { "type": "string" } } } }),
        json!({ "name": "licenses_list", "description": "List a team's licenses.", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" } } } }),
        json!({ "name": "vps_add", "description": "Register a VPS deploy target (SSH key stored server-side). Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id", "host", "ssh_key"], "properties": { "team_id": { "type": "string" }, "name": { "type": "string" }, "host": { "type": "string" }, "ssh_user": { "type": "string" }, "ssh_key": { "type": "string" } } } }),
        json!({ "name": "vps_list", "description": "List a team's VPS targets (keys never leave the server).", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" } } } }),
        json!({ "name": "deploy_start", "description": "Deploy a project's repo HEAD to a VPS (compose up). Runs in background; poll deployments_list. Owner/admin only.", "inputSchema": { "type": "object", "required": ["project_id", "vps_id"], "properties": { "project_id": { "type": "string" }, "vps_id": { "type": "string" } } } }),
        json!({ "name": "deployments_list", "description": "Recent deployments of a project with logs.", "inputSchema": { "type": "object", "required": ["project_id"], "properties": { "project_id": { "type": "string" } } } }),
        json!({ "name": "groups_public", "description": "List public support channels across all teams (anyone can read/post; owning teams bots reply).", "inputSchema": { "type": "object", "properties": {} } }),
        json!({ "name": "groups_set_visibility", "description": "Make a group public (support channel) or private. Owner/admin only.", "inputSchema": { "type": "object", "required": ["group_id", "public"], "properties": { "group_id": { "type": "string" }, "public": { "type": "boolean" } } } }),
        json!({ "name": "groups_support", "description": "Get (or, as the owning team, create) the public support channel for a repo/template.", "inputSchema": { "type": "object", "required": ["repo_id"], "properties": { "repo_id": { "type": "string" } } } }),
        json!({ "name": "oauth_clients_create", "description": "Create a Login with Slaver OAuth client for deployed apps. Owner/admin only; secret is shown once.", "inputSchema": { "type": "object", "required": ["team_id", "name", "redirect_uris"], "properties": { "team_id": { "type": "string" }, "name": { "type": "string" }, "redirect_uris": { "type": "string", "description": "Comma-separated https:// URLs (or http://localhost)" } } } }),
        json!({ "name": "oauth_clients_list", "description": "List a team’s OAuth clients (no secrets). Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" } } } }),
        json!({ "name": "oauth_clients_revoke", "description": "Delete an OAuth client and all its tokens. Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id", "client_id"], "properties": { "team_id": { "type": "string" }, "client_id": { "type": "string" } } } }),
        json!({ "name": "templates_list", "description": "List business team templates for onboarding (preset AI agent teams, e.g. Saung Rangon F&B).", "inputSchema": { "type": "object", "properties": {} } }),
        json!({ "name": "templates_apply", "description": "Create a team from a business template, pre-staffed with preset AI agents. Returns the team and bots.", "inputSchema": { "type": "object", "required": ["template_key"], "properties": { "template_key": { "type": "string" }, "team_name": { "type": "string" } } } }),
        json!({ "name": "connectors_add", "description": "Register a deployed app as an AI-accessible connector (the app must expose POST /mcp with tools/list + tools/call). Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id", "name", "base_url"], "properties": { "team_id": { "type": "string" }, "name": { "type": "string" }, "base_url": { "type": "string" }, "api_key": { "type": "string" }, "project_id": { "type": "string" } } } }),
        json!({ "name": "connectors_list", "description": "List a team's registered app connectors.", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" } } } }),
        json!({ "name": "connectors_remove", "description": "Remove an app connector. Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id", "connector_id"], "properties": { "team_id": { "type": "string" }, "connector_id": { "type": "string" } } } }),
        json!({ "name": "connectors_call", "description": "Call a tool on an installed app through its own MCP surface. This is how agents use app features (tables, booking, stock).", "inputSchema": { "type": "object", "required": ["team_id", "connector_id", "tool"], "properties": { "team_id": { "type": "string" }, "connector_id": { "type": "string" }, "tool": { "type": "string" }, "arguments": { "type": "object" } } } }),
        json!({ "name": "skills_list", "description": "List AI skills: public template skills plus this team's own skills. Install one onto a bot with skills_apply.", "inputSchema": { "type": "object", "properties": { "team_id": { "type": "string" } } } }),
        json!({ "name": "skills_create", "description": "Create a team skill (role+memory pack). Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id", "name"], "properties": { "team_id": { "type": "string" }, "name": { "type": "string" }, "category": { "type": "string" }, "description": { "type": "string" }, "role": { "type": "string" }, "memory": { "type": "string" } } } }),
        json!({ "name": "skills_delete", "description": "Delete a team skill (templates cannot be deleted). Owner/admin only.", "inputSchema": { "type": "object", "required": ["skill_id"], "properties": { "skill_id": { "type": "string" } } } }),
        json!({ "name": "skills_apply", "description": "Install a skill onto a slaveBot: role becomes the bot role, memory is appended. Returns the updated bot.", "inputSchema": { "type": "object", "required": ["skill_id", "slavebot_id"], "properties": { "skill_id": { "type": "string" }, "slavebot_id": { "type": "string" } } } }),
        json!({ "name": "repos_update", "description": "Edit a marketplace listing: name, description, price (cents), category. Owner/admin only.", "inputSchema": { "type": "object", "required": ["repo_id"], "properties": { "repo_id": { "type": "string" }, "name": { "type": "string" }, "description": { "type": "string" }, "price_cents": { "type": "integer" }, "category": { "type": "string" } } } }),
        json!({ "name": "repos_upload", "description": "Upload a project archive (.zip / .tar.gz, base64) as the repo's new HEAD commit. For large files use POST /api/repos/{repo_id}/upload with the raw archive body. Owner/admin only.", "inputSchema": { "type": "object", "required": ["repo_id", "archive_base64"], "properties": { "repo_id": { "type": "string" }, "archive_base64": { "type": "string" }, "message": { "type": "string" } } } }),
        json!({ "name": "repos_import", "description": "Import a public https git repo (e.g. GitHub) into a Slaver repo, replacing its main branch. Owner/admin only.", "inputSchema": { "type": "object", "required": ["repo_id", "url"], "properties": { "repo_id": { "type": "string" }, "url": { "type": "string" } } } }),
        json!({ "name": "hosting_connect", "description": "Connect the team's own hosting account: provider vercel | netlify | cloudflare | fly, with an API token (validated). Cloudflare needs account_ref = Account ID; Vercel account_ref = optional team id; Fly account_ref = optional org slug. Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id", "provider", "api_token"], "properties": { "team_id": { "type": "string" }, "provider": { "type": "string" }, "api_token": { "type": "string" }, "name": { "type": "string" }, "account_ref": { "type": "string" } } } }),
        json!({ "name": "hosting_accounts", "description": "List the team's connected hosting accounts (tokens never leave the server).", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" } } } }),
        json!({ "name": "hosting_disconnect", "description": "Remove a hosting account (remote sites stay). Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id", "provider", "account_id"], "properties": { "team_id": { "type": "string" }, "provider": { "type": "string" }, "account_id": { "type": "string" } } } }),
        json!({ "name": "install_start", "description": "Install (deploy) an owned app's source onto the team's hosting account. Runs in background; poll installs_list. Re-running updates the same site. Owner/admin only.", "inputSchema": { "type": "object", "required": ["project_id", "provider", "account_id"], "properties": { "project_id": { "type": "string" }, "provider": { "type": "string" }, "account_id": { "type": "string" }, "site_name": { "type": "string" } } } }),
        json!({ "name": "installs_list", "description": "Recent installs for a team (optionally one app) with status, URL and log.", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" }, "project_id": { "type": "string" } } } }),
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
                    let mut out = Vec::new();
                    for p in list {
                        let stats = platform::project_stats(db, user_id, &p.id).await.unwrap_or_default();
                        out.push(json!({ "project": p, "stats": stats }));
                    }
                    mcp_data(id, format!("{} project(s).", out.len()), json!({ "projects": out }))
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
                Ok(Some(p)) => {
                    let stats = platform::project_stats(db, user_id, &pid).await.unwrap_or_default();
                    mcp_data(id, p.name.clone(), json!({ "project": p, "stats": stats }))
                }
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
        "issues_create" => {
            let (pid, title) = (arg_str(args, "project_id"), arg_str(args, "title"));
            if pid.is_empty() || title.trim().is_empty() {
                return Some(rpc_err(id, -32602, "project_id and title are required."));
            }
            match platform::create_issue(db, user_id, &pid, &title, &arg_str(args, "body"), &arg_str(args, "assignee_bot_id")).await {
                Ok(r) => mcp_data(id, "Issue created in backlog.".to_string(), json!({ "issue": r })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "issues_list" => {
            let pid = arg_str(args, "project_id");
            if pid.is_empty() {
                return Some(rpc_err(id, -32602, "project_id is required."));
            }
            match platform::list_issues(db, user_id, &pid).await {
                Ok(rows) => mcp_data(id, format!("{} issue(s).", rows.len()), json!({ "issues": rows })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "issues_update" => {
            let iid = arg_str(args, "issue_id");
            if iid.is_empty() {
                return Some(rpc_err(id, -32602, "issue_id is required."));
            }
            let opt = |k: &str| {
                let v = arg_str(args, k);
                if v.is_empty() { None } else { Some(v) }
            };
            let (t, b, p, l) = (opt("title"), opt("body"), opt("priority"), opt("labels"));
            let t = t.as_deref();
            let b = b.as_deref();
            let p = p.as_deref();
            let l = l.as_deref();
            match platform::update_issue(db, user_id, &iid, t, b, p, l).await {
                Ok(r) => mcp_data(id, "Issue updated.".to_string(), json!({ "issue": r })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "issues_assign" => {
            let (iid, bid) = (arg_str(args, "issue_id"), arg_str(args, "bot_id"));
            if iid.is_empty() {
                return Some(rpc_err(id, -32602, "issue_id is required."));
            }
            match platform::assign_issue(db, user_id, &iid, &bid).await {
                Ok(r) => mcp_data(id, "Assignee updated.".to_string(), json!({ "issue": r })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "issues_move" => {
            let (iid, st) = (arg_str(args, "issue_id"), arg_str(args, "state"));
            if iid.is_empty() || st.is_empty() {
                return Some(rpc_err(id, -32602, "issue_id and state are required."));
            }
            match platform::set_issue_state(db, user_id, &iid, &st).await {
                Ok(r) => mcp_data(id, format!("Moved to {}.", r.state), json!({ "issue": r })),
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
                    let branches = crate::git::git_branches(&git_root, &rid).await.unwrap_or_default();
                    let log = crate::git::git_log(&git_root, &rid, 10).await.unwrap_or_default();
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
            match platform::fork_repo(db, user_id, &team_id, &rid, &state.git_root.to_string_lossy()).await {
                Ok(r) => mcp_data(id, format!("Forked as {}.", r.name), json!({ "repo": r, "clone_url": format!("/git/{}", r.id) })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
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
        "vps_add" => {
            let (team_id, host, key) = (arg_str(args, "team_id"), arg_str(args, "host"), arg_str(args, "ssh_key"));
            if team_id.is_empty() || host.is_empty() || key.is_empty() {
                return Some(rpc_err(id, -32602, "team_id, host, and ssh_key are required."));
            }
            match platform::add_vps(db, &team_id, user_id, &arg_str(args, "name"), &host, &arg_str(args, "ssh_user"), &key).await {
                Ok(v) => mcp_data(id, format!("VPS {} registered.", v.name), json!({ "vps": v })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "vps_list" => {
            let team_id = arg_str(args, "team_id");
            if team_id.is_empty() {
                return Some(rpc_err(id, -32602, "team_id is required."));
            }
            match platform::list_vps(db, &team_id, user_id).await {
                Ok(rows) => mcp_data(id, format!("{} VPS target(s).", rows.len()), json!({ "vps": rows })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "deploy_start" => {
            let (pid, vid) = (arg_str(args, "project_id"), arg_str(args, "vps_id"));
            if pid.is_empty() || vid.is_empty() {
                return Some(rpc_err(id, -32602, "project_id and vps_id are required."));
            }
            match crate::deploy::start_deploy(state.clone(), user_id.to_string(), pid, vid).await {
                Ok(dep) => mcp_data(id, "Deploy started in background.".to_string(), json!({ "deployment": dep })),
                Err(e) => rpc_err(id, -32602, &e),
            }
        }
        "deployments_list" => {
            let pid = arg_str(args, "project_id");
            if pid.is_empty() {
                return Some(rpc_err(id, -32602, "project_id is required."));
            }
            match platform::list_deployments(db, user_id, &pid).await {
                Ok(rows) => mcp_data(id, format!("{} deployment(s).", rows.len()), json!({ "deployments": rows })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "groups_public" => match store::list_public_groups(db).await {
            Ok(rows) => mcp_data(id, format!("{} public channel(s).", rows.len()), json!({ "groups": rows })),
            Err(e) => rpc_err(id, -32000, &e.to_string()),
        },
        "groups_set_visibility" => {
            let (gid, pub_) = (arg_str(args, "group_id"), args.get("public").and_then(|v| v.as_bool()).unwrap_or(false));
            if gid.is_empty() {
                return Some(rpc_err(id, -32602, "group_id is required."));
            }
            match store::set_group_visibility(db, user_id, &gid, pub_).await {
                Ok(Some(g)) => mcp_data(id, if g.is_public != 0 { "Channel is now public.".to_string() } else { "Channel is now private.".to_string() }, json!({ "group": g })),
                Ok(None) => rpc_err(id, -32602, "Group not found or not allowed."),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "groups_support" => {
            let rid = arg_str(args, "repo_id");
            if rid.is_empty() {
                return Some(rpc_err(id, -32602, "repo_id is required."));
            }
            match platform::support_group_for_repo(db, user_id, &rid).await {
                Ok(Some(g)) => mcp_data(id, "Support channel.".to_string(), json!({ "group": g })),
                Ok(None) => rpc_err(id, -32602, "No support channel yet — ask the owning team to open one."),
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
        "templates_list" => {
            mcp_data(id, format!("{} template(s).", crate::team_templates::all().len()), json!({ "templates": crate::team_templates::all() }))
        }
        "templates_apply" => {
            let key = arg_str(args, "template_key");
            if key.is_empty() {
                return Some(rpc_err(id, -32602, "template_key is required."));
            }
            match crate::team_templates::apply(db, user_id, &key, &arg_str(args, "team_name")).await {
                Ok((team, bots)) => mcp_data(id, format!("Team {} ready with {} agent(s).", team.name, bots.len()), json!({ "team": team, "bots": bots })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "connectors_add" => {
            let (tid, name, base) = (arg_str(args, "team_id"), arg_str(args, "name"), arg_str(args, "base_url"));
            if tid.is_empty() || name.trim().is_empty() || base.trim().is_empty() {
                return Some(rpc_err(id, -32602, "team_id, name and base_url are required."));
            }
            match crate::connectors::add(db, &tid, user_id, &arg_str(args, "project_id"), &name, &base, &arg_str(args, "api_key")).await {
                Ok(c) => mcp_data(id, format!("Connector {} registered at {}.", c.name, c.base_url), json!({ "connector": c })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "connectors_list" => {
            let tid = arg_str(args, "team_id");
            if tid.is_empty() {
                return Some(rpc_err(id, -32602, "team_id is required."));
            }
            match crate::connectors::list(db, &tid, user_id).await {
                Ok(rows) => mcp_data(id, format!("{} connector(s).", rows.len()), json!({ "connectors": rows })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "connectors_remove" => {
            let (tid, cid) = (arg_str(args, "team_id"), arg_str(args, "connector_id"));
            if tid.is_empty() || cid.is_empty() {
                return Some(rpc_err(id, -32602, "team_id and connector_id are required."));
            }
            match crate::connectors::remove(db, &tid, user_id, &cid).await {
                Ok(()) => mcp_data(id, "Connector removed.".to_string(), json!({ "removed": true })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "connectors_call" => {
            let (tid, cid, tool) = (arg_str(args, "team_id"), arg_str(args, "connector_id"), arg_str(args, "tool"));
            if tid.is_empty() || cid.is_empty() || tool.trim().is_empty() {
                return Some(rpc_err(id, -32602, "team_id, connector_id and tool are required."));
            }
            let args_v = args.get("arguments").cloned().unwrap_or(serde_json::Value::Null);
            match crate::connectors::call_tool(db, &tid, user_id, &cid, &tool, &args_v).await {
                Ok(v) => mcp_data(id, "App answered.".to_string(), v),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "skills_list" => {
            let tid = arg_str(args, "team_id");
            match crate::skills::list(db, user_id, &tid).await {
                Ok(rows) => mcp_data(id, format!("{} skill(s).", rows.len()), json!({ "skills": rows })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "skills_create" => {
            let (tid, name) = (arg_str(args, "team_id"), arg_str(args, "name"));
            if tid.is_empty() || name.trim().is_empty() {
                return Some(rpc_err(id, -32602, "team_id and name are required."));
            }
            match crate::skills::create(db, user_id, &tid, &name, &arg_str(args, "category"), &arg_str(args, "description"), &arg_str(args, "role"), &arg_str(args, "memory")).await {
                Ok(s) => mcp_data(id, format!("Skill {} created.", s.name), json!({ "skill": s })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "skills_delete" => {
            let sid = arg_str(args, "skill_id");
            if sid.is_empty() {
                return Some(rpc_err(id, -32602, "skill_id is required."));
            }
            match crate::skills::delete(db, user_id, &sid).await {
                Ok(true) => mcp_data(id, "Skill deleted.".to_string(), json!({ "deleted": true })),
                Ok(false) => rpc_err(id, -32602, "Skill not found."),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "skills_apply" => {
            let (sid, bid) = (arg_str(args, "skill_id"), arg_str(args, "slavebot_id"));
            if sid.is_empty() || bid.is_empty() {
                return Some(rpc_err(id, -32602, "skill_id and slavebot_id are required."));
            }
            match crate::skills::apply_to_bot(db, user_id, &sid, &bid).await {
                Ok(bot) => mcp_data(id, format!("Skill installed on {}.", bot.name), json!({ "slavebot": bot })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "dm_history" => {
            let (tid, uid) = (arg_str(args, "team_id"), arg_str(args, "user_id"));
            if tid.is_empty() || uid.is_empty() {
                return Some(rpc_err(id, -32602, "team_id and user_id are required."));
            }
            match platform::dm_history_checked(db, &tid, user_id, &uid).await {
                Ok(rows) => mcp_data(id, format!("{} message(s).", rows.len()), json!({ "messages": rows })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "dm_send" => {
            let (tid, to, msg) = (arg_str(args, "team_id"), arg_str(args, "to_user_id"), arg_str(args, "message"));
            if tid.is_empty() || to.is_empty() || msg.trim().is_empty() {
                return Some(rpc_err(id, -32602, "team_id, to_user_id and message are required."));
            }
            match platform::dm_send_checked(db, &tid, user_id, &to, &msg).await {
                Ok(row) => mcp_data(id, "Sent.".to_string(), json!({ "message": row })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "unread_list" => match store::unread_list(db, user_id).await {
            Ok(rows) => {
                let total: i64 = rows.iter().map(|r| r.unread).sum();
                mcp_data(id, format!("{} unread in {} conversation(s).", total, rows.len()), json!({ "unread": rows }))
            }
            Err(e) => rpc_err(id, -32000, &e.to_string()),
        },
        "read_mark" => {
            let (kind, rid) = (arg_str(args, "kind"), arg_str(args, "ref_id"));
            let last = args.get("last_id").and_then(|v| v.as_i64()).unwrap_or(0);
            if !["dm", "group", "meeting", "bot"].contains(&kind.as_str()) || rid.is_empty() {
                return Some(rpc_err(id, -32602, "kind must be dm|group|meeting|bot, ref_id and last_id are required."));
            }
            match store::set_read(db, user_id, &kind, &arg_str(args, "team_id"), &rid, last).await {
                Ok(()) => mcp_data(id, "Marked read.".to_string(), json!({ "marked": true })),
                Err(e) => rpc_err(id, -32000, &e.to_string()),
            }
        }
        "groups_add_user" => {
            let (gid, uid) = (arg_str(args, "group_id"), arg_str(args, "user_id"));
            if gid.is_empty() || uid.is_empty() {
                return Some(rpc_err(id, -32602, "group_id and user_id are required."));
            }
            match platform::group_add_user(db, "", &gid, user_id, &uid).await {
                Ok(true) => mcp_data(id, "User added.".to_string(), json!({ "added": true })),
                Ok(false) => rpc_err(id, -32602, "Channel not found or not allowed."),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "groups_remove_user" => {
            let (gid, uid) = (arg_str(args, "group_id"), arg_str(args, "user_id"));
            if gid.is_empty() || uid.is_empty() {
                return Some(rpc_err(id, -32602, "group_id and user_id are required."));
            }
            match platform::group_remove_user(db, &gid, user_id, &uid).await {
                Ok(true) => mcp_data(id, "User removed.".to_string(), json!({ "removed": true })),
                Ok(false) => rpc_err(id, -32602, "Channel not found or not allowed."),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "groups_set_project" => {
            let (gid, pid) = (arg_str(args, "group_id"), arg_str(args, "project_id"));
            if gid.is_empty() {
                return Some(rpc_err(id, -32602, "group_id is required."));
            }
            match platform::set_group_project(db, &gid, user_id, &pid).await {
                Ok(g) => mcp_data(id, if pid.trim().is_empty() { "Board detached.".to_string() } else { "Board attached.".to_string() }, json!({ "group": g })),
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
        "fly_connect" => {
            let (tid, token) = (arg_str(args, "team_id"), arg_str(args, "api_token"));
            if tid.is_empty() || token.trim().is_empty() {
                return Some(rpc_err(id, -32602, "team_id and api_token are required."));
            }
            match platform::fly_connect(db, &tid, user_id, &arg_str(args, "name"), &arg_str(args, "org"), &token).await {
                Ok(a) => mcp_data(id, format!("Fly account {} connected.", a.name), json!({ "account": a })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "fly_accounts" => {
            let tid = arg_str(args, "team_id");
            if tid.is_empty() {
                return Some(rpc_err(id, -32602, "team_id is required."));
            }
            match platform::fly_list(db, &tid, user_id).await {
                Ok(rows) => mcp_data(id, format!("{} Fly account(s).", rows.len()), json!({ "accounts": rows })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "fly_disconnect" => {
            let (tid, aid) = (arg_str(args, "team_id"), arg_str(args, "account_id"));
            if tid.is_empty() || aid.is_empty() {
                return Some(rpc_err(id, -32602, "team_id and account_id are required."));
            }
            match platform::fly_disconnect(db, &tid, user_id, &aid).await {
                Ok(()) => mcp_data(id, "Fly account removed.".to_string(), json!({ "removed": true })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "fly_provision" => {
            let tid = arg_str(args, "team_id");
            let aid = arg_str(args, "account_id");
            let slug = if arg_str(args, "name").is_empty() { arg_str(args, "slug") } else { arg_str(args, "name") };
            if tid.is_empty() || aid.is_empty() || slug.trim().is_empty() {
                return Some(rpc_err(id, -32602, "team_id, account_id and name (slug) are required."));
            }
            let prod_image = arg_str(args, "prod_image");
            let dev_image = arg_str(args, "dev_image");
            let dev_cpus = args.get("dev_cpus").and_then(|v| v.as_i64()).unwrap_or_else(|| args.get("dev_cpus").and_then(|v| v.as_str()).and_then(|s| s.parse().ok()).unwrap_or(2));
            let dev_mem = args.get("dev_memory").and_then(|v| v.as_i64()).unwrap_or_else(|| args.get("dev_memory_mb").and_then(|v| v.as_i64()).unwrap_or(2048));
            let pi = if prod_image.is_empty() { None } else { Some(prod_image.as_str()) };
            let di = if dev_image.is_empty() { None } else { Some(dev_image.as_str()) };
            match platform::fly_provision_team(db, &tid, user_id, &aid, &slug, pi, di, dev_cpus, dev_mem).await {
                Ok(v) => mcp_data(id, "PROD + DEV machines provisioned.".to_string(), v),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "fly_machines" => {
            let tid = arg_str(args, "team_id");
            if tid.is_empty() {
                return Some(rpc_err(id, -32602, "team_id is required."));
            }
            match platform::fly_machines(db, &tid, user_id).await {
                Ok(rows) => {
                    // Best-effort live state: refresh from Fly when a token is available.
                    let mut out = Vec::new();
                    for m in rows {
                        let live = crate::fly::get_machine_by_token_for(db, &tid, &m.app_name, &m.machine_id).await.ok();
                        let mut v = serde_json::to_value(&m).unwrap_or(serde_json::Value::Null);
                        if let Some(st) = live { v["live"] = st; }
                        out.push(v);
                    }
                    mcp_data(id, format!("{} machine(s).", out.len()), json!({ "machines": out }))
                }
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "fly_destroy" => {
            let (tid, mid) = (arg_str(args, "team_id"), arg_str(args, "machine_id"));
            if tid.is_empty() || mid.is_empty() {
                return Some(rpc_err(id, -32602, "team_id and machine_id are required."));
            }
            let delete_app = args.get("delete_app").and_then(|v| v.as_bool()).unwrap_or(false);
            match platform::fly_destroy_machine(db, "", &tid, user_id, &mid, delete_app).await {
                Ok(v) => mcp_data(id, "Machine destroyed.".to_string(), v),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "domains_add" => {
            let (tid, target) = (arg_str(args, "team_id"), arg_str(args, "target"));
            if tid.is_empty() || target.trim().is_empty() {
                return Some(rpc_err(id, -32602, "team_id and target are required."));
            }
            match platform::domain_add(db, &tid, user_id, &arg_str(args, "project_id"), &arg_str(args, "subdomain"), &target, &arg_str(args, "kind")).await {
                Ok(d) => mcp_data(id, format!("Domain {} mapped.", d.hostname), json!({ "domain": d })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "domains_list" => {
            let tid = arg_str(args, "team_id");
            if tid.is_empty() {
                return Some(rpc_err(id, -32602, "team_id is required."));
            }
            match platform::domain_list(db, &tid, user_id).await {
                Ok(rows) => mcp_data(id, format!("{} domain(s).", rows.len()), json!({ "domains": rows })),
                Err(e) => rpc_err(id, -32602, &e.to_string()),
            }
        }
        "domains_remove" => {
            let (tid, did) = (arg_str(args, "team_id"), arg_str(args, "domain_id"));
            if tid.is_empty() || did.is_empty() {
                return Some(rpc_err(id, -32602, "team_id and domain_id are required."));
            }
            match platform::domain_remove(db, &tid, user_id, &did).await {
                Ok(()) => mcp_data(id, "Domain removed.".to_string(), json!({ "removed": true })),
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
