mod auth;
mod avatar;
mod chat;
mod group;
mod mcp;
mod provider;
mod huddle;
mod pricing;
mod teams;
mod schedule;
mod store;
mod summarize;
mod util;
mod voice;

use worker::*;

#[event(fetch)]
async fn main(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    if req.method() == Method::Options {
        let mut r = Response::empty()?;
        util::cors(&mut r)?;
        return Ok(r);
    }

    Router::new()
        .get("/api/health", |_, _| {
            util::json(
                200,
                &serde_json::json!({ "ok": true, "service": "slaver" }),
            )
        })
        .get_async("/api/models", |req: Request, ctx: RouteContext<()>| async move {
            // Authenticated callers get their own provider's list; strangers get Meta's.
            let preset = match auth::bearer_sub(&req, &ctx.env)? {
                Some(user_id) => {
                    let db = ctx.env.d1("DB")?;
                    provider::provider_for(&db, &ctx.env, &user_id)
                        .await
                        .map(|p| p.preset)
                        .unwrap_or_else(|_| "meta".to_string())
                }
                None => "meta".to_string(),
            };
            util::json(200, &provider::model_list(&preset))
        })
        .post_async("/api/auth/register", auth::register)
        .post_async("/api/auth/login", auth::login)
        .get_async("/api/me", auth::me)
        .put_async("/api/me/provider", auth::set_provider)
        .delete_async("/api/me/provider", auth::clear_provider)
        .post_async("/api/chat", chat::chat)
        .post_async("/api/chat/finish", chat::finish)
        .get_async("/api/slavebots", chat::list_bots)
        .post_async("/api/slavebots", chat::create_bot)
        .get_async("/api/slavebots/:id", chat::bot_detail)
        .put_async("/api/slavebots/:id", chat::update_bot)
        .get_async("/api/usage", chat::usage)
        .post_async("/api/voice/transcribe", voice::transcribe)
        .post_async("/api/voice/speak", voice::speak)
        .post_async("/api/slavebots/:id/avatar", avatar::upload)
        .get_async("/api/slavebots/:id/avatar", avatar::serve)
        .get_async("/api/summaries", summarize::list)
        .post_async("/api/summaries/run", summarize::run_now)
        .get_async("/api/groups", group::list)
        .post_async("/api/groups", group::create)
        .get_async("/api/groups/:id", group::detail)
        .put_async("/api/groups/:id", group::rename)
        .delete_async("/api/groups/:id", group::delete)
        .post_async("/api/groups/:id/members", group::add_member)
        .delete_async("/api/groups/:id/members/:botId", group::remove_member)
        .post_async("/api/groups/:id/chat", group::chat)
        .post_async("/api/groups/:id/broadcast", group::broadcast)
        .post_async("/api/slavebots/:id/memory", group::append_memory)
        .post_async("/api/slavebots/:id/spawn", chat::spawn_sub_bot)
        .get_async("/api/slavebots/:id/children", chat::sub_bot_children)
        .get_async("/api/teams", teams::list)
        .post_async("/api/teams", teams::create)
        .get_async("/api/teams/:id", teams::detail)
        .post_async("/api/teams/:id/invites", teams::invite)
        .delete_async("/api/teams/:id/members/:uid", teams::remove_member)
        .delete_async("/api/teams/:id", teams::delete_team)
        .put_async("/api/teams/:id/members/:uid", teams::update_member)
        .get_async("/api/huddles", huddle::list)
        .post_async("/api/huddles", huddle::create)
        .get_async("/api/huddles/:id", huddle::detail)
        .delete_async("/api/huddles/:id", huddle::delete)
        .post_async("/api/huddles/:id/chat", huddle::chat)
        .get_async("/api/slavebots/:id/schedules", schedule::list_for_bot)
        .post_async("/api/slavebots/:id/schedules", schedule::create_for_bot)
        .put_async("/api/schedules/:sid", schedule::update)
        .delete_async("/api/schedules/:sid", schedule::delete)
        .get("/mcp", |_, _| mcp::info())
        .post_async("/mcp", mcp::rpc)
        .run(req, env)
        .await
}

/// Cron triggers (see `triggers.crons` in wrangler.jsonc):
/// - `5 0 * * *`   daily rollup of yesterday's messages
/// - `10 0 * * 1`  weekly rollup of the last 7 dailies
/// - `15 0 1 * *`  monthly rollup of recent weeklies
#[event(scheduled)]
async fn scheduled(event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    let cron = event.cron();
    let db = match env.d1("DB") {
        Ok(db) => db,
        Err(e) => {
            console_error!("scheduled: no D1: {e}");
            return;
        }
    };
    // Frequent tick: fire due bot schedules (reminders/briefings).
    if cron.starts_with("*/") {
        let fired = schedule::run_due(&env, &db).await;
        console_error!("scheduled: fired {fired} due schedules");
        return;
    }
    let scopes = match store::all_bot_scopes(&db).await {
        Ok(s) => s,
        Err(e) => {
            console_error!("scheduled: list bots failed: {e}");
            return;
        }
    };
    for scope in scopes {
        let bot = match store::get_bot(&db, &scope.user_id, &scope.id).await {
            Ok(Some(b)) => b,
            Ok(None) => continue,
            Err(e) => {
                console_error!("scheduled: get bot failed: {e}");
                continue;
            }
        };
        let job: &str = if cron.contains(" 1 * *") {
            "monthly"
        } else if cron.contains("* * 1") {
            "weekly"
        } else {
            "daily"
        };
        let result = match job {
            "monthly" => summarize::run_monthly(&env, &db, &bot, &scope.user_id).await.map(|_| ()),
            "weekly" => summarize::run_weekly(&env, &db, &bot, &scope.user_id).await.map(|_| ()),
            _ => summarize::run_daily(&env, &db, &bot, &scope.user_id).await.map(|_| ()),
        };
        if let Err(e) = result {
            console_error!("scheduled: {job} summary failed for {}: {e}", bot.id);
        }
    }
}
