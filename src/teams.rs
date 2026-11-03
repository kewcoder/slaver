use crate::{db::Db, store};

/// Team management: list/create teams, invite members by email with a role
/// (admin = same access as owner; staff = only granted bots), change roles,
/// remove members, and set per-staff bot access.
/// Team JSON without the provider API key (managers see key_set only).
pub(crate) fn safe_team(t: &store::TeamRow) -> serde_json::Value {
    serde_json::json!({
        "id": t.id,
        "name": t.name,
        "owner_user_id": t.owner_user_id,
        "personal": t.personal,
        "provider": t.provider,
        "provider_base_url": t.provider_base_url,
        "provider_key_set": !t.provider_api_key.trim().is_empty(),
        "created_at": t.created_at,
    })
}

/// Core team detail (keys never leave the server): team summary, role,
/// members with staff grants, and bots. Used by the team.get MCP tool.
pub(crate) async fn team_detail(db: &Db, user_id: &str, team_id: &str) -> Result<serde_json::Value, String> {
    let team = store::get_team(db, team_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Team not found.".to_string())?;
    let my_role = store::membership(db, team_id, user_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Team not found.".to_string())?;
    let members = store::team_members(db, team_id).await.map_err(|e| e.to_string())?;
    let mut members_out = Vec::new();
    for m in members {
        let grants = if m.role == "staff" {
            store::member_grants(db, team_id, &m.user_id).await.unwrap_or_default()
        } else {
            vec![]
        };
        members_out.push(serde_json::json!({
            "user_id": m.user_id, "email": m.email, "name": m.name,
            "role": m.role, "bot_ids": grants,
        }));
    }
    let bots: Vec<_> = store::list_bots(db, user_id, true)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|b| b.team_id == team_id)
        .collect();
    Ok(serde_json::json!({ "team": safe_team(&team), "my_role": my_role, "members": members_out, "bots": bots }))
}
