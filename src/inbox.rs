//! Live inbox: one Server-Sent Events stream per user carrying every new
//! message that concerns them — DMs, group replies, meeting replies, and
//! bot replies. The frontend opens a single EventSource and routes events to
//! the open conversation, the sidebar badges, and desktop notifications.
//!
//! Auth: `Authorization: Bearer <jwt>` header or `?token=` (EventSource
//! cannot set headers). `?since=` is an ISO timestamp cursor; the server
//! only emits rows newer than it. Clients also dedupe by kind+id.

use std::{collections::HashMap, time::Duration};

use axum::{
    body::Body,
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use tokio_stream::wrappers::ReceiverStream;

use crate::{auth, db::v_text, store, AppState};

fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%fZ").to_string()
}

/// New rows for one user since `since` (ISO text, lexicographically sortable).
/// Returns (events, max_created_at_seen).
async fn poll(db: &crate::db::Db, user_id: &str, since: &str) -> Vec<serde_json::Value> {
    let mut out: Vec<(String, serde_json::Value)> = Vec::new();
    // 1) DMs addressed to me.
    #[derive(serde::Deserialize)]
    struct Dm {
        id: i64,
        team_id: String,
        from_user_id: String,
        from_name: Option<String>,
        content: String,
        created_at: String,
    }
    if let Ok(rows) = db
        .prepare(
            "SELECT m.id, m.team_id, m.from_user_id, COALESCE(u.name, u.email) AS from_name, m.content, m.created_at \
             FROM direct_messages m LEFT JOIN users u ON u.id = m.from_user_id \
             WHERE m.to_user_id = ? AND m.created_at > ? ORDER BY m.created_at ASC LIMIT 50",
        )
        .bind(&[v_text(user_id), v_text(since)])
    {
        if let Ok(list) = rows.all().await {
            if let Ok(v) = list.results::<Dm>() {
                for r in v {
                    out.push((
                        r.created_at.clone(),
                        serde_json::json!({ "kind": "dm", "id": r.id, "team_id": r.team_id, "from_user_id": r.from_user_id, "from_name": r.from_name, "content": r.content, "created_at": r.created_at }),
                    ));
                }
            }
        }
    }
    // 2) Group messages in visible groups, excluding my own posts.
    let group_ids: Vec<String> = match store::list_groups(db, user_id).await {
        Ok(gs) => gs.into_iter().map(|g| g.id).collect(),
        Err(_) => vec![],
    };
    // Public support channels are visible to everyone too.
    let mut public_ids: Vec<String> = match store::list_public_groups(db).await {
        Ok(gs) => gs.into_iter().map(|g| g.id).collect(),
        Err(_) => vec![],
    };
    let mut ids = group_ids;
    ids.append(&mut public_ids);
    ids.sort();
    ids.dedup();
    ids.truncate(200);
    #[derive(serde::Deserialize)]
    struct Gm {
        id: i64,
        group_id: String,
        group_name: String,
        team_id: String,
        slavebot_id: Option<String>,
        bot_name: Option<String>,
        user_id: Option<String>,
        user_name: Option<String>,
        role: String,
        content: String,
        created_at: String,
    }
    for gid in ids {
        let Ok(bound) = db
            .prepare(
                "SELECT g.id, g.group_id, gr.name AS group_name, gr.team_id AS team_id, g.slavebot_id, s.name AS bot_name, g.user_id, COALESCE(u.name, u.email) AS user_name, g.role, g.content, g.created_at \
                 FROM group_messages g JOIN groups gr ON gr.id = g.group_id \
                 LEFT JOIN slavebots s ON s.id = g.slavebot_id LEFT JOIN users u ON u.id = NULLIF(g.user_id, '') \
                 WHERE g.group_id = ? AND g.created_at > ? AND (g.user_id IS NULL OR g.user_id <> ?) ORDER BY g.created_at ASC LIMIT 50",
            )
            .bind(&[v_text(&gid), v_text(since), v_text(user_id)])
        else {
            continue;
        };
        let Ok(fetched) = bound.all().await else {
            continue;
        };
        let list: Vec<Gm> = fetched.results().unwrap_or_default();
        for r in list {
            out.push((
                r.created_at.clone(),
                serde_json::json!({ "kind": "group", "id": r.id, "group_id": r.group_id, "group_name": r.group_name, "team_id": r.team_id, "slavebot_id": r.slavebot_id, "bot_name": r.bot_name, "user_id": r.user_id, "user_name": r.user_name, "role": r.role, "content": r.content, "created_at": r.created_at }),
            ));
        }
    }
    // 3) Meeting replies in my meetings.
    let meetings: Vec<String> = match store::list_meetings(db, user_id).await {
        Ok(ms) => ms.into_iter().map(|m| m.id).collect(),
        Err(_) => vec![],
    };
    #[derive(serde::Deserialize)]
    struct Mm {
        id: i64,
        meeting_id: String,
        topic: String,
        team_id: String,
        slavebot_id: Option<String>,
        bot_name: Option<String>,
        role: String,
        content: String,
        created_at: String,
    }
    for mid in meetings.into_iter().take(100) {
        let Ok(bound) = db
            .prepare(
                "SELECT m.id, m.meeting_id, h.topic AS topic, h.team_id AS team_id, m.slavebot_id, s.name AS bot_name, m.role, m.content, m.created_at \
                 FROM meeting_messages m JOIN meetings h ON h.id = m.meeting_id LEFT JOIN slavebots s ON s.id = m.slavebot_id \
                 WHERE m.meeting_id = ? AND m.created_at > ? AND m.slavebot_id IS NOT NULL ORDER BY m.created_at ASC LIMIT 50",
            )
            .bind(&[v_text(&mid), v_text(since)])
        else {
            continue;
        };
        let Ok(fetched) = bound.all().await else {
            continue;
        };
        let list: Vec<Mm> = fetched.results().unwrap_or_default();
        for r in list {
            out.push((
                r.created_at.clone(),
                serde_json::json!({ "kind": "meeting", "id": r.id, "meeting_id": r.meeting_id, "topic": r.topic, "team_id": r.team_id, "slavebot_id": r.slavebot_id, "bot_name": r.bot_name, "role": r.role, "content": r.content, "created_at": r.created_at }),
            ));
        }
    }
    // 4) Bot replies in my bots (scheduled notes land here too).
    let bots: Vec<String> = match store::list_bots(db, user_id, false).await {
        Ok(bs) => bs.into_iter().map(|b| b.id).collect(),
        Err(_) => vec![],
    };
    #[derive(serde::Deserialize)]
    struct Bm {
        id: i64,
        slavebot_id: String,
        bot_name: String,
        team_id: String,
        role: String,
        content: String,
        created_at: String,
    }
    for bid in bots.into_iter().take(200) {
        let Ok(bound) = db
            .prepare(
                "SELECT m.id, m.slavebot_id, s.name AS bot_name, s.team_id AS team_id, m.role, m.content, m.created_at \
                 FROM messages m JOIN slavebots s ON s.id = m.slavebot_id \
                 WHERE m.slavebot_id = ? AND m.role = 'assistant' AND m.created_at > ? ORDER BY m.created_at ASC LIMIT 20",
            )
            .bind(&[v_text(&bid), v_text(since)])
        else {
            continue;
        };
        let Ok(fetched) = bound.all().await else {
            continue;
        };
        let list: Vec<Bm> = fetched.results().unwrap_or_default();
        for r in list {
            out.push((
                r.created_at.clone(),
                serde_json::json!({ "kind": "bot", "id": r.id, "bot_id": r.slavebot_id, "bot_name": r.bot_name, "team_id": r.team_id, "role": r.role, "content": r.content, "created_at": r.created_at }),
            ));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out.into_iter().map(|(_, v)| v).collect()
}

fn sse(event: &str, data: &serde_json::Value) -> String {
    format!("event: {event}\ndata: {data}\n\n", data = data.to_string().replace('\n', "\\n"))
}

/// GET /api/inbox/stream?since=<iso>&token=<jwt> — one long-lived stream of
/// everything new for the caller. Clients reconnect with the newest
/// created_at they have seen.
pub async fn inbox_stream(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let header_token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let token = q.get("token").cloned().unwrap_or_default();
    let bearer = if !header_token.is_empty() {
        header_token
    } else if !token.is_empty() {
        format!("Bearer {token}")
    } else {
        String::new()
    };
    let user_id = match auth::bearer_sub_from_header(&state.jwt_secret, Some(&bearer)) {
        Some(u) => u,
        None => return (StatusCode::UNAUTHORIZED, "Unauthorized: pass ?token=<jwt>").into_response(),
    };
    let mut cursor = q.get("since").cloned().unwrap_or_default();
    if cursor.trim().is_empty() {
        cursor = "1970-01-01T00:00:00.000Z".to_string();
    }
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<String, std::convert::Infallible>>(32);
    let db = state.db.clone();
    tokio::spawn(async move {
        // Greet immediately so the client can sync its clock/cursor.
        let hello = serde_json::json!({ "now": now_iso() });
        if tx.send(Ok(sse("ready", &hello))).await.is_err() {
            return;
        }
        loop {
            let events = poll(&db, &user_id, &cursor).await;
            let mut advanced = false;
            for ev in events {
                if let Some(at) = ev.get("created_at").and_then(|v| v.as_str()) {
                    if at > cursor.as_str() {
                        cursor = at.to_string();
                        advanced = true;
                    }
                }
                let kind = ev.get("kind").and_then(|v| v.as_str()).unwrap_or("message");
                if tx.send(Ok(sse(kind, &ev))).await.is_err() {
                    return;
                }
            }
            if !advanced {
                // Heartbeat keeps the connection alive and the cursor fresh.
                // Trails real time by 5s so nothing created between polls is
                // ever skipped; clients dedupe by kind+id anyway.
                let hb_now = (chrono::Utc::now() - chrono::Duration::seconds(5)).format("%Y-%m-%dT%H:%M:%fZ").to_string();
                let hb = serde_json::json!({ "now": hb_now });
                if tx.send(Ok(sse("ping", &hb))).await.is_err() {
                    return;
                }
                if let Some(n) = hb.get("now").and_then(|v| v.as_str()) {
                    if n > cursor.as_str() {
                        cursor = n.to_string();
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    let stream = ReceiverStream::new(rx);
    let body = Body::from_stream(stream);
    let mut res = Response::new(body);
    res.headers_mut().insert("content-type", HeaderValue::from_static("text/event-stream"));
    res.headers_mut().insert("cache-control", HeaderValue::from_static("no-cache, no-transform"));
    res.headers_mut().insert("x-accel-buffering", HeaderValue::from_static("no"));
    res
}
