//! Codex-like harness: an agent loop with tools executed on this server.
//!
//! POST /api/runs starts a run and streams Server-Sent Events describing each
//! step (assistant text, tool calls, tool results, done/error). Tools run in
//! per-run workspaces under the configured workspace dir with timeouts and
//! output caps. Same-origin: the web app calls these endpoints directly.

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::HeaderMap,
    response::{sse::{Event, KeepAlive, Sse}, IntoResponse},
};
use serde_json::{json, Value};
use std::{collections::HashMap, convert::Infallible, path::PathBuf};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use crate::{
    auth,
    chat::ChatMessage,
    provider::{self, ToolCall},
    store, AppState,
};

const WORKSPACE_ROOT: &str = "workspace";
const MAX_STEPS: usize = 12;
const EXEC_TIMEOUT_SECS: u64 = 120;
const OUTPUT_CAP: usize = 12_000;

fn sse_error(message: String) -> Sse<ReceiverStream<Result<Event, Infallible>>> {
    let (tx, rx) = mpsc::channel(4);
    let _ = tx.try_send(Ok(Event::default()
        .event("error")
        .data(serde_json::json!({ "message": message }).to_string())));
    Sse::new(ReceiverStream::new(rx)).keep_alive(KeepAlive::default())
}

fn authed(state: &AppState, headers: &HeaderMap) -> Result<String, Sse<ReceiverStream<Result<Event, Infallible>>>> {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    match auth::bearer_sub_from_header(&state.jwt_secret, Some(&auth)) {
        Some(uid) => Ok(uid),
        None => Err(sse_error("Unauthorized.".to_string())),
    }
}

fn confined(root: &std::path::Path, path: &str) -> Result<PathBuf, String> {
    let p = path.trim();
    if p.is_empty() {
        return Err("path is required.".to_string());
    }
    let joined = if p.starts_with('/') {
        PathBuf::from(p)
    } else {
        root.join(p)
    };
    // Lexically normalize .. segments (no symlinks involved yet).
    let mut clean = PathBuf::new();
    for seg in joined.components() {
        use std::path::Component::*;
        match seg {
            Prefix(p) => clean.push(p.as_os_str()),
            RootDir => clean.push("/"),
            CurDir => {}
            ParentDir => {
                clean.pop();
            }
            Normal(s) => clean.push(s),
        }
    }
    if clean != *root && !clean.starts_with(root) {
        return Err("Only the run workspace is writable in this harness.".to_string());
    }
    Ok(clean)
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    format!("{}\n… [truncated {} chars]", &s[..max], s.len() - max)
}

fn tool_defs() -> Value {
    json!([
        { "type": "function", "function": {
            "name": "exec",
            "description": "Run a shell command on the server (Debian Linux, /workspace is the project dir). Use for building, testing, git, listing files, installing packages. Long commands time out after 120s.",
            "parameters": { "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Shell command, e.g. ls -la or npm test" },
                    "workdir": { "type": "string", "description": "Working directory, defaults to /workspace" } },
                "required": ["command"] } } },
        { "type": "function", "function": {
            "name": "read_file",
            "description": "Read a text file. Paths are relative to /workspace unless absolute.",
            "parameters": { "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"] } } },
        { "type": "function", "function": {
            "name": "write_file",
            "description": "Write (create or overwrite) a text file. Parent dirs are created. Paths are relative to /workspace unless absolute.",
            "parameters": { "type": "object",
                "properties": { "path": { "type": "string" }, "content": { "type": "string" } },
                "required": ["path", "content"] } } },
    ])
}

const SYSTEM_PROMPT: &str = "You are Slaver Harness, a coding agent like Codex/Claude Code running on a Linux server. The project lives in /workspace.\n\nRules:\n- Explore before changing: list files, read the relevant code first.\n- Make small, verifiable edits; run the project's own checks (build, tests, typecheck) after changes.\n- Prefer minimal diffs; do not reformat unrelated code.\n- If a command fails, read the error and adapt — don't repeat the same failing command.\n- When done, summarize what changed and how it was verified.";

