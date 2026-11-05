//! Customize an owned app with AI, Lovable-style, on a staging sandbox.
//!
//! Flow per request: a Meta model picks the files to change, rewrites them,
//! Slaver commits the result on the repo's `staging` branch, ships that
//! branch to the team's staging Sprite (customer's own Sprites org, so the
//! customer is billed), rebuilds and restarts it. "Apply to production"
//! merges `staging` into `main`; the team then redeploys production.
//!
//! Jobs run in the background; the UI polls `customize_status`. The change
//! history lives in `customize_changes` (the live step text stays in memory).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::{json, Value};

use crate::ai::ChatMessage;
use crate::db::{v_int, v_text, Db};
use crate::localapp;
use crate::AppState;

const SPRITES_API: &str = "https://api.sprites.dev/v1";
const APP_DIR: &str = "/home/sprite/app";
const BRANCH: &str = "staging";

#[cfg(test)]
mod tests {
    #[test]
    fn parses_framed_exec() {
        assert_eq!(super::parse_exec(b"\x01hi\n__EXIT=0\n\x03\x00"), (0, "hi\n__EXIT=0\n".to_string()));
        assert_eq!(super::parse_exec(b"\x02tar: boom\n\x01__EXIT=2\n\x03\x00").0, 2);
        assert_eq!(super::parse_exec(b"plain\n__EXIT=0\n").0, 0);
        assert_eq!(super::parse_exec(b"\x02killed\n\x03\x89").0, 137);
    }
}

#[derive(Clone, Serialize)]
pub struct Change {
    pub id: String,
    pub prompt: String,
    pub status: String, // working | done | failed | discarded
    pub step: String,
    pub summary: String,
    pub files: Vec<String>,
    pub commit: String,
    pub error: String,
    /// Merged into production by "Apply to production".
    pub applied: bool,
    pub created_at: String,
}

#[derive(Clone, Serialize, Default)]
pub struct Staging {
    pub sprite: String,
    pub url: String,
    pub changes: Vec<Change>,
    #[serde(skip)]
    loaded: bool,
}

fn jobs() -> &'static Mutex<HashMap<String, Staging>> {
    static J: OnceLock<Mutex<HashMap<String, Staging>>> = OnceLock::new();
    J.get_or_init(|| Mutex::new(HashMap::new()))
}

fn update(project_id: &str, f: impl FnOnce(&mut Staging)) {
    let mut m = jobs().lock().unwrap();
    f(m.entry(project_id.to_string()).or_default());
}

fn set_step(project_id: &str, change_id: &str, step: &str) {
    update(project_id, |s| {
        if let Some(c) = s.changes.iter_mut().find(|c| c.id == change_id) {
            c.step = step.to_string();
        }
    });
}

// ---------- persistence ----------

/// Load a project's change history from the DB into the in-memory map (once).
async fn load(db: &Db, project_id: &str) -> Result<(), String> {
    if jobs().lock().unwrap().get(project_id).map(|s| s.loaded).unwrap_or(false) {
        return Ok(());
    }
    let rows: Vec<Value> = db
        .prepare("SELECT id, prompt, status, summary, files_json, commit_sha, error, applied, created_at FROM customize_changes WHERE project_id = ? ORDER BY created_at")
        .bind(&[v_text(project_id)])
        .map_err(|e| e.to_string())?
        .all()
        .await
        .map_err(|e| e.to_string())?
        .results()
        .map_err(|e| e.to_string())?;
    let s = |r: &Value, k: &str| r.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let changes: Vec<Change> = rows
        .iter()
        .map(|r| Change {
            id: s(r, "id"),
            prompt: s(r, "prompt"),
            status: s(r, "status"),
            step: String::new(),
            summary: s(r, "summary"),
            files: serde_json::from_str(&s(r, "files_json")).unwrap_or_default(),
            commit: s(r, "commit_sha"),
            error: s(r, "error"),
            applied: r.get("applied").and_then(|v| v.as_i64()).unwrap_or(0) != 0,
            created_at: s(r, "created_at"),
        })
        .collect();
    update(project_id, |st| {
        if !st.loaded {
            // Keep anything started in memory before the load finished.
            let mut merged = changes;
            for c in st.changes.drain(..) {
                if !merged.iter().any(|m| m.id == c.id) {
                    merged.push(c);
                }
            }
            st.changes = merged;
            st.loaded = true;
        }
    });
    Ok(())
}

