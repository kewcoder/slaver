use serde::Deserialize;
use worker::*;

use crate::{auth, store, util};

/// Team management: list/create teams, invite members by email with a role
/// (admin = same access as owner; staff = only granted bots), change roles,
/// remove members, and set per-staff bot access.
pub async fn list(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Log in first."),
    };
    let db = ctx.env.d1("DB")?;
    // Legacy users get an explicit personal team on demand (backfills their rows).
    let _ = store::ensure_personal_team(&db, &user_id).await;
    let teams = store::list_user_teams(&db, &user_id).await?;
    util::json(200, &serde_json::json!({ "teams": teams }))
}

/// Team JSON without the provider API key (managers see key_set only).
fn safe_team(t: &store::TeamRow) -> serde_json::Value {
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

#[derive(Deserialize)]
struct CreateBody {
    name: Option<String>,
}

pub async fn create(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Log in first."),
    };
    let body: CreateBody = match req.json().await {
        Ok(b) => b,
        Err(_) => return util::err(400, "Invalid JSON body."),
    };
    let db = ctx.env.d1("DB")?;
    let team = store::create_team(&db, &user_id, &body.name.unwrap_or_default(), false).await?;
    util::json(201, &serde_json::json!({ "team": safe_team(&team) }))
}

pub async fn detail(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Log in first."),
    };
    let team_id = ctx.param("id").cloned().unwrap_or_default();
    let db = ctx.env.d1("DB")?;
    let team = match store::get_team(&db, &team_id).await? {
        Some(t) => t,
        None => return util::err(404, "Team not found."),
    };
    let my_role = match store::membership(&db, &team_id, &user_id).await? {
        Some(r) => r,
        None => return util::err(404, "Team not found."),
    };
    let members = store::team_members(&db, &team_id).await?;
    let mut members_out = Vec::new();
    for m in members {
        let grants = if m.role == "staff" {
            store::member_grants(&db, &team_id, &m.user_id).await.unwrap_or_default()
        } else {
            vec![]
        };
        members_out.push(serde_json::json!({
            "user_id": m.user_id, "email": m.email, "name": m.name,
            "role": m.role, "bot_ids": grants,
        }));
    }
    let bots: Vec<_> = store::list_bots(&db, &user_id, true)
        .await?
        .into_iter()
        .filter(|b| b.team_id == team_id)
        .collect();
    util::json(200, &serde_json::json!({ "team": safe_team(&team), "my_role": my_role, "members": members_out, "bots": bots }))
}

#[derive(Deserialize)]
struct InviteBody {
    email: Option<String>,
    role: Option<String>,
}

pub async fn invite(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Log in first."),
    };
    let body: InviteBody = match req.json().await {
        Ok(b) => b,
        Err(_) => return util::err(400, "Invalid JSON body."),
    };
    let team_id = ctx.param("id").cloned().unwrap_or_default();
    let db = ctx.env.d1("DB")?;
    match store::add_member_by_email(
        &db,
        &team_id,
        &user_id,
        &body.email.unwrap_or_default(),
        &body.role.unwrap_or_else(|| "staff".to_string()),
    )
    .await
    {
        Ok(m) => util::json(201, &serde_json::json!({ "member": m })),
        Err(e) => util::err(400, &e),
    }
}

pub async fn delete_team(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Log in first."),
    };
    let team_id = ctx.param("id").cloned().unwrap_or_default();
    let db = ctx.env.d1("DB")?;
    match store::delete_team(&db, &team_id, &user_id).await {
        Ok(()) => util::json(200, &serde_json::json!({ "deleted": true })),
        Err(e) => util::err(400, &e),
    }
}

#[derive(Deserialize)]
struct ProviderBody {
    preset: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
}