#[derive(serde::Deserialize)]
pub struct StartRun {
    team_id: String,
    model: String,
    prompt: String,
    #[serde(default)]
    issue_id: Option<String>,
    #[serde(default)]
    repo_id: Option<String>,
}

async fn emit(
    tx: &mpsc::Sender<Result<Event, Infallible>>,
    run_id: &str,
    db: &crate::db::Db,
    kind: &str,
    name: &str,
    output: &str,
) -> bool {
    let saved = if kind == "text" || kind == "tool" || kind == "error" || kind == "prompt" {
        crate::store::insert_run_step(db, run_id, kind, name, output)
            .await
            .is_ok()
    } else {
        true
    };
    let _ = saved;
    let payload = match kind {
        "text" => json!({ "text": output }),
        "tool_call" => serde_json::from_str::<Value>(output).unwrap_or(json!({})),
        "tool_result" => json!({ "name": name, "output": output }),
        "step" => json!({ "n": name }),
        "run" => serde_json::from_str::<Value>(output).unwrap_or(json!({})),
        "done" => serde_json::from_str::<Value>(output).unwrap_or(json!({})),
        "error" => json!({ "message": output }),
        _ => json!({ "name": name, "output": output }),
    };
    tx.send(Ok(Event::default().event(kind).data(payload.to_string())))
        .await
        .is_ok()
}

async fn run_command(root: &std::path::Path, command: &str, workdir: Option<&str>) -> Result<String, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("command is required.".to_string());
    }
    if command.len() > 4000 {
        return Err("command too long (max 4000 chars).".to_string());
    }
    let dir = match workdir {
        Some(w) if !w.trim().is_empty() => confined(root, w)?,
        _ => root.join(WORKSPACE_ROOT),
    };
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(EXEC_TIMEOUT_SECS),
        tokio::process::Command::new("/bin/bash")
            .arg("-lc")
            .arg(command)
            .current_dir(&dir)
            .output(),
    )
    .await
    .map_err(|_| format!("Command timed out after {EXEC_TIMEOUT_SECS}s."))?
    .map_err(|e| format!("Could not run command: {e}"))?;
    let code = out.status.code().unwrap_or(-1);
    let stdout = truncate(&String::from_utf8_lossy(&out.stdout), OUTPUT_CAP);
    let stderr = truncate(&String::from_utf8_lossy(&out.stderr), OUTPUT_CAP);
    Ok(format!(
        "exit={code}\n{stdout}{}",
        if stderr.trim().is_empty() { String::new() } else { format!("\n[stderr]\n{stderr}") }
    ))
}