async fn save(db: &Db, project_id: &str, c: &Change) -> Result<(), String> {
    db.prepare(
        "INSERT INTO customize_changes (id, project_id, prompt, status, summary, files_json, commit_sha, error, applied, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, summary = excluded.summary, files_json = excluded.files_json, commit_sha = excluded.commit_sha, error = excluded.error, applied = excluded.applied",
    )
    .bind(&[
        v_text(&c.id),
        v_text(project_id),
        v_text(&c.prompt),
        v_text(&c.status),
        v_text(&c.summary),
        v_text(&serde_json::to_string(&c.files).unwrap_or_else(|_| "[]".into())),
        v_text(&c.commit),
        v_text(&c.error),
        v_int(c.applied as i64),
        v_text(&c.created_at),
    ])
    .map_err(|e| e.to_string())?
    .run()
    .await
    .map_err(|e| e.to_string())
}

/// On boot: jobs that were running when the server stopped will never finish.
pub async fn recover(db: &Db) {
    let r = async {
        db.prepare("UPDATE customize_changes SET status = 'failed', error = 'Interrupted by a server restart. Send the request again.' WHERE status = 'working'")
            .bind(&[])?
            .run()
            .await
    }
    .await;
    if let Err(e) = r {
        eprintln!("customize: recover failed: {e}");
    }
}

/// Snapshot of one change (for saving after an in-memory update).
fn change(project_id: &str, change_id: &str) -> Option<Change> {
    jobs().lock().unwrap().get(project_id).and_then(|s| s.changes.iter().find(|c| c.id == change_id).cloned())
}

pub fn sprite_name(project_id: &str) -> String {
    let short: String = project_id.chars().filter(|c| c.is_ascii_alphanumeric()).take(10).collect::<String>().to_lowercase();
    format!("slaver-stg-{short}")
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().timeout(std::time::Duration::from_secs(600)).build().expect("client")
}

/// Run a shell command in the sprite. Returns (exit code, output).
async fn sx(token: &str, sprite: &str, script: &str, stdin: Option<Vec<u8>>) -> Result<(i32, String), String> {
    let wrapped = format!("{script}\necho __EXIT=$?");
    let mut q: Vec<(&str, String)> = vec![("cmd", "bash".into()), ("cmd", "-c".into()), ("cmd", wrapped)];
    let mut req = client().post(format!("{SPRITES_API}/sprites/{sprite}/exec")).bearer_auth(token);
    if let Some(data) = stdin {
        q.push(("stdin", "true".into()));
        req = req.header("content-type", "application/octet-stream").body(data);
    }
    let r = req.query(&q).send().await.map_err(|e| format!("sprites: {e}"))?;
    let status = r.status();
    let body = r.bytes().await.map_err(|e| format!("sprites: {e}"))?;
    if !status.is_success() {
        return Err(format!("sprites exec failed ({status}): {}", String::from_utf8_lossy(&body).chars().take(300).collect::<String>()));
    }
    Ok(parse_exec(&body))
}

/// Exec output is a framed stream: 0x01 stdout / 0x02 stderr chunks, ending with
/// an exit frame 0x03 <code>. Older responses were plain text; both carry our
/// `__EXIT=` marker, used as the fallback exit code.
fn parse_exec(body: &[u8]) -> (i32, String) {
    let (data, frame_code) = match body {
        [rest @ .., 0x03, c] => (rest, Some(*c as i32)),
        _ => (body, None),
    };
    let text: String = String::from_utf8_lossy(&data.iter().copied().filter(|b| !matches!(b, 0x00..=0x03)).collect::<Vec<u8>>()).into_owned();
    let marker = text.rsplit("__EXIT=").next().and_then(|t| t.split_whitespace().next()).and_then(|t| t.parse::<i32>().ok());
    (marker.or(frame_code).unwrap_or(1), text)
}

async fn sprite_url(token: &str, sprite: &str) -> Option<String> {
    let r = client().get(format!("{SPRITES_API}/sprites/{sprite}")).bearer_auth(token).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    let v: Value = r.json().await.ok()?;
    v["url"].as_str().map(String::from)
}

