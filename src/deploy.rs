//! Deploy a project's repo HEAD to a user's VPS over SSH.
//!
//! Flow: export `git archive HEAD` -> transfer -> `docker compose up -d --build`
//! -> verify containers running. Runs in background; progress lands in the
//! deployments row (poll `deployments_list`).

use crate::{platform, store, AppState};

/// Validate, create the deployment row, and spawn the background job.
/// Returns the deployment row for polling.
pub async fn start_deploy(state: AppState, user_id: String, project_id: String, vps_id: String) -> Result<platform::DeployRow, String> {
    let db = &state.db;
    let project = platform::get_project(db, &user_id, &project_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Project not found.".to_string())?;
    if project.repo_id.is_empty() {
        return Err("Project has no repo yet — create one and push code first.".to_string());
    }
    store::membership(db, &project.team_id, &user_id)
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| match r.as_deref() {
            Some("owner") | Some("admin") => Ok(()),
            _ => Err("Only owners and admins can deploy.".to_string()),
        })?;
    let (vps, _key) = platform::get_vps_secret(db, &project.team_id, &user_id, &vps_id)
        .await
        .map_err(|e| e.to_string())?;
    let _ = vps;
    // HEAD must exist (non-empty repo).
    let git_root = state.git_root.clone().to_string_lossy().to_string();
    let sha: String = crate::git::git_head_sha(&git_root, &project.repo_id)
        .await
        .map_err(|e| e)?
        .ok_or_else(|| "Repo is empty — push code first.".to_string())?;
    let dep = platform::create_deployment(db, &project_id, &vps_id, &sha)
        .await
        .map_err(|e| e.to_string())?;
    let st = state.clone();
    let dep_id = dep.id.clone();
    tokio::spawn(async move {
        run_deploy(st, dep_id, user_id, project_id, vps_id).await;
    });
    Ok(dep)
}

async fn ssh(state: &AppState, team_id: &str, user_id: &str, vps_id: &str, key_path: &std::path::Path, remote_cmd: &str) -> Result<String, String> {
    let (vps, _) = platform::get_vps_secret(&state.db, team_id, user_id, vps_id)
        .await
        .map_err(|e| e.to_string())?;
    let target = format!("{}@{}", vps.ssh_user, vps.host);
    let out = tokio::process::Command::new("ssh")
        .arg("-i")
        .arg(key_path)
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=15")
        .arg(&target)
        .arg(remote_cmd)
        .output()
        .await
        .map_err(|e| format!("ssh failed: {e}"))?;
    let mut log = format!("$ ssh {target} {remote_cmd}\n{}", String::from_utf8_lossy(&out.stdout));
    if !out.stderr.is_empty() {
        log.push_str(&format!("\n[stderr]\n{}", String::from_utf8_lossy(&out.stderr)));
    }
    if !out.status.success() {
        return Err(format!("{log}\n(exit {})", out.status.code().unwrap_or(-1)));
    }
    Ok(log)
}

