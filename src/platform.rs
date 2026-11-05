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

/// Remove an installed app: the project, everything hanging off it
/// (customize runs, installs, local-run state, payments), its team-owned
/// source-code fork (DB row + bare git repo + reviews), and the team's active
/// license for the fork's template (so the app can be bought again later).
/// Also stops a locally running copy and wipes its staging/run workdirs.
/// Owner/admin of the owning team only. Templates are never deleted: when the
/// project points at a template (or at another team's repo) only the project
/// rows go. Returns false when the project does not exist or is not visible.
pub async fn delete_project(db: &Db, user_id: &str, project_id: &str, git_root: &str, workspace_root: &str) -> Result<bool, String> {
    let p = get_project(db, user_id, project_id).await.map_err(|e| e.to_string())?;
    let p = match p {
        Some(p) => p,
        None => return Ok(false),
    };
    require_manager(db, &p.team_id, user_id).await.map_err(|e| e.to_string())?;
    // Stop a locally running copy (best effort; nothing running is fine).
    crate::localapp::kill(&format!("run:{}", p.id)).await;
    for child in [
        "customize_changes WHERE project_id",
        "installs WHERE project_id",
        "local_runs WHERE project_id",
        "payments WHERE project_id",
    ] {
        db.prepare(&format!("DELETE FROM {child} = ?"))
            .bind(&[v_text(&p.id)])
            .map_err(|e| e.to_string())?
            .run()
            .await
            .map_err(|e| e.to_string())?;
    }
    // The attached source fork goes too (unless it is a template or belongs
    // to another team — then only the project rows go).
    if !p.repo_id.is_empty() {
        let fork: Option<RepoRow> = db
            .prepare("SELECT id, team_id, name, description, price_cents, template, fork_of, category, created_at FROM repos WHERE id = ?")
            .bind(&[v_text(&p.repo_id)])
            .map_err(|e| e.to_string())?
            .first(None)
            .await
            .map_err(|e| e.to_string())?;
        if let Some(f) = fork {
            if f.team_id == p.team_id && f.template == 0 {
                if !f.fork_of.is_empty() {
                    // Cancel the license for the template so the app can be
                    // bought (and forked) again later.
                    db.prepare("UPDATE licenses SET status = 'cancelled' WHERE team_id = ? AND repo_id = ? AND status = 'active'")
                        .bind(&[v_text(&p.team_id), v_text(&f.fork_of)])
                        .map_err(|e| e.to_string())?
                        .run()
                        .await
                        .map_err(|e| e.to_string())?;
                }
                db.prepare("DELETE FROM listing_reviews WHERE repo_id = ?")
                    .bind(&[v_text(&f.id)])
                    .map_err(|e| e.to_string())?
                    .run()
                    .await
                    .map_err(|e| e.to_string())?;
                db.prepare("DELETE FROM repos WHERE id = ?")
                    .bind(&[v_text(&f.id)])
                    .map_err(|e| e.to_string())?
                    .run()
                    .await
                    .map_err(|e| e.to_string())?;
                let path = bare_repo_path(git_root, &f.id);
                if path.exists() {
                    tokio::fs::remove_dir_all(&path).await.map_err(|e| e.to_string())?;
                }
            }
        }
    }
    db.prepare("DELETE FROM projects WHERE id = ?")
        .bind(&[v_text(&p.id)])
        .map_err(|e| e.to_string())?
        .run()
        .await
        .map_err(|e| e.to_string())?;
    // Staging + local-run workdirs (best effort).
    let root = std::path::PathBuf::from(workspace_root);
    for sub in ["staging", "staging-data", "run", "run-data"] {
        let dir = root.join(sub).join(&p.id);
        if dir.exists() {
            let _ = tokio::fs::remove_dir_all(&dir).await;
        }
    }
    Ok(true)
}

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
///
/// Pricing rule (matches the HitPay minimum): 0 = free (checkout skips
/// payment), otherwise at least 30 cents ($0.30). Anything in between would
/// fail at checkout with a HitPay 422, so reject it here at submit time.
pub const MIN_PAID_PRICE_CENTS: i64 = 30;
pub const MAX_PRICE_CENTS: i64 = 10_000_000;