/// Env for the app inside the sprite: Dockerfile ENV lines with /app and
/// /data remapped, PORT forced to the sprite's HTTP port.
fn sprite_env(dockerfile: &str) -> serde_json::Map<String, Value> {
    let mut env = localapp::env_from_dockerfile(dockerfile, APP_DIR, &format!("{APP_DIR}/data"));
    env.insert("PORT".into(), Value::String("8080".into()));
    env
}

/// Create the staging sprite (if needed) and boot the app from the staging branch.
async fn ensure_sprite(state: &AppState, token: &str, project_id: &str, repo_id: &str, change_id: &str) -> Result<(String, String), String> {
    let sprite = sprite_name(project_id);
    let git_root = state.git_root.to_string_lossy().to_string();
    if let Some(url) = sprite_url(token, &sprite).await {
        // Ready only when the app service exists (a first setup may have failed half-way).
        let svc = client().get(format!("{SPRITES_API}/sprites/{sprite}/services/app")).bearer_auth(token).send().await.map_err(|e| format!("sprites: {e}"))?;
        if svc.status().is_success() {
            return Ok((sprite, url));
        }
    } else {
        set_step(project_id, change_id, "Creating staging sandbox…");
        let r = client()
            .post(format!("{SPRITES_API}/sprites"))
            .bearer_auth(token)
            .json(&json!({ "name": sprite, "url_settings": { "auth": "public" } }))
            .send()
            .await
            .map_err(|e| format!("sprites: {e}"))?;
        if !r.status().is_success() {
            let t = r.text().await.unwrap_or_default();
            return Err(format!("Could not create the staging sandbox: {}", t.chars().take(200).collect::<String>()));
        }
    }
    ship(state, token, &sprite, &git_root, repo_id, project_id, change_id, true).await?;
    set_step(project_id, change_id, "Starting the app…");
    let dockerfile = crate::git::git_read_file_at(&git_root, repo_id, BRANCH, "Dockerfile").await?.unwrap_or_default();
    let mut env = sprite_env(&dockerfile);
    let mut key = [0u8; 32];
    getrandom::getrandom(&mut key).map_err(|e| e.to_string())?;
    env.insert("ADMIN_TOKEN".into(), Value::String(hex::encode(key)));
    let r = client()
        .put(format!("{SPRITES_API}/sprites/{sprite}/services/app"))
        .query(&[("duration", "6s")])
        .bearer_auth(token)
        .json(&json!({ "cmd": "bun", "args": ["run", "start"], "dir": APP_DIR, "needs": [], "http_port": 8080, "env": env }))
        .send()
        .await
        .map_err(|e| format!("sprites: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("Could not start the app on staging ({}).", r.status()));
    }
    let _ = r.text().await;
    let url = sprite_url(&token, &sprite).await.unwrap_or_default();
    Ok((sprite, url))
}

// ---------- local staging (no Sprites account) ----------
//
// Same flow as sprites, but the sandbox is a plain dir on this machine and
// the app runs under the user's own Bun. Used automatically when the team
// has no Sprites token (e.g. the desktop app). The staging DB lives next to
// the checkout so rebuilds keep it.

fn staging_key(project_id: &str) -> String {
    format!("staging:{project_id}")
}

fn staging_dir(state: &AppState, project_id: &str) -> std::path::PathBuf {
    state.workspace_dir.join("staging").join(project_id)
}

fn staging_data_dir(state: &AppState, project_id: &str) -> std::path::PathBuf {
    state.workspace_dir.join("staging-data").join(project_id)
}

/// Prepare, build, and (re)start the local staging app. Returns its URL.
async fn ship_local(state: &AppState, project_id: &str, repo_id: &str, change_id: &str, first: bool) -> Result<String, String> {
    let key = staging_key(project_id);
    let dir = staging_dir(state, project_id);
    let data_dir = staging_data_dir(state, project_id);
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("mkdir data: {e}"))?;

    let bun = localapp::find_bun().ok_or_else(|| localapp::bun_hint().to_string())?;
    let git_root = state.git_root.to_string_lossy().to_string();

    if !change_id.is_empty() {
        set_step(project_id, change_id, "Preparing local staging…");
    }
    // Keep the staging DB across rebuilds: set it aside, extract, restore.
    let data_backup = dir.with_extension("data.bak");
    let had_data = dir.join("data").is_dir();
    if had_data {
        let _ = std::fs::remove_dir_all(&data_backup);
        std::fs::rename(dir.join("data"), &data_backup).map_err(|e| format!("backup data: {e}"))?;
    }
    localapp::prepare_dir(&git_root, repo_id, BRANCH, &dir).await?;
    if had_data {
        let _ = std::fs::remove_dir_all(dir.join("data"));
        std::fs::rename(&data_backup, dir.join("data")).map_err(|e| format!("restore data: {e}"))?;
    }

    if !change_id.is_empty() {
        set_step(project_id, change_id, if first { "Installing and building (first time)…" } else { "Rebuilding…" });
    }
    let seed = first && !data_dir.join("app.db").is_file();
    if let Err(e) = localapp::build_app(&bun, &dir, seed).await {
        return Err(format!("Local build failed. {e}"));
    }

    // Old process out before the new one binds the port.
    localapp::kill(&key).await;
    let port = localapp::free_port();
    if port == 0 {
        return Err("No free port for staging.".to_string());
    }
    let dir_s = dir.to_string_lossy().to_string();
    let data_s = data_dir.to_string_lossy().to_string();
    let mut env = localapp::env_from_dockerfile(
        &crate::git::git_read_file_at(&git_root, repo_id, BRANCH, "Dockerfile").await?.unwrap_or_default(),
        &dir_s,
        &data_s,
    );
    env.insert("PORT".into(), Value::String(port.to_string()));
    env.insert("DB_PATH".into(), Value::String(data_dir.join("app.db").to_string_lossy().to_string()));
    let mut token_bytes = [0u8; 32];
    getrandom::getrandom(&mut token_bytes).map_err(|e| format!("random: {e}"))?;
    env.insert("ADMIN_TOKEN".into(), Value::String(hex::encode(token_bytes)));
    if let Ok(k) = std::env::var("MODEL_API_KEY") {
        if !k.trim().is_empty() {
            env.insert("MODEL_API_KEY".into(), Value::String(k));
        }
    }
    let env_vec: Vec<(String, String)> = env
        .into_iter()
        .filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string())))
        .collect();
    let child = localapp::spawn_bun(&bun, &dir, &env_vec)?;
    let url = format!("http://127.0.0.1:{port}");
    let log = Arc::new(Mutex::new(std::collections::VecDeque::new()));
    localapp::register(&key, child, port, url.clone(), log);
    if !change_id.is_empty() {
        set_step(project_id, change_id, "Starting the app…");
    }
    if !localapp::wait_healthy(port, "/healthz").await {
        localapp::kill(&key).await;
        let tail = localapp::app_logs(&key, 15).join("\n");
        // logs are gone with the registry entry; report what we kept
        let _ = tail;
        return Err(format!("The staging app did not answer on port {port}. See the app log in the run panel."));
    }
    Ok(url)
}