async fn run_agent(
    state: AppState,
    user_id: String,
    run_id: String,
    team_id: String,
    model: String,
    prompt: String,
    issue_id: String,
    repo_id: String,
    tx: mpsc::Sender<Result<Event, Infallible>>,
) {
    let db = &state.db;
    let root = state.workspace_dir.join(format!("run-{run_id}"));
    let ws = root.join(WORKSPACE_ROOT);
    if let Err(e) = tokio::fs::create_dir_all(&ws).await {
        emit(&tx, &run_id, db, "error", "", &format!("Could not prepare workspace: {e}")).await;
        let _ = store::set_run_status(db, &run_id, "error").await;
        return;
    }

    // Link a repo: clone the bare repo into the workspace on an issue branch.
    let mut branch = String::new();
    let mut repo_note = String::new();
    if !repo_id.trim().is_empty() {
        match crate::platform::get_repo(db, &user_id, repo_id.trim()).await {
            Ok(Some(repo)) => {
                let bare = crate::platform::bare_repo_path(
                    &state.git_root.to_string_lossy(),
                    &repo.id,
                );
                let dest = ws.join("repo");
                let clone_out = tokio::process::Command::new("git")
                    .arg("clone")
                    .arg(&bare)
                    .arg(&dest)
                    .output()
                    .await;
                match clone_out {
                    Ok(o) if o.status.success() => {
                        if !issue_id.trim().is_empty() {
                            branch = format!("issue-{}", &issue_id.replace('-', "")[..8.min(issue_id.len())]);
                            let _ = tokio::process::Command::new("git")
                                .arg("-C")
                                .arg(&dest)
                                .arg("checkout")
                                .arg("-B")
                                .arg(&branch)
                                .output()
                                .await;
                        }
                        if branch.is_empty() {
                            branch = "work".to_string();
                        }
                        let _ = store::set_run_repo(db, &run_id, &issue_id, &repo.id, &branch).await;
                        repo_note = format!(
                            "\n\nRepository \"{}\" is cloned at /workspace/repo on branch {branch}. Read code there, make edits there, commit with git when a unit of work is done.",
                            repo.name
                        );
                    }
                    _ => {
                        emit(&tx, &run_id, db, "error", "", &"Could not clone the linked repo; continuing without it.".to_string()).await;
                    }
                }
            }
            _ => {
                emit(&tx, &run_id, db, "error", "", &"Linked repo not found or not visible; continuing without it.".to_string()).await;
            }
        }
    } else if !issue_id.trim().is_empty() {
        let _ = store::set_run_repo(db, &run_id, &issue_id, "", "").await;
    }

    let prov = match provider::provider_for(db, &team_id).await {
        Ok(p) => p,
        Err(e) => {
            emit(&tx, &run_id, db, "error", "", &e.to_string()).await;
            let _ = store::set_run_status(db, &run_id, "error").await;
            return;
        }
    };
    // Prefer chat/completions; fall back to Responses when the catalogue says
    // the model only supports it (e.g. muse-spark-* on OpenCode).
    let apis = provider::model_apis(&prov, &model).await;
    let use_responses = !apis.is_empty() && !apis.iter().any(|a| a == "chat-completions");
    let session = format!("slaver-harness-{run_id}");
    let tools = tool_defs();

    emit(&tx, &run_id, db, "run", "", &json!({ "run_id": run_id, "model": model }).to_string()).await;
    let _ = store::insert_run_step(db, &run_id, "prompt", "", &prompt).await;

    let full_prompt = if repo_note.is_empty() { prompt.clone() } else { format!("{prompt}{repo_note}") };
    let mut chat_msgs = vec![
        ChatMessage { role: "system".to_string(), content: SYSTEM_PROMPT.to_string(), ..Default::default() },
        ChatMessage { role: "user".to_string(), content: full_prompt.clone(), ..Default::default() },
    ];
    let mut resp_input = json!([
        { "role": "system", "content": SYSTEM_PROMPT },
        { "role": "user", "content": full_prompt },
    ]);

    let mut total_prompt = 0u64;
    let mut total_completion = 0u64;
    let mut steps = 0usize;

    for _ in 0..MAX_STEPS {
        let comp = if use_responses {
            match provider::post_tools_responses(&prov, &model, &resp_input, &tools, Some(&session)).await {
                Ok((c, outputs)) => {
                    if let Some(arr) = resp_input.as_array_mut() {
                        arr.push(json!({ "role": "assistant", "content": c.text.clone() }));
                        if let Some(out) = outputs.as_array() {
                            arr.extend(out.iter().cloned());
                        }
                    }
                    c
                }
                Err(e) => {
                    emit(&tx, &run_id, db, "error", "", &e.to_string()).await;
                    let _ = store::set_run_status(db, &run_id, "error").await;
                    return;
                }
            }
        } else {
            match provider::post_chat_tools(&prov, &model, &chat_msgs, &tools, Some(&session)).await {
                Ok(c) => {
                    chat_msgs.push(ChatMessage {
                        role: "assistant".to_string(),
                        content: c.text.clone(),
                        tool_calls: if c.tool_calls.is_empty() {
                            None
                        } else {
                            Some(
                                c.tool_calls
                                    .iter()
                                    .map(|tc| crate::chat::ToolCallMsg {
                                        id: tc.id.clone(),
                                        kind: "function".to_string(),
                                        function: crate::chat::FunctionCall {
                                            name: tc.name.clone(),
                                            arguments: tc.args.clone(),
                                        },
                                    })
                                    .collect(),
                            )
                        },
                        tool_call_id: None,
                    });
                    c
                }
                Err(e) => {
                    emit(&tx, &run_id, db, "error", "", &e.to_string()).await;
                    let _ = store::set_run_status(db, &run_id, "error").await;
                    return;
                }
            }
        };
        steps += 1;
        if !emit(&tx, &run_id, db, "step", &steps.to_string(), "").await {
            break;
        }
        total_prompt += comp.prompt_tokens;
        total_completion += comp.completion_tokens;

        if !comp.text.trim().is_empty() {
            if !emit(&tx, &run_id, db, "text", "", &comp.text).await {
                break;
            }
        }
        if comp.tool_calls.is_empty() {
            break;
        }
        for tc in &comp.tool_calls {
            let args: HashMap<String, String> =
                serde_json::from_str(&tc.args).unwrap_or_default();
            if !emit(
                &tx,
                &run_id,
                db,
                "tool_call",
                "",
                &json!({ "name": tc.name, "args": tc.args }).to_string(),
            )
            .await
            {
                break;
            }
            let output = execute_tool(&root, tc, &args).await;
            if !emit(&tx, &run_id, db, "tool_result", &tc.name, &truncate(&output, 4000)).await {
                break;
            }
            if use_responses {
                if let Some(arr) = resp_input.as_array_mut() {
                    arr.push(json!({
                        "type": "function_call_output",
                        "call_id": tc.id,
                        "output": output,
                    }));
                }
            } else {
                chat_msgs.push(ChatMessage {
                    role: "tool".to_string(),
                    content: output,
                    tool_calls: None,
                    tool_call_id: Some(tc.id.clone()),
                });
            }
        }
    }

    let _ = store::record_usage(
        db,
        &user_id,
        None,
        &store::UsageInput {
            model: format!("{model} (harness)"),
            prompt_tokens: total_prompt,
            cached_tokens: 0,
            completion_tokens: total_completion,
            estimated: false,
            audio_seconds: 0.0,
            cost_override: None,
        },
    )
    .await;
    let _ = store::set_run_status(db, &run_id, "done").await;
    if !issue_id.trim().is_empty() {
        // Finished work goes to review.
        if let Ok(Some(issue)) = crate::platform::get_issue(db, &user_id, &issue_id).await {
            if issue.state == "in_progress" {
                let _ = crate::platform::set_issue_state(db, &user_id, &issue_id, "in_review").await;
            }
        }
    }
    emit(
        &tx,
        &run_id,
        db,
        "done",
        "",
        &json!({ "steps": steps, "prompt_tokens": total_prompt, "completion_tokens": total_completion }).to_string(),
    )
    .await;
}

