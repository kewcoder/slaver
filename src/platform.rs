//! Slaver platform layer: projects/kanban, git repos, marketplace licenses,
//! VPS targets, deployments. Teams double as organizations.

use anyhow::{anyhow, Result};
use chrono::Datelike;
use serde::{Deserialize, Serialize};

use crate::{
    db::{v_text, v_int, Db},
    store,
};

fn new_id() -> String {
    let mut b = [0u8; 16];
    if getrandom::getrandom(&mut b).is_err() {
        let t = crate::db::now_millis();
        b[..8].copy_from_slice(&t.to_be_bytes());
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex::encode(b);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

async fn require_member(db: &Db, team_id: &str, user_id: &str) -> Result<String> {
    store::membership(db, team_id, user_id)
        .await?
        .ok_or_else(|| anyhow!("You are not on that team."))
}

async fn require_manager(db: &Db, team_id: &str, user_id: &str) -> Result<()> {
    match require_member(db, team_id, user_id).await?.as_str() {
        "owner" | "admin" => Ok(()),
        _ => Err(anyhow!("Only owners and admins can do that.")),
    }
}

// ---------- projects ----------

#[derive(Deserialize, Serialize, Clone)]
pub struct ProjectRow {
    pub id: String,
    pub team_id: String,
    pub repo_id: String,
    pub name: String,
    pub description: String,
    pub status: String,
    pub created_at: String,
}

pub async fn create_project(db: &Db, team_id: &str, user_id: &str, name: &str, description: &str) -> Result<ProjectRow> {
    require_member(db, team_id, user_id).await?;
    let name: String = { let n = name.trim().chars().take(80).collect::<String>(); if n.is_empty() { "Project".to_string() } else { n } };
    let description: String = description.trim().chars().take(2000).collect();
    let id = new_id();
    db.prepare("INSERT INTO projects (id, team_id, name, description) VALUES (?, ?, ?, ?)")
        .bind(&[v_text(&id), v_text(team_id), v_text(&name), v_text(&description)])?
        .run()
        .await?;
    get_project(db, user_id, &id).await?.ok_or_else(|| anyhow!("project insert failed"))
}

pub async fn list_projects(db: &Db, team_id: &str, user_id: &str) -> Result<Vec<ProjectRow>> {
    require_member(db, team_id, user_id).await?;
    db.prepare("SELECT id, team_id, repo_id, name, description, status, created_at FROM projects WHERE team_id = ? ORDER BY created_at DESC LIMIT 100")
        .bind(&[v_text(team_id)])?
        .all()
        .await?
        .results()
}

pub async fn get_project(db: &Db, user_id: &str, project_id: &str) -> Result<Option<ProjectRow>> {
    let row: Option<ProjectRow> = db
        .prepare("SELECT id, team_id, repo_id, name, description, status, created_at FROM projects WHERE id = ?")
        .bind(&[v_text(project_id)])?
        .first(None)
        .await?;
    match row {
        Some(p) => {
            require_member(db, &p.team_id, user_id).await?;
            Ok(Some(p))
        }
        None => Ok(None),
    }
}

pub async fn set_project_repo(db: &Db, user_id: &str, project_id: &str, repo_id: &str) -> Result<ProjectRow> {
    let p = get_project(db, user_id, project_id).await?.ok_or_else(|| anyhow!("Project not found."))?;
    require_manager(db, &p.team_id, user_id).await?;
    if !repo_id.is_empty() {
        let r = get_repo(db, user_id, repo_id).await?.ok_or_else(|| anyhow!("Repo not found."))?;
        if r.team_id != p.team_id {
            return Err(anyhow!("Repo belongs to a different team."));
        }
    }
    db.prepare("UPDATE projects SET repo_id = ? WHERE id = ?")
        .bind(&[v_text(repo_id), v_text(project_id)])?
        .run()
        .await?;
    get_project(db, user_id, project_id).await?.ok_or_else(|| anyhow!("Project not found."))
}

#[derive(Deserialize, Serialize, Clone, Default)]
pub struct ProjectStats {
    pub total: i64,
    pub done: i64,
    pub in_progress: i64,
}

pub async fn project_stats(db: &Db, user_id: &str, project_id: &str) -> Result<ProjectStats> {
    let p = get_project(db, user_id, project_id).await?.ok_or_else(|| anyhow!("Project not found."))?;
    #[derive(serde::Deserialize)]
    struct Row { state: String, n: i64 }
    let rows: Vec<Row> = db
        .prepare("SELECT state, COUNT(*) AS n FROM issues WHERE project_id = ? GROUP BY state")
        .bind(&[v_text(&p.id)])?
        .all()
        .await?
        .results()?;
    let mut s = ProjectStats::default();
    for r in rows {
        s.total += r.n;
        if r.state == "done" {
            s.done += r.n;
        } else if r.state == "in_progress" || r.state == "in_review" {
            s.in_progress += r.n;
        }
    }
    Ok(s)
}

// ---------- issues (kanban) ----------

#[derive(Deserialize, Serialize, Clone)]
pub struct IssueRow {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub body: String,
    pub state: String,
    pub assignee_bot_id: String,
    pub assignee_name: Option<String>,
    pub priority: String,
    pub labels: String,
    pub created_at: String,
    pub updated_at: String,
}

pub const STATES: &[&str] = &["backlog", "todo", "in_progress", "in_review", "done"];

fn valid_state(s: &str) -> bool {
    STATES.contains(&s)
}

pub async fn create_issue(
    db: &Db,
    user_id: &str,
    project_id: &str,
    title: &str,
    body: &str,
    assignee_bot_id: &str,
) -> Result<IssueRow> {
    let p = get_project(db, user_id, project_id).await?.ok_or_else(|| anyhow!("Project not found."))?;
    let title: String = title.trim().chars().take(160).collect();
    if title.is_empty() {
        return Err(anyhow!("Issue title is required."));
    }
    let body: String = body.trim().chars().take(8000).collect();
    let mut assign = assignee_bot_id.trim().to_string();
    if !assign.is_empty() {
        // Assignee must be a bot the actor may use.
        let bot = store::get_bot(db, user_id, &assign).await?.ok_or_else(|| anyhow!("Assigned bot not found or not visible to you."))?;
        if bot.team_id != p.team_id {
            return Err(anyhow!("That bot is on a different team."));
        }
        let _ = bot;
    } else {
        assign = String::new();
    }
    let id = new_id();
    db.prepare("INSERT INTO issues (id, project_id, title, body, state, assignee_bot_id) VALUES (?, ?, ?, ?, 'backlog', ?)")
        .bind(&[v_text(&id), v_text(project_id), v_text(&title), v_text(&body), v_text(&assign)])?
        .run()
        .await?;
    get_issue(db, user_id, &id).await?.ok_or_else(|| anyhow!("issue insert failed"))
}

pub async fn list_issues(db: &Db, user_id: &str, project_id: &str) -> Result<Vec<IssueRow>> {
    let p = get_project(db, user_id, project_id).await?.ok_or_else(|| anyhow!("Project not found."))?;
    let _ = p;
    db.prepare(
        "SELECT i.id, i.project_id, i.title, i.body, i.state, i.assignee_bot_id, s.name AS assignee_name, i.priority, i.labels, i.created_at, i.updated_at \
         FROM issues i LEFT JOIN slavebots s ON s.id = i.assignee_bot_id \
         WHERE i.project_id = ? ORDER BY i.created_at ASC LIMIT 200",
    )
    .bind(&[v_text(project_id)])?
    .all()
    .await?
    .results()
}

pub async fn get_issue(db: &Db, user_id: &str, issue_id: &str) -> Result<Option<IssueRow>> {
    let row: Option<IssueRow> = db
        .prepare(
            "SELECT i.id, i.project_id, i.title, i.body, i.state, i.assignee_bot_id, s.name AS assignee_name, i.priority, i.labels, i.created_at, i.updated_at \
             FROM issues i LEFT JOIN slavebots s ON s.id = i.assignee_bot_id WHERE i.id = ?",
        )
        .bind(&[v_text(issue_id)])?
        .first(None)
        .await?;
    match row {
        Some(r) => {
            get_project(db, user_id, &r.project_id).await?;
            Ok(Some(r))
        }
        None => Ok(None),
    }
}

pub async fn set_issue_state(db: &Db, user_id: &str, issue_id: &str, state: &str) -> Result<IssueRow> {
    let issue = get_issue(db, user_id, issue_id).await?.ok_or_else(|| anyhow!("Issue not found."))?;
    let state = state.trim().to_lowercase().replace(' ', "_");
    if !valid_state(&state) {
        return Err(anyhow!("State must be one of: backlog, todo, in_progress, in_review, done."));
    }
    db.prepare("UPDATE issues SET state = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .bind(&[v_text(&state), v_text(&issue.id)])?
        .run()
        .await?;
    get_issue(db, user_id, issue_id).await?.ok_or_else(|| anyhow!("Issue not found."))
}

pub async fn assign_issue(db: &Db, user_id: &str, issue_id: &str, bot_id: &str) -> Result<IssueRow> {
    let issue = get_issue(db, user_id, issue_id).await?.ok_or_else(|| anyhow!("Issue not found."))?;
    let p = get_project(db, user_id, &issue.project_id).await?.ok_or_else(|| anyhow!("Project not found."))?;
    let bot_id = bot_id.trim();
    if !bot_id.is_empty() {
        let bot = store::get_bot(db, user_id, bot_id).await?.ok_or_else(|| anyhow!("Bot not found or not visible to you."))?;
        if bot.team_id != p.team_id {
            return Err(anyhow!("That bot is on a different team."));
        }
    }
    db.prepare("UPDATE issues SET assignee_bot_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .bind(&[v_text(bot_id), v_text(&issue.id)])?
        .run()
        .await?;
    get_issue(db, user_id, issue_id).await?.ok_or_else(|| anyhow!("Issue not found."))
}

pub async fn update_issue(
    db: &Db,
    user_id: &str,
    issue_id: &str,
    title: Option<&str>,
    body: Option<&str>,
    priority: Option<&str>,
    labels: Option<&str>,
) -> Result<IssueRow> {
    let issue = get_issue(db, user_id, issue_id).await?.ok_or_else(|| anyhow!("Issue not found."))?;
    if let Some(t) = title.map(str::trim).filter(|t| !t.is_empty()) {
        let t: String = t.chars().take(160).collect();
        db.prepare("UPDATE issues SET title = ? WHERE id = ?").bind(&[v_text(&t), v_text(&issue.id)])?.run().await?;
    }
    if let Some(b) = body {
        let b: String = b.chars().take(8000).collect();
        db.prepare("UPDATE issues SET body = ? WHERE id = ?").bind(&[v_text(&b), v_text(&issue.id)])?.run().await?;
    }
    if let Some(pr) = priority.map(str::trim).filter(|p| !p.is_empty()) {
        let pr = pr.to_lowercase();
        if !["low", "medium", "high", "urgent"].contains(&pr.as_str()) {
            return Err(anyhow!("Priority must be low, medium, high, or urgent."));
        }
        db.prepare("UPDATE issues SET priority = ? WHERE id = ?").bind(&[v_text(&pr), v_text(&issue.id)])?.run().await?;
    }
    if let Some(l) = labels {
        let l: String = l.chars().take(200).collect();
        db.prepare("UPDATE issues SET labels = ? WHERE id = ?").bind(&[v_text(&l), v_text(&issue.id)])?.run().await?;
    }
    db.prepare("UPDATE issues SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .bind(&[v_text(&issue.id)])?
        .run()
        .await?;
    get_issue(db, user_id, issue_id).await?.ok_or_else(|| anyhow!("Issue not found."))
}

// ---------- repos ----------

#[derive(Deserialize, Serialize, Clone)]
pub struct RepoRow {
    pub id: String,
    pub team_id: String,
    pub name: String,
    pub description: String,
    pub template: i64,
    pub fork_of: String,
    pub created_at: String,
}

pub async fn create_repo(db: &Db, team_id: &str, user_id: &str, name: &str, description: &str) -> Result<RepoRow> {
    require_member(db, team_id, user_id).await?;
    let name: String = { let n = name.trim().chars().take(80).collect::<String>(); if n.is_empty() { "repo".to_string() } else { n } };
    let description: String = description.trim().chars().take(2000).collect();
    let id = new_id();
    db.prepare("INSERT INTO repos (id, team_id, name, description) VALUES (?, ?, ?, ?)")
        .bind(&[v_text(&id), v_text(team_id), v_text(&name), v_text(&description)])?
        .run()
        .await?;
    get_repo(db, user_id, &id).await?.ok_or_else(|| anyhow!("repo insert failed"))
}

pub async fn list_repos(db: &Db, team_id: &str, user_id: &str, templates_only: bool) -> Result<Vec<RepoRow>> {
    if templates_only {
        // Public templates are visible to every logged-in user.
        return db
            .prepare("SELECT id, team_id, name, description, template, fork_of, created_at FROM repos WHERE template = 1 ORDER BY created_at DESC LIMIT 100")
            .bind(&[])?
            .all()
            .await?
            .results();
    }
    require_member(db, team_id, user_id).await?;
    db.prepare("SELECT id, team_id, name, description, template, fork_of, created_at FROM repos WHERE team_id = ? ORDER BY created_at DESC LIMIT 100")
        .bind(&[v_text(team_id)])?
        .all()
        .await?
        .results()
}

pub async fn get_repo(db: &Db, user_id: &str, repo_id: &str) -> Result<Option<RepoRow>> {
    let row: Option<RepoRow> = db
        .prepare("SELECT id, team_id, name, description, template, fork_of, created_at FROM repos WHERE id = ?")
        .bind(&[v_text(repo_id)])?
        .first(None)
        .await?;
    match row {
        Some(r) if r.template != 0 => Ok(Some(r)),
        Some(r) => {
            require_member(db, &r.team_id, user_id).await?;
            Ok(Some(r))
        }
        None => Ok(None),
    }
}

pub async fn mark_template(db: &Db, repo_id: &str, template: bool) -> Result<()> {
    db.prepare("UPDATE repos SET template = ? WHERE id = ?")
        .bind(&[v_int(if template { 1 } else { 0 }), v_text(repo_id)])?
        .run()
        .await?;
    Ok(())
}

pub fn bare_repo_path(git_root: &str, repo_id: &str) -> std::path::PathBuf {
    let mut p = std::path::PathBuf::from(git_root);
    for seg in [repo_id] {
        if seg.bytes().any(|b| b == b'/' || b == 0) {
            continue;
        }
        p.push(format!("{seg}.git"));
    }
    p
}

pub async fn ensure_bare_repo(git_root: &str, repo_id: &str) -> Result<std::path::PathBuf, String> {
    let path = bare_repo_path(git_root, repo_id);
    if !path.join("HEAD").exists() {
        let parent = path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| std::path::PathBuf::from("."));
        tokio::fs::create_dir_all(&parent).await.map_err(|e| e.to_string())?;
        let out = tokio::process::Command::new("git")
            .arg("init")
            .arg("--bare")
            .arg("-b")
            .arg("main")
            .arg(&path)
            .output()
            .await
            .map_err(|e| format!("git not available: {e}"))?;
        if !out.status.success() {
            return Err(format!("git init failed: {}", String::from_utf8_lossy(&out.stderr)));
        }
    }
    Ok(path)
}

pub async fn fork_repo(db: &Db, user_id: &str, team_id: &str, source_repo_id: &str, git_root: &str) -> Result<RepoRow> {
    require_member(db, team_id, user_id).await?;
    let source = get_repo(db, user_id, source_repo_id).await?.ok_or_else(|| anyhow!("Template repo not found."))?;
    if source.template == 0 {
        return Err(anyhow!("Only template repos can be forked. Ask the owner to publish it first."));
    }
    let id = new_id();
    let name = format!("{}-fork", source.name.chars().take(60).collect::<String>());
    db.prepare("INSERT INTO repos (id, team_id, name, description, template, fork_of) VALUES (?, ?, ?, ?, 0, ?)")
        .bind(&[v_text(&id), v_text(team_id), v_text(&name), v_text(&source.description), v_text(&source.id)])?
        .run()
        .await?;
    // Copy the bare repo so history travels with the fork.
    let src = ensure_bare_repo(git_root, &source.id).await.map_err(|e| anyhow!("{e}"))?;
    let dst = bare_repo_path(git_root, &id);
    if let Some(parent) = dst.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| anyhow!("{e}"))?;
    }
    let out = tokio::process::Command::new("git")
        .arg("clone")
        .arg("--bare")
        .arg(&src)
        .arg(&dst)
        .output()
        .await
        .map_err(|e| anyhow!("git not available: {e}"))?;
    if !out.status.success() {
        return Err(anyhow!("Fork failed: {}", String::from_utf8_lossy(&out.stderr)));
    }
    get_repo(db, user_id, &id).await?.ok_or_else(|| anyhow!("fork insert failed"))
}

// ---------- licenses (marketplace buy-once) ----------

#[derive(Deserialize, Serialize, Clone)]
pub struct LicenseRow {
    pub id: String,
    pub team_id: String,
    pub repo_id: String,
    pub kind: String,
    pub support_until: String,
    pub status: String,
    pub provider: String,
    pub amount_cents: i64,
    pub created_at: String,
}

/// Find (or, for the owning team, create) the public support group linked
/// to a repo. Anyone can read/post; only the owning team's bots reply.
pub async fn support_group_for_repo(db: &Db, user_id: &str, repo_id: &str) -> Result<Option<store::GroupRow>, String> {
    let repo = get_repo(db, user_id, repo_id).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "Repo not found.".to_string())?;
    let existing: Option<store::GroupRow> = db
        .prepare("SELECT id, team_id, name, is_public, repo_id, created_at, updated_at FROM groups WHERE repo_id = ? AND is_public <> 0 LIMIT 1")
        .bind(&[v_text(repo_id)])
        .map_err(|e| e.to_string())?
        .first(None)
        .await
        .map_err(|e| e.to_string())?;
    if existing.is_some() {
        return Ok(existing);
    }
    // Only the owning team's owner/admin can open the support channel.
    match store::membership(db, &repo.team_id, user_id).await.map_err(|e| e.to_string())? {
        Some(r) if r == "owner" || r == "admin" => {}
        _ => return Ok(None),
    }
    let name: String = format!("Support: {}", repo.name.chars().take(28).collect::<String>());
    let id = new_id();
    db.prepare("INSERT INTO groups (id, user_id, team_id, name, is_public, repo_id) VALUES (?, ?, ?, ?, 1, ?)")
        .bind(&[v_text(&id), v_text(user_id), v_text(&repo.team_id), v_text(&name), v_text(repo_id)])
        .map_err(|e| e.to_string())?
        .run()
        .await
        .map_err(|e| e.to_string())?;
    store::get_group(db, user_id, &id).await.map_err(|e| e.to_string())
}

pub async fn buy_license(
    db: &Db,
    team_id: &str,
    user_id: &str,
    template_repo_id: &str,
    provider: &str,
    amount_cents: i64,
    support_months: i64,
) -> Result<LicenseRow> {
    require_manager(db, team_id, user_id).await?;
    let tpl = get_repo(db, user_id, template_repo_id).await?.ok_or_else(|| anyhow!("Template not found."))?;
    if tpl.template == 0 {
        return Err(anyhow!("That repo is not a published template."));
    }
    let existing: Option<LicenseRow> = db
        .prepare("SELECT id, team_id, repo_id, kind, support_until, status, provider, amount_cents, created_at FROM licenses WHERE team_id = ? AND repo_id = ? AND status = 'active'")
        .bind(&[v_text(team_id), v_text(template_repo_id)])?
        .first(None)
        .await?;
    if existing.is_some() {
        return Err(anyhow!("Your team already owns an active license for this app."));
    }
    // support_until = today + support_months (UTC date).
    let support_until = {
        let now = chrono::Utc::now().date_naive();
        let total = now.year() * 12 + (now.month() as i32 - 1) + support_months.max(1) as i32;
        let y = total.div_euclid(12);
        let m = (total.rem_euclid(12) + 1) as u32;
        let d = now.day().min(28);
        chrono::NaiveDate::from_ymd_opt(y, m, d).unwrap_or(now).format("%Y-%m-%d").to_string()
    };
    let id = new_id();
    db.prepare("INSERT INTO licenses (id, team_id, repo_id, kind, support_until, status, provider, amount_cents) VALUES (?, ?, ?, 'perpetual', ?, 'active', ?, ?)")
        .bind(&[v_text(&id), v_text(team_id), v_text(template_repo_id), v_text(&support_until), v_text(provider), v_int(amount_cents)])?
        .run()
        .await?;
    let row: Option<LicenseRow> = db
        .prepare("SELECT id, team_id, repo_id, kind, support_until, status, provider, amount_cents, created_at FROM licenses WHERE id = ?")
        .bind(&[v_text(&id)])?
        .first(None)
        .await?;
    row.ok_or_else(|| anyhow!("license insert failed"))
}

pub async fn list_licenses(db: &Db, team_id: &str, user_id: &str) -> Result<Vec<LicenseRow>> {
    require_member(db, team_id, user_id).await?;
    db.prepare("SELECT id, team_id, repo_id, kind, support_until, status, provider, amount_cents, created_at FROM licenses WHERE team_id = ? ORDER BY created_at DESC LIMIT 100")
        .bind(&[v_text(team_id)])?
        .all()
        .await?
        .results()
}

pub async fn license_for_repo(db: &Db, team_id: &str, repo_id: &str) -> Result<Option<LicenseRow>> {
    db.prepare("SELECT id, team_id, repo_id, kind, support_until, status, provider, amount_cents, created_at FROM licenses WHERE team_id = ? AND repo_id = ? AND status = 'active' LIMIT 1")
        .bind(&[v_text(team_id), v_text(repo_id)])?
        .first(None)
        .await
        .map_err(|e| anyhow!("{e}"))
}

// ---------- VPS targets & deployments ----------

#[derive(Deserialize, Serialize, Clone)]
pub struct VpsRow {
    pub id: String,
    pub team_id: String,
    pub name: String,
    pub host: String,
    pub ssh_user: String,
    pub created_at: String,
}

pub async fn add_vps(db: &Db, team_id: &str, user_id: &str, name: &str, host: &str, ssh_user: &str, ssh_key: &str) -> Result<VpsRow> {
    require_manager(db, team_id, user_id).await?;
    let host = host.trim();
    if host.is_empty() || host.len() > 253 {
        return Err(anyhow!("VPS host is required (IP or domain)."));
    }
    if ssh_key.trim().is_empty() {
        return Err(anyhow!("An SSH private key is required for deploys."));
    }
    let name: String = { let n = name.trim().chars().take(60).collect::<String>(); if n.is_empty() { host.to_string() } else { n } };
    let id = new_id();
    db.prepare("INSERT INTO vps_targets (id, team_id, name, host, ssh_user, ssh_key) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&[v_text(&id), v_text(team_id), v_text(&name), v_text(host), v_text(if ssh_user.trim().is_empty() { "root" } else { ssh_user.trim() }), v_text(ssh_key.trim())])?
        .run()
        .await?;
    let row: Option<VpsRow> = db
        .prepare("SELECT id, team_id, name, host, ssh_user, created_at FROM vps_targets WHERE id = ?")
        .bind(&[v_text(&id)])?
        .first(None)
        .await?;
    row.ok_or_else(|| anyhow!("vps insert failed"))
}

pub async fn list_vps(db: &Db, team_id: &str, user_id: &str) -> Result<Vec<VpsRow>> {
    require_member(db, team_id, user_id).await?;
    db.prepare("SELECT id, team_id, name, host, ssh_user, created_at FROM vps_targets WHERE team_id = ? ORDER BY created_at DESC LIMIT 50")
        .bind(&[v_text(team_id)])?
        .all()
        .await?
        .results()
}

pub async fn get_vps_secret(db: &Db, team_id: &str, user_id: &str, vps_id: &str) -> Result<(VpsRow, String)> {
    require_manager(db, team_id, user_id).await?;
    #[derive(serde::Deserialize)]
    struct Key { ssh_key: String }
    let meta: Option<VpsRow> = db
        .prepare("SELECT id, team_id, name, host, ssh_user, created_at FROM vps_targets WHERE id = ? AND team_id = ?")
        .bind(&[v_text(vps_id), v_text(team_id)])?
        .first(None)
        .await?;
    let meta = meta.ok_or_else(|| anyhow!("VPS target not found."))?;
    let key: Option<Key> = db
        .prepare("SELECT ssh_key FROM vps_targets WHERE id = ?")
        .bind(&[v_text(vps_id)])?
        .first(None)
        .await?;
    Ok((meta, key.map(|k| k.ssh_key).unwrap_or_default()))
}

#[derive(Deserialize, Serialize, Clone)]
pub struct DeployRow {
    pub id: String,
    pub project_id: String,
    pub vps_target_id: String,
    pub commit_sha: String,
    pub status: String,
    pub log: String,
    pub created_at: String,
}

pub async fn create_deployment(db: &Db, project_id: &str, vps_target_id: &str, commit_sha: &str) -> Result<DeployRow> {
    let id = new_id();
    db.prepare("INSERT INTO deployments (id, project_id, vps_target_id, commit_sha, status) VALUES (?, ?, ?, ?, 'pending')")
        .bind(&[v_text(&id), v_text(project_id), v_text(vps_target_id), v_text(commit_sha)])?
        .run()
        .await?;
    let row: Option<DeployRow> = db
        .prepare("SELECT id, project_id, vps_target_id, commit_sha, status, log, created_at FROM deployments WHERE id = ?")
        .bind(&[v_text(&id)])?
        .first(None)
        .await?;
    row.ok_or_else(|| anyhow!("deployment insert failed"))
}

pub async fn set_deployment(db: &Db, id: &str, status: &str, log: &str) -> Result<()> {
    let log: String = log.chars().take(20000).collect();
    db.prepare("UPDATE deployments SET status = ?, log = ? WHERE id = ?")
        .bind(&[v_text(status), v_text(&log), v_text(id)])?
        .run()
        .await?;
    Ok(())
}

pub async fn list_deployments(db: &Db, user_id: &str, project_id: &str) -> Result<Vec<DeployRow>> {
    let p = get_project(db, user_id, project_id).await?.ok_or_else(|| anyhow!("Project not found."))?;
    let _ = p;
    db.prepare("SELECT id, project_id, vps_target_id, commit_sha, status, log, created_at FROM deployments WHERE project_id = ? ORDER BY rowid DESC LIMIT 20")
        .bind(&[v_text(project_id)])?
        .all()
        .await?
        .results()
}
