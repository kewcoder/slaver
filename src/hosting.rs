//! One-click install of a team's app (project repo HEAD) onto the team's own
//! Fly.io account (`flyctl deploy --remote-only`; a Caddy image is generated for
//! static sites), plus the creator-side "upload a project" paths. The customer's
//! own tokens are used, so Fly bills the customer directly, never Slaver.
//!
//! Optional `slaver.json` at the repo root:
//!   { "static_dir": "dist", "port": 8080 }
//!
//! Upload paths (creators): `git push`, zip/tar upload (HTTP + MCP), or import
//! from a public https git URL.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use crate::{
    db::{v_text, Db},
    platform, store, AppState,
};

/// Production runs on the customer's Fly.io account; staging on their Sprites org.
pub const PROVIDERS: [&str; 2] = ["fly", "sprites"];


fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .expect("http client builds")
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

/// Lowercase letters/digits/dashes, trimmed, max 40 chars.
pub fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in s.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    let out: String = out.trim_matches('-').chars().take(40).collect();
    out.trim_matches('-').to_string()
}

fn short_rand() -> String {
    crate::util::new_id().chars().filter(|c| c.is_ascii_alphanumeric()).take(4).collect::<String>().to_lowercase()
}

// ---------- accounts ----------

#[derive(Deserialize, Serialize, Clone)]
pub struct HostingAccount {
    pub id: String,
    pub team_id: String,
    pub provider: String,
    pub name: String,
    pub account_ref: String,
    pub created_at: String,
}

async fn validate_token(provider: &str, token: &str, _account_ref: &str) -> Result<String> {
    let c = client();
    match provider {
        "sprites" => {
            // Token format: "<org>/<id>/<secret>" from sprites.dev/account. Billing goes to that org.
            let r = c.get("https://api.sprites.dev/v1/sprites?max_results=1").bearer_auth(token).send().await?;
            if !r.status().is_success() {
                return Err(anyhow!("Sprites rejected the token. Create one at sprites.dev/account."));
            }
            Ok(token.split('/').next().filter(|o| !o.is_empty()).unwrap_or("sprites").to_string())
        }
        _ => Err(anyhow!("Unknown hosting provider.")),
    }
}