async fn execute_tool(root: &std::path::Path, tc: &ToolCall, args: &HashMap<String, String>) -> String {
    let get = |k: &str| args.get(k).cloned().unwrap_or_default();
    match tc.name.as_str() {
        "exec" => {
            let workdir = args.get("workdir").map(|s| s.as_str());
            match run_command(root, &get("command"), workdir).await {
                Ok(o) => o,
                Err(e) => format!("ERROR: {e}"),
            }
        }
        "read_file" => match confined(root, &get("path")) {
            Err(e) => format!("ERROR: {e}"),
            Ok(p) => match tokio::fs::read_to_string(&p).await {
                Ok(s) => truncate(&s, OUTPUT_CAP),
                Err(e) => format!("ERROR: Cannot read {}: {e}", p.display()),
            },
        },
        "write_file" => match confined(root, &get("path")) {
            Err(e) => format!("ERROR: {e}"),
            Ok(p) => {
                if let Some(parent) = p.parent() {
                    if let Err(e) = tokio::fs::create_dir_all(parent).await {
                        return format!("ERROR: Cannot create dir: {e}");
                    }
                }
                match tokio::fs::write(&p, get("content")).await {
                    Ok(()) => format!("Wrote {} ({} chars).", p.display(), get("content").len()),
                    Err(e) => format!("ERROR: Cannot write {}: {e}", p.display()),
                }
            }
        },
        other => format!("ERROR: Unknown tool: {other}"),
    }
}

