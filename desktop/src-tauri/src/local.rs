//! Local execution for the desktop app: clone a repo from the Slaver server,
//! build with the user's Bun, run it, publish via the user's Cloudflare.
//! Same machine, same data as the web version — only the execution is local.

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const LOG_CAP: usize = 400;

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

fn find_bin(name: &str) -> Option<PathBuf> {
    if let Ok(p) = std::env::var(format!("{}_PATH", name.to_uppercase())) {
        let pb = PathBuf::from(&p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    search_path(name)
}

fn probe(path: &PathBuf) -> Option<String> {
    let out = std::process::Command::new(path).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let t = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if t.is_empty() {
        None
    } else {
        Some(t.lines().next().unwrap_or("").trim().to_string())
    }
}

#[derive(Serialize, Clone)]
pub struct DepInfo {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

fn dep(name: &str) -> DepInfo {
    match find_bin(name) {
        Some(p) => {
            let v = probe(&p);
            DepInfo { found: v.is_some(), path: Some(p.to_string_lossy().to_string()), version: v }
        }
        None => DepInfo { found: false, path: None, version: None },
    }
}

#[derive(Serialize, Clone)]
pub struct Deps {
    pub bun: DepInfo,
    pub git: DepInfo,
    pub cloudflared: DepInfo,
}

pub fn check_deps() -> Deps {
    Deps { bun: dep("bun"), git: dep("git"), cloudflared: dep("cloudflared") }
}

pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::getrandom(&mut buf).expect("rng");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------- ports & health ----------

pub fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(0)
}

async fn wait_healthy(port: u16) -> bool {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for path in ["/healthz", "/"] {
        for _ in 0..75 {
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
                    break;
                }
                Err(_) => tokio::time::sleep(std::time::Duration::from_millis(200)).await,
            }
        }
    }
    // Port open but no 200 yet — bun binds before the app is ready; the UI retries.
    tokio::net::TcpStream::connect(format!("127.0.0.1:{port}")).await.is_ok()
}

// ---------- registry ----------

struct ManagedApp {
    child: tokio::process::Child,
    port: u16,
    url: String,
    log: Arc<Mutex<VecDeque<String>>>,
}

struct Registry {
    apps: HashMap<String, ManagedApp>,
    tunnel: Option<TunnelProc>,
}

struct TunnelProc {
    child: tokio::process::Child,
    url: String,
    started_at: String,
}

fn registry() -> &'static Mutex<Registry> {
    static R: std::sync::OnceLock<Mutex<Registry>> = std::sync::OnceLock::new();
    R.get_or_init(|| Mutex::new(Registry { apps: HashMap::new(), tunnel: None }))
}

fn push_capped(log: &Arc<Mutex<VecDeque<String>>>, line: String) {
    if let Ok(mut q) = log.lock() {
        if q.len() >= LOG_CAP {
            q.pop_front();
        }
        q.push_back(line);
    }
}

fn pump(child: &mut tokio::process::Child, tag: String, log: Arc<Mutex<VecDeque<String>>>) {
    use tokio::io::{AsyncBufReadExt, BufReader};
    if let Some(out) = child.stdout.take() {
        let (tag, log) = (tag.clone(), log.clone());
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                push_capped(&log, format!("[{tag}] {l}"));
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                push_capped(&log, format!("[{tag}:err] {l}"));
            }
        });
    }
}

// ---------- git ----------