/// Local staging is only allowed when explicitly enabled (desktop-embedded
/// or self-hosted with Bun). The shared cloud server never runs user code.
fn local_staging_enabled() -> bool {
    std::env::var("SLAVER_LOCAL_STAGING").map(|v| v == "1").unwrap_or(false)
}

#[derive(PartialEq)]
enum StagingKind {
    Sprite,
    Local,
}

struct StagingTarget {
    kind: StagingKind,
    name: String,
    url: String,
}

/// Boot the staging sandbox: team's Sprite when a token is connected,
/// otherwise a local dir + Bun on this machine.
async fn ensure_staging(
    state: &AppState,
    token: Option<&str>,
    project_id: &str,
    repo_id: &str,
    change_id: &str,
) -> Result<(StagingTarget, Option<String>), String> {
    match token {
        Some(t) => {
            let (sprite, url) = ensure_sprite(state, t, project_id, repo_id, change_id).await?;
            Ok((StagingTarget { kind: StagingKind::Sprite, name: sprite, url }, Some(t.to_string())))
        }
        None => {
            let url = ship_local(state, project_id, repo_id, change_id, true).await?;
            Ok((StagingTarget { kind: StagingKind::Local, name: "local".to_string(), url }, None))
        }
    }
}

/// Upload the staging branch into the sprite and build it.
async fn ship(state: &AppState, token: &str, sprite: &str, git_root: &str, repo_id: &str, project_id: &str, change_id: &str, first: bool) -> Result<(), String> {
    let _ = state;
    set_step(project_id, change_id, "Uploading code to staging…");
    let tgz = crate::git::git_archive_targz(git_root, repo_id, BRANCH).await?;
    let (code, out) = sx(token, sprite, &format!("mkdir -p {APP_DIR} && tar xzf - -C {APP_DIR}"), Some(tgz)).await?;
    if code != 0 {
        return Err(format!("Upload failed: {}", tail(&out)));
    }
    set_step(project_id, change_id, if first { "Installing and building (first time)…" } else { "Rebuilding…" });
    let build = format!(
        "cd {APP_DIR} && if grep -q '\"setup\"' package.json; then bun run setup; else bun install && (grep -q '\"build\"' package.json && bun run build || true); fi 2>&1 | tail -25{seed}",
        seed = if first { " && mkdir -p data && (grep -q '\"seed\"' package.json && bun run seed >/dev/null 2>&1 || true)" } else { "" }
    );
    let (code, out) = sx(token, sprite, &build, None).await?;
    if code != 0 {
        return Err(format!("Build failed: {}", tail(&out)));
    }
    Ok(())
}

