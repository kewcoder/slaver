//! Cloudflare DNS for team custom domains, e.g. `{app}.slaver.app`.
//!
//! Requires CF_API_TOKEN (Zone:DNS:Edit) + CF_ZONE_ID env vars. When unset,
//! domain records are stored as "manual" and the owner points DNS by hand.

use anyhow::{Context, Result};

pub fn configured() -> bool {
    !std::env::var("CF_API_TOKEN").unwrap_or_default().trim().is_empty()
        && !std::env::var("CF_ZONE_ID").unwrap_or_default().trim().is_empty()
}

pub fn zone_name() -> String {
    std::env::var("SLAVER_DOMAIN")
        .unwrap_or_default()
        .trim()
        .trim_start_matches('.')
        .to_string()
        .or_default2("slaver.app")
}

trait OrDefault2 {
    fn or_default2(self, d: &str) -> String;
}
impl OrDefault2 for String {
    fn or_default2(self, d: &str) -> String {
        if self.trim().is_empty() {
            d.to_string()
        } else {
            self
        }
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("http client builds")
}

/// Create (or update, if the name exists) a DNS record. Returns the record id.
pub async fn upsert_record(subdomain: &str, kind: &str, target: &str, proxied: bool) -> Result<String> {
    let token = std::env::var("CF_API_TOKEN").unwrap_or_default();
    let zone = std::env::var("CF_ZONE_ID").unwrap_or_default();
    if token.trim().is_empty() || zone.trim().is_empty() {
        anyhow::bail!("Cloudflare is not configured (set CF_API_TOKEN and CF_ZONE_ID).");
    }
    let kind = kind.to_uppercase();
    if kind != "CNAME" && kind != "A" {
        anyhow::bail!("Only CNAME/A records are supported.");
    }
    let name = if subdomain.trim().is_empty() || subdomain == "@" {
        zone_name()
    } else {
        format!("{}.{}", subdomain.trim(), zone_name())
    };
    // Look for an existing record with the same name+type.
    let list: serde_json::Value = client()
        .get(format!("https://api.cloudflare.com/client/v4/zones/{zone}/dns_records"))
        .bearer_auth(token.trim())
        .query(&[("name", name.as_str()), ("type", kind.as_str())])
        .send()
        .await
        .with_context(|| "Cloudflare list failed")?
        .json()
        .await
        .with_context(|| "Cloudflare list parse failed")?;
    if let Some(existing) = list.get("result").and_then(|r| r.as_array()).and_then(|a| a.first()) {
        let rid = existing.get("id").and_then(|x| x.as_str()).unwrap_or("");
        let upd: serde_json::Value = client()
            .put(format!("https://api.cloudflare.com/client/v4/zones/{zone}/dns_records/{rid}"))
            .bearer_auth(token.trim())
            .json(&serde_json::json!({ "type": kind, "name": name, "content": target, "proxied": proxied, "ttl": 1 }))
            .send()
            .await
            .with_context(|| "Cloudflare update failed")?
            .json()
            .await
            .with_context(|| "Cloudflare update parse failed")?;
        if upd.get("success").and_then(|x| x.as_bool()) != Some(true) {
            anyhow::bail!("Cloudflare refused the update: {}", upd.to_string().chars().take(200).collect::<String>());
        }
        return Ok(rid.to_string());
    }
    let created: serde_json::Value = client()
        .post(format!("https://api.cloudflare.com/client/v4/zones/{zone}/dns_records"))
        .bearer_auth(token.trim())
        .json(&serde_json::json!({ "type": kind, "name": name, "content": target, "proxied": proxied, "ttl": 1 }))
        .send()
        .await
        .with_context(|| "Cloudflare create failed")?
        .json()
        .await
        .with_context(|| "Cloudflare create parse failed")?;
    if created.get("success").and_then(|x| x.as_bool()) != Some(true) {
        anyhow::bail!("Cloudflare refused the record: {}", created.to_string().chars().take(300).collect::<String>());
    }
    Ok(created
        .pointer("/result/id")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string())
}

pub async fn delete_record(record_id: &str) -> Result<()> {
    let token = std::env::var("CF_API_TOKEN").unwrap_or_default();
    let zone = std::env::var("CF_ZONE_ID").unwrap_or_default();
    if token.trim().is_empty() || zone.trim().is_empty() || record_id.trim().is_empty() {
        return Ok(());
    }
    let _: serde_json::Value = client()
        .delete(format!("https://api.cloudflare.com/client/v4/zones/{zone}/dns_records/{record_id}"))
        .bearer_auth(token.trim())
        .send()
        .await
        .with_context(|| "Cloudflare delete failed")?
        .json()
        .await
        .unwrap_or(serde_json::Value::Null);
    Ok(())
}