fn git(dir: &PathBuf, args: &[&str], extra_env: &[(&str, &str)]) -> Result<String, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args).current_dir(dir).env("GIT_TERMINAL_PROMPT", "0");
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let out = cmd.output().map_err(|e| format!("git not available: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).chars().take(300).collect());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// ---------- public ops ----------

#[derive(Serialize, Clone)]
pub struct RunInfo {
    pub running: bool,
    pub url: Option<String>,
    pub port: Option<u16>,
}

fn has_script(dir: &PathBuf, name: &str) -> bool {
    std::fs::read_to_string(dir.join("package.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v["scripts"][name].as_str().map(|s| !s.is_empty()))
        .unwrap_or(false)
}

async fn build(bun: &PathBuf, dir: &PathBuf, log: &Arc<Mutex<VecDeque<String>>>) -> Result<(), String> {
    let steps: Vec<Vec<&str>> = if has_script(dir, "setup") {
        vec![vec!["run", "setup"]]
    } else {
        let mut s = vec![vec!["install"]];
        if has_script(dir, "build") {
            s.push(vec!["run", "build"]);
        }
        s
    };
    for args in steps {
        push_capped(log, format!("[desktop] bun {}", args.join(" ")));
        let out = tokio::process::Command::new(bun)
            .args(&args)
            .current_dir(dir)
            .env("NO_COLOR", "1")
            .output()
            .await
            .map_err(|e| format!("build spawn: {e}"))?;
        let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        for l in text.lines().rev().take(10).collect::<Vec<_>>().into_iter().rev() {
            push_capped(log, format!("[build] {l}"));
        }
        if !out.status.success() {
            let tail: Vec<&str> = text.lines().rev().take(20).collect();
            return Err(format!("Build failed:\n{}", tail.into_iter().rev().collect::<Vec<_>>().join("\n")));
        }
    }
    Ok(())
}

/// Clone (or update) `clone_url` at `branch`, build, and run `bun run start`.
/// Untracked files (like the app DB) survive updates.
pub async fn run_app(data_root: PathBuf, key: String, clone_url: String, jwt: String, branch: String) -> Result<RunInfo, String> {
    let _ = stop_app(&key).await;
    let bun = find_bin("bun").ok_or_else(|| "Bun is not installed. Install it: curl -fsSL https://bun.sh/install | bash (or brew install oven-sh/bun/bun).".to_string())?;
    if find_bin("git").is_none() {
        return Err("git is not installed.".to_string());
    }
    let dir = data_root.join("runs").join(&key);
    std::fs::create_dir_all(dir.parent().unwrap()).map_err(|e| format!("mkdir: {e}"))?;
    let auth = format!("Authorization: Bearer {jwt}");
    if dir.join(".git").is_dir() {
        git(&dir, &["fetch", "origin"], &[("GIT_HTTP_EXTRAHEADER", &auth)]).map_err(|e| format!("fetch: {e}"))?;
        let target = if branch.is_empty() || branch == "HEAD" { "origin/HEAD".to_string() } else { format!("origin/{branch}") };
        git(&dir, &["reset", "--hard", &target], &[]).map_err(|e| format!("reset: {e}"))?;
    } else {
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|e| format!("cleanup: {e}"))?;
        }
        let mut cmd = std::process::Command::new("git");
        cmd.args(["clone", "--depth", "1"]).arg(&clone_url).arg(&dir).env("GIT_TERMINAL_PROMPT", "0").env("GIT_HTTP_EXTRAHEADER", &auth);
        if !branch.is_empty() && branch != "HEAD" {
            cmd.args(["--branch", &branch]);
        }
        let out = cmd.output().map_err(|e| format!("git not available: {e}"))?;
        if !out.status.success() {
            return Err(format!("Clone failed: {}", String::from_utf8_lossy(&out.stderr).chars().take(300).collect::<String>()));
        }
    }

    let log: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    build(&bun, &dir, &log).await?;

    let port = free_port();
    if port == 0 {
        return Err("No free port.".to_string());
    }
    let mut env: Vec<(String, String)> = vec![
        ("PORT".into(), port.to_string()),
        ("NO_COLOR".into(), "1".into()),
        ("ADMIN_TOKEN".into(), random_hex(32)),
        ("DB_PATH".into(), dir.join("data").join("app.db").to_string_lossy().to_string()),
    ];
    if let Ok(k) = std::env::var("MODEL_API_KEY") {
        if !k.trim().is_empty() {
            env.push(("MODEL_API_KEY".into(), k));
        }
    }
    let mut child = tokio::process::Command::new(&bun)
        .arg("run")
        .arg("start")
        .current_dir(&dir)
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn: {e}"))?;
    pump(&mut child, key.clone(), log.clone());
    let url = format!("http://127.0.0.1:{port}");
    if let Ok(mut r) = registry().lock() {
        r.apps.insert(key.clone(), ManagedApp { child, port, url: url.clone(), log });
    }
    if !wait_healthy(port).await {
        let tail = app_logs(&key, 20).join("\n");
        let _ = stop_app(&key).await;
        return Err(format!("The app did not answer on port {port}.\n{tail}"));
    }
    Ok(RunInfo { running: true, url: Some(url), port: Some(port) })
}

pub async fn stop_app(key: &str) -> Result<RunInfo, String> {
    let child = registry().lock().ok().and_then(|mut r| r.apps.remove(key).map(|m| m.child));
    if let Some(mut c) = child {
        let _ = c.kill().await;
    }
    Ok(RunInfo { running: false, url: None, port: None })
}

pub fn app_status(key: &str) -> RunInfo {
    match registry().lock().ok().and_then(|r| r.apps.get(key).map(|m| (m.url.clone(), m.port))) {
        Some((url, port)) => RunInfo { running: true, url: Some(url), port: Some(port) },
        None => RunInfo { running: false, url: None, port: None },
    }
}

pub fn app_logs(key: &str, n: usize) -> Vec<String> {
    registry()
        .lock()
        .ok()
        .and_then(|r| r.apps.get(key).map(|m| m.log.lock().map(|q| q.iter().rev().take(n.clamp(1, 200)).cloned().collect::<Vec<_>>().into_iter().rev().collect()).unwrap_or_default()))
        .unwrap_or_default()
}

// ---------- tunnel ----------

#[derive(Serialize, Clone, Default)]
pub struct TunnelInfo {
    pub running: bool,
    pub url: Option<String>,
    pub mode: Option<String>,
    pub started_at: Option<String>,
}

fn extract_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let rest = &line[start + 8..];
    let end = rest.find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '|').unwrap_or(rest.len());
    let host = &rest[..end];
    if host.ends_with(".trycloudflare.com") && !host.contains('/') {
        return Some(format!("https://{host}"));
    }
    None
}

