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
    util::json(201, &serde_json::json!({ "team": team }))
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
    util::json(200, &serde_json::json!({ "team": team, "my_role": my_role, "members": members_out, "bots": bots }))
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