pub async fn start_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Sse<ReceiverStream<Result<Event, Infallible>>> {
    let user_id = match authed(&state, &headers) {
        Ok(u) => u,
        Err(s) => return s,
    };
    let req: StartRun = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(_) => return sse_error("Body must be JSON.".to_string()),
    };
    let team_id = req.team_id.trim().to_string();
    let model = req.model.trim().to_string();
    let prompt = req.prompt.trim().to_string();
    if team_id.is_empty() || model.is_empty() || prompt.is_empty() {
        return sse_error("team_id, model, and prompt are required.".to_string());
    }
    if prompt.len() > 8000 {
        return sse_error("prompt must be 1..8000 characters.".to_string());
    }
    if store::membership(&state.db, &team_id, &user_id).await.unwrap_or(None).is_none() {
        return sse_error("You are not on that team.".to_string());
    }
    let issue_id = req.issue_id.as_deref().unwrap_or("").trim().to_string();
    let repo_id = req.repo_id.as_deref().unwrap_or("").trim().to_string();
    if !issue_id.is_empty() {
        // Linked issue moves to in_progress (from backlog/todo only).
        if let Ok(Some(issue)) = crate::platform::get_issue(&state.db, &user_id, &issue_id).await {
            if issue.state == "backlog" || issue.state == "todo" {
                let _ = crate::platform::set_issue_state(&state.db, &user_id, &issue_id, "in_progress").await;
            }
        }
    }
    let run_id = uuid();
    if store::insert_run(&state.db, &run_id, &user_id, &team_id, &model, &prompt)
        .await
        .is_err()
    {
        return sse_error("Could not create run.".to_string());
    }
    let (tx, rx) = mpsc::channel(32);
    tokio::spawn(run_agent(state, user_id, run_id, team_id, model, prompt, issue_id, repo_id, tx));
    Sse::new(ReceiverStream::new(rx)).keep_alive(KeepAlive::default())
}

pub async fn list_runs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> impl axum::response::IntoResponse {
    let user_id = match auth::bearer_sub_from_header(&state.jwt_secret, headers.get("authorization").and_then(|v| v.to_str().ok())) {
        Some(u) => u,
        None => return unauthorized(),
    };
    let team_id = params.get("team_id").map(|s| s.as_str()).unwrap_or("");
    match store::list_runs(&state.db, &user_id, team_id).await {
        Ok(runs) => axum::Json(json!({ "runs": runs })).into_response(),
        Err(e) => axum::Json(json!({ "error": e.to_string() })).into_response(),
    }
}

pub async fn run_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
) -> impl axum::response::IntoResponse {
    let user_id = match auth::bearer_sub_from_header(&state.jwt_secret, headers.get("authorization").and_then(|v| v.to_str().ok())) {
        Some(u) => u,
        None => return unauthorized(),
    };
    match store::get_run(&state.db, &user_id, &run_id).await {
        Ok(Some((run, steps))) => axum::Json(json!({ "run": run, "steps": steps })).into_response(),
        Ok(None) => axum::Json(json!({ "error": "Run not found." })).into_response(),
        Err(e) => axum::Json(json!({ "error": e.to_string() })).into_response(),
    }
}

fn unauthorized() -> axum::response::Response {
    axum::Json(json!({ "error": "Unauthorized." })).into_response()
}

fn uuid() -> String {
    let mut b = [0u8; 16];
    if getrandom::getrandom(&mut b).is_err() {
        let t = crate::db::now_millis();
        b[..8].copy_from_slice(&t.to_be_bytes());
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex::encode(b);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}