pub async fn connect(db: &Db, team_id: &str, user_id: &str, provider: &str, name: &str, account_ref: &str, token: &str) -> Result<HostingAccount> {
    require_manager(db, team_id, user_id).await?;
    let token = token.trim();
    if token.is_empty() {
        return Err(anyhow!("Paste an API token."));
    }
    if provider == "fly" {
        let a = platform::fly_connect(db, team_id, user_id, name, account_ref, token).await?;
        return Ok(HostingAccount { id: a.id, team_id: a.team_id, provider: "fly".into(), name: a.name, account_ref: a.org, created_at: a.created_at });
    }
    if !PROVIDERS.contains(&provider) {
        return Err(anyhow!("Unknown hosting provider."));
    }
    let who = validate_token(provider, token, account_ref).await?;
    let org = who.clone();
    let account_ref = if provider == "sprites" { org.as_str() } else { account_ref };
    let name = if name.trim().is_empty() { who } else { name.trim().chars().take(60).collect() };
    let id = crate::util::new_id();
    db.prepare("INSERT INTO hosting_accounts (id, team_id, provider, name, account_ref, api_token) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&[v_text(&id), v_text(team_id), v_text(provider), v_text(&name), v_text(account_ref.trim()), v_text(token)])?
        .run()
        .await?;
    Ok(HostingAccount { id, team_id: team_id.into(), provider: provider.into(), name, account_ref: account_ref.trim().into(), created_at: String::new() })
}

pub async fn list_accounts(db: &Db, team_id: &str, user_id: &str) -> Result<Vec<HostingAccount>> {
    require_member(db, team_id, user_id).await?;
    let mut rows: Vec<HostingAccount> = db
        .prepare("SELECT id, team_id, provider, name, account_ref, created_at FROM hosting_accounts WHERE team_id = ? ORDER BY created_at DESC LIMIT 50")
        .bind(&[v_text(team_id)])?
        .all()
        .await?
        .results()?;
    for a in platform::fly_list(db, team_id, user_id).await.unwrap_or_default() {
        rows.push(HostingAccount { id: a.id, team_id: a.team_id, provider: "fly".into(), name: a.name, account_ref: a.org, created_at: a.created_at });
    }
    Ok(rows)
}

pub async fn disconnect(db: &Db, team_id: &str, user_id: &str, provider: &str, account_id: &str) -> Result<()> {
    require_manager(db, team_id, user_id).await?;
    if provider == "fly" {
        return platform::fly_disconnect(db, team_id, user_id, account_id).await;
    }
    db.prepare("DELETE FROM hosting_accounts WHERE id = ? AND team_id = ?")
        .bind(&[v_text(account_id), v_text(team_id)])?
        .run()
        .await?;
    Ok(())
}

/// (account_ref, token) for an account on this team.
async fn account_secret(db: &Db, team_id: &str, user_id: &str, provider: &str, account_id: &str) -> Result<(String, String)> {
    if provider == "fly" {
        let (a, token) = platform::fly_get(db, team_id, user_id, account_id).await?.ok_or_else(|| anyhow!("Fly account not found."))?;
        return Ok((a.org, token));
    }
    #[derive(Deserialize)]
    struct R {
        account_ref: String,
        api_token: String,
    }
    let r: Option<R> = db
        .prepare("SELECT account_ref, api_token FROM hosting_accounts WHERE id = ? AND team_id = ? AND provider = ?")
        .bind(&[v_text(account_id), v_text(team_id), v_text(provider)])?
        .first(None)
        .await?;
    let r = r.ok_or_else(|| anyhow!("Hosting account not found — connect it first."))?;
    Ok((r.account_ref, r.api_token))
}

// ---------- installs ----------

#[derive(Deserialize, Serialize, Clone)]
pub struct InstallRow {
    pub id: String,
    pub team_id: String,
    pub project_id: String,
    pub provider: String,
    pub account_id: String,
    pub site_name: String,
    pub external_id: String,
    pub url: String,
    pub status: String,
    pub log: String,
    pub commit_sha: String,
    pub created_at: String,
    pub updated_at: String,
}

const INSTALL_COLS: &str = "id, team_id, project_id, provider, account_id, site_name, external_id, url, status, log, commit_sha, created_at, updated_at";

pub async fn list_installs(db: &Db, team_id: &str, user_id: &str, project_id: &str) -> Result<Vec<InstallRow>> {
    require_member(db, team_id, user_id).await?;
    let (sql, binds) = if project_id.is_empty() {
        (format!("SELECT {INSTALL_COLS} FROM installs WHERE team_id = ? ORDER BY created_at DESC LIMIT 50"), vec![v_text(team_id)])
    } else {
        (format!("SELECT {INSTALL_COLS} FROM installs WHERE team_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 20"), vec![v_text(team_id), v_text(project_id)])
    };
    db.prepare(&sql).bind(&binds)?.all().await?.results()
}

async fn get_install(db: &Db, id: &str) -> Result<Option<InstallRow>> {
    db.prepare(&format!("SELECT {INSTALL_COLS} FROM installs WHERE id = ?")).bind(&[v_text(id)])?.first(None).await
}

async fn set_install(db: &Db, id: &str, status: &str, log: &str, url: Option<&str>, external_id: Option<&str>) {
    let tail: String = {
        let chars: Vec<char> = log.chars().collect();
        let start = chars.len().saturating_sub(20_000);
        chars[start..].iter().collect()
    };
    if let Ok(stmt) = db
        .prepare("UPDATE installs SET status = ?, log = ?, url = COALESCE(?, url), external_id = COALESCE(?, external_id), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .bind(&[
            v_text(status),
            v_text(&tail),
            url.map(v_text).unwrap_or(rusqlite::types::Value::Null),
            external_id.map(v_text).unwrap_or(rusqlite::types::Value::Null),
            v_text(id),
        ])
    {
        let _ = stmt.run().await;
    }
}

