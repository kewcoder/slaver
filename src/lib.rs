mod auth;
mod chat;
mod mcp;
mod meta;
mod pricing;
mod store;
mod util;

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
        .get("/api/models", |_, ctx| {
            util::json(200, &meta::model_list(&ctx.env))
        })
        .post_async("/api/auth/register", auth::register)
        .post_async("/api/auth/login", auth::login)
        .get_async("/api/me", auth::me)
        .post_async("/api/chat", chat::chat)
        .post_async("/api/chat/finish", chat::finish)
        .get_async("/api/chats", chat::list_chats)
        .get_async("/api/chats/:id", chat::chat_detail)
        .get_async("/api/usage", chat::usage)
        .get("/mcp", |_, _| mcp::info())
        .post_async("/mcp", mcp::rpc)
        .run(req, env)
        .await
}
