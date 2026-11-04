use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use crate::db::{v_real, v_text, Db};


#[derive(Deserialize, Serialize)]
pub struct UserRecord {
    pub id: String,
    pub email: String,
    pub name: String,
    #[serde(default)]
    pub lang: String,
}

pub async fn get_user(db: &Db, id: &str) -> Result<Option<UserRecord>> {
    db.prepare("SELECT id, email, name, lang FROM users WHERE id = ?")
        .bind(&[v_text(id)])?
        .first(None)
        .await
}

/// Set a team's AI provider. Only owners and admins may do this.
pub async fn set_team_provider(db: &Db, team_id: &str, actor_id: &str, preset: &str, base_url: &str, api_key: &str) -> Result<(), String> {
    match membership(db, team_id, actor_id).await.map_err(|e| e.to_string())? {
        Some(r) if r == "owner" || r == "admin" => {}
        _ => return Err("Only owners and admins can change the team AI provider.".to_string()),
    }
    let preset = preset.trim().to_lowercase();
    let base_url = crate::provider::normalize_base_url(base_url);
    let api_key = api_key.trim().to_string();
    db.prepare("UPDATE teams SET provider = ?, provider_base_url = ?, provider_api_key = ? WHERE id = ?")
        .bind(&[v_text(&preset), v_text(&base_url), v_text(&api_key), v_text(team_id)])
        .map_err(|e| e.to_string())?
        .run()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Deserialize, Serialize, Clone)]