fn tail(s: &str) -> String {
    let lines: Vec<&str> = s.lines().filter(|l| !l.contains("__EXIT=") && !l.contains("bind: warning")).collect();
    lines[lines.len().saturating_sub(8)..].join("\n")
}

fn ignored(path: &str) -> bool {
    ["node_modules/", "dist/", ".git/", "data/", ".astro/"].iter().any(|d| path.starts_with(d) || path.contains(&format!("/{d}")))
        || path.ends_with(".lock")
        || path.ends_with("lock.json")
}

fn is_text(path: &str) -> bool {
    let ext = path.rsplit('.').next().unwrap_or("");
    ["ts", "tsx", "js", "jsx", "mjs", "astro", "css", "html", "json", "md", "svelte", "vue", "toml", "yml", "yaml"].contains(&ext)
}

/// Ask the model which files to change, then for their new contents.
async fn ai_edit(state: &AppState, team_id: &str, repo_id: &str, prompt: &str, history: &[Change]) -> Result<(String, Vec<(String, String)>), String> {
    let git_root = state.git_root.to_string_lossy().to_string();
    let (prov, model) = crate::review::model_for(&state.db, team_id).await.map_err(|e| format!("AI key: {e}"))?;
    let files: Vec<String> = crate::git::git_tree_files_at(&git_root, repo_id, BRANCH)
        .await?
        .into_iter()
        .filter(|(p, size)| !ignored(p) && is_text(p) && *size < 120_000)
        .map(|(p, _)| p)
        .collect();
    let past = history
        .iter()
        .filter(|c| c.status == "done")
        .map(|c| format!("- {} → {}", c.prompt, c.summary))
        .collect::<Vec<_>>()
        .join("\n");
    let sys = "You are a senior engineer customizing a small business web app for its owner. Make the smallest correct change. Reply with JSON only.";
    let pick = vec![
        ChatMessage::text("system", sys.to_string()),
        ChatMessage::text(
            "user",
            format!(
                "Owner request: {prompt}\n\nEarlier changes:\n{}\n\nProject files:\n{}\n\nWhich files must be read and edited? Reply {{\"files\": [\"path\", ...]}} with at most 6 paths from the list (UI text/colors usually live in admin/src or store/src).",
                if past.is_empty() { "(none)" } else { &past },
                files.join("\n")
            ),
        ),
    ];
    let c = crate::ai::complete_with_usage(&prov, &model, &pick, None).await?;
    let start = c.text.find('{').ok_or("model did not return JSON")?;
    let end = c.text.rfind('}').ok_or("model did not return JSON")?;
    let v: Value = serde_json::from_str(&c.text[start..=end]).map_err(|e| format!("bad JSON from model: {e}"))?;
    let chosen: Vec<String> = v["files"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).filter(|p| files.contains(p)).take(6).collect())
        .unwrap_or_default();
    if chosen.is_empty() {
        return Err("The AI could not find which files to change. Try describing the screen or text more precisely.".into());
    }
    let mut body = String::new();
    for p in &chosen {
        let text = crate::git::git_read_file_at(&git_root, repo_id, BRANCH, p).await?.unwrap_or_default();
        body.push_str(&format!("--- {p} ---\n{text}\n\n"));
    }
    let edit = vec![
        ChatMessage::text("system", sys.to_string()),
        ChatMessage::text(
            "user",
            format!(
                "Owner request: {prompt}\n\nCurrent files:\n{body}\nReturn the COMPLETE new content of every file you change, keeping everything else identical. Reply JSON: {{\"summary\": \"one short sentence in the owner's language\", \"edits\": [{{\"path\": \"...\", \"content\": \"full file\"}}]}}"
            ),
        ),
    ];
    let c = crate::ai::complete_with_usage(&prov, &model, &edit, None).await?;
    let start = c.text.find('{').ok_or("model did not return JSON")?;
    let end = c.text.rfind('}').ok_or("model did not return JSON")?;
    let v: Value = serde_json::from_str(&c.text[start..=end]).map_err(|e| format!("bad JSON from model: {e}"))?;
    let summary = v["summary"].as_str().unwrap_or("Updated the app.").to_string();
    let edits: Vec<(String, String)> = v["edits"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|e| Some((e["path"].as_str()?.to_string(), e["content"].as_str()?.to_string())))
                .filter(|(p, c)| chosen.contains(p) && !p.contains("..") && !c.trim().is_empty())
                .collect()
        })
        .unwrap_or_default();
    if edits.is_empty() {
        return Err("The AI did not change any file. Try rephrasing the request.".into());
    }
    Ok((summary, edits))
}

