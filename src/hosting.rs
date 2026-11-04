//! One-click install of a team's app (project repo HEAD) onto the team's own
//! hosting, plus the creator-side "upload a project" paths.
//!
//! Providers (all driven by their public HTTP APIs with the team's own token):
//!   - vercel      inline-file deployment (Vercel builds from source)
//!   - netlify     zip deploy of the static output
//!   - cloudflare  Pages direct upload of the static output
//!   - fly         `flyctl deploy --remote-only` (Dockerfile, or generated Caddy image for static sites)
//!
//! Optional `slaver.json` at the repo root:
//!   { "static_dir": "dist", "port": 8080 }
//!
//! Upload paths (creators): `git push`, zip/tar upload (HTTP + MCP), or import
//! from a public https git URL.

use anyhow::{anyhow, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use crate::{
    db::{v_text, Db},
    platform, store, AppState,
};

pub const PROVIDERS: [&str; 4] = ["vercel", "netlify", "cloudflare", "fly"];

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

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

async fn validate_token(provider: &str, token: &str, account_ref: &str) -> Result<String> {
    let c = client();
    match provider {
        "vercel" => {
            let r = c.get("https://api.vercel.com/v2/user").bearer_auth(token).send().await?;
            let ok = r.status().is_success();
            let v: Value = r.json().await.unwrap_or(Value::Null);
            if !ok {
                return Err(anyhow!("Vercel rejected the token."));
            }
            Ok(v["user"]["username"].as_str().unwrap_or("vercel").to_string())
        }
        "netlify" => {
            let r = c.get("https://api.netlify.com/api/v1/user").bearer_auth(token).send().await?;
            let ok = r.status().is_success();
            let v: Value = r.json().await.unwrap_or(Value::Null);
            if !ok {
                return Err(anyhow!("Netlify rejected the token."));
            }
            Ok(v["email"].as_str().or(v["full_name"].as_str()).unwrap_or("netlify").to_string())
        }
        "cloudflare" => {
            if account_ref.trim().is_empty() {
                return Err(anyhow!("Cloudflare needs your Account ID (dashboard → Workers & Pages → right sidebar)."));
            }
            let r = c
                .get(format!("https://api.cloudflare.com/client/v4/accounts/{}/pages/projects", account_ref.trim()))
                .bearer_auth(token)
                .send()
                .await?;
            if !r.status().is_success() {
                return Err(anyhow!("Cloudflare rejected the token (it needs Account → Cloudflare Pages → Edit)."));
            }
            Ok("cloudflare".to_string())
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
        "vercel" => deploy_vercel(&state.db, job, &token, &account_ref, &src, log).await,
        "netlify" => {
            let dir = static_dir(&src, &manifest)?;
            deploy_netlify(&state.db, job, &token, &dir, log).await
        }
        "cloudflare" => {
            let dir = static_dir(&src, &manifest)?;
            deploy_cloudflare(&state.db, job, &token, &account_ref, &dir, log).await
        }
        "fly" => deploy_fly(&state.db, job, &token, &account_ref, &src, &manifest, log).await,
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

/// All files under `root` as (posix relative path, bytes). Skips VCS + deps.
fn walk(root: &Path) -> Result<Vec<(String, Vec<u8>)>> {
    let mut out = Vec::new();
    let mut total: u64 = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            let ft = entry.file_type()?;
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                if name == ".git" || name == "node_modules" {
                    continue;
                }
                stack.push(entry.path());
            } else if ft.is_file() {
                let rel = entry.path().strip_prefix(root).map_err(|e| anyhow!("{e}"))?.to_string_lossy().replace('\\', "/");
                let bytes = std::fs::read(entry.path())?;
                total += bytes.len() as u64;
                if total > 200 * 1024 * 1024 {
                    return Err(anyhow!("Project is larger than 200 MB."));
                }
                out.push((rel, bytes));
            }
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    if out.is_empty() {
        return Err(anyhow!("No files to deploy."));
    }
    Ok(out)
}

fn content_type(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "application/javascript",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "txt" => "text/plain",
        "xml" => "application/xml",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

fn api_error(v: &Value, fallback: &str) -> String {
    v["error"]["message"]
        .as_str()
        .or_else(|| v["errors"][0]["message"].as_str())
        .or_else(|| v["message"].as_str())
        .unwrap_or(fallback)
        .to_string()
}

async fn tick() {
    tokio::time::sleep(std::time::Duration::from_secs(4)).await;
}

// ---------- Vercel ----------

async fn deploy_vercel(db: &Db, job: &InstallRow, token: &str, team_ref: &str, src: &Path, log: &mut Log) -> Result<(String, String)> {
    let files = walk(src)?;
    log.line(format!("→ Uploading {} files to Vercel project \"{}\"…", files.len(), job.site_name));
    set_install(db, &job.id, "running", &log.text, None, None).await;
    let q = if team_ref.trim().is_empty() { String::new() } else { format!("&teamId={}", team_ref.trim()) };
    let body = json!({
        "name": job.site_name,
        "target": "production",
        "files": files.iter().map(|(p, b)| json!({ "file": p, "data": b64().encode(b), "encoding": "base64" })).collect::<Vec<_>>(),
    });
    let c = client();
    let r = c
        .post(format!("https://api.vercel.com/v13/deployments?skipAutoDetectionConfirmation=1{q}"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await?;
    let ok = r.status().is_success();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    if !ok {
        return Err(anyhow!("Vercel: {}", api_error(&v, "deployment rejected")));
    }
    let dep_id = v["id"].as_str().unwrap_or("").to_string();
    log.line(format!("✓ Deployment {dep_id} created — Vercel is building…"));
    set_install(db, &job.id, "running", &log.text, None, None).await;
    for _ in 0..180 {
        tick().await;
        let r = c.get(format!("https://api.vercel.com/v13/deployments/{dep_id}?x=1{q}")).bearer_auth(token).send().await?;
        let v: Value = r.json().await.unwrap_or(Value::Null);
        match v["readyState"].as_str().unwrap_or("") {
            "READY" => {
                let host = v["alias"][0].as_str().or(v["url"].as_str()).unwrap_or("").to_string();
                return Ok((format!("https://{host}"), v["projectId"].as_str().unwrap_or(&dep_id).to_string()));
            }
            "ERROR" | "CANCELED" => {
                return Err(anyhow!("Vercel build failed: {} (open the deployment in your Vercel dashboard for build logs).", v["errorMessage"].as_str().unwrap_or("see dashboard")));
            }
            _ => {}
        }
    }
    Err(anyhow!("Vercel build is taking longer than 12 minutes — check your Vercel dashboard."))
}

// ---------- Netlify ----------

fn zip_dir(dir: &Path) -> Result<Vec<u8>> {
    use std::io::Write;
    let files = walk(dir)?;
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (p, b) in files {
            z.start_file(p, opts)?;
            z.write_all(&b)?;
        }
        z.finish()?;
    }
    Ok(buf.into_inner())
}

async fn deploy_netlify(db: &Db, job: &InstallRow, token: &str, dir: &Path, log: &mut Log) -> Result<(String, String)> {
    let c = client();
    let api = "https://api.netlify.com/api/v1";
    let mut site_id = job.external_id.clone();
    let mut site_url = String::new();
    if !site_id.is_empty() {
        let r = c.get(format!("{api}/sites/{site_id}")).bearer_auth(token).send().await?;
        if r.status().is_success() {
            let v: Value = r.json().await.unwrap_or(Value::Null);
            site_url = v["ssl_url"].as_str().or(v["url"].as_str()).unwrap_or("").to_string();
        } else {
            site_id.clear();
        }
    }
    if site_id.is_empty() {
        let mut name = job.site_name.clone();
        for attempt in 0..2 {
            let r = c.post(format!("{api}/sites")).bearer_auth(token).json(&json!({ "name": name })).send().await?;
            let ok = r.status().is_success();
            let v: Value = r.json().await.unwrap_or(Value::Null);
            if ok {
                site_id = v["id"].as_str().unwrap_or("").to_string();
                site_url = v["ssl_url"].as_str().or(v["url"].as_str()).unwrap_or("").to_string();
                break;
            }
            if attempt == 1 {
                return Err(anyhow!("Netlify: {}", api_error(&v, "cannot create site")));
            }
            name = format!("{}-{}", job.site_name, short_rand());
        }
        log.line(format!("✓ Netlify site created ({site_url})"));
    }
    let zip = zip_dir(dir)?;
    log.line(format!("→ Uploading {} KB…", zip.len() / 1024));
    set_install(db, &job.id, "running", &log.text, None, Some(&site_id)).await;
    let r = c
        .post(format!("{api}/sites/{site_id}/deploys"))
        .bearer_auth(token)
        .header("Content-Type", "application/zip")
        .body(zip)
        .send()
        .await?;
    let ok = r.status().is_success();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    if !ok {
        return Err(anyhow!("Netlify: {}", api_error(&v, "deploy rejected")));
    }
    let deploy_id = v["id"].as_str().unwrap_or("").to_string();
    for _ in 0..90 {
        let r = c.get(format!("{api}/deploys/{deploy_id}")).bearer_auth(token).send().await?;
        let v: Value = r.json().await.unwrap_or(Value::Null);
        match v["state"].as_str().unwrap_or("") {
            "ready" => return Ok((site_url, site_id)),
            "error" => return Err(anyhow!("Netlify: {}", v["error_message"].as_str().unwrap_or("deploy failed"))),
            _ => tick().await,
        }
    }
    Err(anyhow!("Netlify deploy is taking long — check your Netlify dashboard."))
}

// ---------- Cloudflare Pages ----------

fn cf_hash(path: &str, bytes: &[u8]) -> String {
    let ext = path.rsplit_once('.').map(|(_, e)| e).filter(|e| !e.contains('/')).unwrap_or("");
    let mut h = blake3::Hasher::new();
    h.update(b64().encode(bytes).as_bytes());
    h.update(ext.as_bytes());
    h.finalize().to_hex().as_str()[..32].to_string()
}

async fn deploy_cloudflare(db: &Db, job: &InstallRow, token: &str, account: &str, dir: &Path, log: &mut Log) -> Result<(String, String)> {
    let c = client();
    let account = account.trim();
    if account.is_empty() {
        return Err(anyhow!("Cloudflare account ID missing — reconnect Cloudflare with your Account ID."));
    }
    let base = format!("https://api.cloudflare.com/client/v4/accounts/{account}/pages/projects");
    let name = job.site_name.clone();
    let r = c.get(format!("{base}/{name}")).bearer_auth(token).send().await?;
    let mut project: Value = if r.status().is_success() { r.json().await.unwrap_or(Value::Null) } else { Value::Null };
    if project["result"].is_null() {
        let r = c.post(&base).bearer_auth(token).json(&json!({ "name": name, "production_branch": "main" })).send().await?;
        let ok = r.status().is_success();
        project = r.json().await.unwrap_or(Value::Null);
        if !ok {
            return Err(anyhow!("Cloudflare: {}", api_error(&project, "cannot create Pages project")));
        }
        log.line(format!("✓ Pages project \"{name}\" created"));
    }
    let subdomain = project["result"]["subdomain"].as_str().map(|s| s.to_string()).unwrap_or_else(|| format!("{name}.pages.dev"));

    let r = c.get(format!("{base}/{name}/upload-token")).bearer_auth(token).send().await?;
    let v: Value = r.json().await.unwrap_or(Value::Null);
    let jwt = v["result"]["jwt"].as_str().ok_or_else(|| anyhow!("Cloudflare: {}", api_error(&v, "no upload token")))?.to_string();

    let files = walk(dir)?;
    let mut manifest = serde_json::Map::new();
    let mut special: Vec<(String, Vec<u8>)> = Vec::new();
    let mut assets: Vec<(String, String, &Vec<u8>)> = Vec::new(); // (hash, path, bytes)
    for (p, b) in &files {
        if p == "_headers" || p == "_redirects" || p == "_routes.json" {
            special.push((p.clone(), b.clone()));
            continue;
        }
        if p == "_worker.js" || p.starts_with("functions/") {
            continue;
        }
        let h = cf_hash(p, b);
        manifest.insert(format!("/{p}"), Value::String(h.clone()));
        assets.push((h, p.clone(), b));
    }
    let hashes: Vec<String> = {
        let mut hs: Vec<String> = assets.iter().map(|a| a.0.clone()).collect();
        hs.sort();
        hs.dedup();
        hs
    };
    let r = c
        .post("https://api.cloudflare.com/client/v4/pages/assets/check-missing")
        .bearer_auth(&jwt)
        .json(&json!({ "hashes": hashes }))
        .send()
        .await?;
    let v: Value = r.json().await.unwrap_or(Value::Null);
    let missing: std::collections::HashSet<String> = v["result"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    log.line(format!("→ {} files, {} new to upload…", assets.len(), missing.len()));
    set_install(db, &job.id, "running", &log.text, None, None).await;

    let mut batch: Vec<Value> = Vec::new();
    let mut size = 0usize;
    let mut seen = std::collections::HashSet::new();
    let flush = |batch: Vec<Value>, jwt: String| {
        let c = c.clone();
        async move {
            let r = c.post("https://api.cloudflare.com/client/v4/pages/assets/upload").bearer_auth(&jwt).json(&batch).send().await?;
            if !r.status().is_success() {
                let v: Value = r.json().await.unwrap_or(Value::Null);
                return Err(anyhow!("Cloudflare upload: {}", api_error(&v, "failed")));
            }
            Ok::<(), anyhow::Error>(())
        }
    };
    for (h, p, b) in &assets {
        if !missing.contains(h) || !seen.insert(h.clone()) {
            continue;
        }
        let enc = b64().encode(b);
        size += enc.len();
        batch.push(json!({ "key": h, "value": enc, "metadata": { "contentType": content_type(p) }, "base64": true }));
        if batch.len() >= 50 || size > 30 * 1024 * 1024 {
            flush(std::mem::take(&mut batch), jwt.clone()).await?;
            size = 0;
        }
    }
    if !batch.is_empty() {
        flush(batch, jwt.clone()).await?;
    }
    let _ = c
        .post("https://api.cloudflare.com/client/v4/pages/assets/upsert-hashes")
        .bearer_auth(&jwt)
        .json(&json!({ "hashes": hashes }))
        .send()
        .await;

    let mut form = reqwest::multipart::Form::new()
        .text("manifest", Value::Object(manifest).to_string())
        .text("branch", "main");
    for (p, b) in special {
        form = form.part(p.clone(), reqwest::multipart::Part::bytes(b).file_name(p));
    }
    let r = c.post(format!("{base}/{name}/deployments")).bearer_auth(token).multipart(form).send().await?;
    let ok = r.status().is_success();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    if !ok {
        return Err(anyhow!("Cloudflare: {}", api_error(&v, "deployment rejected")));
    }
    let dep_id = v["result"]["id"].as_str().unwrap_or("").to_string();
    for _ in 0..60 {
        let r = c.get(format!("{base}/{name}/deployments/{dep_id}")).bearer_auth(token).send().await?;
        let v: Value = r.json().await.unwrap_or(Value::Null);
        let stage = &v["result"]["latest_stage"];
        match (stage["name"].as_str().unwrap_or(""), stage["status"].as_str().unwrap_or("")) {
            ("deploy", "success") => return Ok((format!("https://{subdomain}"), name)),
            (_, "failure") => return Err(anyhow!("Cloudflare deployment failed at stage {}.", stage["name"].as_str().unwrap_or("?"))),
            _ => tick().await,
        }
    }
    Ok((format!("https://{subdomain}"), name))
}

// ---------- Fly.io ----------

fn flyctl_bin() -> String {
    std::env::var("FLYCTL_PATH").unwrap_or_else(|_| "flyctl".to_string())
}

async fn deploy_fly(db: &Db, job: &InstallRow, token: &str, org: &str, src: &Path, m: &Manifest, log: &mut Log) -> Result<(String, String)> {
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
    Ok((format!("https://{app}.fly.dev"), app))
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