pub struct TeamRow {
    pub id: String,
    pub name: String,
    pub owner_user_id: String,
    pub personal: i64,
    pub provider: String,
    pub provider_base_url: String,
    pub provider_api_key: String,
    pub created_at: String,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct MemberRow {
    pub team_id: String,
    pub user_id: String,
    pub email: Option<String>,
    pub name: Option<String>,
    pub role: String,
    pub created_at: String,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct TeamWithRole {
    pub id: String,
    pub name: String,
    pub owner_user_id: String,
    pub personal: i64,
    pub role: String,
    pub provider: String,
    pub provider_base_url: String,
    pub provider_key_set: i64,
    pub created_at: String,
}

pub async fn create_team(db: &Db, owner_id: &str, name: &str, personal: bool) -> Result<TeamRow> {
    let name: String = name.trim().chars().take(60).collect();
    let name = if name.is_empty() { "Team".to_string() } else { name };
    let id = new_id();
    db.prepare("INSERT INTO teams (id, name, owner_user_id, personal) VALUES (?, ?, ?, ?)")
        .bind(&[v_text(&id), v_text(&name), v_text(owner_id), v_real(if personal { 1.0 } else { 0.0 })])?
        .run()
        .await?;
    db.prepare("INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'owner')")
        .bind(&[v_text(&id), v_text(owner_id)])?
        .run()
        .await?;
    get_team(db, &id).await?.ok_or_else(|| anyhow!("team insert failed".to_string()))
}

/// Delete a team and everything in it. Only the owner (or an admin) may do this.
/// Personal teams cannot be deleted.
pub async fn delete_team(db: &Db, team_id: &str, actor_id: &str) -> Result<(), String> {
    let team: Option<TeamRow> = db
        .prepare("SELECT id, name, owner_user_id, personal, provider, provider_base_url, provider_api_key, created_at FROM teams WHERE id = ?")
        .bind(&[v_text(team_id)])
        .map_err(|e| e.to_string())?
        .first(None)
        .await
        .map_err(|e| e.to_string())?;
    let team = team.ok_or_else(|| "Team not found.".to_string())?;
    if team.personal != 0 {
        return Err("The personal team cannot be deleted.".to_string());
    }
    let role = membership(db, team_id, actor_id).await.map_err(|e| e.to_string())?;
    match role.as_deref() {
        Some("owner") | Some("admin") => {}
        _ => return Err("Only owners and admins can delete the team.".to_string()),
    }
    for sql in [
        "DELETE FROM team_members WHERE team_id = ?",
        "DELETE FROM teams WHERE id = ?",
    ] {
        db.prepare(sql)
            .bind(&[v_text(team_id)])
            .map_err(|e| e.to_string())?
            .run()
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub async fn get_team(db: &Db, team_id: &str) -> Result<Option<TeamRow>> {
    db.prepare("SELECT id, name, owner_user_id, personal, provider, provider_base_url, provider_api_key, created_at FROM teams WHERE id = ?")
        .bind(&[v_text(team_id)])?
        .first(None)
        .await
}

pub async fn list_user_teams(db: &Db, user_id: &str) -> Result<Vec<TeamWithRole>> {
    db.prepare(
        "SELECT t.id, t.name, t.owner_user_id, t.personal, m.role, t.provider, t.provider_base_url, (t.provider_api_key <> '') AS provider_key_set, t.created_at \
         FROM teams t JOIN team_members m ON m.team_id = t.id \
         WHERE m.user_id = ? ORDER BY t.personal DESC, t.created_at ASC",
    )
    .bind(&[v_text(user_id)])?
    .all()
    .await?
    .results()
}

pub async fn membership(db: &Db, team_id: &str, user_id: &str) -> Result<Option<String>> {
    let row: Option<TeamRole> = db
        .prepare("SELECT role FROM team_members WHERE team_id = ? AND user_id = ?")
        .bind(&[v_text(team_id), v_text(user_id)])?
        .first(None)
        .await?;
    Ok(row.map(|r| r.role))
}

#[derive(Deserialize)]
struct TeamRole {
    role: String,
}

/// The user's explicit personal team, creating it (and adopting legacy
/// team-less rows) on first use.
pub async fn ensure_personal_team(db: &Db, user_id: &str) -> Result<TeamRow> {
    let existing: Option<TeamRow> = db
        .prepare("SELECT id, name, owner_user_id, personal, provider, provider_base_url, provider_api_key, created_at FROM teams WHERE owner_user_id = ? AND personal = 1")
        .bind(&[v_text(user_id)])?
        .first(None)
        .await?;
    if let Some(t) = existing {
        return Ok(t);
    }
    let name = get_user(db, user_id)
        .await?
        .map(|u| if u.name.trim().is_empty() { "My team".to_string() } else { format!("{}'s team", u.name.chars().take(40).collect::<String>()) })
        .unwrap_or_else(|| "My team".to_string());
    let team = create_team(db, user_id, &name, true).await?;
    Ok(team)
}

pub async fn team_members(db: &Db, team_id: &str) -> Result<Vec<MemberRow>> {
    db.prepare(
        "SELECT m.team_id, m.user_id, u.email AS email, u.name AS name, m.role, m.created_at \
         FROM team_members m LEFT JOIN users u ON u.id = m.user_id \
         WHERE m.team_id = ? ORDER BY m.created_at ASC",
    )
    .bind(&[v_text(team_id)])?
    .all()
    .await?
    .results()
}

pub async fn add_member_by_email(
    db: &Db,
    team_id: &str,
    adder_id: &str,
    email: &str,
    role: &str,
) -> Result<MemberRow, String> {
    let adder_role = membership(db, team_id, adder_id).await.map_err(|e| e.to_string())?;
    let adder_role = adder_role.ok_or_else(|| "You are not a member of this team.".to_string())?;
    let role = role.trim().to_lowercase();
    if role != "admin" && role != "staff" {
        return Err("Role must be admin or staff.".to_string());
    }
    if role == "admin" && adder_role != "owner" {
        return Err("Only the team owner can add admins.".to_string());
    }
    if adder_role != "owner" && adder_role != "admin" {
        return Err("Only owners and admins can invite.".to_string());
    }
    let email = email.trim().to_lowercase();
    if email.is_empty() {
        return Err("Invite an email address.".to_string());
    }
    let target: Option<UserId> = db
        .prepare("SELECT id FROM users WHERE email = ?")
        .bind(&[v_text(&email)])
        .map_err(|e| e.to_string())?
        .first(None)
        .await
        .map_err(|e| e.to_string())?;
    let target = target.ok_or_else(|| "No user with that email yet — ask them to register first.".to_string())?;
    if membership(db, team_id, &target.id).await.map_err(|e| e.to_string())?.is_some() {
        return Err("That user is already on the team.".to_string());
    }
    db.prepare("INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)")
        .bind(&[v_text(team_id), v_text(&target.id), v_text(&role)])
        .map_err(|e| e.to_string())?
        .run()
        .await
        .map_err(|e| e.to_string())?;
    Ok(MemberRow { team_id: team_id.to_string(), user_id: target.id, email: Some(email), name: None, role, created_at: String::new() })
}

#[derive(Deserialize)]
struct UserId {
    id: String,
}

pub async fn remove_member(db: &Db, team_id: &str, actor_id: &str, target_id: &str) -> Result<(), String> {
    let actor_role = membership(db, team_id, actor_id).await.map_err(|e| e.to_string())?;
    let actor_role = actor_role.ok_or_else(|| "You are not a member of this team.".to_string())?;
    let target_role = membership(db, team_id, target_id).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "That user is not on the team.".to_string())?;
    if target_role == "owner" {
        return Err("The team owner cannot be removed.".to_string());
    }
    if actor_role != "owner" && (actor_role != "admin" || target_role != "staff") {
        return Err("Only the owner can remove admins; admins can remove staff.".to_string());
    }
    if actor_id == target_id {
        return Err("Leave the team by deleting it — members cannot remove themselves.".to_string());
    }
    db.prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?")
        .bind(&[v_text(team_id), v_text(target_id)])
        .map_err(|e| e.to_string())?
        .run()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn set_member_role(db: &Db, team_id: &str, actor_id: &str, target_id: &str, role: &str) -> Result<(), String> {
    let actor_role = membership(db, team_id, actor_id).await.map_err(|e| e.to_string())?;
    if actor_role.as_deref() != Some("owner") {
        return Err("Only the team owner can change roles.".to_string());
    }
    if role != "admin" && role != "staff" {
        return Err("Role must be admin or staff.".to_string());
    }
    let target_role = membership(db, team_id, target_id).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "That user is not on the team.".to_string())?;
    if target_role == "owner" {
        return Err("The team owner keeps the owner role.".to_string());
    }
    db.prepare("UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?")
        .bind(&[v_text(role), v_text(team_id), v_text(target_id)])
        .map_err(|e| e.to_string())?
        .run()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn new_id() -> String {
    crate::util::new_id()
}
