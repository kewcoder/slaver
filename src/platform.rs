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
    crate::util::new_id()
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
    pub prod_url: String,
    pub dev_url: String,
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
    db.prepare("SELECT id, team_id, repo_id, name, description, status, prod_url, dev_url, created_at FROM projects WHERE team_id = ? ORDER BY created_at DESC LIMIT 100")
        .bind(&[v_text(team_id)])?
        .all()
        .await?
        .results()
}

pub async fn get_project(db: &Db, user_id: &str, project_id: &str) -> Result<Option<ProjectRow>> {
    let row: Option<ProjectRow> = db
        .prepare("SELECT id, team_id, repo_id, name, description, status, prod_url, dev_url, created_at FROM projects WHERE id = ?")
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
    pub price_cents: i64,
    pub template: i64,
    pub fork_of: String,
    #[serde(default)]
    pub category: String,
    pub created_at: String,
}

/// Edit a listing's storefront fields. Owner/admin of the owning team only.
pub async fn update_repo(db: &Db, user_id: &str, repo_id: &str, name: Option<&str>, description: Option<&str>, price_cents: Option<i64>, category: Option<&str>) -> Result<RepoRow> {
    let r = get_repo(db, user_id, repo_id).await?.ok_or_else(|| anyhow!("Repo not found."))?;
    require_manager(db, &r.team_id, user_id).await?;
    let name: String = name.map(|n| n.trim().chars().take(80).collect()).filter(|n: &String| !n.is_empty()).unwrap_or(r.name);
    let description: String = description.map(|d| d.trim().chars().take(2000).collect()).unwrap_or(r.description);
    let price = price_cents.map(|p| p.clamp(0, 10_000_000)).unwrap_or(r.price_cents);
    let category: String = category.map(|c| c.trim().chars().take(40).collect()).unwrap_or(r.category);
    db.prepare("UPDATE repos SET name = ?, description = ?, price_cents = ?, category = ? WHERE id = ?")
        .bind(&[v_text(&name), v_text(&description), v_int(price), v_text(&category), v_text(repo_id)])?
        .run()
        .await?;
    get_repo(db, user_id, repo_id).await?.ok_or_else(|| anyhow!("Repo not found."))
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
            .prepare("SELECT id, team_id, name, description, price_cents, template, fork_of, category, created_at FROM repos WHERE template = 1 ORDER BY created_at DESC LIMIT 100")
            .bind(&[])?
            .all()
            .await?
            .results();
    }
    require_member(db, team_id, user_id).await?;
    db.prepare("SELECT id, team_id, name, description, price_cents, template, fork_of, category, created_at FROM repos WHERE team_id = ? ORDER BY created_at DESC LIMIT 100")
        .bind(&[v_text(team_id)])?
        .all()
        .await?
        .results()
}

