//! Expose a local app to the public internet through the user's OWN
//! Cloudflare account (or nobody's account for quick tunnels).
//!
//! Quick tunnel: `cloudflared tunnel --url http://127.0.0.1:PORT` prints an
//! instant https://*.trycloudflare.com URL. No account needed — good for
//! demos. The URL changes every restart; for a permanent hostname the user
//! follows the named-tunnel tutorial in the UI (their own domain).

use serde::Serialize;
use std::sync::Mutex;

#[derive(Serialize, Clone, Default)]
pub struct TunnelInfo {
    pub running: bool,
    pub url: Option<String>,
    pub mode: Option<String>,
    pub started_at: Option<String>,
}

struct ActiveTunnel {
    child: tokio::process::Child,
    url: String,
    started_at: String,
}

fn current() -> &'static Mutex<Option<ActiveTunnel>> {
    static C: std::sync::OnceLock<Mutex<Option<ActiveTunnel>>> = std::sync::OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

/// Scan a cloudflared log line for the public https URL.
pub fn extract_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let rest = &line[start + 8..];
    let end = rest.find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '|').unwrap_or(rest.len());
    let host = &rest[..end];
    if host.ends_with(".trycloudflare.com") && !host.contains('/') {
        return Some(format!("https://{host}"));
    }
    None
}

pub fn status() -> TunnelInfo {
    match current().lock().ok().and_then(|m| m.as_ref().map(|t| (t.url.clone(), t.started_at.clone()))) {
        Some((url, started_at)) => TunnelInfo { running: true, url: Some(url), mode: Some("quick".to_string()), started_at: Some(started_at) },
        None => TunnelInfo::default(),
    }
}

fn cloudflared() -> Result<std::path::PathBuf, String> {
    crate::localapp::find_bin("cloudflared").ok_or_else(|| {
        "cloudflared is not installed on this machine. Install it (brew install cloudflared, or https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), then try again.".to_string()
    })
}

pub async fn start_quick(port: u16) -> Result<TunnelInfo, String> {
    if current().lock().map_err(|e| e.to_string())?.is_some() {
        return Err("A tunnel is already running — stop it first.".to_string());
    }
    let cf = cloudflared()?;
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

    let started_at = chrono::Utc::now().to_rfc3339();
    current().lock().map_err(|e| e.to_string())?.replace(ActiveTunnel { child, url: url.clone(), started_at: started_at.clone() });
    Ok(TunnelInfo { running: true, url: Some(url), mode: Some("quick".to_string()), started_at: Some(started_at) })
}

pub async fn stop() -> TunnelInfo {
    let child = current().lock().ok().and_then(|mut c| c.take().map(|t| t.child));
    if let Some(mut c) = child {
        let _ = c.kill().await;
    }
    TunnelInfo::default()
}

#[cfg(test)]
mod tests {
    use super::extract_url;

    #[test]
    fn finds_quick_tunnel_url() {
        assert_eq!(extract_url("INF +----+"), None);
        assert_eq!(
            extract_url("INF |  https://brave-tiger-42.trycloudflare.com  |"),
            Some("https://brave-tiger-42.trycloudflare.com".to_string())
        );
    }

    #[test]
    fn ignores_other_urls() {
        assert_eq!(extract_url("https://example.com/x"), None);
        assert_eq!(extract_url("https://foo.trycloudflare.com/a/b"), None);
        assert_eq!(extract_url("nothing here"), None);
    }
}
