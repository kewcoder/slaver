use crate::{db::Db, store};

/// Team management: list/create teams, invite members by email with a role
/// (owner/admin manage apps and settings; staff can use the team's apps),
/// change roles and remove members.
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
/// and members. Used by the teams_get MCP tool.
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
    let members_out: Vec<_> = members
        .into_iter()
        .map(|m| serde_json::json!({ "user_id": m.user_id, "email": m.email, "name": m.name, "role": m.role }))
        .collect();
    Ok(serde_json::json!({ "team": safe_team(&team), "my_role": my_role, "members": members_out }))
}