async fn run_change(state: AppState, team_id: String, project_id: String, repo_id: String, token: Option<String>, change_id: String, prompt: String, ship_none: bool) {
    let res = async {
        let git_root = state.git_root.to_string_lossy().to_string();
        // staging branch starts from main
        if crate::git::git_rev(&git_root, &repo_id, BRANCH).await?.is_none() {
            let main = crate::git::git_rev(&git_root, &repo_id, "HEAD").await?.ok_or("This app has no code yet.")?;
            crate::git::git_set_branch(&git_root, &repo_id, BRANCH, &main, None).await?;
        }
        // ship:none (desktop): the client runs the staging branch itself.
        let target = if ship_none {
            update(&project_id, |s| {
                s.sprite = "local-client".to_string();
            });
            None
        } else {
            let (t, tok) = ensure_staging(&state, token.as_deref(), &project_id, &repo_id, &change_id).await?;
            update(&project_id, |s| {
                s.sprite = t.name.clone();
                s.url = t.url.clone();
            });
            Some((t, tok))
        };
        set_step(&project_id, &change_id, "Meta model is editing the code…");
        let history = jobs().lock().unwrap().get(&project_id).map(|s| s.changes.clone()).unwrap_or_default();
        let (summary, edits) = ai_edit(&state, &team_id, &repo_id, &prompt, &history).await?;
        let parent = crate::git::git_rev(&git_root, &repo_id, BRANCH).await?.ok_or("staging branch missing")?;
        let commit = crate::git::git_commit_files(&git_root, &repo_id, &parent, &edits, &format!("AI: {prompt}\n\n{summary}")).await?;
        crate::git::git_set_branch(&git_root, &repo_id, BRANCH, &commit, Some(&parent)).await?;
        if let Some((target, token)) = target {
            match (&target.kind, token.as_deref()) {
                (StagingKind::Sprite, Some(t)) => {
                    ship(&state, t, &target.name, &git_root, &repo_id, &project_id, &change_id, false).await?;
                    set_step(&project_id, &change_id, "Restarting…");
                    let _ = client().post(format!("{SPRITES_API}/sprites/{}/services/app/restart", target.name)).bearer_auth(t).send().await;
                }
                // Local staging: ship rebuilds and restarts in one step.
                _ => {
                    ship_local(&state, &project_id, &repo_id, &change_id, false).await?;
                }
            }
        }
        Ok::<_, String>((summary, edits.into_iter().map(|(p, _)| p).collect::<Vec<_>>(), commit))
    }
    .await;
    update(&project_id, |s| {
        if let Some(c) = s.changes.iter_mut().find(|c| c.id == change_id) {
            match res {
                Ok((summary, files, commit)) => {
                    c.status = "done".into();
                    c.summary = summary;
                    c.files = files;
                    c.commit = commit;
                }
                Err(e) => {
                    c.status = "failed".into();
                    c.error = e;
                }
            }
            c.step.clear();
        }
    });
    if let Some(c) = change(&project_id, &change_id) {
        if let Err(e) = save(&state.db, &project_id, &c).await {
            eprintln!("customize: save failed: {e}");
        }
    }
}