/// Validate, create the install row and spawn the background job.
pub async fn start_install(state: AppState, user_id: &str, project_id: &str, provider: &str, account_id: &str, site_name: &str) -> Result<InstallRow> {
    let db = &state.db;
    if !PROVIDERS.contains(&provider) {
        return Err(anyhow!("Pick a hosting provider."));
    }
    let project = platform::get_project(db, user_id, project_id).await?.ok_or_else(|| anyhow!("App not found."))?;
    require_manager(db, &project.team_id, user_id).await?;
    if project.repo_id.is_empty() {
        return Err(anyhow!("This app has no source yet."));
    }
    let git_root = state.git_root.to_string_lossy().to_string();
    let sha = crate::git::git_head_sha(&git_root, &project.repo_id)
        .await
        .map_err(|e| anyhow!(e))?
        .ok_or_else(|| anyhow!("The app's source is empty — the creator has not uploaded code yet."))?;
    // Make sure the secret resolves before queueing.
    account_secret(db, &project.team_id, user_id, provider, account_id).await?;

    // Reuse the previous site on this provider so redeploys update in place.
    let prev = list_installs(db, &project.team_id, user_id, project_id)
        .await
        .unwrap_or_default()
        .into_iter()
        .find(|i| i.provider == provider && i.account_id == account_id && i.status == "live");
    let mut site = slugify(site_name);
    let mut external = String::new();
    if let Some(p) = &prev {
        if site.is_empty() || site == p.site_name {
            site = p.site_name.clone();
            external = p.external_id.clone();
        }
    }
    if site.is_empty() {
        let base = slugify(&project.name);
        site = format!("{}-{}", if base.is_empty() { "app".to_string() } else { base.chars().take(30).collect() }, short_rand());
    }

    let id = crate::util::new_id();
    db.prepare("INSERT INTO installs (id, team_id, project_id, provider, account_id, site_name, external_id, commit_sha, log) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&[
            v_text(&id),
            v_text(&project.team_id),
            v_text(project_id),
            v_text(provider),
            v_text(account_id),
            v_text(&site),
            v_text(&external),
            v_text(&sha),
            v_text("Queued.\n"),
        ])?
        .run()
        .await?;
    let row = get_install(db, &id).await?.ok_or_else(|| anyhow!("install insert failed"))?;
    let st = state.clone();
    let uid = user_id.to_string();
    let job = row.clone();
    let repo_id = project.repo_id.clone();
    tokio::spawn(async move {
        run_install(st, uid, job, repo_id).await;
    });
    Ok(row)
}

struct Log {
    text: String,
}

impl Log {
    fn line(&mut self, s: impl AsRef<str>) {
        self.text.push_str(s.as_ref());
        self.text.push('\n');
    }
}

async fn run_install(state: AppState, user_id: String, job: InstallRow, repo_id: String) {
    let db = state.db.clone();
    let mut log = Log { text: String::new() };
    set_install(&db, &job.id, "running", "Starting install…\n", None, None).await;
    let tmp = std::env::temp_dir().join(format!("slaver-install-{}", job.id));
    let res = install_inner(&state, &user_id, &job, &repo_id, &tmp, &mut log).await;
    let _ = tokio::fs::remove_dir_all(&tmp).await;
    match res {
        Ok((url, external)) => {
            log.line(format!("✓ Live at {url}"));
            set_install(&db, &job.id, "live", &log.text, Some(&url), Some(&external)).await;
            // Surface it on the Apps home.
            let _ = platform::set_project_urls(&db, &user_id, &job.project_id, Some(&url), None).await;
        }
        Err(e) => {
            log.line(format!("✗ {e}"));
            set_install(&db, &job.id, "failed", &log.text, None, None).await;
        }
    }
}

