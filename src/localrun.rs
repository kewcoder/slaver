//! Run an owned app on this machine (HEAD of the project's repo) and stop it.
//!
//! The desktop app (and any self-hosted server with Bun) uses this instead of
//! Fly/Sprites: the buyer truly runs their copy locally. Ports are stable per
//! project (stored in `local_runs`); the project's `dev_url` is pointed at
//! the local URL while running. Publish to the internet via `tunnel_*` tools.

use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

use crate::db::{v_int, v_text, Db};
use crate::localapp;
use crate::{platform, AppState};

fn key(project_id: &str) -> String {
    format!("run:{project_id}")
}

fn run_dir(state: &AppState, project_id: &str) -> std::path::PathBuf {
    state.workspace_dir.join("run").join(project_id)
}

fn run_data_dir(state: &AppState, project_id: &str) -> std::path::PathBuf {
    state.workspace_dir.join("run-data").join(project_id)
}

fn save_row(db: &Db, project_id: &str, port: u16, status: &str, log: &str) {
    let db = db.clone();
    let (pid, st, lg) = (project_id.to_string(), status.to_string(), log.chars().take(8000).collect::<String>());
    tokio::spawn(async move {
        let r = db
            .prepare("INSERT INTO local_runs (project_id, port, status, log, updated_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(project_id) DO UPDATE SET port = excluded.port, status = excluded.status, log = excluded.log, updated_at = excluded.updated_at")
            .bind(&[v_text(&pid), v_int(port as i64), v_text(&st), v_text(&lg)]);
        if let Ok(stmt) = r {
            let _ = stmt.run().await;
        }
    });
}

pub async fn status(state: &AppState, user_id: &str, project_id: &str) -> Result<Value, String> {
    let p = platform::get_project(&state.db, user_id, project_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("App not found.")?;
    if p.repo_id.is_empty() {
        return Err("This app has no source code.".to_string());
    }
    let k = key(project_id);
    let running = localapp::is_running(&k);
    let (url, port) = match (running, localapp::get_url(&k), localapp::app_port(&k)) {
        (true, Some(u), Some(pt)) => (Some(u), Some(pt)),
        _ => (None, None),
    };
    Ok(json!({ "project_id": project_id, "running": running, "url": url, "port": port }))
}

pub async fn start(state: &AppState, user_id: &str, project_id: &str) -> Result<Value, String> {
    let p = platform::get_project(&state.db, user_id, project_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("App not found.")?;
    if p.repo_id.is_empty() {
        return Err("This app has no source code.".to_string());
    }
    let k = key(project_id);
    if localapp::is_running(&k) {
        return status(state, user_id, project_id).await;
    }
    let bun = localapp::find_bun().ok_or_else(|| localapp::bun_hint().to_string())?;
    let dir = run_dir(state, project_id);
    let data_dir = run_data_dir(state, project_id);
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("mkdir data: {e}"))?;
    let git_root = state.git_root.to_string_lossy().to_string();

    // Stable port per project; re-pick when something else took it.
    let port: u16 = {
        let row: Option<Value> = state
            .db
            .prepare("SELECT port FROM local_runs WHERE project_id = ?")
            .bind(&[v_text(project_id)])
            .map_err(|e| e.to_string())?
            .first(None)
            .await
            .map_err(|e| e.to_string())?;
        row.and_then(|r| r.get("port").and_then(|v| v.as_i64()).map(|n| n as u16)).unwrap_or(0)
    };
    let mut port = if port != 0 && std::net::TcpListener::bind(format!("127.0.0.1:{port}")).is_ok() { port } else { localapp::free_port() };
    if port == 0 {
        return Err("No free port.".to_string());
    }

    localapp::prepare_dir(&git_root, &p.repo_id, "HEAD", &dir).await?;
    if let Err(e) = localapp::build_app(&bun, &dir, false).await {
        return Err(format!("Build failed. {e}"));
    }

    let dir_s = dir.to_string_lossy().to_string();
    let data_s = data_dir.to_string_lossy().to_string();
    let mut env = localapp::env_from_dockerfile(
        &crate::git::git_read_file_at(&git_root, &p.repo_id, "HEAD", "Dockerfile").await?.unwrap_or_default(),
        &dir_s,
        &data_s,
    );
    env.insert("PORT".into(), Value::String(port.to_string()));
    env.insert("DB_PATH".into(), Value::String(data_dir.join("app.db").to_string_lossy().to_string()));
    let mut tb = [0u8; 32];
    getrandom::getrandom(&mut tb).map_err(|e| format!("random: {e}"))?;
    env.insert("ADMIN_TOKEN".into(), Value::String(hex::encode(tb)));
    if let Ok(mk) = std::env::var("MODEL_API_KEY") {
        if !mk.trim().is_empty() {
            env.insert("MODEL_API_KEY".into(), Value::String(mk));
        }
    }
    let env_vec: Vec<(String, String)> = env.into_iter().filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string()))).collect();
    let child = localapp::spawn_bun(&bun, &dir, &env_vec)?;
    let url = format!("http://127.0.0.1:{port}");
    let log = Arc::new(Mutex::new(std::collections::VecDeque::new()));
    localapp::register(&k, child, port, url.clone(), log);
    if !localapp::wait_healthy(port, "/healthz").await {
        let tail = localapp::app_logs(&k, 20).join("\n");
        localapp::kill(&k).await;
        save_row(&state.db, project_id, port, "failed", &tail);
        return Err(format!("The app did not answer on port {port}.\n{tail}"));
    }
    // Re-check the port actually stuck (paranoia against a race).
    port = localapp::app_port(&k).unwrap_or(port);
    save_row(&state.db, project_id, port, "running", "");
    // Best effort: non-managers cannot set dev_url, the run still works.
    let _ = platform::set_project_urls(&state.db, user_id, project_id, None, Some(&url)).await;
    status(state, user_id, project_id).await
}

pub async fn stop(state: &AppState, user_id: &str, project_id: &str) -> Result<Value, String> {
    platform::get_project(&state.db, user_id, project_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("App not found.")?;
    let k = key(project_id);
    let tail = localapp::app_logs(&k, 30).join("\n");
    localapp::kill(&k).await;
    save_row(&state.db, project_id, 0, "stopped", &tail);
    Ok(json!({ "project_id": project_id, "running": false }))
}

pub async fn logs(state: &AppState, user_id: &str, project_id: &str, n: usize) -> Result<Value, String> {
    platform::get_project(&state.db, user_id, project_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("App not found.")?;
    let lines = localapp::app_logs(&key(project_id), n.clamp(1, 200));
    Ok(json!({ "project_id": project_id, "lines": lines }))
}
