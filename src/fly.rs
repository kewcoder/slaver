//! Fly.io integration for team-owned infrastructure.
//!
//! Teams connect their own Fly account (API token stored per team). Slaver can
//! list apps, provision one PROD + one DEV machine per team, run commands on
//! the dev machine (agent sandbox), and destroy machines again.

use anyhow::{anyhow, Context, Result};

const API: &str = "https://api.machines.dev/v1";

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .expect("http client builds")
}

async fn api_get(token: &str, path: &str) -> Result<(u16, serde_json::Value)> {
    let resp = client()
        .get(format!("{API}{path}"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await?;
    let status = resp.status().as_u16();
    let v: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    Ok((status, v))
}

async fn api_post(token: &str, path: &str, body: &serde_json::Value) -> Result<(u16, serde_json::Value)> {
    let resp = client()
        .post(format!("{API}{path}"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .json(body)
        .send()
        .await?;
    let status = resp.status().as_u16();
    let v: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    Ok((status, v))
}

async fn api_delete(token: &str, path: &str) -> Result<u16> {
    let resp = client()
        .delete(format!("{API}{path}"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await?;
    Ok(resp.status().as_u16())
}

/// Validate a Fly API token by listing apps. Returns the org slug hint.
pub async fn validate_token(token: &str) -> Result<String> {
    let (status, v) = api_get(token, "/apps").await?;
    if status == 401 || status == 403 {
        anyhow::bail!("Invalid Fly API token (unauthorized).");
    }
    if !(200..300).contains(&status) {
        anyhow::bail!("Fly API error ({status}).");
    }
    let org = v
        .as_array()
        .and_then(|a| a.first())
        .and_then(|a| a.get("organization"))
        .and_then(|o| o.get("slug"))
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    Ok(org)
}

pub async fn list_apps(token: &str) -> Result<Vec<serde_json::Value>> {
    let (status, v) = api_get(token, "/apps").await?;
    if !(200..300).contains(&status) {
        anyhow::bail!("Fly API error ({status}).");
    }
    Ok(v.as_array().cloned().unwrap_or_default())
}

pub async fn ensure_app(token: &str, app_name: &str, org: &str) -> Result<()> {
    // Idempotent: create, ignore "already exists".
    let body = serde_json::json!({ "app_name": app_name, "org": org });
    let (status, _v) = api_post(token, "/apps", &body).await?;
    if (200..300).contains(&status) {
        return Ok(());
    }
    // 422 with name-taken error means it already exists (possibly in this org).
    Err(anyhow!("Could not ensure Fly app {app_name} (status {status}). Make sure the org slug is right and the name is free."))
}

#[derive(Debug, Clone)]
pub struct MachineSpec {
    pub image: String,
    pub cpus: i64,
    pub memory_mb: i64,
    pub env: Vec<(String, String)>,
    pub with_proxy_port: Option<u16>,
    pub entrypoint: Option<Vec<String>>,
}

pub async fn ensure_app_no_org(token: &str, app_name: &str) -> Result<()> {
    let (status, _) = api_post(token, "/apps", &serde_json::json!({ "app_name": app_name })).await?;
    if (200..300).contains(&status) {
        return Ok(());
    }
    Err(anyhow!("Could not create Fly app {app_name} (status {status}). If the name is taken, pick another slug."))
}

pub async fn delete_app(token: &str, app_name: &str) -> Result<()> {
    let status = api_delete(token, &format!("/apps/{app_name}")).await?;
    if !(200..300).contains(&status) && status != 404 {
        anyhow::bail!("Fly could not delete app {app_name} (status {status}).");
    }
    Ok(())
}

pub async fn create_machine(token: &str, app_name: &str, spec: &MachineSpec) -> Result<(String, String)> {
    let mut env_map = serde_json::Map::new();
    for (k, v) in &spec.env {
        env_map.insert(k.clone(), serde_json::Value::String(v.clone()));
    }
    let mut config = serde_json::json!({
        "image": spec.image,
        "guest": { "cpus": spec.cpus, "memory_mb": spec.memory_mb },
        "auto_destroy": false,
        "restart": { "policy": "always" },
        "env": env_map,
    });
    if let Some(port) = spec.with_proxy_port {
        config["services"] = serde_json::json!([{
            "ports": [{ "port": 443, "handlers": ["tls", "http"] }, { "port": 80, "handlers": ["http"] }],
            "protocol": "tcp",
            "internal_port": port,
        }]);
    }
    if let Some(ep) = &spec.entrypoint {
        config["entrypoint"] = serde_json::Value::Array(ep.iter().map(|s| serde_json::Value::String(s.clone())).collect());
    }
    let (status, v) = api_post(token, &format!("/apps/{app_name}/machines"), &serde_json::json!({ "config": config })).await
        .with_context(|| "Fly create-machine request failed")?;
    if !(200..300).contains(&status) {
        anyhow::bail!("Fly could not create machine (status {status}): {}", v.to_string().chars().take(300).collect::<String>());
    }
    let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let state = v.get("state").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if id.is_empty() {
        anyhow::bail!("Fly did not return a machine id.");
    }
    Ok((id, state))
}

pub async fn get_machine(token: &str, app_name: &str, machine_id: &str) -> Result<serde_json::Value> {
    let (status, v) = api_get(token, &format!("/apps/{app_name}/machines/{machine_id}")).await?;
    if !(200..300).contains(&status) {
        anyhow::bail!("Fly machine lookup failed (status {status}).");
    }
    Ok(v)
}

/// Best-effort live lookup using the team's first stored token.
pub async fn get_machine_by_token_for(
    db: &crate::db::Db,
    team_id: &str,
    app_name: &str,
    machine_id: &str,
) -> Result<serde_json::Value> {
    #[derive(serde::Deserialize)]
    struct T { api_token: String }
    let t: Option<T> = db
        .prepare("SELECT api_token FROM fly_accounts WHERE team_id = ? ORDER BY rowid ASC LIMIT 1")
        .bind(&[crate::db::v_text(team_id)])?
        .first(None)
        .await?;
    let t = t.ok_or_else(|| anyhow!("no fly token"))?;
    get_machine(&t.api_token, app_name, machine_id).await
}

pub async fn destroy_machine(token: &str, app_name: &str, machine_id: &str) -> Result<()> {
    let status = api_delete(token, &format!("/apps/{app_name}/machines/{machine_id}?force=true")).await?;
    if !(200..300).contains(&status) && status != 404 {
        anyhow::bail!("Fly could not destroy machine (status {status}).");
    }
    Ok(())
}

/// Run a command on a machine and wait for the result (used for the
/// isolated dev-harness path). Returns (exit_code, stdout, stderr).
pub async fn exec_on_machine(
    token: &str,
    app_name: &str,
    machine_id: &str,
    command: &[String],
    workdir: &str,
    timeout_secs: u64,
    stdin_b64: Option<&str>,
) -> Result<(i64, String, String)> {
    let mut cmd = command.to_vec();
    if !workdir.trim().is_empty() && workdir != "/" {
        cmd = vec!["/bin/sh".to_string(), "-lc".to_string(), format!("cd {} && {}", shell_quote(workdir), cmd.join(" "))];
    }
    let mut payload = serde_json::json!({ "command": cmd, "timeout": timeout_secs.max(1).min(300) });
    if let Some(data) = stdin_b64 {
        payload["stdin"] = serde_json::Value::String(data.to_string());
    }
    let (status, v) = api_post(token, &format!("/apps/{app_name}/machines/{machine_id}/exec"), &payload).await?;
    if !(200..300).contains(&status) {
        anyhow::bail!("Fly exec failed (status {status}): {}", v.to_string().chars().take(300).collect::<String>());
    }
    let exit_code = v.get("exit_code").and_then(|x| x.as_i64()).unwrap_or(-1);
    let stdout = v.get("stdout").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let stderr = v.get("stderr").and_then(|x| x.as_str()).unwrap_or("").to_string();
    Ok((exit_code, stdout, stderr))
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
