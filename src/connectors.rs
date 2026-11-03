//! App connectors: the hub through which AI agents reach installed apps.
//!
//! Rule: NO external/outbound integrations. Every Slaver app MUST expose its
//! own MCP surface (`POST {base_url}/mcp`, JSON-RPC `tools/list` + `tools/call`,
//! optional Bearer key). A team registers each deployed app copy here; agents
//! then use `connectors_call` to use app features (tables, booking, stock...).
//! Slaver itself never talks to third-party software.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use crate::{
    db::{v_text, Db},
    store,
};

#[derive(Deserialize, Serialize, Clone)]
pub struct ConnectorRow {
    pub id: String,
    pub team_id: String,
    pub project_id: String,
    pub name: String,
    pub base_url: String,
    pub has_key: bool,
    pub created_at: String,
}

async fn require_manager(db: &Db, team_id: &str, user_id: &str) -> Result<()> {
    match store::membership(db, team_id, user_id).await? {
        Some(r) if r == "owner" || r == "admin" => Ok(()),
        _ => Err(anyhow!("Only owners and admins can do that.")),
    }
}

fn norm_base(raw: &str) -> Result<String> {
    let b = raw.trim().trim_end_matches('/').to_string();
    if b.is_empty() {
        return Err(anyhow!("base_url is required (the deployed app URL, e.g. https://resto-abc.slaver.app)."));
    }
    if !(b.starts_with("https://") || b.starts_with("http://")) {
        return Err(anyhow!("base_url must start with https:// (http:// only for localhost)."));
    }
    Ok(b)
}

pub async fn list(db: &Db, team_id: &str, user_id: &str) -> Result<Vec<ConnectorRow>> {
    store::membership(db, team_id, user_id)
        .await?
        .ok_or_else(|| anyhow!("You are not on that team."))?;
    #[derive(serde::Deserialize)]
    struct R {
        id: String,
        team_id: String,
        project_id: String,
        name: String,
        base_url: String,
        has_key: i64,
        created_at: String,
    }
    let rows: Vec<R> = db
        .prepare("SELECT id, team_id, project_id, name, base_url, (api_key <> '') AS has_key, created_at FROM app_connectors WHERE team_id = ? ORDER BY created_at DESC LIMIT 50")
        .bind(&[v_text(team_id)])?
        .all()
        .await?
        .results()?;
    Ok(rows
        .into_iter()
        .map(|r| ConnectorRow {
            id: r.id,
            team_id: r.team_id,
            project_id: r.project_id,
            name: r.name,
            base_url: r.base_url,
            has_key: r.has_key != 0,
            created_at: r.created_at,
        })
        .collect())
}

async fn get_secret(db: &Db, team_id: &str, user_id: &str, id: &str) -> Result<(ConnectorRow, String)> {
    store::membership(db, team_id, user_id)
        .await?
        .ok_or_else(|| anyhow!("You are not on that team."))?;
    #[derive(serde::Deserialize)]
    struct R {
        id: String,
        team_id: String,
        project_id: String,
        name: String,
        base_url: String,
        api_key: String,
        created_at: String,
    }
    let row: Option<R> = db
        .prepare("SELECT id, team_id, project_id, name, base_url, api_key, created_at FROM app_connectors WHERE id = ? AND team_id = ?")
        .bind(&[v_text(id), v_text(team_id)])?
        .first(None)
        .await?;
    let r = row.ok_or_else(|| anyhow!("Connector not found."))?;
    let key = r.api_key.clone();
    Ok((
        ConnectorRow {
            id: r.id,
            team_id: r.team_id,
            project_id: r.project_id,
            name: r.name,
            base_url: r.base_url,
            has_key: !key.is_empty(),
            created_at: r.created_at,
        },
        key,
    ))
}

pub async fn add(
    db: &Db,
    team_id: &str,
    user_id: &str,
    project_id: &str,
    name: &str,
    base_url: &str,
    api_key: &str,
) -> Result<ConnectorRow> {
    require_manager(db, team_id, user_id).await?;
    let name: String = {
        let n = name.trim().chars().take(60).collect::<String>();
        if n.is_empty() {
            "App".to_string()
        } else {
            n
        }
    };
    let base = norm_base(base_url)?;
    if !project_id.trim().is_empty() {
        let p = crate::platform::get_project(db, user_id, project_id.trim())
            .await?
            .ok_or_else(|| anyhow!("Project not found."))?;
        if p.team_id != team_id {
            return Err(anyhow!("That project is on a different team."));
        }
    }
    let id = crate::util::new_id();
    db.prepare("INSERT INTO app_connectors (id, team_id, project_id, name, base_url, api_key) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&[v_text(&id), v_text(team_id), v_text(project_id.trim()), v_text(&name), v_text(&base), v_text(api_key.trim())])?
        .run()
        .await?;
    Ok(get_secret(db, team_id, user_id, &id).await?.0)
}

pub async fn remove(db: &Db, team_id: &str, user_id: &str, id: &str) -> Result<()> {
    require_manager(db, team_id, user_id).await?;
    db.prepare("DELETE FROM app_connectors WHERE id = ? AND team_id = ?")
        .bind(&[v_text(id), v_text(team_id)])?
        .run()
        .await?;
    Ok(())
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .expect("http client builds")
}

/// Call a tool on the app's own MCP surface. The app speaks plain JSON-RPC:
/// POST {base}/mcp {"jsonrpc":"2.0","id":N,"method":"tools/call",
/// "params":{"name": tool, "arguments": {...}}}.
pub async fn call_tool(
    db: &Db,
    team_id: &str,
    user_id: &str,
    connector_id: &str,
    tool: &str,
    arguments: &serde_json::Value,
) -> Result<serde_json::Value> {
    let (conn, key) = get_secret(db, team_id, user_id, connector_id).await?;
    let tool = tool.trim();
    if tool.is_empty() {
        return Err(anyhow!("tool is required."));
    }
    let args = if arguments.is_null() {
        serde_json::Value::Object(Default::default())
    } else {
        arguments.clone()
    };
    let mut req = client().post(format!("{}/mcp", conn.base_url.trim_end_matches('/'))).json(
        &serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": tool, "arguments": args } }),
    );
    if !key.trim().is_empty() {
        req = req.bearer_auth(key.trim());
    }
    let resp = req.send().await.map_err(|e| anyhow!("Cannot reach app at {}: {e}", conn.base_url))?;
    let status = resp.status().as_u16();
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    if !(200..300).contains(&status) {
        return Err(anyhow!("App returned HTTP {status}."));
    }
    if let Some(err) = body.get("error") {
        return Err(anyhow!("App error: {}", err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown")));
    }
    Ok(body.pointer("/result").cloned().unwrap_or(serde_json::Value::Null))
}