pub fn tunnel_status() -> TunnelInfo {
    match registry().lock().ok().and_then(|r| r.tunnel.as_ref().map(|t| (t.url.clone(), t.started_at.clone()))) {
        Some((url, started_at)) => TunnelInfo { running: true, url: Some(url), mode: Some("quick".to_string()), started_at: Some(started_at) },
        None => TunnelInfo::default(),
    }
}

pub async fn tunnel_start(port: u16) -> Result<TunnelInfo, String> {
    if registry().lock().map_err(|e| e.to_string())?.tunnel.is_some() {
        return Err("A tunnel is already running — stop it first.".to_string());
    }
    let cf = find_bin("cloudflared").ok_or_else(|| "cloudflared is not installed. Install it: brew install cloudflared.".to_string())?;
    let mut child = tokio::process::Command::new(&cf)
        .args(["tunnel", "--no-autoupdate", "--url", &format!("http://127.0.0.1:{port}")])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run cloudflared: {e}"))?;
    let mut stderr = child.stderr.take().ok_or("could not read cloudflared output")?;
    let url = tokio::time::timeout(std::time::Duration::from_secs(60), async {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut lines = BufReader::new(&mut stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(u) = extract_url(&line) {
                return Some(u);
            }
        }
        None
    })
    .await
    .map_err(|_| "cloudflared timed out — check the internet connection.".to_string())?
    .ok_or("cloudflared exited before giving a URL.".to_string())?;
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut lines = BufReader::new(stderr).lines();
        while lines.next_line().await.ok().flatten().is_some() {}
    });
    let started_at = format!("{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
    registry().lock().map_err(|e| e.to_string())?.tunnel.replace(TunnelProc { child, url: url.clone(), started_at: started_at.clone() });
    Ok(TunnelInfo { running: true, url: Some(url), mode: Some("quick".to_string()), started_at: Some(started_at) })
}

pub async fn tunnel_stop() -> TunnelInfo {
    let child = registry().lock().ok().and_then(|mut r| r.tunnel.take().map(|t| t.child));
    if let Some(mut c) = child {
        let _ = c.kill().await;
    }
    TunnelInfo::default()
}

#[cfg(test)]
mod tests {
    use super::extract_url;

    #[test]
    fn finds_url() {
        assert_eq!(extract_url("INF |  https://brave-tiger-42.trycloudflare.com  |"), Some("https://brave-tiger-42.trycloudflare.com".to_string()));
        assert_eq!(extract_url("https://example.com"), None);
    }

    /// Full lifecycle against a fixture bun app in a local git repo
    /// (file:// clone, no server needed).
    #[tokio::test]
    async fn runs_and_stops_a_fixture_app() {
        let tmp = std::env::temp_dir().join(format!("slaver-desk-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let src = tmp.join("fixture");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("package.json"), r#"{"name":"fixture","scripts":{"start":"bun server.ts"}}"#).unwrap();
        std::fs::write(src.join("server.ts"), "Bun.serve({port:Number(process.env.PORT||0),fetch:()=>new Response('ok')});\n").unwrap();
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&src)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_SYSTEM", "/dev/null")
                .output()
        };
        git(&["init", "-q", "-b", "main"]).unwrap();
        git(&["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]).unwrap();
        git(&["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]).unwrap();

        let data = tmp.join("data");
        let info = super::run_app(data, "fixture-app".to_string(), format!("file://{}", src.display()), String::new(), String::new())
            .await
            .expect("run fixture");
        assert!(info.running);
        let port = info.port.expect("port");
        let body = reqwest::get(format!("http://127.0.0.1:{port}/")).await.expect("get").text().await.expect("body");
        assert_eq!(body, "ok");
        let st = super::app_status("fixture-app");
        assert!(st.running && st.port == Some(port));
        assert!(!super::app_logs("fixture-app", 5).is_empty());
        super::stop_app("fixture-app").await.expect("stop");
        assert!(!super::app_status("fixture-app").running);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
