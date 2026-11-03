//! MCP tools for the Slaver platform layer: projects/kanban, git repos,
//! marketplace licenses, VPS targets, deployments. Dispatched from mcp.rs.

use axum::response::Response;
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
        json!({ "name": "licenses_buy", "description": "Buy a perpetual license for a template (mock checkout), auto-forks the repo and creates a project. Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id", "repo_id"], "properties": { "team_id": { "type": "string" }, "repo_id": { "type": "string" }, "provider": { "type": "string" } } } }),
        json!({ "name": "licenses_list", "description": "List a team's licenses.", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" } } } }),
        json!({ "name": "vps_add", "description": "Register a VPS deploy target (SSH key stored server-side). Owner/admin only.", "inputSchema": { "type": "object", "required": ["team_id", "host", "ssh_key"], "properties": { "team_id": { "type": "string" }, "name": { "type": "string" }, "host": { "type": "string" }, "ssh_user": { "type": "string" }, "ssh_key": { "type": "string" } } } }),
        json!({ "name": "vps_list", "description": "List a team's VPS targets (keys never leave the server).", "inputSchema": { "type": "object", "required": ["team_id"], "properties": { "team_id": { "type": "string" } } } }),
        json!({ "name": "deploy_start", "description": "Deploy a project's repo HEAD to a VPS (compose up). Runs in background; poll deployments_list. Owner/admin only.", "inputSchema": { "type": "object", "required": ["project_id", "vps_id"], "properties": { "project_id": { "type": "string" }, "vps_id": { "type": "string" } } } }),
        json!({ "name": "deployments_list", "description": "Recent deployments of a project with logs.", "inputSchema": { "type": "object", "required": ["project_id"], "properties": { "project_id": { "type": "string" } } } }),
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
        "licenses_buy" => {
            let (team_id, rid) = (arg_str(args, "team_id"), arg_str(args, "repo_id"));
            if team_id.is_empty() || rid.is_empty() {
                return Some(rpc_err(id, -32602, "team_id and repo_id are required."));
            }
            let provider = {
                let p = arg_str(args, "provider");
                if p.is_empty() { "mock".to_string() } else { p }
            };
            if provider != "mock" {
                return Some(rpc_err(id, -32602, "Real payment providers (HitPay/Stripe) are not connected yet — use provider \"mock\" for now."));
            }
            // Buy-once: license (12 months support) + auto-fork + auto-project.
            match platform::buy_license(db, &team_id, user_id, &rid, &provider, 0, 12).await {
                Ok(lic) => {
                    let fork = match platform::fork_repo(db, user_id, &team_id, &rid, &state.git_root.to_string_lossy()).await {
                        Ok(f) => f,
                        Err(e) => return Some(rpc_err(id, -32602, &e.to_string())),
                    };
                    let tpl_name = platform::get_repo(db, user_id, &rid).await.ok().flatten().map(|r| r.name).unwrap_or_else(|| "app".to_string());
                    let project = match platform::create_project(db, &team_id, user_id, &format!("{tpl_name} (custom)"), "Forked from marketplace template.").await {
                        Ok(p) => p,
                        Err(e) => return Some(rpc_err(id, -32602, &e.to_string())),
                    };
                    let project = match platform::set_project_repo(db, user_id, &project.id, &fork.id).await {
                        Ok(p) => p,
                        Err(e) => return Some(rpc_err(id, -32602, &e.to_string())),
                    };
                    mcp_data(id, "License active — repo forked and project created.".to_string(), json!({ "license": lic, "repo": fork, "project": project }))
                }
                Err(e) => rpc_err(id, -32602, &e.to_string()),
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
        _ => return None,
    };
    Some(out)
}
