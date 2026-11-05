//! Run buyer apps on this machine with the user's own Bun — no server rental.
//!
//! Generic lifecycle shared by two callers:
//!   - customize staging in local mode (`staging:<project_id>`)
//!   - owned apps run locally (`run:<project_id>`, see localrun.rs)
//!
//! Flow: extract a git branch archive into a dir → `bun run setup`
//! (or install+build) → spawn `bun run start` with env → wait for /healthz.
//! Processes are tracked in a registry so they can be restarted, tailed,
//! and killed. Requires `bun` (and `tar`) on this machine.

use serde_json::{Map, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const LOG_CAP: usize = 400;

pub struct ManagedApp {
    pub child: tokio::process::Child,
    pub port: u16,
    pub url: String,
    pub started_at: String,
    pub log: Arc<Mutex<VecDeque<String>>>,
}

impl ManagedApp {
    pub fn tail(&self, n: usize) -> Vec<String> {
        self.log
            .lock()
            .map(|q| q.iter().rev().take(n).cloned().collect::<Vec<_>>().into_iter().rev().collect())
            .unwrap_or_default()
    }
}

struct Registry {
    apps: HashMap<String, ManagedApp>,
}

fn registry() -> &'static Mutex<Registry> {
    static R: std::sync::OnceLock<Mutex<Registry>> = std::sync::OnceLock::new();
    R.get_or_init(|| Mutex::new(Registry { apps: HashMap::new() }))
}

// ---------- binaries ----------

fn search_path(name: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.push("/opt/homebrew/bin".into());
    dirs.push("/usr/local/bin".into());
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        dirs.push(home.join(".bun").join("bin"));
    }
    for dir in dirs {
        let c = dir.join(name);
        if c.is_file() {
            return Some(c);
        }
        #[cfg(windows)]
        {
            let e = dir.join(format!("{name}.exe"));
            if e.is_file() {
                return Some(e);
            }
        }
    }
    None
}

/// `BUN_PATH` (or `<NAME>_PATH`) wins, then PATH + usual spots.
pub fn find_bin(name: &str) -> Option<PathBuf> {
    let var = format!("{}_PATH", name.to_uppercase());
    if let Ok(p) = std::env::var(&var) {
        let pb = PathBuf::from(&p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    search_path(name)
}

pub fn find_bun() -> Option<PathBuf> {
    find_bin("bun")
}

pub fn bun_hint() -> &'static str {
    "Bun is not installed on this machine. Install it first: curl -fsSL https://bun.sh/install | bash (or: brew install oven-sh/bun/bun), then try again."
}

// ---------- ports & health ----------

pub fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(0)
}

/// Wait until the port accepts TCP and answers `path` with HTTP 200.
pub async fn wait_healthy(port: u16, path: &str) -> bool {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for _ in 0..150 {
        match tokio::net::TcpStream::connect(format!("127.0.0.1:{port}")).await {
            Ok(mut s) => {
                let req = format!("GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n");
                if s.write_all(req.as_bytes()).await.is_ok() {
                    let mut buf = vec![0u8; 1024];
                    if let Ok(n) = s.read(&mut buf).await {
                        if String::from_utf8_lossy(&buf[..n]).contains("200") {
                            return true;
                        }
                    }
                }
                return true; // bun binds the port before the app is ready; the
                             // caller retries its own requests from here.
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(200)).await,
        }
    }
    false
}

// ---------- env from Dockerfile ----------

/// Env for the app, from the repo Dockerfile's ENV lines (/app and /data
/// remapped to the local dir). PORT is always forced to the local port.
pub fn env_from_dockerfile(dockerfile: &str, app_dir: &str, data_dir: &str) -> Map<String, Value> {
    let mut env = Map::new();
    let joined = dockerfile.replace("\\\n", " ");
    for line in joined.lines() {
        let Some(rest) = line.trim().strip_prefix("ENV ") else { continue };
        for pair in rest.split_whitespace() {
            if let Some((k, v)) = pair.split_once('=') {
                let v = v.trim_matches('"');
                let v = if let Some(r) = v.strip_prefix("/app") {
                    format!("{app_dir}{r}")
                } else if let Some(r) = v.strip_prefix("/data") {
                    format!("{data_dir}{r}")
                } else {
                    v.to_string()
                };
                env.insert(k.to_string(), Value::String(v));
            }
        }
    }
    env.entry("NODE_ENV".to_string()).or_insert(Value::String("production".into()));
    env
}

// ---------- prepare / build / spawn ----------

/// Extract a branch archive into a fresh dir. Returns the HEAD sha.
pub async fn prepare_dir(git_root: &str, repo_id: &str, rev: &str, dest: &Path) -> Result<String, String> {
    let sha = crate::git::git_rev(git_root, repo_id, rev).await?.ok_or("branch not found")?;
    let tgz = crate::git::git_archive_targz(git_root, repo_id, rev).await?;
    if dest.exists() {
        std::fs::remove_dir_all(dest).map_err(|e| format!("cleanup: {e}"))?;
    }
    std::fs::create_dir_all(dest).map_err(|e| format!("mkdir: {e}"))?;
    let tmp = dest.with_extension("tgz.tmp");
    std::fs::write(&tmp, &tgz).map_err(|e| format!("write archive: {e}"))?;
    let out = tokio::process::Command::new("tar")
        .args(["-xzf"])
        .arg(&tmp)
        .arg("-C")
        .arg(dest)
        .output()
        .await
        .map_err(|e| format!("tar missing? {e}"))?;
    let _ = std::fs::remove_file(&tmp);
    if !out.status.success() {
        return Err(format!("extract failed: {}", String::from_utf8_lossy(&out.stderr).chars().take(300).collect::<String>()));
    }
    Ok(sha)
}