async fn run_deploy(state: AppState, deploy_id: String, user_id: String, project_id: String, vps_id: String) {
    let db = &state.db;
    let mut log = String::new();
    let fail = |db: &crate::db::Db, deploy_id: &str, log: &str| {
        let db = db.clone();
        let deploy_id = deploy_id.to_string();
        let log = log.to_string();
        async move {
            let _ = platform::set_deployment(&db, &deploy_id, "failed", &log).await;
        }
    };
    let project = match platform::get_project(db, &user_id, &project_id).await {
        Ok(Some(p)) => p,
        _ => {
            fail(db, &deploy_id, "Project not found.").await;
            return;
        }
    };
    let _ = platform::set_deployment(db, &deploy_id, "running", "Deploy started.").await;

    // 1) Export HEAD.
    let git_root = state.git_root.clone();
    let bare = platform::bare_repo_path(&git_root.to_string_lossy(), &project.repo_id);
    let tmp = std::env::temp_dir().join(format!("slaver-deploy-{deploy_id}"));
    if tokio::fs::create_dir_all(&tmp).await.is_err() {
        fail(db, &deploy_id, "Cannot create temp dir.").await;
        return;
    }
    let archive = tokio::process::Command::new("git")
        .arg(format!("--git-dir={}", bare.display()))
        .arg("archive")
        .arg("HEAD")
        .output()
        .await;
    let archive = match archive {
        Ok(o) if o.status.success() => o.stdout,
        _ => {
            fail(db, &deploy_id, "git archive failed (empty repo?).").await;
            return;
        }
    };
    // 2) Compose file must exist at repo root.
    let compose_src = tmp.join("docker-compose.yml");
    // Extract first to inspect.
    {
        let mut cmd = tokio::process::Command::new("tar");
        cmd.arg("-x").arg("-C").arg(&tmp).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped());
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                fail(db, &deploy_id, &format!("tar unavailable: {e}")).await;
                return;
            }
        };
        use tokio::io::AsyncWriteExt;
        if let Some(mut stdin) = child.stdin.take() {
            if stdin.write_all(&archive).await.is_err() {
                fail(db, &deploy_id, "Cannot unpack archive.").await;
                return;
            }
        }
        match child.wait_with_output().await {
            Ok(o) if o.status.success() => {}
            _ => {
                fail(db, &deploy_id, "Cannot unpack archive.").await;
                return;
            }
        }
    }
    if !compose_src.exists() {
        fail(db, &deploy_id, "Repo has no docker-compose.yml at root — add one (see marketplace templates), then deploy again.").await;
        return;
    }
    log.push_str("✓ Source exported (docker-compose.yml found).\n");

    // 3) Ship to VPS + compose up.
    let key_path = tmp.join("deploy_key");
    let (_, key) = match platform::get_vps_secret(db, &project.team_id, &user_id, &vps_id).await {
        Ok(k) => k,
        Err(e) => {
            fail(db, &deploy_id, &e.to_string()).await;
            return;
        }
    };
    if tokio::fs::write(&key_path, key.as_bytes()).await.is_err() {
        fail(db, &deploy_id, "Cannot stage SSH key.").await;
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600)).await;
    }
    let remote_dir = format!("/opt/slaver/{}", project.id);
    // mkdir first (simple remote command).
    match ssh(&state, &project.team_id, &user_id, &vps_id, &key_path, &format!("mkdir -p {remote_dir}")).await {
        Ok(o) => log.push_str(&o),
        Err(e) => {
            log.push_str(&e);
            fail(db, &deploy_id, &log).await;
            return;
        }
    }
    // Transfer the raw tar archive through ssh stdin (no scp dependency).
    {
        let (vps, _) = match platform::get_vps_secret(db, &project.team_id, &user_id, &vps_id).await {
            Ok(v) => v,
            Err(e) => {
                fail(db, &deploy_id, &e.to_string()).await;
                return;
            }
        };
        let target = format!("{}@{}", vps.ssh_user, vps.host);
        let mut child = match tokio::process::Command::new("ssh")
            .arg("-i")
            .arg(&key_path)
            .arg("-o")
            .arg("StrictHostKeyChecking=accept-new")
            .arg("-o")
            .arg("BatchMode=yes")
            .arg("-o")
            .arg("ConnectTimeout=15")
            .arg(&target)
            .arg(format!("tar -x -C {remote_dir}"))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                fail(db, &deploy_id, &format!("ssh failed: {e}")).await;
                return;
            }
        };
        use tokio::io::AsyncWriteExt;
        let mut ok = true;
        if let Some(mut stdin) = child.stdin.take() {
            if stdin.write_all(&archive).await.is_err() {
                ok = false;
            }
        }
        let status_ok = child.wait().await.map(|s| s.success()).unwrap_or(false);
        if !ok || !status_ok {
            fail(db, &deploy_id, "Source transfer failed.").await;
            return;
        }
    }
    log.push_str("✓ Source transferred.\n");
    match ssh(&state, &project.team_id, &user_id, &vps_id, &key_path, &format!("cd {remote_dir} && docker compose up -d --build")).await {
        Ok(o) => log.push_str(&o),
        Err(e) => {
            log.push_str(&e);
            fail(db, &deploy_id, &log).await;
            return;
        }
    }
    match ssh(&state, &project.team_id, &user_id, &vps_id, &key_path, &format!("cd {remote_dir} && docker compose ps")).await {
        Ok(o) => log.push_str(&o),
        Err(e) => log.push_str(&e),
    }
    let _ = tokio::fs::remove_dir_all(&tmp).await;
    let _ = platform::set_deployment(db, &deploy_id, "done", &log).await;
}