async fn install_inner(state: &AppState, user_id: &str, job: &InstallRow, repo_id: &str, tmp: &Path, log: &mut Log) -> Result<(String, String)> {
    let (account_ref, token) = account_secret(&state.db, &job.team_id, user_id, &job.provider, &job.account_id).await?;
    let src = tmp.join("src");
    export_head(&state.git_root.to_string_lossy(), repo_id, &src).await?;
    log.line(format!("✓ Source exported ({})", &job.commit_sha.chars().take(8).collect::<String>()));
    set_install(&state.db, &job.id, "running", &log.text, None, None).await;
    let manifest = read_manifest(&src);
    match job.provider.as_str() {
        "fly" => deploy_fly(&state.db, user_id, job, &token, &account_ref, &src, &manifest, log).await,
        _ => Err(anyhow!("Unknown provider.")),
    }
}

// ---------- source helpers ----------

async fn run_git(args: &[&str], cwd: Option<&Path>) -> Result<String> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(args).env("GIT_TERMINAL_PROMPT", "0");
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    let out = cmd.output().await.map_err(|e| anyhow!("git not available: {e}"))?;
    if !out.status.success() {
        return Err(anyhow!("git {}: {}", args.first().unwrap_or(&""), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// `git archive HEAD | tar -x` into `dest`.
async fn export_head(git_root: &str, repo_id: &str, dest: &Path) -> Result<()> {
    tokio::fs::create_dir_all(dest).await?;
    let bare = platform::bare_repo_path(git_root, repo_id);
    let tar_path = dest.with_extension("tar");
    run_git(&[&format!("--git-dir={}", bare.display()), "archive", "--format=tar", "-o", &tar_path.to_string_lossy(), "HEAD"], None).await?;
    let out = tokio::process::Command::new("tar").arg("-xf").arg(&tar_path).arg("-C").arg(dest).output().await?;
    let _ = tokio::fs::remove_file(&tar_path).await;
    if !out.status.success() {
        return Err(anyhow!("Cannot unpack source."));
    }
    Ok(())
}

#[derive(Default, Deserialize)]
struct Manifest {
    #[serde(default)]
    static_dir: String,
    #[serde(default)]
    port: u16,
}

fn read_manifest(src: &Path) -> Manifest {
    std::fs::read_to_string(src.join("slaver.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// Folder holding the static site (index.html).
fn static_dir(src: &Path, m: &Manifest) -> Result<PathBuf> {
    if !m.static_dir.trim().is_empty() {
        let rel = m.static_dir.trim().trim_start_matches("./").trim_matches('/');
        if rel.contains("..") {
            return Err(anyhow!("slaver.json static_dir must stay inside the repo."));
        }
        let p = if rel.is_empty() { src.to_path_buf() } else { src.join(rel) };
        if p.is_dir() {
            return Ok(p);
        }
        return Err(anyhow!("slaver.json static_dir \"{rel}\" not found in the repo."));
    }
    for cand in ["", "dist", "build", "public", "out", "site", "www"] {
        let p = if cand.is_empty() { src.to_path_buf() } else { src.join(cand) };
        if p.join("index.html").is_file() {
            return Ok(p);
        }
    }
    Err(anyhow!("No index.html found (checked /, dist, build, public, out). This host serves static files only — commit the built site or pick Vercel/Fly.io, which build from source."))
}


fn api_error(v: &Value, fallback: &str) -> String {
    v["error"]["message"]
        .as_str()
        .or_else(|| v["errors"][0]["message"].as_str())
        .or_else(|| v["message"].as_str())
        .unwrap_or(fallback)
        .to_string()
}

fn flyctl_bin() -> String {
    std::env::var("FLYCTL_PATH").unwrap_or_else(|_| "flyctl".to_string())
}

async fn deploy_fly(db: &Db, _user_id: &str, job: &InstallRow, token: &str, org: &str, src: &Path, m: &Manifest, log: &mut Log) -> Result<(String, String)> {
    let bin = flyctl_bin();
    if tokio::process::Command::new(&bin).arg("version").output().await.map(|o| !o.status.success()).unwrap_or(true) {
        return Err(anyhow!("flyctl is not installed on this Slaver server (set FLYCTL_PATH)."));
    }
    let app = job.site_name.clone();
    // Ensure the app exists (Machines API).
    let c = client();
    let r = c.get(format!("https://api.machines.dev/v1/apps/{app}")).bearer_auth(token).send().await?;
    if !r.status().is_success() {
        let mut body = json!({ "app_name": app });
        if !org.trim().is_empty() {
            body["org_slug"] = json!(org.trim());
        } else {
            body["org_slug"] = json!("personal");
        }
        let r = c.post("https://api.machines.dev/v1/apps").bearer_auth(token).json(&body).send().await?;
        if !r.status().is_success() {
            let v: Value = r.json().await.unwrap_or(Value::Null);
            return Err(anyhow!("Fly: cannot create app \"{app}\": {}", api_error(&v, "name taken or org invalid")));
        }
        log.line(format!("✓ Fly app \"{app}\" created"));
    }
    // Never follow symlinks from untrusted source when we write files.
    for f in ["Dockerfile", "fly.toml"] {
        if let Ok(md) = std::fs::symlink_metadata(src.join(f)) {
            if md.file_type().is_symlink() {
                let _ = std::fs::remove_file(src.join(f));
            }
        }
    }
    let mut port = if m.port > 0 { m.port } else { 8080 };
    if !src.join("Dockerfile").is_file() {
        let dir = static_dir(src, m)?;
        let rel = dir.strip_prefix(src).map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        let from = if rel.is_empty() { ".".to_string() } else { rel };
        tokio::fs::write(src.join("Dockerfile"), format!("FROM caddy:2-alpine\nCOPY {from} /usr/share/caddy\n")).await?;
        port = 80;
        log.line("✓ No Dockerfile — serving the static site with Caddy");
    }
    if !src.join("fly.toml").is_file() {
        tokio::fs::write(
            src.join("fly.toml"),
            format!("app = \"{app}\"\n\n[http_service]\n  internal_port = {port}\n  force_https = true\n  auto_stop_machines = \"stop\"\n  auto_start_machines = true\n  min_machines_running = 0\n"),
        )
        .await?;
    }
    // App needs from fly.toml: volumes ([[mounts]]) and generated secrets
    // (comment lines like `fly secrets set ADMIN_TOKEN=$(openssl rand -hex 32)`).
    let toml = std::fs::read_to_string(src.join("fly.toml")).unwrap_or_default();
    let (region, mounts, secrets) = fly_toml_needs(&toml);
    for vol in &mounts {
        ensure_fly_volume(token, &app, vol, &region, log).await?;
    }
    
    if !secrets.is_empty() {
        let existing = fly_secret_names(&bin, token, &app).await;
        for (name, bytes) in &secrets {
            if existing.iter().any(|e| e == name) {
                continue;
            }
            let mut buf = vec![0u8; *bytes];
            getrandom::getrandom(&mut buf).map_err(|e| anyhow!("random: {e}"))?;
            let val = hex::encode(buf);
            let out = tokio::process::Command::new(&bin)
                .args(["secrets", "set", &format!("{name}={val}"), "--stage", "--app", &app])
                .env("FLY_API_TOKEN", token)
                .output()
                .await?;
            if !out.status.success() {
                return Err(anyhow!("Could not set secret {name}: {}", String::from_utf8_lossy(&out.stderr).trim()));
            }
            log.line(format!("✓ Secret {name} generated"));
            let _ = val;
        }
    }
    log.line("→ flyctl deploy --remote-only (building on Fly)…");
    set_install(db, &job.id, "running", &log.text, None, None).await;
    let fut = tokio::process::Command::new(&bin)
        .args(["deploy", "--remote-only", "--yes", "--ha=false", "--app", &app])
        .current_dir(src)
        .env("FLY_API_TOKEN", token)
        .env("NO_COLOR", "1")
        .output();
    let out = tokio::time::timeout(std::time::Duration::from_secs(20 * 60), fut)
        .await
        .map_err(|_| anyhow!("Fly deploy timed out after 20 minutes."))??;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    let tail: Vec<&str> = text.lines().rev().take(40).collect();
    for l in tail.into_iter().rev() {
        log.line(l);
    }
    if !out.status.success() {
        return Err(anyhow!("flyctl deploy failed."));
    }
    let url = format!("https://{app}.fly.dev");
    Ok((url, app))
}

/// (primary_region, mount sources, secrets to generate as (NAME, random bytes)).
fn fly_toml_needs(toml: &str) -> (String, Vec<String>, Vec<(String, usize)>) {
    let mut region = String::new();
    let mut mounts = vec![];
    let mut secrets = vec![];
    let mut in_mounts = false;
    for raw in toml.lines() {
        let line = raw.trim();
        if let Some(c) = line.strip_prefix('#') {
            // fly secrets set NAME=$(openssl rand -hex N)
            if let Some(rest) = c.trim().strip_prefix("fly secrets set ") {
                if let Some((name, val)) = rest.split_once('=') {
                    let name = name.trim();
                    if !name.is_empty() && name.chars().all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_') && val.contains("openssl rand -hex") {
                        let n = val.split_whitespace().filter_map(|w| w.trim_end_matches(')').parse::<usize>().ok()).next().unwrap_or(32).clamp(16, 64);
                        secrets.push((name.to_string(), n));
                    }
                }
            }
            continue;
        }
        if line.starts_with('[') {
            in_mounts = line == "[[mounts]]";
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let (k, v) = (k.trim(), v.trim().trim_matches('"').to_string());
            if k == "primary_region" && region.is_empty() {
                region = v;
            } else if in_mounts && k == "source" && !v.is_empty() {
                mounts.push(v);
            }
        }
    }
    if region.is_empty() {
        region = "sin".into();
    }
    (region, mounts, secrets)
}

async fn ensure_fly_volume(token: &str, app: &str, name: &str, region: &str, log: &mut Log) -> Result<()> {
    let c = client();
    let r = c.get(format!("https://api.machines.dev/v1/apps/{app}/volumes")).bearer_auth(token).send().await?;
    let v: Value = r.json().await.unwrap_or(Value::Null);
    let exists = v.as_array().map(|a| a.iter().any(|x| x["name"].as_str() == Some(name) && x["state"].as_str() != Some("destroyed"))).unwrap_or(false);
    if exists {
        return Ok(());
    }
    let r = c
        .post(format!("https://api.machines.dev/v1/apps/{app}/volumes"))
        .bearer_auth(token)
        .json(&json!({ "name": name, "region": region, "size_gb": 1 }))
        .send()
        .await?;
    if !r.status().is_success() {
        let v: Value = r.json().await.unwrap_or(Value::Null);
        return Err(anyhow!("Fly: cannot create volume {name}: {}", api_error(&v, "volume create failed")));
    }
    log.line(format!("✓ Volume {name} created in {region} (1 GB)"));
    Ok(())
}

async fn fly_secret_names(bin: &str, token: &str, app: &str) -> Vec<String> {
    let out = tokio::process::Command::new(bin).args(["secrets", "list", "--app", app, "--json"]).env("FLY_API_TOKEN", token).output().await;
    let Ok(out) = out else { return vec![] };
    let v: Value = serde_json::from_slice(&out.stdout).unwrap_or(Value::Null);
    v.as_array()
        .map(|a| a.iter().filter_map(|x| x["Name"].as_str().or(x["name"].as_str()).map(String::from)).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod fly_toml_tests {
    #[test]
    fn reads_needs() {
        let t = "# fly secrets set ADMIN_TOKEN=$(openssl rand -hex 32)\napp = \"x\"\nprimary_region = \"sin\"\n[[mounts]]\n  source = \"fnb_data\"\n  destination = \"/data\"\n[[vm]]\n  size = \"a\"\n";
        let (r, m, s) = super::fly_toml_needs(t);
        assert_eq!(r, "sin");
        assert_eq!(m, vec!["fnb_data".to_string()]);
        assert_eq!(s, vec![("ADMIN_TOKEN".to_string(), 32)]);
    }
}

// ---------- creator uploads ----------

async fn require_repo_manager(db: &Db, user_id: &str, repo_id: &str) -> Result<platform::RepoRow> {
    let r = platform::get_repo(db, user_id, repo_id).await?.ok_or_else(|| anyhow!("Repo not found."))?;
    require_manager(db, &r.team_id, user_id).await?;
    Ok(r)
}

/// Commit an uploaded .zip / .tar(.gz) as the new HEAD of the repo.
pub async fn upload_archive(state: &AppState, user_id: &str, repo_id: &str, bytes: &[u8], message: &str) -> Result<String> {
    require_repo_manager(&state.db, user_id, repo_id).await?;
    if crate::github::linked_repo(&state.db, repo_id).await.is_some() {
        return Err(anyhow!("This listing is synced from GitHub — push to GitHub, then Sync."));
    }
    if bytes.is_empty() {
        return Err(anyhow!("Empty upload."));
    }
    let git_root = state.git_root.to_string_lossy().to_string();
    let bare = platform::ensure_bare_repo(&git_root, repo_id).await.map_err(|e| anyhow!(e))?;
    let tmp = std::env::temp_dir().join(format!("slaver-upload-{}", crate::util::new_id()));
    let res = upload_inner(&bare, &tmp, bytes, message).await;
    let _ = tokio::fs::remove_dir_all(&tmp).await;
    res
}

async fn upload_inner(bare: &Path, tmp: &Path, bytes: &[u8], message: &str) -> Result<String> {
    let unpack = tmp.join("unpack");
    tokio::fs::create_dir_all(&unpack).await?;
    if bytes.starts_with(b"PK\x03\x04") {
        let data = bytes.to_vec();
        let dest = unpack.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut z = zip::ZipArchive::new(std::io::Cursor::new(data))?;
            z.extract(&dest)?; // rejects paths escaping dest
            Ok(())
        })
        .await??;
    } else {
        let f = tmp.join("upload.tar");
        tokio::fs::write(&f, bytes).await?;
        let out = tokio::process::Command::new("tar").arg("-xf").arg(&f).arg("-C").arg(&unpack).output().await?;
        if !out.status.success() {
            return Err(anyhow!("Upload must be a .zip, .tar or .tar.gz archive."));
        }
    }
    // Strip a single wrapping folder (GitHub "Download ZIP" style).
    let mut root = unpack.clone();
    loop {
        let entries: Vec<_> = std::fs::read_dir(&root)?.filter_map(|e| e.ok()).filter(|e| e.file_name() != "__MACOSX" && e.file_name() != ".DS_Store").collect();
        if entries.len() == 1 && entries[0].file_type().map(|t| t.is_dir()).unwrap_or(false) && entries[0].file_name() != ".git" {
            root = entries[0].path();
        } else {
            break;
        }
    }
    let _ = tokio::fs::remove_dir_all(root.join(".git")).await;
    let _ = tokio::fs::remove_dir_all(root.join("__MACOSX")).await;

    let work = tmp.join("work");
    tokio::fs::create_dir_all(&work).await?;
    let bare_s = bare.to_string_lossy().to_string();
    let head_ref = run_git(&[&format!("--git-dir={bare_s}"), "symbolic-ref", "HEAD"], None).await.unwrap_or_else(|_| "refs/heads/main".to_string());
    let has_head = run_git(&[&format!("--git-dir={bare_s}"), "rev-parse", "--verify", "HEAD"], None).await.is_ok();
    run_git(&["init", "-q", "-b", "main"], Some(&work)).await?;
    if has_head {
        run_git(&["fetch", "-q", &bare_s, "HEAD"], Some(&work)).await?;
        run_git(&["reset", "-q", "--soft", "FETCH_HEAD"], Some(&work)).await?;
    }
    let out = tokio::process::Command::new("cp").arg("-R").arg(format!("{}/.", root.display())).arg(&work).output().await?;
    if !out.status.success() {
        return Err(anyhow!("Cannot stage uploaded files."));
    }
    run_git(&["add", "-A"], Some(&work)).await?;
    let msg = if message.trim().is_empty() { "Upload via Slaver" } else { message.trim() };
    let committed = run_git(&["-c", "user.name=Slaver Upload", "-c", "user.email=upload@slaver.local", "commit", "-q", "-m", msg], Some(&work)).await;
    if committed.is_err() && has_head {
        // Nothing changed.
        return run_git(&[&format!("--git-dir={bare_s}"), "rev-parse", "HEAD"], None).await;
    }
    committed?;
    run_git(&["push", "-q", &bare_s, &format!("HEAD:{head_ref}")], Some(&work)).await?;
    run_git(&["rev-parse", "HEAD"], Some(&work)).await
}

/// Replace the repo with a public https git repo's default branch.
pub async fn import_git(state: &AppState, user_id: &str, repo_id: &str, url: &str) -> Result<String> {
    require_repo_manager(&state.db, user_id, repo_id).await?;
    let url = url.trim();
    if !url.starts_with("https://") || url.contains(char::is_whitespace) || url.len() > 500 {
        return Err(anyhow!("Paste a public https:// git URL (e.g. https://github.com/you/app)."));
    }
    let git_root = state.git_root.to_string_lossy().to_string();
    let bare = platform::ensure_bare_repo(&git_root, repo_id).await.map_err(|e| anyhow!(e))?;
    let bare_s = format!("--git-dir={}", bare.display());
    let head_ref = run_git(&[&bare_s, "symbolic-ref", "HEAD"], None).await.unwrap_or_else(|_| "refs/heads/main".to_string());
    let refspec = format!("+HEAD:{head_ref}");
    let args = [bare_s.as_str(), "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "fetch", "-q", "--no-tags", url, refspec.as_str()];
    tokio::time::timeout(std::time::Duration::from_secs(180), run_git(&args, None))
        .await
        .map_err(|_| anyhow!("Import timed out."))?
        .map_err(|e| anyhow!("Import failed — is the repo public? ({e})"))?;
    run_git(&[&bare_s, "rev-parse", "HEAD"], None).await
}

// ---------- HTTP upload endpoint ----------

/// `POST /api/repos/:id/upload?message=…` with a .zip/.tar.gz body and
/// `Authorization: Bearer <token>`. Returns `{ "sha": "…" }`.
pub async fn upload_http(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: axum::http::HeaderMap,
    axum::extract::Path(repo_id): axum::extract::Path<String>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    use axum::{http::StatusCode, response::IntoResponse, Json};
    let auth = headers.get("authorization").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
    let Some(user_id) = crate::auth::bearer_sub_from_header(&state.jwt_secret, auth.as_deref()) else {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Sign in (Bearer token) required." }))).into_response();
    };
    match upload_archive(&state, &user_id, &repo_id, &body, q.get("message").map(|s| s.as_str()).unwrap_or("")).await {
        Ok(sha) => (StatusCode::OK, Json(json!({ "sha": sha }))).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() }))).into_response(),
    }
}
