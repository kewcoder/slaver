//! AI skill marketplace: reusable role+memory packs.
//!
//! Template skills (template = 1, owned by the system-templates team) are
//! public. Teams can also craft their own skills and install any skill onto
//! a bot with one click — the skill's role becomes the bot's role and its
//! memory is appended to the bot's memory.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use crate::{
    db::{v_text, Db},
    store,
};

#[derive(Deserialize, Serialize, Clone)]
pub struct SkillRow {
    pub id: String,
    pub team_id: String,
    pub name: String,
    pub category: String,
    pub description: String,
    pub role: String,
    pub memory: String,
    pub price_cents: i64,
    pub template: i64,
    pub fork_of: String,
    pub created_at: String,
}

const COLS: &str = "id, team_id, name, category, description, role, memory, price_cents, template, fork_of, created_at";

async fn require_manager(db: &Db, team_id: &str, user_id: &str) -> Result<()> {
    match store::membership(db, team_id, user_id).await? {
        Some(r) if r == "owner" || r == "admin" => Ok(()),
        _ => Err(anyhow!("Only owners and admins can do that.")),
    }
}

pub async fn list(db: &Db, user_id: &str, team_id: &str) -> Result<Vec<SkillRow>> {
    if !team_id.is_empty() {
        store::membership(db, team_id, user_id)
            .await?
            .ok_or_else(|| anyhow!("You are not on that team."))?;
        let sql = format!(
            "SELECT {COLS} FROM skills WHERE template = 1 OR team_id = ? ORDER BY template DESC, created_at DESC LIMIT 100"
        );
        return db
            .prepare(&sql)
            .bind(&[v_text(team_id)])?
            .all()
            .await?
            .results();
    }
    // No team: public templates only.
    let sql = format!("SELECT {COLS} FROM skills WHERE template = 1 ORDER BY created_at DESC LIMIT 100");
    db.prepare(&sql).bind(&[])?.all().await?.results()
}

pub async fn get(db: &Db, user_id: &str, skill_id: &str) -> Result<Option<SkillRow>> {
    let sql = format!("SELECT {COLS} FROM skills WHERE id = ?");
    let row: Option<SkillRow> = db.prepare(&sql).bind(&[v_text(skill_id)])?.first(None).await?;
    match row {
        Some(s) if s.template != 0 => Ok(Some(s)),
        Some(s) => {
            store::membership(db, &s.team_id, user_id)
                .await?
                .ok_or_else(|| anyhow!("Skill not found."))?;
            Ok(Some(s))
        }
        None => Ok(None),
    }
}

pub async fn create(
    db: &Db,
    user_id: &str,
    team_id: &str,
    name: &str,
    category: &str,
    description: &str,
    role: &str,
    memory: &str,
) -> Result<SkillRow> {
    require_manager(db, team_id, user_id).await?;
    let name: String = name.trim().chars().take(60).collect();
    if name.is_empty() {
        return Err(anyhow!("Skill name is required."));
    }
    let id = crate::util::new_id();
    db.prepare("INSERT INTO skills (id, team_id, name, category, description, role, memory) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(&[
            v_text(&id),
            v_text(team_id),
            v_text(&name),
            v_text(category.trim()),
            v_text(description.trim()),
            v_text(role.trim()),
            v_text(memory.trim()),
        ])?
        .run()
        .await?;
    get(db, user_id, &id).await?.ok_or_else(|| anyhow!("skill insert failed"))
}

pub async fn delete(db: &Db, user_id: &str, skill_id: &str) -> Result<bool> {
    let s = get(db, user_id, skill_id).await?.ok_or_else(|| anyhow!("Skill not found."))?;
    if s.template != 0 {
        return Err(anyhow!("Template skills cannot be deleted."));
    }
    require_manager(db, &s.team_id, user_id).await?;
    db.prepare("DELETE FROM skills WHERE id = ?")
        .bind(&[v_text(skill_id)])?
        .run()
        .await?;
    Ok(true)
}

/// Install a skill onto a bot: the skill role becomes the bot role and the
/// skill memory is appended to the bot memory (trimmed to 4000 chars).
pub async fn apply_to_bot(db: &Db, user_id: &str, skill_id: &str, bot_id: &str) -> Result<store::BotRow> {
    let s = get(db, user_id, skill_id).await?.ok_or_else(|| anyhow!("Skill not found."))?;
    let bot = store::get_bot(db, user_id, bot_id).await?.ok_or_else(|| anyhow!("SlaveBot not found."))?;
    if !store::can_manage(db, user_id, bot_id).await? {
        return Err(anyhow!("Only the bot's owner (or team owner/admin) can do that."));
    }
    let _ = bot;
    let updated = store::update_bot(db, user_id, bot_id, None, None, None, None, None, None, None, Some(s.role.trim()), None)
        .await?
        .ok_or_else(|| anyhow!("SlaveBot not found."))?;
    if !s.memory.trim().is_empty() {
        let entry = format!("[Keahlian: {}]\n{}", s.name, s.memory.trim());
        store::append_memory(db, user_id, bot_id, &entry).await?;
    }
    Ok(updated)
}
