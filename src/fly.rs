//! Fly.io integration for team-owned infrastructure.
//!
//! Teams connect their own Fly account (API token stored per team). Slaver can
//! list apps, provision one PROD + one DEV machine per team, run commands on
//! the dev machine (agent sandbox), and destroy machines again.

use anyhow::Result;

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

/// Validate a Fly API token by listing apps. Returns the org slug hint.
pub async fn validate_token(token: &str) -> Result<String> {
    let (status, v) = api_get(token, "/apps?org_slug=personal").await?;
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

/// Apps in an org. The Machines API requires `org_slug` and returns `{ "apps": [...] }`.
pub async fn list_apps(token: &str, org: &str) -> Result<Vec<serde_json::Value>> {
    let org = if org.trim().is_empty() { "personal" } else { org.trim() };
    let (status, v) = api_get(token, &format!("/apps?org_slug={org}")).await?;
    if status == 401 || status == 403 {
        anyhow::bail!("unauthorized for org '{org}'");
    }
    if !(200..300).contains(&status) {
        anyhow::bail!("Fly API error ({status}) for org '{org}'");
    }
    Ok(v.get("apps").and_then(|a| a.as_array()).or_else(|| v.as_array()).cloned().unwrap_or_default())
}