pub async fn get_repo(db: &Db, user_id: &str, repo_id: &str) -> Result<Option<RepoRow>> {
    let row: Option<RepoRow> = db
        .prepare("SELECT id, team_id, name, description, price_cents, template, fork_of, category, created_at FROM repos WHERE id = ?")
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

/// Delete a team repo and its on-disk bare clone. Owner/admin of the owning
/// team only. Refuses templates and repos still backing active licenses or
/// attached projects (unpublish / detach first).
pub async fn delete_repo(db: &Db, user_id: &str, repo_id: &str, git_root: &str) -> Result<bool, String> {
    let repo = get_repo(db, user_id, repo_id).await.map_err(|e| e.to_string())?;
    let repo = match repo {
        Some(r) => r,
        None => return Ok(false),
    };
    if repo.team_id.is_empty() {
        return Err("Legacy repos cannot be deleted this way.".to_string());
    }
    match crate::store::membership(db, &repo.team_id, user_id).await.map_err(|e| e.to_string())? {
        Some(r) if r == "owner" || r == "admin" => {}
        _ => return Ok(false),
    }
    if repo.template != 0 {
        return Err("Unpublish a template before deleting it.".to_string());
    }
    let licensed: Option<LicenseRow> = db
        .prepare("SELECT id, team_id, repo_id, kind, support_until, status, provider, amount_cents, created_at FROM licenses WHERE repo_id = ? AND status = 'active' LIMIT 1")
        .bind(&[v_text(repo_id)])
        .map_err(|e| e.to_string())?
        .first(None)
        .await
        .map_err(|e| e.to_string())?;
    if licensed.is_some() {
        return Err("An active license references this repo — it cannot be deleted.".to_string());
    }
    // Detach projects that point at it, then remove DB rows + bare repo.
    db.prepare("UPDATE projects SET repo_id = '' WHERE repo_id = ?")
        .bind(&[v_text(repo_id)])
        .map_err(|e| e.to_string())?
        .run()
        .await
        .map_err(|e| e.to_string())?;
    // Runs that cloned it keep their history rows; only the repo row goes.
    db.prepare("DELETE FROM repos WHERE id = ?")
        .bind(&[v_text(repo_id)])
        .map_err(|e| e.to_string())?
        .run()
        .await
        .map_err(|e| e.to_string())?;
    let path = bare_repo_path(git_root, repo_id);
    if path.exists() {
        tokio::fs::remove_dir_all(&path).await.map_err(|e| e.to_string())?;
    }
    Ok(true)
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
pub struct PaymentRow {
    pub id: String,
    pub team_id: String,
    pub repo_id: String,
    pub hitpay_request_id: String,
    pub amount_cents: i64,
    pub currency: String,
    pub status: String,
    pub license_id: String,
    pub reference: String,
    pub fork_repo_id: String,
    pub project_id: String,
    pub created_by: String,
    pub provider: String,
    pub created_at: String,
    pub paid_at: String,
}
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

pub async fn repo_price_cents(db: &Db, repo_id: &str) -> Result<i64> {
    #[derive(serde::Deserialize)]
    struct R {
        price_cents: i64,
    }
    let row: Option<R> = db
        .prepare("SELECT price_cents FROM repos WHERE id = ?")
        .bind(&[v_text(repo_id)])?
        .first(None)
        .await?;
    Ok(row.map(|r| r.price_cents).unwrap_or(4900).max(0))
}

pub async fn create_payment(
    db: &Db,
    team_id: &str,
    user_id: &str,
    repo_id: &str,
    amount_cents: i64,
    currency: &str,
    reference: &str,
    hitpay_request_id: &str,
) -> Result<PaymentRow> {
    require_manager(db, team_id, user_id).await?;
    let id = new_id();
    db.prepare("INSERT INTO payments (id, team_id, repo_id, hitpay_request_id, reference, amount_cents, currency, status, provider, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'hitpay', ?)")
        .bind(&[v_text(&id), v_text(team_id), v_text(repo_id), v_text(hitpay_request_id), v_text(reference), v_int(amount_cents), v_text(currency), v_text(user_id)])?
        .run()
        .await?;
    get_payment(db, &id).await?.ok_or_else(|| anyhow!("payment insert failed"))
}

pub async fn find_payment_by_reference(db: &Db, reference: &str) -> Result<Option<PaymentRow>> {
    if reference.trim().is_empty() {
        return Ok(None);
    }
    get_payment_by(db, "reference", reference).await
}

async fn get_payment_by(db: &Db, col: &str, val: &str) -> Result<Option<PaymentRow>> {
    let allowed = ["hitpay_request_id", "reference", "id"];
    if !allowed.contains(&col) {
        return Err(anyhow!("bad lookup column"));
    }
    let sql = format!("SELECT id, team_id, repo_id, hitpay_request_id, reference, amount_cents, currency, status, license_id, fork_repo_id, project_id, created_by, provider, created_at, paid_at FROM payments WHERE {} = ? ORDER BY rowid DESC LIMIT 1", col);
    db.prepare(&sql)
        .bind(&[v_text(val)])?
        .first(None)
        .await
        .map_err(|e| anyhow!("{e}"))
}

pub async fn get_payment(db: &Db, id: &str) -> Result<Option<PaymentRow>> {
    db.prepare("SELECT id, team_id, repo_id, hitpay_request_id, reference, amount_cents, currency, status, license_id, fork_repo_id, project_id, created_by, provider, created_at, paid_at FROM payments WHERE id = ?")
        .bind(&[v_text(id)])?
        .first(None)
        .await
        .map_err(|e| anyhow!("{e}"))
}

pub async fn find_payment_by_hitpay(db: &Db, hitpay_request_id: &str) -> Result<Option<PaymentRow>> {
    if hitpay_request_id.trim().is_empty() {
        return Ok(None);
    }
    db.prepare("SELECT id, team_id, repo_id, hitpay_request_id, reference, amount_cents, currency, status, license_id, fork_repo_id, project_id, created_by, provider, created_at, paid_at FROM payments WHERE hitpay_request_id = ? ORDER BY rowid DESC LIMIT 1")
        .bind(&[v_text(hitpay_request_id)])?
        .first(None)
        .await
        .map_err(|e| anyhow!("{e}"))
}

pub async fn mark_payment_paid(db: &Db, payment_id: &str, license_id: &str, fork_repo_id: &str, project_id: &str) -> Result<()> {
    db.prepare("UPDATE payments SET status = 'paid', license_id = ?, fork_repo_id = ?, project_id = ?, paid_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status <> 'paid'")
        .bind(&[v_text(license_id), v_text(fork_repo_id), v_text(project_id), v_text(payment_id)])?
        .run()
        .await?;
    Ok(())
}

pub async fn mark_payment_failed(db: &Db, payment_id: &str) -> Result<()> {
    db.prepare("UPDATE payments SET status = 'failed' WHERE id = ? AND status = 'pending'")
        .bind(&[v_text(payment_id)])?
        .run()
        .await?;
    Ok(())
}


/// Find (or, for the owning team, create) the public support group linked
/// to a repo. Anyone can read/post; only the owning team's bots reply.
pub async fn dm_history_checked(db: &Db, team_id: &str, me: &str, peer_id: &str) -> Result<Vec<crate::store::DirectMessageRow>> {
    require_member(db, team_id, me).await?;
    require_member(db, team_id, peer_id).await.map_err(|_| anyhow!("That user is not on this team."))?;
    crate::store::dm_history(db, team_id, me, peer_id, 100).await
}

pub async fn dm_send_checked(db: &Db, team_id: &str, from_id: &str, to_id: &str, content: &str) -> Result<crate::store::DirectMessageRow> {
    require_member(db, team_id, from_id).await?;
    require_member(db, team_id, to_id).await.map_err(|_| anyhow!("That user is not on this team."))?;
    crate::store::dm_send(db, team_id, from_id, to_id, content).await
}

pub async fn set_project_urls(db: &Db, user_id: &str, project_id: &str, prod_url: Option<&str>, dev_url: Option<&str>) -> Result<ProjectRow> {
    let p = get_project(db, user_id, project_id).await?.ok_or_else(|| anyhow!("Project not found."))?;
    require_manager(db, &p.team_id, user_id).await?;
    if let Some(u) = prod_url {
        let u = u.trim().chars().take(300).collect::<String>();
        if !u.is_empty() && !(u.starts_with("https://") || u.starts_with("http://")) {
            return Err(anyhow!("Production URL must start with http(s)://"));
        }
        db.prepare("UPDATE projects SET prod_url = ? WHERE id = ?").bind(&[v_text(&u), v_text(&p.id)])?.run().await?;
    }
    if let Some(u) = dev_url {
        let u = u.trim().chars().take(300).collect::<String>();
        if !u.is_empty() && !(u.starts_with("https://") || u.starts_with("http://")) {
            return Err(anyhow!("Dev URL must start with http(s)://"));
        }
        let _ = db.prepare("UPDATE projects SET dev_url = ? WHERE id = ?").bind(&[v_text(&u), v_text(&p.id)])?.run().await;
    }
    get_project(db, user_id, project_id).await?.ok_or_else(|| anyhow!("Project not found."))
}

pub async fn support_group_for_repo(db: &Db, user_id: &str, repo_id: &str) -> Result<Option<store::GroupRow>, String> {
    let repo = get_repo(db, user_id, repo_id).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "Repo not found.".to_string())?;
    let existing: Option<store::GroupRow> = db
        .prepare("SELECT id, team_id, name, is_public, repo_id, project_id, created_at, updated_at FROM groups WHERE repo_id = ? AND is_public <> 0 LIMIT 1")
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

/// Core license insert shared by mock + paid checkouts. Creates the license
/// row only (no fork/project — the caller composes those).
pub async fn buy_license_inner(
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

/// Full buy-once bundle: license + fork + project. Shared by the mock
/// checkout and the paid (HitPay) activation path.
pub async fn buy_bundle(
    db: &Db,
    git_root: &str,
    team_id: &str,
    user_id: &str,
    template_repo_id: &str,
    provider: &str,
    amount_cents: i64,
) -> Result<(LicenseRow, RepoRow, ProjectRow)> {
    let lic = buy_license_inner(db, team_id, user_id, template_repo_id, provider, amount_cents, 12).await?;
    let fork = fork_repo(db, user_id, team_id, template_repo_id, git_root).await?;
    let tpl_name = get_repo(db, user_id, template_repo_id)
        .await?
        .map(|r| r.name)
        .unwrap_or_else(|| "app".to_string());
    let project = create_project(db, team_id, user_id, &format!("{tpl_name} (custom)"), "Forked from marketplace template.").await?;
    let project = set_project_repo(db, user_id, &project.id, &fork.id).await?;
    Ok((lic, fork, project))
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

 // ---------- team Fly.io accounts & machines ----------

#[derive(Deserialize, Serialize, Clone)]
pub struct FlyAccountRow {
    pub id: String,
    pub team_id: String,
    pub name: String,
    pub org: String,
    pub has_token: bool,
    pub created_at: String,
}

pub async fn fly_connect(db: &Db, team_id: &str, user_id: &str, name: &str, org: &str, token: &str) -> Result<FlyAccountRow> {
    require_manager(db, team_id, user_id).await?;
    if token.trim().len() < 8 {
        return Err(anyhow!("That Fly API token looks empty."));
    }
    // Validate before storing: must be able to list apps.
    crate::fly::list_apps(token.trim()).await.map_err(|e| anyhow!("Fly rejected the token: {e}"))?;
    let name = { let n = name.trim().chars().take(60).collect::<String>(); if n.is_empty() { "fly".to_string() } else { n } };
    let id = new_id();
    db.prepare("INSERT INTO fly_accounts (id, team_id, name, org, api_token) VALUES (?, ?, ?, ?, ?)")
        .bind(&[v_text(&id), v_text(team_id), v_text(&name), v_text(org.trim()), v_text(token.trim())])?
        .run()
        .await?;
    Ok(FlyAccountRow { id, team_id: team_id.to_string(), name, org: org.trim().to_string(), has_token: true, created_at: String::new() })
}

pub async fn fly_list(db: &Db, team_id: &str, user_id: &str) -> Result<Vec<FlyAccountRow>> {
    #[derive(serde::Deserialize)]
    struct R { id: String, team_id: String, name: String, org: String, has_token: i64, created_at: String }
    require_member(db, team_id, user_id).await?;
    let rows: Vec<R> = db
        .prepare("SELECT id, team_id, name, org, (length(api_token) > 0) AS has_token, created_at FROM fly_accounts WHERE team_id = ? ORDER BY created_at DESC LIMIT 20")
        .bind(&[v_text(team_id)])?
        .all()
        .await?
        .results()?;
    Ok(rows.into_iter().map(|r| FlyAccountRow { id: r.id, team_id: r.team_id, name: r.name, org: r.org, has_token: r.has_token != 0, created_at: r.created_at }).collect())
}

pub async fn fly_get(db: &Db, team_id: &str, user_id: &str, account_id: &str) -> Result<Option<(FlyAccountRow, String)>> {
    #[derive(serde::Deserialize)]
    struct R { id: String, team_id: String, name: String, org: String, api_token: String, created_at: String }
    require_member(db, team_id, user_id).await?;
    let row: Option<R> = db
        .prepare("SELECT id, team_id, name, org, api_token, created_at FROM fly_accounts WHERE id = ? AND team_id = ?")
        .bind(&[v_text(account_id), v_text(team_id)])?
        .first(None)
        .await?;
    Ok(row.map(|r| (FlyAccountRow { id: r.id, team_id: r.team_id, name: r.name, org: r.org, has_token: !r.api_token.is_empty(), created_at: r.created_at }, r.api_token)))
}

pub async fn fly_disconnect(db: &Db, team_id: &str, user_id: &str, account_id: &str) -> Result<()> {
    require_manager(db, team_id, user_id).await?;
    db.prepare("DELETE FROM fly_accounts WHERE id = ? AND team_id = ?")
        .bind(&[v_text(account_id), v_text(team_id)])?
        .run()
        .await?;
    Ok(())
}

#[derive(Deserialize, Serialize, Clone)]
pub struct FlyMachineRow {
    pub id: String,
    pub team_id: String,
    pub role: String,
    pub app_name: String,
    pub machine_id: String,
    pub image: String,
    pub cpus: i64,
    pub memory_mb: i64,
    pub status: String,
    pub created_at: String,
}

pub async fn fly_machines(db: &Db, team_id: &str, user_id: &str) -> Result<Vec<FlyMachineRow>> {
    require_member(db, team_id, user_id).await?;
    db.prepare("SELECT id, team_id, role, app_name, machine_id, image, cpus, memory_mb, status, created_at FROM fly_machines WHERE team_id = ? ORDER BY role, created_at DESC LIMIT 20")
        .bind(&[v_text(team_id)])?
        .all()
        .await?
        .results()
}

pub async fn fly_machine_for_role(db: &Db, team_id: &str, role: &str) -> Result<Option<(FlyMachineRow, String)>> {
    #[derive(serde::Deserialize)]
    struct R { token: String }
    let m: Option<FlyMachineRow> = db
        .prepare("SELECT id, team_id, role, app_name, machine_id, image, cpus, memory_mb, status, created_at FROM fly_machines WHERE team_id = ? AND role = ? ORDER BY rowid DESC LIMIT 1")
        .bind(&[v_text(team_id), v_text(role)])?
        .first(None)
        .await?;
    let m = match m { Some(x) => x, None => return Ok(None) };
    // Token lives on the team's first Fly account (single account per team for now).
    let t: Option<R> = db
        .prepare("SELECT api_token AS token FROM fly_accounts WHERE team_id = ? ORDER BY rowid ASC LIMIT 1")
        .bind(&[v_text(team_id)])?
        .first(None)
        .await?;
    Ok(t.map(|t| (m, t.token)))
}

pub async fn fly_register_machine(
    db: &Db,
    team_id: &str,
    role: &str,
    app_name: &str,
    machine_id: &str,
    image: &str,
    cpus: i64,
    memory_mb: i64,
    status: &str,
) -> Result<FlyMachineRow> {
    require_manager_any(db, team_id).await?;
    let id = new_id();
    db.prepare("INSERT INTO fly_machines (id, team_id, role, app_name, machine_id, image, cpus, memory_mb, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&[v_text(&id), v_text(team_id), v_text(role), v_text(app_name), v_text(machine_id), v_text(image), v_int(cpus), v_int(memory_mb), v_text(status)])?
        .run()
        .await?;
    Ok(FlyMachineRow { id, team_id: team_id.to_string(), role: role.to_string(), app_name: app_name.to_string(), machine_id: machine_id.to_string(), image: image.to_string(), cpus, memory_mb, status: status.to_string(), created_at: String::new() })
}

async fn require_manager_any(_db: &Db, _team_id: &str) -> Result<()> {
    // Internal helper: callers already checked membership/role.
    Ok(())
}

pub async fn fly_forget_machine(db: &Db, team_id: &str, user_id: &str, id: &str) -> Result<()> {
    require_manager(db, team_id, user_id).await?;
    db.prepare("DELETE FROM fly_machines WHERE id = ? AND team_id = ?")
        .bind(&[v_text(id), v_text(team_id)])?
        .run()
        .await?;
    Ok(())
}

// ---------- custom domains (plain DNS, pointed at Fly) ----------

/// Base domain for team subdomains, e.g. `app-xyz.slaver.app`.
/// DNS records are created manually (no provider integration by design).
fn zone_name() -> String {
    let z = std::env::var("SLAVER_DOMAIN").unwrap_or_default();
    let z = z.trim().trim_start_matches('.').to_string();
    if z.is_empty() {
        "slaver.app".to_string()
    } else {
        z
    }
}

#[derive(Deserialize, Serialize, Clone)]
pub struct DomainRow {
    pub id: String,
    pub team_id: String,
    pub project_id: String,
    pub subdomain: String,
    pub hostname: String,
    pub target: String,
    pub kind: String,
    pub status: String,
    pub created_at: String,
}

pub async fn domain_add(db: &Db, team_id: &str, user_id: &str, project_id: &str, subdomain: &str, target: &str, kind: &str) -> Result<DomainRow> {
    require_manager(db, team_id, user_id).await?;
    if !project_id.is_empty() {
        get_project(db, user_id, project_id).await?.ok_or_else(|| anyhow!("Project not found."))?;
    }
    let kind = kind.trim().to_uppercase();
    if kind != "CNAME" && kind != "A" {
        return Err(anyhow!("kind must be CNAME or A."));
    }
    let sub = subdomain.trim().to_lowercase().replace(|c: char| !(c.is_ascii_alphanumeric() || c == '-'), "");
    if sub.is_empty() || sub.len() > 63 {
        return Err(anyhow!("Bad subdomain (letters, numbers, dashes)."));
    }
    if target.trim().is_empty() {
        return Err(anyhow!("Target is required (Fly hostname or IP)."));
    }
    let id = new_id();
    let hostname = format!("{sub}.{}", zone_name());
    // Always manual: point the record at the target yourself (A/AAAA to the
    // Fly IPs, or CNAME to the Fly hostname). No DNS provider integration.
    let status = "manual".to_string();
    db.prepare("INSERT INTO custom_domains (id, team_id, project_id, subdomain, hostname, target, kind, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&[v_text(&id), v_text(team_id), v_text(project_id), v_text(&sub), v_text(&hostname), v_text(target.trim()), v_text(&kind), v_text(&status)])?
        .run()
        .await?;
    Ok(DomainRow { id, team_id: team_id.to_string(), project_id: project_id.to_string(), subdomain: sub, hostname, target: target.trim().to_string(), kind, status, created_at: String::new() })
}

pub async fn domain_list(db: &Db, team_id: &str, user_id: &str) -> Result<Vec<DomainRow>> {
    require_member(db, team_id, user_id).await?;
    db.prepare("SELECT id, team_id, project_id, subdomain, hostname, target, kind, status, created_at FROM custom_domains WHERE team_id = ? ORDER BY created_at DESC LIMIT 100")
        .bind(&[v_text(team_id)])?
        .all()
        .await?
        .results()
}

pub async fn domain_remove(db: &Db, team_id: &str, user_id: &str, id: &str) -> Result<()> {
    require_manager(db, team_id, user_id).await?;
    db.prepare("DELETE FROM custom_domains WHERE id = ? AND team_id = ?")
        .bind(&[v_text(id), v_text(team_id)])?
        .run()
        .await?;
    Ok(())
}

/// Add a user to a channel: the actor must see the channel; the target must
/// be on the same team (public channels additionally allow self-join so any
/// logged-in user can join a support channel).
pub async fn group_add_user(db: &Db, git_root_note: &str, group_id: &str, actor_id: &str, target_id: &str) -> Result<bool> {
    let _ = git_root_note;
    let g = crate::store::get_group(db, actor_id, group_id).await?.ok_or_else(|| anyhow!("Channel not found."))?;
    let target_is_self = target_id == actor_id;
    if g.team_id.is_empty() {
        return Ok(false);
    }
    if g.is_public != 0 {
        if !target_is_self {
            // Adding others still requires team membership.
            require_member(db, &g.team_id, actor_id).await?;
        }
        require_member(db, &g.team_id, target_id).await.map_err(|_| anyhow!("That user is not on this team."))?;
    } else {
        require_member(db, &g.team_id, actor_id).await?;
        require_member(db, &g.team_id, target_id).await.map_err(|_| anyhow!("That user is not on this team."))?;
    }
    crate::store::add_group_user(db, group_id, target_id).await?;
    Ok(true)
}

pub async fn group_remove_user(db: &Db, group_id: &str, actor_id: &str, target_id: &str) -> Result<bool> {
    let g = crate::store::get_group(db, actor_id, group_id).await?.ok_or_else(|| anyhow!("Channel not found."))?;
    if g.team_id.is_empty() {
        return Ok(false);
    }
    let self_remove = target_id == actor_id;
    if !self_remove {
        match crate::store::membership(db, &g.team_id, actor_id).await? {
            Some(r) if r == "owner" || r == "admin" => {}
            _ => return Ok(false),
        }
    }
    crate::store::remove_group_user(db, group_id, target_id).await?;
    Ok(true)
}

/// Attach (or detach with "") a kanban project to a channel. The board then
/// lives inside the channel, auto-filtered to that project. Owner/admin only;
/// the project must belong to the channel's team.
pub async fn set_group_project(db: &Db, group_id: &str, actor_id: &str, project_id: &str) -> Result<crate::store::GroupRow> {
    let g = crate::store::get_group(db, actor_id, group_id).await?.ok_or_else(|| anyhow!("Channel not found."))?;
    if g.team_id.is_empty() {
        return Err(anyhow!("Legacy channels cannot own a board."));
    }
    require_manager(db, &g.team_id, actor_id).await?;
    let project_id = project_id.trim();
    if !project_id.is_empty() {
        let p = get_project(db, actor_id, project_id).await?.ok_or_else(|| anyhow!("Project not found."))?;
        if p.team_id != g.team_id {
            return Err(anyhow!("That project is on a different team."));
        }
    }
    db.prepare("UPDATE groups SET project_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .bind(&[v_text(project_id), v_text(group_id)])?
        .run()
        .await?;
    crate::store::get_group(db, actor_id, group_id).await?.ok_or_else(|| anyhow!("Channel not found."))
}

/// Provision 1 PROD + 1 DEV machine on the team's Fly account.
pub async fn fly_provision_team(
    db: &Db,
    team_id: &str,
    user_id: &str,
    account_id: &str,
    slug: &str,
    prod_image: Option<&str>,
    dev_image: Option<&str>,
    dev_cpus: i64,
    dev_memory_mb: i64,
) -> Result<serde_json::Value, anyhow::Error> {
    require_manager(db, team_id, user_id).await?;
    let (acct, token) = fly_get_account(db, team_id, user_id, account_id).await?.ok_or_else(|| anyhow!("Fly account not found."))?;
    let org = if acct.org.trim().is_empty() { None } else { Some(acct.org.clone()) };
    let base: String = slug.trim().to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    if base.is_empty() || base.len() > 40 {
        return Err(anyhow!("Pick a short slug: letters, numbers, dashes."));
    }
    let org_ref = org.as_deref().unwrap_or("");
    // Ensure both apps exist.
    for app in [format!("{base}-prod"), format!("{base}-dev")] {
        if !org_ref.is_empty() {
            crate::fly::ensure_app(&token, &app, org_ref).await?;
        } else {
            // No org pinned: still try plain create (Fly uses default org).
            crate::fly::ensure_app_no_org(&token, &app).await?;
        }
    }
    let prod_app = format!("{base}-prod");
    let dev_app = format!("{base}-dev");
    let prod_image = prod_image.unwrap_or("caddy:2-alpine").trim();
    let prod_image = if prod_image.is_empty() { "caddy:2-alpine" } else { prod_image };
    let dev_image = dev_image.unwrap_or("debian:bookworm-slim").trim();
    let dev_image = if dev_image.is_empty() { "debian:bookworm-slim" } else { dev_image };
    let dev_cpus = if dev_cpus <= 0 { 2 } else { dev_cpus.min(8) };
    let dev_mem = if dev_memory_mb <= 0 { 2048 } else { dev_memory_mb.min(32768) };
    // Remove previous machines with same role (idempotent re-provision).
    for (role, app) in [("prod", &prod_app), ("dev", &dev_app)] {
        if let Ok(Some((old, _))) = fly_machine_for_role(db, team_id, role).await {
            let _ = crate::fly::destroy_machine(&token, app, &old.machine_id).await;
            let _ = fly_forget_machine(db, team_id, user_id, &old.id).await;
        }
    }
    let (prod_mid, prod_state) = crate::fly::create_machine(
        &token,
        &prod_app,
        &crate::fly::MachineSpec {
            image: prod_image.to_string(),
            cpus: 1,
            memory_mb: 512,
            env: vec![],
            with_proxy_port: Some(80),
            entrypoint: None,
        },
    )
    .await?;
    let (dev_mid, dev_state) = crate::fly::create_machine(
        &token,
        &dev_app,
        &crate::fly::MachineSpec {
            image: dev_image.to_string(),
            cpus: dev_cpus,
            memory_mb: dev_mem,
            env: vec![],
            with_proxy_port: None,
            entrypoint: Some(vec!["sleep".to_string(), "infinity".to_string()]),
        },
    )
    .await?;
    let prod_row = fly_register_machine(db, team_id, "prod", &prod_app, &prod_mid, prod_image, 1, 512, &prod_state).await?;
    let dev_row = fly_register_machine(db, team_id, "dev", &dev_app, &dev_mid, dev_image, dev_cpus, dev_mem, &dev_state).await?;
    Ok(serde_json::json!({ "prod": prod_row, "dev": dev_row }))
}

async fn fly_get_account(db: &Db, team_id: &str, user_id: &str, account_id: &str) -> Result<Option<(FlyAccountRow, String)>> {
    fly_account_checked(db, team_id, user_id, account_id).await
}

async fn fly_account_checked(db: &Db, team_id: &str, user_id: &str, account_id: &str) -> Result<Option<(FlyAccountRow, String)>> {
    // Caller already checked manager role; re-check membership for audit symmetry.
    require_member(db, team_id, user_id).await?;
    #[derive(serde::Deserialize)]
    struct R { id: String, team_id: String, name: String, org: String, api_token: String, created_at: String }
    let row: Option<R> = db
        .prepare("SELECT id, team_id, name, org, api_token, created_at FROM fly_accounts WHERE id = ? AND team_id = ?")
        .bind(&[v_text(account_id), v_text(team_id)])?
        .first(None)
        .await?;
    Ok(row.map(|r| (FlyAccountRow { id: r.id, team_id: r.team_id, name: r.name, org: r.org, has_token: !r.api_token.is_empty(), created_at: r.created_at }, r.api_token)))
}

pub async fn fly_destroy_machine(db: &Db, state_note: &str, team_id: &str, user_id: &str, id: &str, delete_app: bool) -> Result<serde_json::Value> {
    let _ = state_note;
    require_manager(db, team_id, user_id).await?;
    let m: Option<FlyMachineRow> = db
        .prepare("SELECT id, team_id, role, app_name, machine_id, image, cpus, memory_mb, status, created_at FROM fly_machines WHERE id = ? AND team_id = ?")
        .bind(&[v_text(id), v_text(team_id)])?
        .first(None)
        .await?;
    let m = m.ok_or_else(|| anyhow!("Machine not found."))?;
    let token: Option<String> = db
        .prepare("SELECT api_token FROM fly_accounts WHERE team_id = ? ORDER BY rowid ASC LIMIT 1")
        .bind(&[v_text(team_id)])?
        .first::<FlyTokenRow>(None)
        .await?
        .map(|r| r.api_token);
    if let Some(t) = token {
        let _ = crate::fly::destroy_machine(&t, &m.app_name, &m.machine_id).await;
        if delete_app {
            let _ = crate::fly::delete_app(&t, &m.app_name).await;
        }
    }
    fly_forget_machine(db, team_id, user_id, &m.id).await?;
    Ok(serde_json::json!({ "destroyed": m.id, "app": m.app_name }))
}

#[derive(serde::Deserialize)]
struct FlyTokenRow {
    api_token: String,
}