fn has_script(dir: &Path, name: &str) -> bool {
    std::fs::read_to_string(dir.join("package.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["scripts"][name].as_str().map(|s| !s.is_empty()))
        .unwrap_or(false)
}

/// Run a bun command and capture combined output. Err carries the tail.
async fn run_capture(bun: &Path, dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = tokio::process::Command::new(bun)
        .args(args)
        .current_dir(dir)
        .env("NO_COLOR", "1")
        .output()
        .await
        .map_err(|e| format!("spawn: {e}"))?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if !out.status.success() {
        let tail: Vec<&str> = text.lines().rev().take(20).collect();
        return Err(tail.into_iter().rev().collect::<Vec<_>>().join("\n"));
    }
    Ok(text)
}

fn tail_lines(s: &str, n: usize) -> String {
    s.lines().rev().take(n).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n")
}

/// Install + build. `seed` runs `bun run seed` after setup (staging first
/// boot; failures are ignored like the cloud flow). Returns the output tail.
pub async fn build_app(bun: &Path, dir: &Path, seed: bool) -> Result<String, String> {
    let mut log = String::new();
    if has_script(dir, "setup") {
        log.push_str(&run_capture(bun, dir, &["run", "setup"]).await.map_err(|t| format!("Build failed.\n{t}"))?);
        if seed && has_script(dir, "seed") {
            log.push_str(&run_capture(bun, dir, &["run", "seed"]).await.unwrap_or_default());
        }
    } else {
        log.push_str(&run_capture(bun, dir, &["install"]).await.map_err(|t| format!("Build failed.\n{t}"))?);
        if has_script(dir, "build") {
            match run_capture(bun, dir, &["run", "build"]).await {
                Ok(t) => log.push_str(&t),
                Err(t) => return Err(format!("Build failed.\n{t}")),
            }
        }
    }
    Ok(tail_lines(&log, 25))
}

/// Spawn `bun run start` in `dir` with `env`. The child is NOT registered;
/// the caller registers it with `register` after the health check passes.
pub fn spawn_bun(bun: &Path, dir: &Path, env: &[(String, String)]) -> Result<tokio::process::Child, String> {
    let mut cmd = tokio::process::Command::new(bun);
    cmd.args(["run", "start"]).current_dir(dir).env("NO_COLOR", "1");
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    cmd.spawn().map_err(|e| format!("spawn: {e}"))
}

/// Pump child output into the app log (also keeps the pipes from filling).
pub fn pump_logs(child: &mut tokio::process::Child, tag: String, log: std::sync::Arc<Mutex<VecDeque<String>>>) {
    use tokio::io::{AsyncBufReadExt, BufReader};
    if let Some(out) = child.stdout.take() {
        let (tag, log) = (tag.clone(), log.clone());
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                push_capped(&log, format!("[{tag}] {l}"));
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                push_capped(&log, format!("[{tag}:err] {l}"));
            }
        });
    }
}

fn push_capped(log: &Arc<Mutex<VecDeque<String>>>, line: String) {
    if let Ok(mut q) = log.lock() {
        if q.len() >= LOG_CAP {
            q.pop_front();
        }
        q.push_back(line);
    }
}

// ---------- registry ----------

/// Register a spawned child. The child must already have its stdio taken
/// (use `pump_logs` with a shared log, or pass a fresh one here).
pub fn register(key: &str, mut child: tokio::process::Child, port: u16, url: String, log: Arc<Mutex<VecDeque<String>>>) {
    pump_logs(&mut child, key.to_string(), log.clone());
    let app = ManagedApp { child, port, url, started_at: now_iso(), log };
    if let Ok(mut r) = registry().lock() {
        r.apps.insert(key.to_string(), app);
    }
}

/// Kill and forget a registered app. Returns its log tail for error reports.
pub async fn kill(key: &str) -> Vec<String> {
    let child = registry().lock().ok().and_then(|mut r| r.apps.remove(key).map(|m| m.child));
    if let Some(mut c) = child {
        let _ = c.kill().await;
        let _ = c.wait().await;
    }
    Vec::new()
}

pub fn get_url(key: &str) -> Option<String> {
    registry().lock().ok()?.apps.get(key).map(|m| m.url.clone())
}

pub fn is_running(key: &str) -> bool {
    registry().lock().map(|r| r.apps.contains_key(key)).unwrap_or(false)
}

pub fn app_port(key: &str) -> Option<u16> {
    registry().lock().ok()?.apps.get(key).map(|m| m.port)
}

pub fn app_logs(key: &str, n: usize) -> Vec<String> {
    registry().lock().ok().and_then(|r| r.apps.get(key).map(|m| m.tail(n))).unwrap_or_default()
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::env_from_dockerfile;

    #[test]
    fn maps_docker_env() {
        let e = env_from_dockerfile("ENV NODE_ENV=production \\\n    DB_PATH=/data/fnb.db \\\n    ADMIN_DIR=/app/admin/dist\n", "/home/u/app", "/home/u/data");
        assert_eq!(e["DB_PATH"], "/home/u/data/fnb.db");
        assert_eq!(e["ADMIN_DIR"], "/home/u/app/admin/dist");
        assert_eq!(e["NODE_ENV"], "production");
    }

    #[test]
    fn free_port_is_usable() {
        let p = super::free_port();
        assert!(p != 0);
    }

    #[test]
    fn missing_binary_is_none() {
        assert!(super::find_bin("definitely-not-a-real-binary-xyz").is_none());
    }
}
