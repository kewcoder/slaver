//! GitHub connector (creator side) + upstream updates (buyer side).
//!
//! Creators connect GitHub (OAuth App when GITHUB_CLIENT_ID/SECRET are set,
//! or a fine-grained personal access token) and link one repo+branch to a
//! Slaver listing. Slaver mirrors that branch into its own bare repo — on
//! "Sync now" and every 10 minutes in the background. GitHub tokens never
//! leave the server and are passed to git via env config (not argv).
//!
//! Buyers are isolated: their copy is a separate bare repo. New creator
//! versions show up as "update available"; nothing changes until a team
//! owner/admin applies it (a git merge into their copy), then redeploys.

use anyhow::{anyhow, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

use crate::{
    db::{v_text, Db},
    platform, store, AppState,
};

const UA: &str = "slaver-github-connector";

fn client() -> reqwest::Client {
    reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build().expect("http client builds")
}

async fn require_member(db: &Db, team_id: &str, user_id: &str) -> Result<String> {
    store::membership(db, team_id, user_id).await?.ok_or_else(|| anyhow!("You are not on that team."))
}

async fn require_manager(db: &Db, team_id: &str, user_id: &str) -> Result<()> {
    match require_member(db, team_id, user_id).await?.as_str() {
        "owner" | "admin" => Ok(()),
        _ => Err(anyhow!("Only owners and admins can do that.")),
    }
}

fn oauth_config() -> Option<(String, String)> {
    let id = std::env::var("GITHUB_CLIENT_ID").ok().filter(|s| !s.trim().is_empty())?;
    let secret = std::env::var("GITHUB_CLIENT_SECRET").ok().filter(|s| !s.trim().is_empty())?;
    Some((id, secret))
}

pub fn oauth_available() -> bool {
    oauth_config().is_some()
}

// ---------- accounts ----------

#[derive(Deserialize, Serialize, Clone)]
pub struct GithubAccount {
    pub id: String,
    pub team_id: String,
    pub login: String,
    pub created_at: String,
}

async fn gh_get(token: &str, path: &str) -> Result<(u16, Value)> {
    let r = client()
        .get(format!("https://api.github.com{path}"))
        .bearer_auth(token)
        .header("User-Agent", UA)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await?;
    let s = r.status().as_u16();
    Ok((s, r.json().await.unwrap_or(Value::Null)))
}

async fn save_account(db: &Db, team_id: &str, token: &str) -> Result<GithubAccount> {
    let (status, v) = gh_get(token, "/user").await?;
    if status != 200 {
        return Err(anyhow!("GitHub rejected the token."));
    }
    let login = v["login"].as_str().unwrap_or("github").to_string();
    // One row per (team, login): refresh the token if it already exists.
    #[derive(Deserialize)]
    struct R {
        id: String,
    }
    let existing: Option<R> = db
        .prepare("SELECT id FROM github_accounts WHERE team_id = ? AND login = ?")
        .bind(&[v_text(team_id), v_text(&login)])?
        .first(None)
        .await?;
    let id = if let Some(r) = existing {
        db.prepare("UPDATE github_accounts SET token = ? WHERE id = ?").bind(&[v_text(token), v_text(&r.id)])?.run().await?;
        r.id
    } else {
        let id = crate::util::new_id();
        db.prepare("INSERT INTO github_accounts (id, team_id, login, token) VALUES (?, ?, ?, ?)")
            .bind(&[v_text(&id), v_text(team_id), v_text(&login), v_text(token)])?
            .run()
            .await?;
        id
    };
    Ok(GithubAccount { id, team_id: team_id.into(), login, created_at: String::new() })
}

pub async fn connect_token(db: &Db, team_id: &str, user_id: &str, token: &str) -> Result<GithubAccount> {
    require_manager(db, team_id, user_id).await?;
    let token = token.trim();
    if token.is_empty() {
        return Err(anyhow!("Paste a GitHub token."));
    }
    save_account(db, team_id, token).await
}

pub async fn list_accounts(db: &Db, team_id: &str, user_id: &str) -> Result<Vec<GithubAccount>> {
    require_member(db, team_id, user_id).await?;
    db.prepare("SELECT id, team_id, login, created_at FROM github_accounts WHERE team_id = ? ORDER BY created_at DESC")
        .bind(&[v_text(team_id)])?
        .all()
        .await?
        .results()
}

pub async fn disconnect(db: &Db, team_id: &str, user_id: &str, account_id: &str) -> Result<()> {
    require_manager(db, team_id, user_id).await?;
    db.prepare("DELETE FROM github_accounts WHERE id = ? AND team_id = ?").bind(&[v_text(account_id), v_text(team_id)])?.run().await?;
    db.prepare("UPDATE repos SET github_account_id = '', github_repo = '', github_branch = '' WHERE github_account_id = ? AND team_id = ?")
        .bind(&[v_text(account_id), v_text(team_id)])?
        .run()
        .await?;
    Ok(())
}

async fn account_token(db: &Db, team_id: &str, account_id: &str) -> Result<String> {
    #[derive(Deserialize)]
    struct R {
        token: String,
    }
    let r: Option<R> = db
        .prepare("SELECT token FROM github_accounts WHERE id = ? AND team_id = ?")
        .bind(&[v_text(account_id), v_text(team_id)])?
        .first(None)
        .await?;
    r.map(|r| r.token).ok_or_else(|| anyhow!("GitHub account not connected."))
}

// ---------- OAuth ----------

fn sign(secret: &str, payload: &str) -> String {
    use hmac::Mac;
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(secret.as_bytes()).expect("hmac key");
    mac.update(payload.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

pub async fn oauth_start(state: &AppState, team_id: &str, user_id: &str) -> Result<String> {
    require_manager(&state.db, team_id, user_id).await?;
    let (client_id, _) = oauth_config().ok_or_else(|| anyhow!("GitHub OAuth is not configured on this server — use a personal access token."))?;
    let exp = chrono::Utc::now().timestamp() + 600;
    let payload = format!("{team_id}.{user_id}.{exp}");
    let st = format!("{payload}.{}", sign(&state.jwt_secret, &payload));
    let redirect = format!("{}/api/github/callback", crate::hitpay::app_base_url());
    Ok(format!(
        "https://github.com/login/oauth/authorize?client_id={}&scope=repo&state={}&redirect_uri={}",
        urlencode(&client_id),
        urlencode(&st),
        urlencode(&redirect)
    ))
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// `GET /api/github/callback?code&state` → store token → back to Publish.
pub async fn oauth_callback(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> axum::response::Response {
    use axum::response::{IntoResponse, Redirect};
    let fail = |m: &str| Redirect::to(&format!("/?view=publish&github=error&msg={}", urlencode(m))).into_response();
    let (Some(code), Some(st)) = (q.get("code"), q.get("state")) else {
        return fail("GitHub did not return a code.");
    };
    let parts: Vec<&str> = st.split('.').collect();
    if parts.len() != 4 {
        return fail("Bad state.");
    }
    let payload = format!("{}.{}.{}", parts[0], parts[1], parts[2]);
    if sign(&state.jwt_secret, &payload) != parts[3] || parts[2].parse::<i64>().unwrap_or(0) < chrono::Utc::now().timestamp() {
        return fail("Link expired — try again.");
    }
    let (team_id, user_id) = (parts[0], parts[1]);
    if require_manager(&state.db, team_id, user_id).await.is_err() {
        return fail("Only owners and admins can connect GitHub.");
    }
    let Some((cid, secret)) = oauth_config() else {
        return fail("GitHub OAuth is not configured.");
    };
    let r = client()
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .header("User-Agent", UA)
        .json(&json!({ "client_id": cid, "client_secret": secret, "code": code }))
        .send()
        .await;
    let token = match r {
        Ok(r) => r.json::<Value>().await.ok().and_then(|v| v["access_token"].as_str().map(String::from)),
        Err(_) => None,
    };
    let Some(token) = token else {
        return fail("GitHub sign-in failed.");
    };
    match save_account(&state.db, team_id, &token).await {
        Ok(_) => Redirect::to("/?view=publish&github=connected").into_response(),
        Err(e) => fail(&e.to_string()),
    }
}

// ---------- repos ----------

pub async fn list_github_repos(db: &Db, team_id: &str, user_id: &str, account_id: &str) -> Result<Vec<Value>> {
    require_manager(db, team_id, user_id).await?;
    let token = account_token(db, team_id, account_id).await?;
    let (status, v) = gh_get(&token, "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member").await?;
    if status != 200 {
        return Err(anyhow!("GitHub error ({status}) — reconnect GitHub."));
    }
    Ok(v.as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|r| {
            json!({
                "full_name": r["full_name"], "private": r["private"], "default_branch": r["default_branch"],
                "description": r["description"], "updated_at": r["pushed_at"],
            })
        })
        .collect())
}

#[derive(Deserialize, Serialize, Clone)]
pub struct Link {
    pub repo_id: String,
    pub team_id: String,
    pub github_account_id: String,
    pub github_repo: String,
    pub github_branch: String,
    pub github_synced_at: String,
    pub github_error: String,
}

pub async fn linked_repo(db: &Db, repo_id: &str) -> Option<Link> {
    let l: Option<Link> = db
        .prepare("SELECT id AS repo_id, team_id, github_account_id, github_repo, github_branch, github_synced_at, github_error FROM repos WHERE id = ?")
        .bind(&[v_text(repo_id)])
        .ok()?
        .first(None)
        .await
        .ok()
        .flatten();
    l.filter(|l| !l.github_repo.is_empty())
}

pub async fn get_link(db: &Db, user_id: &str, repo_id: &str) -> Result<Option<Link>> {
    let r = platform::get_repo(db, user_id, repo_id).await?.ok_or_else(|| anyhow!("Repo not found."))?;
    require_member(db, &r.team_id, user_id).await?;
    Ok(linked_repo(db, repo_id).await)
}

fn valid_full_name(s: &str) -> bool {
    let mut it = s.split('/');
    let ok = |p: &str| !p.is_empty() && p.len() <= 100 && p.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) && p != "." && p != "..";
    matches!((it.next(), it.next(), it.next()), (Some(a), Some(b), None) if ok(a) && ok(b))
}

fn valid_branch(s: &str) -> bool {
    !s.is_empty() && s.len() <= 200 && !s.starts_with('-') && !s.contains("..") && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_./".contains(c))
}

pub async fn link(state: &AppState, user_id: &str, repo_id: &str, account_id: &str, full_name: &str, branch: &str) -> Result<Link> {
    let db = &state.db;
    let r = platform::get_repo(db, user_id, repo_id).await?.ok_or_else(|| anyhow!("Repo not found."))?;
    require_manager(db, &r.team_id, user_id).await?;
    if !r.fork_of.is_empty() {
        return Err(anyhow!("Purchased copies can't be linked to GitHub."));
    }
    let full_name = full_name.trim();
    let branch = if branch.trim().is_empty() { "main" } else { branch.trim() };
    if !valid_full_name(full_name) || !valid_branch(branch) {
        return Err(anyhow!("Pick a repository and branch."));
    }
    account_token(db, &r.team_id, account_id).await?;
    db.prepare("UPDATE repos SET github_account_id = ?, github_repo = ?, github_branch = ?, github_error = '' WHERE id = ?")
        .bind(&[v_text(account_id), v_text(full_name), v_text(branch), v_text(repo_id)])?
        .run()
        .await?;
    sync(state, repo_id).await?;
    linked_repo(db, repo_id).await.ok_or_else(|| anyhow!("link failed"))
}

pub async fn unlink(db: &Db, user_id: &str, repo_id: &str) -> Result<()> {
    let r = platform::get_repo(db, user_id, repo_id).await?.ok_or_else(|| anyhow!("Repo not found."))?;
    require_manager(db, &r.team_id, user_id).await?;
    db.prepare("UPDATE repos SET github_account_id = '', github_repo = '', github_branch = '', github_error = '' WHERE id = ?")
        .bind(&[v_text(repo_id)])?
        .run()
        .await?;
    Ok(())
}

async fn git_env(args: &[&str], cwd: Option<&Path>, env: &[(&str, String)]) -> Result<String> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(args).env("GIT_TERMINAL_PROMPT", "0");
    for (k, v) in env {
        cmd.env(k, v);
    }
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    let out = tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output())
        .await
        .map_err(|_| anyhow!("git timed out"))?
        .map_err(|e| anyhow!("git not available: {e}"))?;
    if !out.status.success() {
        return Err(anyhow!("{}", String::from_utf8_lossy(&out.stderr).trim().lines().last().unwrap_or("git failed")));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Mirror the linked GitHub branch into Slaver's bare repo. Returns HEAD sha.
pub async fn sync(state: &AppState, repo_id: &str) -> Result<String> {
    let db = &state.db;
    let l = linked_repo(db, repo_id).await.ok_or_else(|| anyhow!("This listing is not linked to GitHub."))?;
    let token = account_token(db, &l.team_id, &l.github_account_id).await?;
    let git_root = state.git_root.to_string_lossy().to_string();
    let bare = platform::ensure_bare_repo(&git_root, repo_id).await.map_err(|e| anyhow!(e))?;
    let gd = format!("--git-dir={}", bare.display());
    let head_ref = git_env(&[&gd, "symbolic-ref", "HEAD"], None, &[]).await.unwrap_or_else(|_| "refs/heads/main".into());
    let basic = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
    // Token goes through env-config, never argv / remote URL / logs.
    let env = [
        ("GIT_CONFIG_COUNT", "1".to_string()),
        ("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader".to_string()),
        ("GIT_CONFIG_VALUE_0", format!("Authorization: Basic {basic}")),
    ];
    let url = format!("https://github.com/{}.git", l.github_repo);
    let refspec = format!("+refs/heads/{}:{head_ref}", l.github_branch);
    let res = git_env(&[&gd, "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "fetch", "-q", "--no-tags", &url, &refspec], None, &env).await;
    match res {
        Ok(_) => {
            let _ = db
                .prepare("UPDATE repos SET github_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), github_error = '' WHERE id = ?")
                .bind(&[v_text(repo_id)])?
                .run()
                .await;
            git_env(&[&gd, "rev-parse", "HEAD"], None, &[]).await
        }
        Err(e) => {
            let msg = format!("Sync failed: {e}");
            let _ = db.prepare("UPDATE repos SET github_error = ? WHERE id = ?").bind(&[v_text(&msg), v_text(repo_id)])?.run().await;
            Err(anyhow!(msg))
        }
    }
}

pub async fn sync_checked(state: &AppState, user_id: &str, repo_id: &str) -> Result<String> {
    let r = platform::get_repo(&state.db, user_id, repo_id).await?.ok_or_else(|| anyhow!("Repo not found."))?;
    require_manager(&state.db, &r.team_id, user_id).await?;
    sync(state, repo_id).await
}

/// Background mirror of every linked repo (every 10 minutes).
pub async fn sync_loop(state: AppState) {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(600)).await;
        #[derive(Deserialize)]
        struct R {
            id: String,
        }
        let rows: Vec<R> = match state.db.prepare("SELECT id FROM repos WHERE github_repo != ''").bind(&[]) {
            Ok(s) => match s.all().await.and_then(|r| r.results()) {
                Ok(r) => r,
                Err(_) => continue,
            },
            Err(_) => continue,
        };
        for r in rows {
            let _ = sync(&state, &r.id).await;
        }
    }
}

// ---------- buyer updates (isolated, opt-in) ----------

#[derive(Serialize)]
pub struct UpdateInfo {
    pub repo_id: String,
    pub project_id: String,
    pub app_name: String,
    pub behind: i64,
    pub latest_sha: String,
    pub changes: Vec<Value>,
}

/// Fetch the template's HEAD into the copy's private ref `refs/slaver/upstream`
/// (never a branch — the buyer's code is untouched) and count new commits.
async fn check_one(git_root: &str, fork_id: &str, template_id: &str) -> Result<(i64, String, Vec<Value>)> {
    let fork = platform::bare_repo_path(git_root, fork_id);
    let tpl = platform::bare_repo_path(git_root, template_id);
    if !fork.join("HEAD").exists() || !tpl.join("HEAD").exists() {
        return Ok((0, String::new(), vec![]));
    }
    let gd = format!("--git-dir={}", fork.display());
    git_env(&[&gd, "fetch", "-q", "--no-tags", &tpl.to_string_lossy(), "+HEAD:refs/slaver/upstream"], None, &[]).await?;
    let latest = git_env(&[&gd, "rev-parse", "refs/slaver/upstream"], None, &[]).await?;
    let behind: i64 = git_env(&[&gd, "rev-list", "--count", "HEAD..refs/slaver/upstream"], None, &[]).await?.parse().unwrap_or(0);
    let mut changes = vec![];
    if behind > 0 {
        let log = git_env(&[&gd, "log", "--format=%h%x1f%s%x1f%cI", "-n", "20", "HEAD..refs/slaver/upstream"], None, &[]).await.unwrap_or_default();
        for line in log.lines() {
            let p: Vec<&str> = line.split('\x1f').collect();
            if p.len() == 3 {
                changes.push(json!({ "sha": p[0], "subject": p[1], "date": p[2] }));
            }
        }
    }
    Ok((behind, latest, changes))
}

pub async fn list_updates(state: &AppState, team_id: &str, user_id: &str) -> Result<Vec<UpdateInfo>> {
    require_member(&state.db, team_id, user_id).await?;
    #[derive(Deserialize)]
    struct R {
        fork_id: String,
        template_id: String,
        project_id: String,
        app_name: String,
    }
    let rows: Vec<R> = state
        .db
        .prepare(
            "SELECT r.id AS fork_id, r.fork_of AS template_id, p.id AS project_id, p.name AS app_name \
             FROM repos r JOIN projects p ON p.repo_id = r.id \
             WHERE r.team_id = ? AND r.fork_of != ''",
        )
        .bind(&[v_text(team_id)])?
        .all()
        .await?
        .results()?;
    let git_root = state.git_root.to_string_lossy().to_string();
    let mut out = vec![];
    for r in rows {
        if let Ok((behind, latest, changes)) = check_one(&git_root, &r.fork_id, &r.template_id).await {
            if behind > 0 {
                out.push(UpdateInfo { repo_id: r.fork_id, project_id: r.project_id, app_name: r.app_name, behind, latest_sha: latest, changes });
            }
        }
    }
    Ok(out)
}

/// Merge the creator's latest version into the team's copy. On conflict the
/// copy is left untouched and the update is parked on branch `slaver-update`.
pub async fn apply_update(state: &AppState, user_id: &str, fork_id: &str) -> Result<Value> {
    let db = &state.db;
    let r = platform::get_repo(db, user_id, fork_id).await?.ok_or_else(|| anyhow!("App not found."))?;
    require_manager(db, &r.team_id, user_id).await?;
    if r.fork_of.is_empty() {
        return Err(anyhow!("This app has no upstream."));
    }
    let git_root = state.git_root.to_string_lossy().to_string();
    let (behind, _, _) = check_one(&git_root, fork_id, &r.fork_of).await?;
    if behind == 0 {
        return Ok(json!({ "status": "up_to_date" }));
    }
    let bare = platform::bare_repo_path(&git_root, fork_id);
    let bare_s = bare.to_string_lossy().to_string();
    let gd = format!("--git-dir={bare_s}");
    let head_ref = git_env(&[&gd, "symbolic-ref", "HEAD"], None, &[]).await.unwrap_or_else(|_| "refs/heads/main".into());
    let tmp = std::env::temp_dir().join(format!("slaver-update-{}", crate::util::new_id()));
    let work = tmp.join("w");
    let res: Result<Value> = async {
        git_env(&["clone", "-q", &bare_s, &work.to_string_lossy()], None, &[]).await?;
        git_env(&["fetch", "-q", &bare_s, "refs/slaver/upstream"], Some(&work), &[]).await?;
        let id = ["-c", "user.name=Slaver Update", "-c", "user.email=update@slaver.local"];
        let merged = git_env(&[id[0], id[1], id[2], id[3], "merge", "--no-edit", "-m", "Update from creator", "FETCH_HEAD"], Some(&work), &[]).await;
        if merged.is_err() {
            let _ = git_env(&["merge", "--abort"], Some(&work), &[]).await;
            git_env(&[&gd, "update-ref", "refs/heads/slaver-update", "refs/slaver/upstream"], None, &[]).await?;
            return Ok(json!({ "status": "conflict", "branch": "slaver-update" }));
        }
        git_env(&["push", "-q", "origin", &format!("HEAD:{head_ref}")], Some(&work), &[]).await?;
        let sha = git_env(&["rev-parse", "HEAD"], Some(&work), &[]).await?;
        Ok(json!({ "status": "updated", "sha": sha, "commits": behind }))
    }
    .await;
    let _ = tokio::fs::remove_dir_all(&tmp).await;
    res
}