/// PUT /api/teams/:id/provider — owner/admin set the team's AI provider.
/// Body: {preset: meta|baseten|modal|openrouter|custom, base_url?, api_key?}.
/// An empty api_key keeps the stored key (lets admins change preset/URL only).
pub async fn set_provider(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Log in first."),
    };
    let body: ProviderBody = match req.json().await {
        Ok(b) => b,
        Err(_) => return util::err(400, "Invalid JSON body."),
    };
    let preset = body.preset.unwrap_or_else(|| "meta".to_string());
    let known = ["meta", "baseten", "modal", "openrouter", "custom"];
    if !known.contains(&preset.as_str()) {
        return util::err(400, "Unknown provider preset.");
    }
    let team_id = ctx.param("id").cloned().unwrap_or_default();
    let db = ctx.env.d1("DB")?;
    let stored = store::get_team(&db, &team_id).await?;
    if (preset == "modal" || preset == "custom")
        && body.base_url.as_deref().unwrap_or("").trim().is_empty()
        && stored.as_ref().map(|t| t.provider_base_url.trim().is_empty()).unwrap_or(true)
    {
        return util::err(400, "This provider needs a base URL.");
    }
    let api_key = body.api_key.unwrap_or_default();
    if !api_key.is_empty() && !crate::provider::key_prefix_ok(&preset, &api_key) {
        return util::err(400, "That key does not look like a valid key for this provider.");
    }
    let current_base = stored.as_ref().map(|t| t.provider_base_url.clone()).unwrap_or_default();
    let current_key = stored.as_ref().map(|t| t.provider_api_key.clone()).unwrap_or_default();
    let base_url = if body.base_url.as_deref().unwrap_or("").trim().is_empty() { current_base } else { body.base_url.unwrap_or_default() };
    let api_key = if api_key.is_empty() { current_key } else { api_key };
    match store::set_team_provider(&db, &team_id, &user_id, &preset, &base_url, &api_key).await {
        Ok(()) => match store::get_team(&db, &team_id).await? {
            Some(t) => util::json(200, &serde_json::json!({ "team": safe_team(&t) })),
            None => util::err(404, "Team not found."),
        },
        Err(e) => util::err(403, &e),
    }
}

/// DELETE /api/teams/:id/provider — owner/admin remove the team's key.
pub async fn clear_provider(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Log in first."),
    };
    let team_id = ctx.param("id").cloned().unwrap_or_default();
    let db = ctx.env.d1("DB")?;
    let preset = store::get_team(&db, &team_id)
        .await?
        .map(|t| t.provider)
        .unwrap_or_else(|| "meta".to_string());
    match store::set_team_provider(&db, &team_id, &user_id, &preset, "", "").await {
        Ok(()) => util::json(200, &serde_json::json!({ "cleared": true })),
        Err(e) => util::err(403, &e),
    }
}

pub async fn remove_member(req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Log in first."),
    };
    let team_id = ctx.param("id").cloned().unwrap_or_default();
    let target = ctx.param("uid").cloned().unwrap_or_default();
    let db = ctx.env.d1("DB")?;
    match store::remove_member(&db, &team_id, &user_id, &target).await {
        Ok(()) => util::json(200, &serde_json::json!({ "removed": true })),
        Err(e) => util::err(400, &e),
    }
}

#[derive(Deserialize)]
struct MemberUpdateBody {
    role: Option<String>,
    bot_ids: Option<Vec<String>>,
}

pub async fn update_member(mut req: Request, ctx: RouteContext<()>) -> Result<Response> {
    let user_id = match auth::bearer_sub(&req, &ctx.env)? {
        Some(id) => id,
        None => return util::err(401, "Log in first."),
    };
    let body: MemberUpdateBody = match req.json().await {
        Ok(b) => b,
        Err(_) => return util::err(400, "Invalid JSON body."),
    };
    let team_id = ctx.param("id").cloned().unwrap_or_default();
    let target = ctx.param("uid").cloned().unwrap_or_default();
    let db = ctx.env.d1("DB")?;
    if let Some(role) = body.role {
        if let Err(e) = store::set_member_role(&db, &team_id, &user_id, &target, &role).await {
            return util::err(400, &e);
        }
    }
    if let Some(bot_ids) = body.bot_ids {
        if let Err(e) = store::set_grants(&db, &team_id, &user_id, &target, &bot_ids).await {
            return util::err(400, &e);
        }
    }
    util::json(200, &serde_json::json!({ "updated": true }))
}
