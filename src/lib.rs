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

    if req.path() == "/ping" {
        return util::json(200, &serde_json::json!({ "ok": true }));
    }
    Router::new()
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
