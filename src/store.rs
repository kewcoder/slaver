use anyhow::{anyhow, Result};
use chrono::Datelike;
use serde::{Deserialize, Serialize};
use crate::db::{v_int, v_null, v_real, v_text, Db};

use crate::chat::ChatMessage;
use crate::pricing;

#[derive(Deserialize, Serialize)]
pub struct UserRecord {
    pub id: String,
    pub email: String,
    pub name: String,
}

#[derive(Deserialize, Serialize)]
pub struct MessageRow {
    pub id: i64,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

#[derive(Deserialize, Serialize)]
pub struct BotRow {
    pub id: String,
    pub user_id: String,
    pub team_id: String,
    pub name: String,
    pub title: String,
    pub model: String,
    pub memory: String,
    pub role: String,
    pub parent_id: String,
    pub pinned: i64,
    pub pinned_by: String,
    pub owner_user_id: String,
    pub relay: i64,
    pub avatar_key: String,
    pub archived: i64,
    pub voice: String,
    pub active_days: String,
    pub active_start: String,
    pub active_end: String,
    pub created_at: String,
    pub updated_at: String,
}



pub async fn get_user(db: &Db, id: &str) -> Result<Option<UserRecord>> {
    db.prepare("SELECT id, email, name FROM users WHERE id = ?")
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

pub async fn bot_count(db: &Db, user_id: &str) -> Result<i64> {
    let row: Option<CountRow> = db
        .prepare("SELECT COUNT(*) AS n FROM slavebots WHERE user_id = ?")
        .bind(&[v_text(user_id)])?
        .first(None)
        .await?;
    Ok(row.map(|r| r.n).unwrap_or(0))
}

#[derive(Deserialize)]
struct CountRow {
    n: i64,
}

/// Create a new slaveBot with an auto-numbered default name inside a team
/// the creator belongs to. The bot is partnered with `owner` (a team member;
/// staff may only pick themselves, owner/admin may pick anyone). The owner
/// always gets a grant; staff creators get one too.
pub async fn create_bot(db: &Db, user_id: &str, team_id: &str, model: &str, owner: &str) -> Result<BotRow> {
    let team_id = if team_id.is_empty() {
        ensure_personal_team(db, user_id).await?.id
    } else {
        match membership(db, team_id, user_id).await? {
            Some(_) => team_id.to_string(),
            None => return Err(anyhow!("You are not on that team.".to_string())),
        }
    };
    let role = membership(db, &team_id, user_id).await?.unwrap_or_default();
    let mut owner = owner.trim().to_string();
    if owner.is_empty() || (role == "staff" && owner != user_id) {
        owner = user_id.to_string();
    }
    if membership(db, &team_id, &owner).await?.is_none() {
        return Err(anyhow!("The chosen owner is not on this team.".to_string()));
    }
    let n = bot_count(db, user_id).await? + 1;
    let id = new_id();
    let name = format!("SlaveBot {n}");
    db.prepare("INSERT INTO slavebots (id, user_id, team_id, owner_user_id, name, title, model) VALUES (?, ?, ?, ?, ?, '', ?)")
        .bind(&[v_text(&id), v_text(user_id), v_text(&team_id), v_text(&owner), v_text(&name), v_text(model)])?
        .run()
        .await?;
    for uid in [user_id, owner.as_str()] {
        db.prepare("INSERT OR IGNORE INTO bot_grants (bot_id, user_id) VALUES (?, ?)")
            .bind(&[v_text(&id), v_text(uid)])?
            .run()
            .await?;
    }
    Ok(get_bot_any(db, &id)
        .await?
        .expect("just-inserted bot must exist"))
}

/// One bot by id, no access check (cron/system paths use this, then check access).
pub async fn get_bot_any(db: &Db, id: &str) -> Result<Option<BotRow>> {
    db.prepare("SELECT id, user_id, team_id, name, title, model, memory, role, parent_id, pinned, pinned_by, owner_user_id, relay, avatar_key, archived, voice, active_days, active_start, active_end, created_at, updated_at FROM slavebots WHERE id = ?")
        .bind(&[v_text(id)])?
        .first(None)
        .await
}

/// One bot the caller is allowed to see: team owner/admin, granted staff, or
/// the legacy creator (pre-team rows carry team_id '').
pub async fn get_bot(db: &Db, user_id: &str, id: &str) -> Result<Option<BotRow>> {
    Ok(bot_access(db, user_id, id).await?.map(|(b, _, _)| b))
}

#[allow(clippy::too_many_arguments)]
pub async fn update_bot(
    db: &Db,
    user_id: &str,
    id: &str,
    name: Option<&str>,
    memory: Option<&str>,
    model: Option<&str>,
    voice: Option<&str>,
    active_days: Option<&str>,
    active_start: Option<&str>,
    active_end: Option<&str>,
    role: Option<&str>,
    relay: Option<bool>,
) -> Result<Option<BotRow>> {
    if !can_manage(db, user_id, id).await? {
        return Ok(None);
    }
    if let Some(name) = name {
        let name: String = name.trim().chars().take(40).collect();
        if !name.is_empty() {
            db.prepare("UPDATE slavebots SET name = ? WHERE id = ?")
                .bind(&[v_text(&name), v_text(id)])?
                .run()
                .await?;
        }
    }
    if let Some(memory) = memory {
        let memory: String = memory.chars().take(4000).collect();
        db.prepare("UPDATE slavebots SET memory = ? WHERE id = ?")
            .bind(&[v_text(&memory), v_text(id)])?
            .run()
            .await?;
    }
    // The HTTP handler pre-validates the model against the caller's provider.
    if let Some(model) = model.map(str::trim).filter(|m| !m.is_empty()) {
        db.prepare("UPDATE slavebots SET model = ? WHERE id = ?")
            .bind(&[v_text(model), v_text(id)])?
            .run()
            .await?;
    }
    if let Some(voice) = voice.map(str::trim).filter(|v| {
        ["luna", "athena", "orion", "zeus", "hera", "perseus", "angus", "stella"].contains(v)
    }) {
        db.prepare("UPDATE slavebots SET voice = ? WHERE id = ?")
            .bind(&[v_text(voice), v_text(id)])?
            .run()
            .await?;
    }
    if let Some(days) = active_days.map(str::trim).filter(|d| !d.is_empty()) {
        let days: String = days
            .to_lowercase()
            .chars()
            .take(40)
            .collect::<String>()
            .split(',')
            .map(str::trim)
            .filter(|d| {
                ["all", "weekdays", "weekends", "mon", "tue", "wed", "thu", "fri", "sat", "sun"]
                    .contains(d)
            })
            .collect::<Vec<_>>()
            .join(",");
        let days = if days.is_empty() { "all".to_string() } else { days };
        db.prepare("UPDATE slavebots SET active_days = ? WHERE id = ?")
            .bind(&[v_text(&days), v_text(id)])?
            .run()
            .await?;
    }
    if let Some(role) = role {
        let role: String = role.trim().chars().take(120).collect();
        db.prepare("UPDATE slavebots SET role = ? WHERE id = ?")
            .bind(&[v_text(&role), v_text(id)])?
            .run()
            .await?;
    }
    if let Some(relay) = relay {
        db.prepare("UPDATE slavebots SET relay = ? WHERE id = ?")
            .bind(&[v_real(if relay { 1.0 } else { 0.0 }), v_text(id)])?
            .run()
            .await?;
    }
    for (col, val) in [("active_start", active_start), ("active_end", active_end)] {
        if let Some(hhmm) = val.map(str::trim).filter(|v| valid_hhmm(v) || v.is_empty()) {
            let sql = format!("UPDATE slavebots SET {col} = ? WHERE id = ?");
            db.prepare(&sql)
                .bind(&[v_text(hhmm), v_text(id)])?
                .run()
                .await?;
        }
    }
    touch_bot(db, id).await?;
    get_bot(db, user_id, id).await
}

/// HH:MM 24-hour wall clock, e.g. "07:00".
pub fn valid_hhmm(v: &str) -> bool {
    if v.len() != 5 || v.as_bytes()[2] != b':' {
        return false;
    }
    let (hh, mm) = (&v[0..2], &v[3..5]);
    hh.chars().all(|c| c.is_ascii_digit())
        && mm.chars().all(|c| c.is_ascii_digit())
        && hh <= "23"
        && mm <= "59"
}

/// Refresh the title from the first user message (only while still untitled).
pub async fn maybe_title_bot(db: &Db, id: &str, first_message: &str) -> Result<()> {
    let title: String = first_message.chars().take(60).collect();
    if title.is_empty() {
        return Ok(());
    }
    db.prepare("UPDATE slavebots SET title = ? WHERE id = ? AND title = ''")
        .bind(&[v_text(&title), v_text(id)])?
        .run()
        .await?;
    Ok(())
}

/// Update a bot's avatar key (ownership already checked by the caller).
pub async fn set_avatar_key(db: &Db, user_id: &str, bot_id: &str, key: &str) -> Result<()> {
    db.prepare("UPDATE slavebots SET avatar_key = ? WHERE id = ? AND user_id = ?")
        .bind(&[v_text(key), v_text(bot_id), v_text(user_id)])?
        .run()
        .await?;
    Ok(())
}

pub async fn touch_bot(db: &Db, slavebot_id: &str) -> Result<()> {
    db.prepare("UPDATE slavebots SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .bind(&[v_text(slavebot_id)])?
        .run()
        .await?;
    Ok(())
}

pub async fn insert_message(db: &Db, slavebot_id: &str, role: &str, content: &str) -> Result<()> {
    db.prepare("INSERT INTO messages (slavebot_id, role, content) VALUES (?, ?, ?)")
        .bind(&[v_text(slavebot_id), v_text(role), v_text(content)])?
        .run()
        .await?;
    Ok(())
}

pub async fn recent_messages(db: &Db, slavebot_id: &str, limit: i32) -> Result<Vec<ChatMessage>> {
    let rows: Vec<MessageRow> = db
        .prepare("SELECT id, role, content, created_at FROM messages WHERE slavebot_id = ? ORDER BY id DESC LIMIT ?")
        .bind(&[v_text(slavebot_id), v_real(limit as f64)])?
        .all()
        .await?
        .results()?;
    let mut msgs: Vec<ChatMessage> = rows
        .into_iter()
        .rev()
        .map(|r| ChatMessage { role: r.role, content: r.content, ..Default::default() })
        .collect();
    // Defensive: keep only valid roles for the upstream call.
    msgs.retain(|m| m.role == "system" || m.role == "user" || m.role == "assistant");
    Ok(msgs)
}

pub struct UsageInput {
    pub model: String,
    pub prompt_tokens: u64,
    pub cached_tokens: u64,
    pub completion_tokens: u64,
    pub estimated: bool,
    /// Seconds of transcribed audio (voice endpoint only, else 0).
    pub audio_seconds: f64,
    /// Explicit cost in USD (voice bills by audio seconds, not tokens).
    pub cost_override: Option<f64>,
}

/// Insert a usage log row (token/cost telemetry only — every team pays its
/// own provider key, Slaver sells no credit). Returns the estimated cost.
pub async fn record_usage(
    db: &Db,
    user_id: &str,
    slavebot_id: Option<&str>,
    input: &UsageInput,
) -> Result<f64> {
    let rates = pricing::rates_for(&input.model);
    let cost = input.cost_override.unwrap_or_else(|| {
        pricing::cost_usd(&rates, input.prompt_tokens, input.cached_tokens, input.completion_tokens)
    });
    let total = input.prompt_tokens + input.completion_tokens;
    db.prepare(
        "INSERT INTO usage_logs (user_id, slavebot_id, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, estimated, audio_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&[
        v_text(user_id),
        slavebot_id.map(v_text).unwrap_or(v_null()),
        v_text(&input.model),
        v_real(input.prompt_tokens as f64),
        v_real(input.completion_tokens as f64),
        v_real(total as f64),
        v_real(cost),
        v_real(if input.estimated { 1.0 } else { 0.0 }),
        v_real(input.audio_seconds),
    ])?
    .run()
    .await?;
    Ok(cost)
}

/// Every bot the caller may use: team owner/admin see all team bots, staff
/// see granted bots, plus legacy creator-owned rows.
pub async fn list_bots(db: &Db, user_id: &str, include_archived: bool) -> Result<Vec<BotRow>> {
    let archived = if include_archived { "1 = 1" } else { "b.archived = 0" };
    let sql = format!(
        "SELECT b.id, b.user_id, b.team_id, b.name, b.title, b.model, b.memory, b.role, b.parent_id, b.pinned, b.pinned_by, b.owner_user_id, b.relay, b.avatar_key, b.archived, b.voice, b.active_days, b.active_start, b.active_end, b.created_at, b.updated_at \
         FROM slavebots b WHERE {archived} AND \
         ((b.team_id = '' AND b.user_id = ?) \
          OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = b.team_id AND m.user_id = ? AND m.role IN ('owner', 'admin')) \
          OR EXISTS (SELECT 1 FROM bot_grants g WHERE g.bot_id = b.id AND g.user_id = ?)) \
         ORDER BY b.updated_at DESC LIMIT 100"
    );
    db.prepare(&sql)
        .bind(&[v_text(user_id), v_text(user_id), v_text(user_id)])?
        .all()
        .await?
        .results()
}

/// True when the caller may manage the bot (rename, memory, model, archive,
/// pin): team owner/admin, or the legacy creator.
pub async fn can_manage(db: &Db, user_id: &str, bot_id: &str) -> Result<bool> {
    Ok(matches!(bot_access(db, user_id, bot_id).await?, Some((_, _, role)) if role == "owner" || role == "admin"))
}

pub async fn set_archived(db: &Db, user_id: &str, id: &str, archived: bool) -> Result<Option<BotRow>> {
    if !can_manage(db, user_id, id).await? {
        return Ok(None);
    }
    db.prepare("UPDATE slavebots SET archived = ? WHERE id = ?")
        .bind(&[v_real(if archived { 1.0 } else { 0.0 }), v_text(id)])?
        .run()
        .await?;
    if archived {
        // An archived bot can no longer be anyone's auto-opened one.
        db.prepare("UPDATE slavebots SET pinned = 0, pinned_by = '' WHERE id = ?")
            .bind(&[v_text(id)])?
            .run()
            .await?;
    }
    touch_bot(db, id).await?;
    get_bot_any(db, id).await
}

/// Pin a bot as the caller's auto-open bot. Pins are per user (tracked in
/// `pinned_by`) so teammates never clobber each other. Archived bots cannot
/// be pinned; only managers (owner/admin) may pin.
pub async fn set_pinned(db: &Db, user_id: &str, id: &str, pinned: bool) -> Result<Option<BotRow>> {
    let bot = match get_bot_any(db, id).await? {
        Some(b) => b,
        None => return Ok(None),
    };
    if !can_manage(db, user_id, id).await? {
        return Ok(None);
    }
    if pinned && bot.archived != 0 {
        return Err(anyhow!("Restore the bot before pinning it.".to_string()));
    }
    if pinned {
        db.prepare("UPDATE slavebots SET pinned = 1, pinned_by = ? WHERE id = ?")
            .bind(&[v_text(user_id), v_text(id)])?
            .run()
            .await?;
    } else if bot.pinned_by == user_id {
        db.prepare("UPDATE slavebots SET pinned = 0, pinned_by = '' WHERE id = ?")
            .bind(&[v_text(id)])?
            .run()
            .await?;
    }
    touch_bot(db, id).await?;
    get_bot_any(db, id).await
}

pub async fn bot_messages(db: &Db, user_id: &str, slavebot_id: &str) -> Result<Option<(BotRow, Vec<MessageRow>)>> {
    let bot = match get_bot(db, user_id, slavebot_id).await? {
        Some(b) => b,
        None => return Ok(None),
    };
    let messages: Vec<MessageRow> = db
        .prepare("SELECT id, role, content, created_at FROM messages WHERE slavebot_id = ? ORDER BY id ASC LIMIT 500")
        .bind(&[v_text(slavebot_id)])?
        .all()
        .await?
        .results()?;
    Ok(Some((bot, messages)))
}

#[derive(Deserialize, Serialize, Clone)]
pub struct GroupRow {
    pub id: String,
    pub team_id: String,
    pub name: String,
    pub is_public: i64,
    pub repo_id: String,
    pub project_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct PublicGroupRow {
    pub id: String,
    pub team_id: String,
    pub team_name: String,
    pub name: String,
    pub repo_id: String,
    pub created_at: String,
}

/// Groups live on a team: any member may use/rename one, only owner/admin
/// may delete it. Legacy team-less groups belong to their creator.
pub async fn create_group(db: &Db, user_id: &str, team_id: &str, name: &str) -> Result<GroupRow> {
    let team_id = if team_id.is_empty() {
        ensure_personal_team(db, user_id).await?.id
    } else {
        match membership(db, team_id, user_id).await? {
            Some(_) => team_id.to_string(),
            None => return Err(anyhow!("You are not on that team.".to_string())),
        }
    };
    let id = new_id();
    let name: String = name.trim().chars().take(40).collect();
    let name = if name.is_empty() { "New group".to_string() } else { name };
    db.prepare("INSERT INTO groups (id, user_id, team_id, name) VALUES (?, ?, ?, ?)")
        .bind(&[v_text(&id), v_text(user_id), v_text(&team_id), v_text(&name)])?
        .run()
        .await?;
    get_group(db, user_id, &id)
        .await?
        .ok_or_else(|| anyhow!("group insert failed".to_string()))
}

pub async fn get_group(db: &Db, user_id: &str, id: &str) -> Result<Option<GroupRow>> {
    let row: Option<GroupRow> = db
        .prepare("SELECT id, team_id, name, is_public, repo_id, project_id, created_at, updated_at FROM groups WHERE id = ?")
        .bind(&[v_text(id)])?
        .first(None)
        .await?;
    Ok(match row {
        Some(g) if g.team_id.is_empty() => {
            // Legacy group: creator only. Find the creator via user scoping.
            let mine: Option<GroupRow> = db
                .prepare("SELECT id, team_id, name, is_public, repo_id, project_id, created_at, updated_at FROM groups WHERE id = ? AND user_id = ?")
                .bind(&[v_text(id), v_text(user_id)])?
                .first(None)
                .await?;
            mine
        }
        // Public support groups are visible to every logged-in user.
        Some(g) if g.is_public != 0 => Some(g),
        Some(g) => membership(db, &g.team_id, user_id).await?.map(|_| g),
        None => None,
    })
}

/// Public support groups across all teams (anyone can read/post; only the
/// owning team's bots reply).
pub async fn list_public_groups(db: &Db) -> Result<Vec<PublicGroupRow>> {
    db.prepare(
        "SELECT g.id, g.team_id, t.name AS team_name, g.name, g.repo_id, g.created_at \
         FROM groups g LEFT JOIN teams t ON t.id = g.team_id \
         WHERE g.is_public != 0 AND g.team_id <> '' \
         ORDER BY g.updated_at DESC LIMIT 100",
    )
    .bind(&[])?
    .all()
    .await?
    .results()
}

/// Toggle a group's public support-channel visibility. Owner/admin of the
/// owning team only (legacy team-less groups: creator only).
pub async fn set_group_visibility(db: &Db, user_id: &str, id: &str, public: bool) -> Result<Option<GroupRow>> {
    let group = match get_group_any(id, db).await? {
        Some(g) => g,
        None => return Ok(None),
    };
    if group.team_id.is_empty() {
        let mine: Option<GroupRow> = db
            .prepare("SELECT id, team_id, name, is_public, repo_id, project_id, created_at, updated_at FROM groups WHERE id = ? AND user_id = ?")
            .bind(&[v_text(id), v_text(user_id)])?
            .first(None)
            .await?;
        if mine.is_none() {
            return Ok(None);
        }
    } else {
        match membership(db, &group.team_id, user_id).await? {
            Some(r) if r == "owner" || r == "admin" => {}
            _ => return Ok(None),
        }
    }
    db.prepare("UPDATE groups SET is_public = ? WHERE id = ?")
        .bind(&[v_int(if public { 1 } else { 0 }), v_text(id)])?
        .run()
        .await?;
    get_group(db, user_id, id).await
}

async fn get_group_any(id: &str, db: &Db) -> Result<Option<GroupRow>> {
    db.prepare("SELECT id, team_id, name, is_public, repo_id, project_id, created_at, updated_at FROM groups WHERE id = ?")
        .bind(&[v_text(id)])?
        .first(None)
        .await
}

pub async fn list_groups(db: &Db, user_id: &str) -> Result<Vec<GroupRow>> {
    db.prepare(
        "SELECT g.id, g.team_id, g.name, g.is_public, g.repo_id, g.project_id, g.created_at, g.updated_at FROM groups g \
         WHERE (g.team_id = '' AND g.user_id = ?) \
         OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = g.team_id AND m.user_id = ?) \
         ORDER BY g.updated_at DESC LIMIT 100",
    )
    .bind(&[v_text(user_id), v_text(user_id)])?
    .all()
    .await?
    .results()
}

pub async fn rename_group(db: &Db, user_id: &str, id: &str, name: &str) -> Result<Option<GroupRow>> {
    if get_group(db, user_id, id).await?.is_none() {
        return Ok(None);
    }
    let name: String = name.trim().chars().take(40).collect();
    if !name.is_empty() {
        db.prepare("UPDATE groups SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
            .bind(&[v_text(&name), v_text(id)])?
            .run()
            .await?;
    }
    get_group(db, user_id, id).await
}

pub async fn delete_group(db: &Db, user_id: &str, id: &str) -> Result<bool> {
    let group = match get_group(db, user_id, id).await? {
        Some(g) => g,
        None => return Ok(false),
    };
    if !group.team_id.is_empty() {
        match membership(db, &group.team_id, user_id).await? {
            Some(r) if r == "owner" || r == "admin" => {}
            _ => return Ok(false),
        }
    }
    db.prepare("DELETE FROM group_messages WHERE group_id = ?")
        .bind(&[v_text(id)])?
        .run()
        .await?;
    db.prepare("DELETE FROM group_members WHERE group_id = ?")
        .bind(&[v_text(id)])?
        .run()
        .await?;
    db.prepare("DELETE FROM groups WHERE id = ?")
        .bind(&[v_text(id)])?
        .run()
        .await?;
    Ok(true)
}

pub async fn group_members(db: &Db, user_id: &str, group_id: &str) -> Result<Vec<BotRow>> {
    if get_group(db, user_id, group_id).await?.is_none() {
        return Ok(vec![]);
    }
    db.prepare(
        "SELECT s.id, s.user_id, s.team_id, s.name, s.title, s.model, s.memory, s.role, s.parent_id, s.pinned, s.pinned_by, s.owner_user_id, s.relay, s.avatar_key, s.archived, s.voice, s.active_days, s.active_start, s.active_end, s.created_at, s.updated_at \
         FROM slavebots s JOIN group_members m ON m.slavebot_id = s.id \
         WHERE m.group_id = ? AND s.archived = 0 ORDER BY m.created_at ASC",
    )
    .bind(&[v_text(group_id)])?
    .all()
    .await?
    .results()
}

/// Max 8 bots per group — each group message fans out to every member.
pub const MAX_GROUP_MEMBERS: usize = 8;

pub async fn add_group_member(db: &Db, user_id: &str, group_id: &str, bot_id: &str) -> Result<Option<BotRow>> {
    let group = match get_group(db, user_id, group_id).await? {
        Some(g) => g,
        None => return Ok(None),
    };
    let bot = match get_bot(db, user_id, bot_id).await? {
        Some(b) => b,
        None => return Ok(None),
    };
    if bot.team_id != group.team_id {
        return Err(anyhow!("That bot is on a different team.".to_string()));
    }
    let members = group_members(db, user_id, &group.id).await?;
    if members.len() >= MAX_GROUP_MEMBERS && !members.iter().any(|m| m.id == bot_id) {
        return Err(anyhow!(format!("Group is full (max {MAX_GROUP_MEMBERS} bots).")));
    }
    db.prepare("INSERT OR IGNORE INTO group_members (group_id, slavebot_id) VALUES (?, ?)")
        .bind(&[v_text(&group.id), v_text(&bot.id)])?
        .run()
        .await?;
    touch_group(db, &group.id).await?;
    Ok(Some(bot))
}

pub async fn remove_group_member(db: &Db, user_id: &str, group_id: &str, bot_id: &str) -> Result<bool> {
    if get_group(db, user_id, group_id).await?.is_none() {
        return Ok(false);
    }
    db.prepare("DELETE FROM group_members WHERE group_id = ? AND slavebot_id = ?")
        .bind(&[v_text(group_id), v_text(bot_id)])?
        .run()
        .await?;
    touch_group(db, group_id).await?;
    Ok(true)
}

pub async fn touch_group(db: &Db, group_id: &str) -> Result<()> {
    db.prepare("UPDATE groups SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .bind(&[v_text(group_id)])?
        .run()
        .await?;
    Ok(())
}

pub async fn insert_group_message(
    db: &Db,
    group_id: &str,
    slavebot_id: Option<&str>,
    user_id: Option<&str>,
    role: &str,
    content: &str,
) -> Result<()> {
    // user_id is NOT NULL ('' = bot message): never bind an explicit NULL.
    db.prepare("INSERT INTO group_messages (group_id, slavebot_id, user_id, role, content) VALUES (?, ?, ?, ?, ?)")
        .bind(&[
            v_text(group_id),
        slavebot_id.map(v_text).unwrap_or(v_null()),
            user_id.map(v_text).unwrap_or_else(|| v_text("")),
            v_text(role),
            v_text(content),
        ])?
        .run()
        .await?;
    Ok(())
}

pub async fn group_history(db: &Db, group_id: &str, limit: i32) -> Result<Vec<GroupMessageRow>> {
    db.prepare(
        "SELECT g.id, g.slavebot_id, s.name AS bot_name, g.user_id, COALESCE(u.name, u.email) AS user_name, g.role, g.content, g.created_at \
         FROM group_messages g LEFT JOIN slavebots s ON s.id = g.slavebot_id LEFT JOIN users u ON u.id = g.user_id \
         WHERE g.group_id = ? ORDER BY g.id DESC LIMIT ?",
    )
    .bind(&[v_text(group_id), v_real(limit as f64)])?
    .all()
    .await?
    .results::<GroupMessageRow>()
    .map(|mut rows| {
        rows.reverse();
        rows
    })
}

/// Append a fact to a bot's memory (capped at 4000 chars, oldest trimmed).
pub async fn append_memory(db: &Db, user_id: &str, bot_id: &str, text: &str) -> Result<Option<String>> {
    if !can_manage(db, user_id, bot_id).await? {
        return Ok(None);
    }
    let bot = match get_bot_any(db, bot_id).await? {
        Some(b) => b,
        None => return Ok(None),
    };
    let text = text.trim();
    if text.is_empty() || text.len() > 2000 {
        return Err(anyhow!("Memory snippet must be 1..2000 characters.".to_string()));
    }
    let mut memory = bot.memory;
    if !memory.is_empty() && !memory.ends_with('\n') {
        memory.push('\n');
    }
    memory.push_str("- ");
    memory.push_str(text);
    while memory.len() > 4000 {
        if let Some(pos) = memory.find('\n') {
            memory = memory[pos + 1..].to_string();
        } else {
            memory = truncate_chars(&memory, 4000);
            break;
        }
    }
    db.prepare("UPDATE slavebots SET memory = ? WHERE id = ?")
        .bind(&[v_text(&memory), v_text(bot_id)])?
        .run()
        .await?;
    touch_bot(db, bot_id).await?;
    Ok(Some(memory))
}

fn truncate_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

#[derive(Deserialize)]
pub struct BotScope {
    pub id: String,
    pub user_id: String,
}

/// Every active bot with its owner — for the scheduled summarizer only.
pub async fn all_bot_scopes(db: &Db) -> Result<Vec<BotScope>> {
    db.prepare("SELECT id, user_id FROM slavebots WHERE archived = 0")
        .bind(&[])?
        .all()
        .await?
        .results()
}

/// Group-channel activity involving one bot since a UTC timestamp (ISO-8601),
/// oldest first, capped for prompts. Covers both the bot's own replies and
/// the human tasks posted in its groups — this is how group work lands in
/// the bot's automatic recaps without any manual "+memory" step.
pub async fn group_messages_for_bot_since(
    db: &Db,
    slavebot_id: &str,
    since_iso: &str,
    limit: i32,
) -> Result<Vec<GroupMemoryRow>> {
    db.prepare(
        "SELECT gr.name AS group_name, \
                COALESCE(s.name, u.name, u.email, 'user') AS author, \
                g.role AS role, g.content AS content, g.created_at AS created_at \
         FROM group_messages g \
         JOIN groups gr ON gr.id = g.group_id \
         LEFT JOIN slavebots s ON s.id = g.slavebot_id \
         LEFT JOIN users u ON u.id = g.user_id \
         WHERE g.created_at >= ? \
           AND EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = g.group_id AND m.slavebot_id = ?) \
         ORDER BY g.created_at ASC LIMIT ?",
    )
    .bind(&[v_text(since_iso), v_text(slavebot_id), v_real(limit as f64)])?
    .all()
    .await?
    .results()
}

#[derive(Deserialize, Serialize, Clone)]
pub struct GroupMemoryRow {
    pub group_name: String,
    pub author: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

/// Messages since a UTC timestamp (ISO-8601), oldest first, capped for prompts.
pub async fn messages_since(
    db: &Db,
    slavebot_id: &str,
    since_iso: &str,
    limit: i32,
) -> Result<Vec<MessageRow>> {
    db.prepare("SELECT role, content, created_at FROM messages WHERE slavebot_id = ? AND created_at >= ? ORDER BY id ASC LIMIT ?")
        .bind(&[v_text(slavebot_id), v_text(since_iso), v_real(limit as f64)])?
        .all()
        .await?
        .results()
}

#[derive(Deserialize, Serialize)]
pub struct SummaryRow {
    pub id: i64,
    pub period: String,
    pub period_key: String,
    pub content: String,
    pub created_at: String,
}

pub async fn upsert_summary(
    db: &Db,
    slavebot_id: &str,
    period: &str,
    period_key: &str,
    content: &str,
) -> Result<SummaryRow> {
    db.prepare(
        "INSERT INTO summaries (slavebot_id, period, period_key, content) VALUES (?, ?, ?, ?) \
         ON CONFLICT(slavebot_id, period, period_key) DO UPDATE SET content = excluded.content",
    )
    .bind(&[v_text(slavebot_id), v_text(period), v_text(period_key), v_text(content)])?
    .run()
    .await?;
    let row: Option<SummaryRow> = db
        .prepare("SELECT id, period, period_key, content, created_at FROM summaries WHERE slavebot_id = ? AND period = ? AND period_key = ?")
        .bind(&[v_text(slavebot_id), v_text(period), v_text(period_key)])?
        .first(None)
        .await?;
    row.ok_or_else(|| anyhow!("summary upsert failed".to_string()))
}

pub async fn list_summaries(
    db: &Db,
    slavebot_id: &str,
    period: &str,
    limit: i32,
) -> Result<Vec<SummaryRow>> {
    db.prepare("SELECT id, period, period_key, content, created_at FROM summaries WHERE slavebot_id = ? AND period = ? ORDER BY period_key DESC LIMIT ?")
        .bind(&[v_text(slavebot_id), v_text(period), v_real(limit as f64)])?
        .all()
        .await?
        .results()
}

/// Wall-clock "now" in the bot timezone (Asia/Jakarta, UTC+7, no DST),
/// formatted so lexicographic comparison matches chronological order.
pub fn jakarta_now_iso() -> String {
    let now = chrono::Utc::now() + chrono::Duration::hours(7);
    now.format("%Y-%m-%dT%H:%M:00").to_string()
}

fn jakarta_weekday(now_iso: &str) -> String {
    chrono::NaiveDateTime::parse_from_str(now_iso, "%Y-%m-%dT%H:%M:%S")
        .map(|dt| format!("{:?}", dt.date().weekday()).to_lowercase())
        .unwrap_or_else(|_| "mon".to_string())
}

fn day_matches(days: &str, weekday: &str) -> bool {
    let days = days.trim().to_lowercase();
    if days.is_empty() || days == "all" {
        return true;
    }
    let parts: Vec<&str> = days.split(',').map(str::trim).collect();
    if parts.contains(&"all") {
        return true;
    }
    if parts.contains(&"weekdays") && ["mon", "tue", "wed", "thu", "fri"].contains(&weekday) {
        return true;
    }
    if parts.contains(&"weekends") && ["sat", "sun"].contains(&weekday) {
        return true;
    }
    parts.contains(&weekday)
}

/// Is the bot inside its own active window right now? Empty hours = always on.
pub fn bot_in_window(bot: &BotRow, now_iso: &str) -> bool {
    if !day_matches(&bot.active_days, &jakarta_weekday(now_iso)) {
        return false;
    }
    let (s, e) = (bot.active_start.trim(), bot.active_end.trim());
    if s.is_empty() || e.is_empty() || s == e {
        return true;
    }
    let t: String = now_iso.chars().skip(11).take(5).collect();
    let (t, s, e) = (t.as_str(), s, e);
    if s <= e {
        s <= t && t < e
    } else {
        t >= s || t < e
    }
}

/// Next run (Jakarta wall-clock ISO) strictly after `now_iso`.
pub fn next_run_after(
    kind: &str,
    time_hhmm: &str,
    days: &str,
    interval_minutes: i64,
    now_iso: &str,
) -> Option<String> {
    let now = chrono::NaiveDateTime::parse_from_str(now_iso, "%Y-%m-%dT%H:%M:%S").ok()?;
    match kind {
        "interval" => {
            let mins = interval_minutes.clamp(5, 60 * 24 * 7).max(5);
            Some((now + chrono::Duration::minutes(mins)).format("%Y-%m-%dT%H:%M:00").to_string())
        }
        _ => {
            if !valid_hhmm(time_hhmm) {
                return None;
            }
            for offset in 0..=8 {
                let day = now.date() + chrono::Days::new(offset);
                let cand = format!("{}T{}:00", day.format("%Y-%m-%d"), time_hhmm);
                if cand.as_str() <= now_iso {
                    continue;
                }
                let weekday = format!("{:?}", day.weekday()).to_lowercase();
                if kind == "once" || day_matches(days, &weekday) {
                    return Some(cand);
                }
            }
            None
        }
    }
}

#[derive(Deserialize, Serialize, Clone)]
pub struct ScheduleRow {
    pub id: String,
    pub user_id: String,
    pub slavebot_id: String,
    pub name: String,
    pub kind: String,
    pub time_hhmm: String,
    pub days: String,
    pub interval_minutes: i64,
    pub prompt: String,
    pub active: i64,
    pub next_run_at: String,
    pub last_run_at: String,
    pub created_at: String,
}

#[allow(clippy::too_many_arguments)]
pub async fn create_schedule(
    db: &Db,
    user_id: &str,
    bot_id: &str,
    name: &str,
    kind: &str,
    time_hhmm: &str,
    days: &str,
    interval_minutes: i64,
    prompt: &str,
) -> Result<ScheduleRow> {
    let kind = match kind {
        "once" | "daily" | "interval" => kind,
        _ => "daily",
    };
    let prompt: String = prompt.trim().chars().take(1000).collect();
    if prompt.is_empty() {
        return Err(anyhow!("Schedule prompt must be 1..1000 characters.".to_string()));
    }
    let days = if days.trim().is_empty() { "all" } else { days.trim() };
    let now = jakarta_now_iso();
    let next = next_run_after(kind, time_hhmm, days, interval_minutes, &now)
        .ok_or_else(|| anyhow!("Could not compute the next run time.".to_string()))?;
    let id = new_id();
    let name: String = if name.trim().is_empty() {
        "Scheduled task".to_string()
    } else {
        name.trim().chars().take(60).collect()
    };
    db.prepare(
        "INSERT INTO schedules (id, user_id, slavebot_id, name, kind, time_hhmm, days, interval_minutes, prompt, next_run_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&[
        v_text(&id),
        v_text(user_id),
        v_text(bot_id),
        v_text(&name),
        v_text(kind),
        v_text(time_hhmm),
        v_text(days),
        v_real(interval_minutes as f64),
        v_text(&prompt),
        v_text(&next),
    ])?
    .run()
    .await?;
    get_schedule(db, user_id, &id)
        .await?
        .ok_or_else(|| anyhow!("schedule insert failed".to_string()))
}

pub async fn get_schedule(db: &Db, user_id: &str, id: &str) -> Result<Option<ScheduleRow>> {
    db.prepare(
        "SELECT id, user_id, slavebot_id, name, kind, time_hhmm, days, interval_minutes, prompt, active, next_run_at, last_run_at, created_at \
         FROM schedules WHERE id = ? AND user_id = ?",
    )
    .bind(&[v_text(id), v_text(user_id)])?
    .first(None)
    .await
}

pub async fn list_schedules(
    db: &Db,
    user_id: &str,
    bot_id: Option<&str>,
) -> Result<Vec<ScheduleRow>> {
    if let Some(bot) = bot_id {
        db.prepare(
            "SELECT id, user_id, slavebot_id, name, kind, time_hhmm, days, interval_minutes, prompt, active, next_run_at, last_run_at, created_at \
             FROM schedules WHERE user_id = ? AND slavebot_id = ? ORDER BY next_run_at ASC LIMIT 100",
        )
        .bind(&[v_text(user_id), v_text(bot)])?
        .all()
        .await?
        .results()
    } else {
        db.prepare(
            "SELECT id, user_id, slavebot_id, name, kind, time_hhmm, days, interval_minutes, prompt, active, next_run_at, last_run_at, created_at \
             FROM schedules WHERE user_id = ? ORDER BY next_run_at ASC LIMIT 100",
        )
        .bind(&[v_text(user_id)])?
        .all()
        .await?
        .results()
    }
}

pub async fn set_schedule_active(
    db: &Db,
    user_id: &str,
    id: &str,
    active: bool,
) -> Result<Option<ScheduleRow>> {
    let sched = match get_schedule(db, user_id, id).await? {
        Some(s) => s,
        None => return Ok(None),
    };
    let next = if active && sched.next_run_at.is_empty() {
        next_run_after(&sched.kind, &sched.time_hhmm, &sched.days, sched.interval_minutes, &jakarta_now_iso())
            .unwrap_or_default()
    } else {
        sched.next_run_at.clone()
    };
    db.prepare("UPDATE schedules SET active = ?, next_run_at = ? WHERE id = ? AND user_id = ?")
        .bind(&[
            v_real(if active { 1.0 } else { 0.0 }),
            v_text(&next),
            v_text(id),
            v_text(user_id),
        ])?
        .run()
        .await?;
    get_schedule(db, user_id, id).await
}

pub async fn delete_schedule(db: &Db, user_id: &str, id: &str) -> Result<bool> {
    if get_schedule(db, user_id, id).await?.is_none() {
        return Ok(false);
    }
    db.prepare("DELETE FROM schedules WHERE id = ? AND user_id = ?")
        .bind(&[v_text(id), v_text(user_id)])?
        .run()
        .await?;
    Ok(true)
}

/// Schedules ready to fire (active, next_run_at passed). Runner re-checks the bot.
pub async fn due_schedules(db: &Db, now_iso: &str) -> Result<Vec<ScheduleRow>> {
    db.prepare(
        "SELECT id, user_id, slavebot_id, name, kind, time_hhmm, days, interval_minutes, prompt, active, next_run_at, last_run_at, created_at \
         FROM schedules WHERE active = 1 AND next_run_at <> '' AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT 50",
    )
    .bind(&[v_text(now_iso)])?
    .all()
    .await?
    .results()
}

/// Spawn a sub-bot under a manager bot. The child inherits the manager's model
/// unless overridden, and carries the manager link in parent_id.
pub async fn spawn_bot(
    db: &Db,
    user_id: &str,
    manager_id: &str,
    name: &str,
    role: &str,
    model: &str,
) -> Result<BotRow> {
    let manager = get_bot(db, user_id, manager_id)
        .await?
        .ok_or_else(|| anyhow!("Manager bot not found.".to_string()))?;
    if manager.archived != 0 {
        return Err(anyhow!("That bot is archived — restore it first.".to_string()));
    }
    let name: String = {
        let n = name.trim().chars().take(40).collect::<String>();
        if n.is_empty() {
            format!("{} Jr {}", manager.name.chars().take(28).collect::<String>(), bot_count(db, user_id).await? + 1)
        } else {
            n
        }
    };
    let role: String = role.trim().chars().take(120).collect();
    let id = new_id();
    db.prepare("INSERT INTO slavebots (id, user_id, team_id, name, title, model, role, parent_id) VALUES (?, ?, ?, ?, '', ?, ?, ?)")
        .bind(&[v_text(&id), v_text(user_id), v_text(&manager.team_id), v_text(&name), v_text(model), v_text(&role), v_text(manager_id)])?
        .run()
        .await?;
    // Staff spawning inside a team get access to their own sub-bot.
    if manager.team_id.is_empty() {
        // Legacy team-less manager: nothing to grant, ownership is by creator.
    } else if let Some(role) = membership(db, &manager.team_id, user_id).await? {
        if role == "staff" {
            db.prepare("INSERT OR IGNORE INTO bot_grants (bot_id, user_id) VALUES (?, ?)")
                .bind(&[v_text(&id), v_text(user_id)])?
                .run()
                .await?;
        }
    }
    Ok(get_bot_any(db, &id)
        .await?
        .expect("just-inserted sub-bot must exist"))
}

/// Direct sub-bots of one manager (access filtered by the caller).
pub async fn children_of(db: &Db, user_id: &str, manager_id: &str) -> Result<Vec<BotRow>> {
    if bot_access(db, user_id, manager_id).await?.is_none() {
        return Ok(vec![]);
    }
    let rows: Vec<BotRow> = db
        .prepare(
            "SELECT id, user_id, team_id, name, title, model, memory, role, parent_id, pinned, pinned_by, owner_user_id, relay, avatar_key, archived, voice, active_days, active_start, active_end, created_at, updated_at \
             FROM slavebots WHERE parent_id = ? ORDER BY created_at ASC LIMIT 50",
        )
        .bind(&[v_text(manager_id)])?
        .all()
        .await?
        .results()?;
    let mut visible = Vec::new();
    for b in rows {
        if bot_access(db, user_id, &b.id).await?.is_some() {
            visible.push(b);
        }
    }
    Ok(visible)
}

#[derive(Deserialize, Serialize, Clone)]
pub struct MeetingRow {
    pub id: String,
    pub user_id: String,
    pub team_id: String,
    pub topic: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct MeetingParticipant {
    pub meeting_id: String,
    pub slavebot_id: String,
    pub bot_name: Option<String>,
    pub decision: String,
    pub reason: String,
    pub created_at: String,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct GroupMessageRow {
    pub id: i64,
    pub slavebot_id: Option<String>,
    pub bot_name: Option<String>,
    pub user_id: Option<String>,
    pub user_name: Option<String>,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct GroupUserRow {
    pub user_id: String,
    pub name: String,
    pub email: Option<String>,
}

/// Human members of a group (mixed human + AI channels).
pub async fn group_user_members(db: &Db, group_id: &str) -> Result<Vec<GroupUserRow>> {
    db.prepare(
        "SELECT m.user_id AS user_id, COALESCE(u.name, u.email, m.user_id) AS name, u.email AS email \
         FROM group_members m LEFT JOIN users u ON u.id = m.user_id \
         WHERE m.group_id = ? AND m.user_id <> '' ORDER BY m.created_at ASC",
    )
    .bind(&[v_text(group_id)])?
    .all()
    .await?
    .results()
}

pub async fn add_group_user(db: &Db, group_id: &str, user_id: &str) -> Result<()> {
    db.prepare("INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)")
        .bind(&[v_text(group_id), v_text(user_id)])?
        .run()
        .await?;
    touch_group(db, group_id).await
}

pub async fn remove_group_user(db: &Db, group_id: &str, user_id: &str) -> Result<()> {
    db.prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?")
        .bind(&[v_text(group_id), v_text(user_id)])?
        .run()
        .await?;
    touch_group(db, group_id).await
}

// ---------- user-to-user direct messages (same team) ----------

#[derive(Deserialize, Serialize, Clone)]
pub struct DirectMessageRow {
    pub id: i64,
    pub team_id: String,
    pub from_user_id: String,
    pub from_name: Option<String>,
    pub to_user_id: String,
    pub content: String,
    pub created_at: String,
}

pub async fn dm_history(
    db: &Db,
    team_id: &str,
    me: &str,
    peer_id: &str,
    limit: i64,
) -> Result<Vec<DirectMessageRow>> {
    db.prepare(
        "SELECT m.id, m.team_id, m.from_user_id, COALESCE(u.name, u.email) AS from_name, m.to_user_id, m.content, m.created_at \
         FROM direct_messages m LEFT JOIN users u ON u.id = m.from_user_id \
         WHERE m.team_id = ? AND ((m.from_user_id = ? AND m.to_user_id = ?) OR (m.from_user_id = ? AND m.to_user_id = ?)) \
         ORDER BY m.id DESC LIMIT ?",
    )
    .bind(&[v_text(team_id), v_text(me), v_text(peer_id), v_text(peer_id), v_text(me), v_int(limit.clamp(1, 200))])?
    .all()
    .await?
    .results()
    .map(|mut rows: Vec<DirectMessageRow>| {
        rows.reverse();
        rows
    })
}

pub async fn dm_send(
    db: &Db,
    team_id: &str,
    from_id: &str,
    to_id: &str,
    content: &str,
) -> Result<DirectMessageRow> {
    let content = content.trim();
    if content.is_empty() || content.len() > 4000 {
        return Err(anyhow!("message must be 1..4000 characters."));
    }
    if from_id == to_id {
        return Err(anyhow!("Pick someone else to message."));
    }
    db.prepare("INSERT INTO direct_messages (team_id, from_user_id, to_user_id, content) VALUES (?, ?, ?, ?)")
        .bind(&[v_text(team_id), v_text(from_id), v_text(to_id), v_text(content)])?
        .run()
        .await?;
    let rows: Vec<DirectMessageRow> = db
        .prepare(
            "SELECT m.id, m.team_id, m.from_user_id, COALESCE(u.name, u.email) AS from_name, m.to_user_id, m.content, m.created_at \
             FROM direct_messages m LEFT JOIN users u ON u.id = m.from_user_id \
             WHERE m.team_id = ? AND m.from_user_id = ? AND m.to_user_id = ? ORDER BY m.id DESC LIMIT 1",
        )
        .bind(&[v_text(team_id), v_text(from_id), v_text(to_id)])?
        .all()
        .await?
        .results()?;
    rows.into_iter().next().ok_or_else(|| anyhow!("message insert failed"))
}

// ---------- live read state (unread badges + notifications) ----------

#[derive(Deserialize, Serialize, Clone)]
pub struct UnreadRow {
    pub kind: String,
    pub team_id: String,
    pub ref_id: String,
    pub name: String,
    pub unread: i64,
    pub preview: String,
    pub at: String,
}

pub async fn get_read_last(db: &Db, user_id: &str, kind: &str, team_id: &str, ref_id: &str) -> Result<i64> {
    #[derive(Deserialize)]
    struct R {
        last_id: i64,
    }
    let row: Option<R> = db
        .prepare("SELECT last_id FROM read_state WHERE user_id = ? AND kind = ? AND team_id = ? AND ref_id = ?")
        .bind(&[v_text(user_id), v_text(kind), v_text(team_id), v_text(ref_id)])?
        .first(None)
        .await?;
    Ok(row.map(|r| r.last_id).unwrap_or(0))
}

pub async fn set_read(db: &Db, user_id: &str, kind: &str, team_id: &str, ref_id: &str, last_id: i64) -> Result<()> {
    db.prepare(
        "INSERT INTO read_state (user_id, kind, team_id, ref_id, last_id, updated_at) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) \
         ON CONFLICT(user_id, kind, team_id, ref_id) DO UPDATE SET last_id = max(last_id, excluded.last_id), updated_at = excluded.updated_at",
    )
    .bind(&[v_text(user_id), v_text(kind), v_text(team_id), v_text(ref_id), v_int(last_id.max(0))])?
    .run()
    .await?;
    Ok(())
}

fn recent_enough(created_at: &str) -> bool {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(7);
    created_at >= cutoff.format("%Y-%m-%dT%H:%M:%fZ").to_string().as_str()
}

/// Unread conversations for the sidebar badges. Only conversations with
/// activity in the last 7 days are included, so ancient history never
/// lights up badges on first login.
pub async fn unread_list(db: &Db, user_id: &str) -> Result<Vec<UnreadRow>> {
    #[derive(Deserialize)]
    struct C {
        n: i64,
    }
    #[derive(Deserialize)]
    struct L {
        content: String,
        created_at: String,
    }
    let mut out = Vec::new();
    // DMs: every peer pair the user has ever messaged; count only inbound.
    #[derive(Deserialize)]
    struct Peer {
        team_id: String,
        peer_id: String,
        peer_name: String,
    }
    let peers: Vec<Peer> = db
        .prepare(
            "SELECT DISTINCT d.team_id AS team_id, \
                    CASE WHEN d.from_user_id = ? THEN d.to_user_id ELSE d.from_user_id END AS peer_id, \
                    COALESCE(u.name, u.email, '') AS peer_name \
             FROM direct_messages d LEFT JOIN users u ON u.id = CASE WHEN d.from_user_id = ? THEN d.to_user_id ELSE d.from_user_id END \
             WHERE d.from_user_id = ? OR d.to_user_id = ?",
        )
        .bind(&[v_text(user_id), v_text(user_id), v_text(user_id), v_text(user_id)])?
        .all()
        .await?
        .results()?;
    for p in peers {
        let last = get_read_last(db, user_id, "dm", &p.team_id, &p.peer_id).await?;
        let c: Option<C> = db
            .prepare("SELECT COUNT(*) AS n FROM direct_messages WHERE team_id = ? AND from_user_id = ? AND to_user_id = ? AND id > ?")
            .bind(&[v_text(&p.team_id), v_text(&p.peer_id), v_text(user_id), v_int(last)])?
            .first(None)
            .await?;
        let n = c.map(|x| x.n).unwrap_or(0);
        if n <= 0 {
            continue;
        }
        if let Some(latest) = db
            .prepare(
                "SELECT content, created_at FROM direct_messages WHERE team_id = ? AND ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)) ORDER BY id DESC LIMIT 1",
            )
            .bind(&[v_text(&p.team_id), v_text(&p.peer_id), v_text(user_id), v_text(user_id), v_text(&p.peer_id)])?
            .first::<L>(None)
            .await?
        {
            if recent_enough(&latest.created_at) {
                out.push(UnreadRow {
                    kind: "dm".to_string(),
                    team_id: p.team_id,
                    ref_id: p.peer_id,
                    name: p.peer_name,
                    unread: n,
                    preview: latest.content.chars().take(120).collect(),
                    at: latest.created_at,
                });
            }
        }
    }
    // Groups the user can see (member or public): count others' messages
    // (bot replies store NULL user_id; humans store their id).
    let groups: Vec<GroupRow> = list_groups(db, user_id).await?;
    for g in groups {
        let last = get_read_last(db, user_id, "group", &g.team_id, &g.id).await?;
        let c: Option<C> = db
            .prepare("SELECT COUNT(*) AS n FROM group_messages WHERE group_id = ? AND (user_id IS NULL OR user_id <> ?) AND id > ?")
            .bind(&[v_text(&g.id), v_text(user_id), v_int(last)])?
            .first(None)
            .await?;
        let n = c.map(|x| x.n).unwrap_or(0);
        if n <= 0 {
            continue;
        }
        if let Some(latest) = db
            .prepare("SELECT content, created_at FROM group_messages WHERE group_id = ? ORDER BY id DESC LIMIT 1")
            .bind(&[v_text(&g.id)])?
            .first::<L>(None)
            .await?
        {
            if recent_enough(&latest.created_at) {
                out.push(UnreadRow {
                    kind: "group".to_string(),
                    team_id: g.team_id,
                    ref_id: g.id,
                    name: g.name,
                    unread: n,
                    preview: latest.content.chars().take(120).collect(),
                    at: latest.created_at,
                });
            }
        }
    }
    // Meetings on the user's teams: count bot replies.
    let meetings: Vec<MeetingRow> = list_meetings(db, user_id).await?;
    for m in meetings {
        let last = get_read_last(db, user_id, "meeting", &m.team_id, &m.id).await?;
        let c: Option<C> = db
            .prepare("SELECT COUNT(*) AS n FROM meeting_messages WHERE meeting_id = ? AND slavebot_id IS NOT NULL AND id > ?")
            .bind(&[v_text(&m.id), v_int(last)])?
            .first(None)
            .await?;
        let n = c.map(|x| x.n).unwrap_or(0);
        if n <= 0 {
            continue;
        }
        if let Some(latest) = db
            .prepare("SELECT content, created_at FROM meeting_messages WHERE meeting_id = ? ORDER BY id DESC LIMIT 1")
            .bind(&[v_text(&m.id)])?
            .first::<L>(None)
            .await?
        {
            if recent_enough(&latest.created_at) {
                out.push(UnreadRow {
                    kind: "meeting".to_string(),
                    team_id: m.team_id,
                    ref_id: m.id,
                    name: m.topic,
                    unread: n,
                    preview: latest.content.chars().take(120).collect(),
                    at: latest.created_at,
                });
            }
        }
    }
    // Bot DMs with new assistant replies (own echoes don't count).
    let bots_list = list_bots(db, user_id, false).await?;
    for b in bots_list {
        let last = get_read_last(db, user_id, "bot", &b.team_id, &b.id).await?;
        let c: Option<C> = db
            .prepare("SELECT COUNT(*) AS n FROM messages WHERE slavebot_id = ? AND role = 'assistant' AND id > ?")
            .bind(&[v_text(&b.id), v_int(last)])?
            .first(None)
            .await?;
        let n = c.map(|x| x.n).unwrap_or(0);
        if n <= 0 {
            continue;
        }
        if let Some(latest) = db
            .prepare("SELECT content, created_at FROM messages WHERE slavebot_id = ? ORDER BY id DESC LIMIT 1")
            .bind(&[v_text(&b.id)])?
            .first::<L>(None)
            .await?
        {
            if recent_enough(&latest.created_at) {
                out.push(UnreadRow {
                    kind: "bot".to_string(),
                    team_id: b.team_id,
                    ref_id: b.id,
                    name: b.name,
                    unread: n,
                    preview: latest.content.chars().take(120).collect(),
                    at: latest.created_at,
                });
            }
        }
    }
    out.sort_by(|a, b| b.at.cmp(&a.at));
    Ok(out)
}


pub async fn create_meeting(db: &Db, user_id: &str, team_id: &str, topic: &str) -> Result<MeetingRow> {
    let team_id = if team_id.is_empty() {
        ensure_personal_team(db, user_id).await?.id
    } else {
        match membership(db, team_id, user_id).await? {
            Some(_) => team_id.to_string(),
            None => return Err(anyhow!("You are not on that team.".to_string())),
        }
    };
    let topic: String = topic.trim().chars().take(500).collect();
    if topic.is_empty() {
        return Err(anyhow!("Meeting topic must be 1..500 characters.".to_string()));
    }
    let id = new_id();
    db.prepare("INSERT INTO meetings (id, user_id, team_id, topic) VALUES (?, ?, ?, ?)")
        .bind(&[v_text(&id), v_text(user_id), v_text(&team_id), v_text(&topic)])?
        .run()
        .await?;
    get_meeting(db, user_id, &id)
        .await?
        .ok_or_else(|| anyhow!("meeting insert failed".to_string()))
}

pub async fn get_meeting(db: &Db, user_id: &str, id: &str) -> Result<Option<MeetingRow>> {
    let row: Option<MeetingRow> = db
        .prepare("SELECT id, user_id, team_id, topic, status, created_at, updated_at FROM meetings WHERE id = ?")
        .bind(&[v_text(id)])?
        .first(None)
        .await?;
    Ok(match row {
        Some(h) if h.team_id.is_empty() => {
            let mine: Option<MeetingRow> = db
                .prepare("SELECT id, user_id, team_id, topic, status, created_at, updated_at FROM meetings WHERE id = ? AND user_id = ?")
                .bind(&[v_text(id), v_text(user_id)])?
                .first(None)
                .await?;
            mine
        }
        Some(h) => membership(db, &h.team_id, user_id).await?.map(|_| h),
        None => None,
    })
}

pub async fn list_meetings(db: &Db, user_id: &str) -> Result<Vec<MeetingRow>> {
    db.prepare(
        "SELECT h.id, h.user_id, h.team_id, h.topic, h.status, h.created_at, h.updated_at FROM meetings h \
         WHERE (h.team_id = '' AND h.user_id = ?) \
         OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = h.team_id AND m.user_id = ?) \
         ORDER BY h.updated_at DESC LIMIT 50",
    )
    .bind(&[v_text(user_id), v_text(user_id)])?
    .all()
    .await?
    .results()
}

pub async fn touch_meeting(db: &Db, id: &str) -> Result<()> {
    db.prepare("UPDATE meetings SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .bind(&[v_text(id)])?
        .run()
        .await?;
    Ok(())
}

pub async fn delete_meeting(db: &Db, user_id: &str, id: &str) -> Result<bool> {
    let meeting = match get_meeting(db, user_id, id).await? {
        Some(h) => h,
        None => return Ok(false),
    };
    if !meeting.team_id.is_empty() {
        match membership(db, &meeting.team_id, user_id).await? {
            Some(r) if r == "owner" || r == "admin" => {}
            _ => return Ok(false),
        }
    }
    // Child tables carry no user_id: they are scoped by the ownership check above.
    db.prepare("DELETE FROM meeting_messages WHERE meeting_id = ?")
        .bind(&[v_text(id)])?
        .run()
        .await?;
    db.prepare("DELETE FROM meeting_participants WHERE meeting_id = ?")
        .bind(&[v_text(id)])?
        .run()
        .await?;
    db.prepare("DELETE FROM meetings WHERE id = ?")
        .bind(&[v_text(id)])?
        .run()
        .await?;
    Ok(true)
}

pub async fn set_participant(
    db: &Db,
    meeting_id: &str,
    bot_id: &str,
    decision: &str,
    reason: &str,
) -> Result<()> {
    let reason: String = reason.chars().take(300).collect();
    db.prepare(
        "INSERT INTO meeting_participants (meeting_id, slavebot_id, decision, reason) VALUES (?, ?, ?, ?) \
         ON CONFLICT(meeting_id, slavebot_id) DO UPDATE SET decision = excluded.decision, reason = excluded.reason",
    )
    .bind(&[v_text(meeting_id), v_text(bot_id), v_text(decision), v_text(&reason)])?
    .run()
    .await?;
    Ok(())
}

pub async fn meeting_participants(db: &Db, meeting_id: &str) -> Result<Vec<MeetingParticipant>> {
    db.prepare(
        "SELECT p.meeting_id, p.slavebot_id, s.name AS bot_name, p.decision, p.reason, p.created_at \
         FROM meeting_participants p LEFT JOIN slavebots s ON s.id = p.slavebot_id \
         WHERE p.meeting_id = ? ORDER BY p.created_at ASC",
    )
    .bind(&[v_text(meeting_id)])?
    .all()
    .await?
    .results()
}

pub async fn insert_meeting_message(
    db: &Db,
    meeting_id: &str,
    bot: Option<&BotRow>,
    role: &str,
    content: &str,
) -> Result<()> {
    let (bot_id, bot_name) = match bot {
        Some(b) => (Some(b.id.clone()), Some(b.name.clone())),
        None => (None, None),
    };
    let none = v_null();
    let id_val = bot_id.map(|s| v_text(&s)).unwrap_or(none.clone());
    let name_val = bot_name.map(|s| v_text(&s)).unwrap_or(none);
    db.prepare("INSERT INTO meeting_messages (meeting_id, slavebot_id, bot_name, role, content) VALUES (?, ?, ?, ?, ?)")
        .bind(&[v_text(meeting_id), id_val, name_val, v_text(role), v_text(content)])?
        .run()
        .await?;
    Ok(())
}

#[derive(Deserialize, Serialize, Clone)]
pub struct MeetingMessageRow {
    pub id: i64,
    pub meeting_id: String,
    pub slavebot_id: Option<String>,
    pub bot_name: Option<String>,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

pub async fn meeting_history(db: &Db, meeting_id: &str, limit: i32) -> Result<Vec<MeetingMessageRow>> {
    let rows: Vec<MeetingMessageRow> = db
        .prepare("SELECT id, meeting_id, slavebot_id, bot_name, role, content, created_at FROM meeting_messages WHERE meeting_id = ? ORDER BY id DESC LIMIT ?")
        .bind(&[v_text(meeting_id), v_real(limit as f64)])?
        .all()
        .await?
        .results()?;
    Ok(rows.into_iter().rev().collect())
}

pub async fn mark_schedule_run(db: &Db, id: &str, next_run_at: &str) -> Result<()> {
    db.prepare("UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?")
        .bind(&[
            v_text(&jakarta_now_iso()),
            v_text(next_run_at),
            v_text(id),
        ])?
        .run()
        .await?;
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
    for bot in list_bots(db, actor_id, false).await.map_err(|e| e.to_string())? {
        if bot.team_id == team_id {
            set_archived(db, actor_id, &bot.id, true).await.map_err(|e| e.to_string())?;
        }
    }
    for sql in [
        "DELETE FROM bot_grants WHERE bot_id IN (SELECT id FROM slavebots WHERE team_id = ?)",
        "DELETE FROM team_members WHERE team_id = ?",
        "DELETE FROM group_messages WHERE group_id IN (SELECT id FROM groups WHERE team_id = ?)",
        "DELETE FROM meeting_messages WHERE meeting_id IN (SELECT id FROM meetings WHERE team_id = ?)",
        "DELETE FROM groups WHERE team_id = ?",
        "DELETE FROM meetings WHERE team_id = ?",
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

/// Transfer a bot's partnership to another team member. Only the team's
/// owner/admin may do this; the new owner gets a grant automatically.
pub async fn set_bot_owner(db: &Db, actor_id: &str, bot_id: &str, owner_id: &str) -> Result<BotRow, String> {
    let bot = get_bot_any(db, bot_id).await.map_err(|e| e.to_string())?;
    let bot = bot.ok_or_else(|| "SlaveBot not found.".to_string())?;
    if bot.team_id.is_empty() {
        if bot.user_id != actor_id {
            return Err("Only the creator can transfer this bot.".to_string());
        }
    } else {
        match membership(db, &bot.team_id, actor_id).await.map_err(|e| e.to_string())? {
            Some(r) if r == "owner" || r == "admin" => {}
            _ => return Err("Only owners and admins can transfer bots.".to_string()),
        }
        if membership(db, &bot.team_id, owner_id).await.map_err(|e| e.to_string())?.is_none() {
            return Err("The new owner is not on this team.".to_string());
        }
    }
    db.prepare("UPDATE slavebots SET owner_user_id = ? WHERE id = ?")
        .bind(&[v_text(owner_id), v_text(bot_id)])
        .map_err(|e| e.to_string())?
        .run()
        .await
        .map_err(|e| e.to_string())?;
    db.prepare("INSERT OR IGNORE INTO bot_grants (bot_id, user_id) VALUES (?, ?)")
        .bind(&[v_text(bot_id), v_text(owner_id)])
        .map_err(|e| e.to_string())?
        .run()
        .await
        .map_err(|e| e.to_string())?;
    get_bot_any(db, bot_id).await.map_err(|e| e.to_string())?.ok_or_else(|| "SlaveBot not found.".to_string())
}

/// Recent bot conversations across a team for owner oversight:
/// newest first, capped. Caller must have checked owner/admin already.
#[derive(Deserialize, Serialize)]
pub struct ActivityItem {
    pub slavebot_id: String,
    pub bot_name: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

pub async fn team_activity(db: &Db, team_id: &str, limit: i64) -> Result<Vec<ActivityItem>> {
    let limit = limit.clamp(1, 200);
    db.prepare(
        "SELECT m.slavebot_id AS slavebot_id, b.name AS bot_name, m.role AS role, m.content AS content, m.created_at AS created_at \
         FROM messages m JOIN slavebots b ON b.id = m.slavebot_id \
         WHERE b.team_id = ? AND b.archived = 0 \
         ORDER BY m.id DESC LIMIT ?",
    )
    .bind(&[v_text(team_id), v_real(limit as f64)])?
    .all()
    .await?
    .results()
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
    for (table, col) in [("slavebots", "user_id"), ("groups", "user_id"), ("meetings", "user_id")] {
        let sql = format!("UPDATE {table} SET team_id = ? WHERE team_id = '' AND {col} = ?");
        db.prepare(&sql).bind(&[v_text(&team.id), v_text(user_id)])?.run().await?;
    }
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
    db.prepare("DELETE FROM bot_grants WHERE user_id = ? AND bot_id IN (SELECT id FROM slavebots WHERE team_id = ?)")
        .bind(&[v_text(target_id), v_text(team_id)])
        .map_err(|e| e.to_string())?
        .run()
        .await
        .map_err(|e| e.to_string())?;
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

/// Bot ids a staff member may use inside one team.
pub async fn member_grants(db: &Db, team_id: &str, user_id: &str) -> Result<Vec<String>, String> {
    let rows: Vec<GrantBot> = db
        .prepare("SELECT g.bot_id AS bot_id FROM bot_grants g JOIN slavebots b ON b.id = g.bot_id WHERE g.user_id = ? AND b.team_id = ?")
        .bind(&[v_text(user_id), v_text(team_id)])
        .map_err(|e| e.to_string())?
        .all()
        .await
        .map_err(|e| e.to_string())?
        .results()
        .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|g| g.bot_id).collect())
}

#[derive(Deserialize)]
struct GrantBot {
    bot_id: String,
}

pub async fn set_grants(db: &Db, team_id: &str, actor_id: &str, target_id: &str, bot_ids: &[String]) -> Result<(), String> {
    let actor_role = membership(db, team_id, actor_id).await.map_err(|e| e.to_string())?;
    let actor_role = actor_role.ok_or_else(|| "You are not a member of this team.".to_string())?;
    if actor_role != "owner" && actor_role != "admin" {
        return Err("Only owners and admins can set bot access.".to_string());
    }
    let target_role = membership(db, team_id, target_id).await.map_err(|e| e.to_string())?
        .ok_or_else(|| "That user is not on the team.".to_string())?;
    if target_role != "staff" {
        return Err("Owners and admins already see every team bot.".to_string());
    }
    // Validate every bot belongs to this team.
    for id in bot_ids.iter().take(100) {
        let bot = get_bot_any(db, id).await.map_err(|e| e.to_string())?;
        match bot {
            Some(b) if b.team_id == team_id => {}
            _ => return Err(format!("Bot {id} is not on this team.")),
        }
    }
    db.prepare("DELETE FROM bot_grants WHERE user_id = ? AND bot_id IN (SELECT id FROM slavebots WHERE team_id = ?)")
        .bind(&[v_text(target_id), v_text(team_id)])
        .map_err(|e| e.to_string())?
        .run()
        .await
        .map_err(|e| e.to_string())?;
    for id in bot_ids.iter().take(100) {
        db.prepare("INSERT OR IGNORE INTO bot_grants (bot_id, user_id) VALUES (?, ?)")
            .bind(&[v_text(id), v_text(target_id)])
            .map_err(|e| e.to_string())?
            .run()
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// (bot, team_id, role): team owner/admin see every team bot; staff see
/// granted bots; legacy team-less rows belong to their creator.
pub async fn bot_access(db: &Db, user_id: &str, bot_id: &str) -> Result<Option<(BotRow, String, String)>> {
    let bot = match get_bot_any(db, bot_id).await? {
        Some(b) => b,
        None => return Ok(None),
    };
    if bot.team_id.is_empty() {
        if bot.user_id == user_id {
            return Ok(Some((bot, String::new(), "owner".to_string())));
        }
        return Ok(None);
    }
    let role = match membership(db, &bot.team_id, user_id).await? {
        Some(r) => r,
        None => return Ok(None),
    };
    if role == "owner" || role == "admin" {
        let team_id = bot.team_id.clone();
        return Ok(Some((bot, team_id, role)));
    }
    let grant: Option<GrantBot> = db
        .prepare("SELECT bot_id AS bot_id FROM bot_grants WHERE bot_id = ? AND user_id = ?")
        .bind(&[v_text(bot_id), v_text(user_id)])?
        .first(None)
        .await?;
    if grant.is_some() {
        let team_id = bot.team_id.clone();
        Ok(Some((bot, team_id, role)))
    } else {
        Ok(None)
    }
}

fn new_id() -> String {
    crate::util::new_id()
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn scratch_db() -> Db {
        let dir = std::env::temp_dir().join(format!("slaver-test-{}", crate::db::now_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(dir.join("t.db").to_str().unwrap()).unwrap();
        db.run_migrations("migrations").unwrap();
        db
    }

    async fn exec(db: &Db, sql: &str) {
        db.prepare(sql).bind(&[]).unwrap().run().await.unwrap();
    }

    #[tokio::test]
    async fn group_messages_for_bot_since_sees_group_work() {
        let db = scratch_db().await;
        exec(&db, "INSERT INTO users (id, email, name, password_salt, password_hash) VALUES ('u1', 'a@x.id', 'A', 's', 'h')").await;
        exec(&db, "INSERT INTO teams (id, name, owner_user_id, personal) VALUES ('t1', 'T', 'u1', 0)").await;
        exec(&db, "INSERT INTO team_members (team_id, user_id, role) VALUES ('t1', 'u1', 'owner')").await;
        exec(&db, "INSERT INTO slavebots (id, user_id, team_id, name) VALUES ('b1', 'u1', 't1', 'Kasir')").await;
        exec(&db, "INSERT INTO groups (id, user_id, team_id, name) VALUES ('g1', 'u1', 't1', 'Warung')").await;
        exec(&db, "INSERT INTO group_members (group_id, slavebot_id) VALUES ('g1', 'b1')").await;
        // Human task + bot reply, stamped now (after the cutoff below).
        exec(&db, "INSERT INTO group_messages (group_id, user_id, role, content) VALUES ('g1', 'u1', 'user', 'tambah 2 es teh')").await;
        exec(&db, "INSERT INTO group_messages (group_id, slavebot_id, role, content) VALUES ('g1', 'b1', 'assistant', 'Siap, dicatat 2 es teh')").await;
        // Old DM noise must not leak in.
        exec(&db, "INSERT INTO messages (slavebot_id, role, content, created_at) VALUES ('b1', 'user', 'halo', '2000-01-01T00:00:00.000Z')").await;

        let rows = group_messages_for_bot_since(&db, "b1", "2020-01-01T00:00:00.000Z", 50).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].group_name, "Warung");
        assert_eq!(rows[0].author, "A");
        assert_eq!(rows[1].author, "Kasir");

        // A bot that is not a member sees nothing.
        exec(&db, "INSERT INTO slavebots (id, user_id, team_id, name) VALUES ('b2', 'u1', 't1', 'Luar')").await;
        let rows = group_messages_for_bot_since(&db, "b2", "2020-01-01T00:00:00.000Z", 50).await.unwrap();
        assert!(rows.is_empty());
    }
}