async fn project_for(state: &AppState, user_id: &str, project_id: &str, manage: bool) -> Result<crate::platform::ProjectRow, String> {
    let p = crate::platform::get_project(&state.db, user_id, project_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("App not found.")?;
    if p.repo_id.is_empty() {
        return Err("This app has no source code to customize.".into());
    }
    if manage {
        match crate::store::membership(&state.db, &p.team_id, user_id).await.map_err(|e| e.to_string())? {
            Some(r) if r == "owner" || r == "admin" => {}
            _ => return Err("Only owners and admins can customize apps.".into()),
        }
    }
    Ok(p)
}

pub async fn status(state: &AppState, user_id: &str, project_id: &str) -> Result<Value, String> {
    let p = project_for(state, user_id, project_id, false).await?;
    load(&state.db, project_id).await?;
    let mut st = jobs().lock().unwrap().get(project_id).cloned().unwrap_or_default();
    let token = crate::hosting::sprites_token(&state.db, &p.team_id).await.map_err(|e| e.to_string())?;
    let sandbox = if token.is_some() { "sprites" } else if local_staging_enabled() { "local" } else { "none" };
    if sandbox == "local" {
        // A local staging keeps its URL in the process registry.
        if let Some(url) = localapp::get_url(&staging_key(project_id)) {
            st.sprite = "local".to_string();
            st.url = url.clone();
            update(project_id, |s| {
                s.sprite = st.sprite.clone();
                s.url = url;
            });
        }
    } else if st.url.is_empty() {
        if let Some(t) = &token {
            if let Some(url) = sprite_url(t, &sprite_name(project_id)).await {
                st.sprite = sprite_name(project_id);
                st.url = url.clone();
                update(project_id, |s| {
                    s.sprite = st.sprite.clone();
                    s.url = url;
                });
            }
        }
    }
    Ok(json!({ "staging": st, "sprites_connected": token.is_some(), "sandbox": sandbox, "project": p }))
}

pub async fn send(state: &AppState, user_id: &str, project_id: &str, prompt: &str, ship_none: bool) -> Result<Value, String> {
    let p = project_for(state, user_id, project_id, true).await?;
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("Describe what to change.".into());
    }
    let token = crate::hosting::sprites_token(&state.db, &p.team_id)
        .await
        .map_err(|e| e.to_string())?;
    // ship:none (desktop): the server only edits+commits; the desktop runs staging.
    if !ship_none && token.is_none() {
        if local_staging_enabled() {
            if localapp::find_bun().is_none() {
                return Err(format!("{}. Or connect Sprites for cloud staging.", localapp::bun_hint()));
            }
        } else {
            return Err("Connect your Sprites account first (staging runs there).".to_string());
        }
    }
    load(&state.db, project_id).await?;
    if jobs().lock().unwrap().get(project_id).map(|s| s.changes.iter().any(|c| c.status == "working")).unwrap_or(false) {
        return Err("A change is still running. Wait for it to finish.".into());
    }
    let change = Change {
        id: crate::util::new_id(),
        prompt: prompt.chars().take(2000).collect(),
        status: "working".into(),
        step: "Starting…".into(),
        summary: String::new(),
        files: vec![],
        commit: String::new(),
        error: String::new(),
        applied: false,
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    save(&state.db, project_id, &change).await?;
    update(project_id, |s| s.changes.push(change.clone()));
    tokio::spawn(run_change(state.clone(), p.team_id.clone(), p.id.clone(), p.repo_id.clone(), token, change.id.clone(), change.prompt.clone(), ship_none));
    Ok(json!({ "change": change }))
}

/// Merge staging into main. The team then redeploys production from the Apps page.
pub async fn promote(state: &AppState, user_id: &str, project_id: &str) -> Result<Value, String> {
    let p = project_for(state, user_id, project_id, true).await?;
    let git_root = state.git_root.to_string_lossy().to_string();
    if crate::git::git_rev(&git_root, &p.repo_id, BRANCH).await?.is_none() {
        return Err("Nothing on staging yet.".into());
    }
    let head = crate::git::git_rev(&git_root, &p.repo_id, "HEAD").await?.unwrap_or_default();
    let main_branch = if crate::git::git_rev(&git_root, &p.repo_id, "main").await?.is_some() { "main" } else { "master" };
    let new = crate::git::git_merge_branch(&git_root, &p.repo_id, main_branch, BRANCH).await?;
    load(&state.db, project_id).await?;
    mark(state, project_id, |c| {
        if c.status == "done" && !c.applied {
            c.applied = true;
            true
        } else {
            false
        }
    })
    .await?;
    Ok(json!({ "merged": new != head, "commit": new }))
}

/// Apply `f` to every change of a project; save the ones it reports as changed.
async fn mark(state: &AppState, project_id: &str, f: impl Fn(&mut Change) -> bool) -> Result<usize, String> {
    let mut touched = Vec::new();
    update(project_id, |s| {
        for c in s.changes.iter_mut() {
            if f(c) {
                touched.push(c.clone());
            }
        }
    });
    for c in &touched {
        save(&state.db, project_id, c).await?;
    }
    Ok(touched.len())
}

/// Throw away everything on staging that is not in production yet: reset the
/// staging branch to main and rebuild the sandbox from it.
pub async fn discard(state: &AppState, user_id: &str, project_id: &str) -> Result<Value, String> {
    let p = project_for(state, user_id, project_id, true).await?;
    load(&state.db, project_id).await?;
    if jobs().lock().unwrap().get(project_id).map(|s| s.changes.iter().any(|c| c.status == "working")).unwrap_or(false) {
        return Err("A change is still running. Wait for it to finish.".into());
    }
    let git_root = state.git_root.to_string_lossy().to_string();
    let Some(staging) = crate::git::git_rev(&git_root, &p.repo_id, BRANCH).await? else {
        return Err("Nothing on staging yet.".into());
    };
    let main = crate::git::git_rev(&git_root, &p.repo_id, "HEAD").await?.ok_or("This app has no code yet.")?;
    let n = mark(state, project_id, |c| {
        if c.status == "done" && !c.applied {
            c.status = "discarded".into();
            true
        } else {
            false
        }
    })
    .await?;
    if staging == main {
        return Ok(json!({ "discarded": n, "rebuilding": false }));
    }
    crate::git::git_set_branch(&git_root, &p.repo_id, BRANCH, &main, Some(&staging)).await?;
    // Rebuild the sandbox in the background when it exists.
    let token = crate::hosting::sprites_token(&state.db, &p.team_id).await.map_err(|e| e.to_string())?;
    let rebuilding = match token {
        Some(t) if sprite_url(&t, &sprite_name(project_id)).await.is_some() => {
            let (st, pid, rid) = (state.clone(), project_id.to_string(), p.repo_id.clone());
            tokio::spawn(async move {
                let sprite = sprite_name(&pid);
                let git_root = st.git_root.to_string_lossy().to_string();
                match ship(&st, &t, &sprite, &git_root, &rid, &pid, "", false).await {
                    Ok(()) => {
                        let _ = client().post(format!("{SPRITES_API}/sprites/{sprite}/services/app/restart")).bearer_auth(&t).send().await;
                    }
                    Err(e) => eprintln!("customize: rebuild after discard failed: {e}"),
                }
            });
            true
        }
        _ => {
            // Local staging: rebuild when it is running.
            let key = staging_key(project_id);
            if localapp::is_running(&key) {
                let (st, pid, rid) = (state.clone(), project_id.to_string(), p.repo_id.clone());
                tokio::spawn(async move {
                    if let Err(e) = ship_local(&st, &pid, &rid, "", false).await {
                        eprintln!("customize: local rebuild after discard failed: {e}");
                    }
                });
                true
            } else {
                false
            }
        }
    };
    Ok(json!({ "discarded": n, "rebuilding": rebuilding }))
}