pub async fn update_repo(db: &Db, user_id: &str, repo_id: &str, name: Option<&str>, description: Option<&str>, price_cents: Option<i64>, category: Option<&str>) -> Result<RepoRow> {
    let r = get_repo(db, user_id, repo_id).await?.ok_or_else(|| anyhow!("Repo not found."))?;
    require_manager(db, &r.team_id, user_id).await?;
    let name: String = name.map(|n| n.trim().chars().take(80).collect()).filter(|n: &String| !n.is_empty()).unwrap_or(r.name);
    let description: String = description.map(|d| d.trim().chars().take(2000).collect()).unwrap_or(r.description);
    let price = price_cents.map(|p| p.clamp(0, MAX_PRICE_CENTS)).unwrap_or(r.price_cents);
    if price > 0 && price < MIN_PAID_PRICE_CENTS {
        return Err(anyhow!("Paid apps must cost at least $0.30 (payment minimum) — set 0 for free."));
    }
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

/// Who may read a repo's SOURCE (clone, log, diff, fork). Metadata of a
/// published listing is public; the code is not. Allowed: members of the
/// owning team, or members of a team holding an active license for it.
pub async fn can_read_source(db: &Db, user_id: &str, repo: &RepoRow) -> Result<bool> {
    if store::membership(db, &repo.team_id, user_id).await?.is_some() {
        return Ok(true);
    }
    if repo.template == 0 {
        return Ok(false);
    }
    #[derive(Deserialize)]
    struct C {
        n: i64,
    }
    let c: Option<C> = db
        .prepare("SELECT COUNT(*) AS n FROM licenses l JOIN team_members m ON m.team_id = l.team_id WHERE l.repo_id = ? AND l.status = 'active' AND m.user_id = ?")
        .bind(&[v_text(&repo.id), v_text(user_id)])?
        .first(None)
        .await?;
    Ok(c.map(|c| c.n > 0).unwrap_or(false))
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
    crate::fly::list_apps(token.trim(), org).await.map_err(|e| anyhow!("Fly rejected the token: {e}"))?;
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

#[cfg(test)]
mod delete_project_tests {
    use super::*;
    use crate::db::Db;

    async fn count(db: &Db, sql: &str) -> i64 {
        #[derive(serde::Deserialize)]
        struct R {
            n: i64,
        }
        let row: Option<R> = db.prepare(sql).bind(&[]).unwrap().first(None).await.unwrap();
        row.map(|r| r.n).unwrap_or(-1)
    }

    #[tokio::test]
    async fn removes_project_fork_license_and_disk() {
        let base = std::env::temp_dir().join(format!("slaver-del-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let db = Db::open(base.join("t.db").to_str().unwrap()).unwrap();
        db.run_migrations(&format!("{}/migrations", env!("CARGO_MANIFEST_DIR"))).unwrap();
        let git_root = base.join("git").to_str().unwrap().to_string();
        let ws_root = base.join("ws").to_str().unwrap().to_string();

        // Owner + team.
        db.prepare("INSERT INTO users (id, email, name, password_salt, password_hash) VALUES ('u1', 'o@x.co', 'O', '', '')")
            .bind(&[]).unwrap().run().await.unwrap();
        let team = crate::store::create_team(&db, "u1", "T", false).await.unwrap();

        // Template with a bare repo, a bought fork, an active license and a project.
        db.prepare("INSERT INTO repos (id, team_id, name, template) VALUES ('tpl', ?, 'Tpl', 1)")
            .bind(&[v_text(&team.id)]).unwrap().run().await.unwrap();
        ensure_bare_repo(&git_root, "tpl").await.unwrap();
        db.prepare("INSERT INTO repos (id, team_id, name, fork_of) VALUES ('fork', ?, 'Tpl-fork', 'tpl')")
            .bind(&[v_text(&team.id)]).unwrap().run().await.unwrap();
        ensure_bare_repo(&git_root, "fork").await.unwrap();
        db.prepare("INSERT INTO licenses (id, team_id, repo_id, status) VALUES ('lic', ?, 'tpl', 'active')")
            .bind(&[v_text(&team.id)]).unwrap().run().await.unwrap();
        let project = create_project(&db, &team.id, "u1", "App", "").await.unwrap();
        set_project_repo(&db, "u1", &project.id, "fork").await.unwrap();
        db.prepare("INSERT INTO installs (id, team_id, project_id) VALUES ('n1', ?, ?)")
            .bind(&[v_text(&team.id), v_text(&project.id)]).unwrap().run().await.unwrap();
        std::fs::create_dir_all(format!("{ws_root}/staging/{}", project.id)).unwrap();

        assert!(delete_project(&db, "u1", &project.id, &git_root, &ws_root).await.unwrap());
        assert_eq!(count(&db, "SELECT COUNT(*) AS n FROM projects").await, 0);
        assert_eq!(count(&db, "SELECT COUNT(*) AS n FROM repos WHERE id = 'fork'").await, 0);
        assert!(!bare_repo_path(&git_root, "fork").exists());
        // Template survives; license is cancelled so the app can be re-bought.
        assert_eq!(count(&db, "SELECT COUNT(*) AS n FROM repos WHERE id = 'tpl'").await, 1);
        assert!(bare_repo_path(&git_root, "tpl").exists());
        let st: Option<LicenseRow> = db
            .prepare("SELECT id, team_id, repo_id, kind, support_until, status, provider, amount_cents, created_at FROM licenses WHERE id = 'lic'")
            .bind(&[]).unwrap().first(None).await.unwrap();
        assert_eq!(st.unwrap().status, "cancelled");
        assert_eq!(count(&db, "SELECT COUNT(*) AS n FROM installs").await, 0);
        assert!(!std::path::Path::new(&format!("{ws_root}/staging/{}", project.id)).exists());
        // Second call: already gone.
        assert!(!delete_project(&db, "u1", &project.id, &git_root, &ws_root).await.unwrap());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn non_manager_cannot_delete() {
        let base = std::env::temp_dir().join(format!("slaver-del-test-staff-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let db = Db::open(base.join("t.db").to_str().unwrap()).unwrap();
        db.run_migrations(&format!("{}/migrations", env!("CARGO_MANIFEST_DIR"))).unwrap();
        db.prepare("INSERT INTO users (id, email, name, password_salt, password_hash) VALUES ('u1', 'o@x.co', 'O', '', ''), ('u2', 's@x.co', 'S', '', '')")
            .bind(&[]).unwrap().run().await.unwrap();
        let team = crate::store::create_team(&db, "u1", "T", false).await.unwrap();
        db.prepare("INSERT INTO team_members (team_id, user_id, role) VALUES (?, 'u2', 'staff')")
            .bind(&[v_text(&team.id)]).unwrap().run().await.unwrap();
        let project = create_project(&db, &team.id, "u1", "App", "").await.unwrap();
        let r = delete_project(&db, "u2", &project.id, "/tmp", "/tmp").await;
        assert!(r.is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
}
