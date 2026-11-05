//! AI review of a marketplace listing request.
//!
//! A seller asks to list an app ("Ajukan listing"). Slaver reads the code at the
//! repo's HEAD, runs static checks (leaked secrets, README, size), then asks a
//! Meta model for a review: score, strengths, must-fix items and suggestions.
//! The listing can only go live when the latest review of the current version
//! is "approved" (no static must-fix and no AI must-fix).
//!
//! Model key: the server's MODEL_API_KEY (Meta Model API) when set, otherwise
//! the seller team's own provider key. Files that look like they hold secrets
//! are never sent to the model.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::ai::ChatMessage;
use crate::db::{v_text, Db};
use crate::provider::{self, Provider};

const MAX_TEXT_BYTES: u64 = 200_000;
const MAX_FILE_BYTES: u64 = 5_000_000;
const IGNORED_DIRS: &[&str] = &["node_modules/", ".git/", "dist/", ".astro/", "data/", "coverage/", "target/", "build/"];
const LOCKFILES: &[&str] = &["bun.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock"];
const TEXT_EXT: &[&str] = &["ts", "tsx", "js", "jsx", "mjs", "cjs", "astro", "json", "md", "html", "css", "yml", "yaml", "toml", "sh", "sql", "py", "rs", "go", "rb", "php", "vue", "svelte", "env", "example", "txt"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Check {
    pub level: String, // must | suggest | ok
    pub name: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AiReview {
    pub score: Option<f64>,
    pub summary: String,
    pub strengths: Vec<String>,
    pub must_fix: Vec<String>,
    pub suggestions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Review {
    pub id: String,
    pub repo_id: String,
    pub commit_sha: String,
    pub verdict: String, // approved | changes
    pub score: Option<f64>,
    pub model: String,
    pub checks: Vec<Check>,
    pub ai: Option<AiReview>,
    pub ai_error: String,
    pub files_reviewed: Vec<String>,
    pub created_at: String,
    /// True when this review is for the repo's current HEAD.
    #[serde(default)]
    pub current: bool,
}

fn ignored(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    LOCKFILES.contains(&name) || IGNORED_DIRS.iter().any(|d| path.starts_with(d) || path.contains(&format!("/{d}")))
}

fn is_text(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    if name == "Dockerfile" || name == "Makefile" || name.starts_with(".env") {
        return true;
    }
    match name.rsplit_once('.') {
        Some((_, ext)) => TEXT_EXT.contains(&ext.to_ascii_lowercase().as_str()),
        None => false,
    }
}

/// Names of credential patterns found in `text` (no regex crate: simple scanners).
pub fn secret_hits(text: &str) -> Vec<&'static str> {
    let mut hits = Vec::new();
    let token_after = |prefix: &str, min: usize, ok: fn(char) -> bool| {
        text.match_indices(prefix).any(|(i, _)| {
            let boundary = i == 0 || !text[..i].chars().next_back().map(|c| c.is_ascii_alphanumeric()).unwrap_or(false);
            boundary && text[i + prefix.len()..].chars().take_while(|c| ok(*c)).count() >= min
        })
    };
    let key_char = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    if token_after("sk-", 20, key_char) {
        hits.push("OpenAI-style key");
    }
    if ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"].iter().any(|p| token_after(p, 30, |c| c.is_ascii_alphanumeric())) {
        hits.push("GitHub token");
    }
    if token_after("AKIA", 16, |c| c.is_ascii_uppercase() || c.is_ascii_digit()) {
        hits.push("AWS access key");
    }
    // A real PEM block: the header line followed by base64 key material (not a regex that mentions it).
    let pem = text.match_indices("PRIVATE KEY-----").any(|(i, m)| {
        let before = &text[..i];
        let header_start = before.rfind('\n').map(|n| n + 1).unwrap_or(0);
        before[header_start..].trim_start().starts_with("-----BEGIN")
            && text[i + m.len()..]
                .lines()
                .nth(1)
                .map(|l| l.trim().len() >= 40 && l.trim().chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '='))
                .unwrap_or(false)
    });
    if pem {
        hits.push("private key block");
    }
    // NAME = "long-literal" for typical secret variable names.
    for line in text.lines() {
        let up = line.to_ascii_uppercase();
        if !["API_KEY", "SECRET", "TOKEN"].iter().any(|n| up.contains(n)) {
            continue;
        }
        let Some(pos) = line.find(['=', ':']) else { continue };
        let val = line[pos + 1..].trim().trim_matches(|c| c == '"' || c == '\'' || c == ',' || c == ';');
        if val.len() >= 24 && val.chars().all(key_char) && looks_random(val) {
            hits.push("hard-coded API key assignment");
            break;
        }
    }
    hits
}

/// A credential looks random: letters and digits mixed, not an identifier such as
/// `OPENAI_API_KEY` or `ACCESS_TOKEN_REFRESH_SKEW_SECONDS` (env var names, constants).
fn looks_random(v: &str) -> bool {
    let digits = v.chars().filter(|c| c.is_ascii_digit()).count();
    let letters = v.chars().filter(|c| c.is_ascii_alphabetic()).count();
    let upper_ident = v.contains('_') && v.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    let lower_ident = v.contains('_') && v.chars().all(|c| c.is_ascii_lowercase() || c == '_');
    digits >= 2 && letters >= 8 && !upper_ident && !lower_ident
}

pub fn model_provider_from_env() -> Option<(Provider, String)> {
    let key = std::env::var("MODEL_API_KEY").ok().filter(|k| !k.trim().is_empty())?;
    let base = std::env::var("AI_BASE_URL").ok().filter(|b| !b.trim().is_empty()).unwrap_or_else(|| "https://api.meta.ai/v1".to_string());
    let model = std::env::var("AI_TEXT_MODEL").ok().filter(|m| !m.trim().is_empty()).unwrap_or_else(|| provider::default_model_for("meta").to_string());
    Some((Provider { preset: "meta".to_string(), base_url: provider::normalize_base_url(&base), api_key: key.trim().to_string() }, model))
}

/// Model for a team: the server MODEL_API_KEY (Meta) when set, else the team's own key.
pub async fn model_for(db: &Db, team_id: &str) -> Result<(Provider, String), String> {
    if let Some(pm) = model_provider_from_env() {
        return Ok(pm);
    }
    let p = provider::provider_for(db, team_id).await.map_err(|e| e.to_string())?;
    let m = provider::default_model_for(&p.preset).to_string();
    Ok((p, m))
}

/// Pull the first JSON object out of a model reply (handles ```json fences and prose around it).
pub fn parse_ai(text: &str) -> Result<AiReview, String> {
    let start = text.find('{').ok_or("model did not return JSON")?;
    let end = text.rfind('}').ok_or("model did not return JSON")?;
    let v: Value = serde_json::from_str(&text[start..=end]).map_err(|e| format!("bad JSON from model: {e}"))?;
    let list = |k: &str| -> Vec<String> {
        v.get(k)
            .and_then(|x| x.as_array())
            .map(|a| a.iter().filter_map(|s| s.as_str().map(|s| s.trim().to_string())).filter(|s| !s.is_empty()).take(5).collect())
            .unwrap_or_default()
    };
    Ok(AiReview {
        score: v.get("score").and_then(|s| s.as_f64()).map(|s| s.clamp(0.0, 10.0)),
        summary: v.get("summary").and_then(|s| s.as_str()).unwrap_or("").trim().to_string(),
        strengths: list("strengths"),
        must_fix: list("must_fix"),
        suggestions: list("suggestions"),
    })
}

fn build_prompt(name: &str, description: &str, lang: &str, tree: &[String], picked: &[(String, String)]) -> Vec<ChatMessage> {
    let language = if lang == "en" { "English" } else { "Bahasa Indonesia" };
    let body = picked
        .iter()
        .map(|(p, c)| format!("--- {p} ---\n{}", c.chars().take(4000).collect::<String>()))
        .collect::<Vec<_>>()
        .join("\n\n");
    vec![
        ChatMessage::text(
            "system",
            format!(
                "You review apps that sellers want to list on Slaver, a marketplace where business owners buy their own copy of an app and self-host it. \
                 Decide if this version is ready to be listed and give specific, actionable feedback in {language}. \
                 Focus on: README and install clarity, code quality, security (secrets, input validation, auth), how easy it is to customize, and tests. \
                 Only put real blockers in must_fix (security holes, app cannot be installed or run, missing README). Everything else goes to suggestions. \
                 Reply with JSON only: {{\"score\": 0-10, \"summary\": \"1-2 sentences\", \"strengths\": [], \"must_fix\": [], \"suggestions\": []}}. \
                 At most 4 items per list. Refer to real file names from the list; never invent files."
            ),
        ),
        ChatMessage::text(
            "user",
            format!(
                "App: {name}\nSeller description: {}\n\nFiles:\n{}\n\nSelected file contents:\n{body}",
                if description.trim().is_empty() { "(none)" } else { description.trim() },
                tree.join("\n"),
            ),
        ),
    ]
}

/// Static part of a review: HEAD sha, checks, the files picked for the model, and the tree.
struct Scan {
    sha: String,
    checks: Vec<Check>,
    picked: Vec<(String, String)>,
    tree: Vec<String>,
}

/// Tests, fixtures and docs: key-like strings there are usually fake examples.
fn is_fixture(path: &str) -> bool {
    let l = path.to_ascii_lowercase();
    let name = l.rsplit('/').next().unwrap_or(&l);
    l.ends_with(".md")
        || l.ends_with(".mdx")
        || ["test/", "tests/", "__tests__/", "fixtures/", "e2e/", "docs/", "examples/"].iter().any(|d| l.starts_with(d) || l.contains(&format!("/{d}")))
        || name.starts_with("test_")
        || name.contains(".test.")
        || name.contains(".spec.")
        || name.contains("_test.")
}

/// `.env`, `.env.local`, ... but not `.env.example` / `.env.sample` or direnv's `.envrc`.
fn is_env_file(name: &str) -> bool {
    (name == ".env" || name.starts_with(".env.")) && !name.ends_with(".example") && !name.ends_with(".sample")
}

async fn scan(git_root: &str, repo_id: &str) -> Result<Scan, String> {
    let sha = crate::git::git_head_sha(git_root, repo_id).await?.ok_or("This listing has no code yet. Upload or import the source first.")?;
    let all = crate::git::git_tree_files(git_root, repo_id).await?;
    let files: Vec<(String, u64)> = all.into_iter().filter(|(p, _)| !ignored(p)).collect();

    // Read text files and run static checks.
    let mut contents: Vec<(String, String)> = Vec::new();
    let mut secret_files: Vec<String> = Vec::new();
    let mut fixture_secrets: Vec<String> = Vec::new();
    let mut big: Vec<String> = Vec::new();
    for (path, size) in &files {
        if *size > MAX_FILE_BYTES {
            big.push(path.clone());
        }
        if *size > MAX_TEXT_BYTES || !is_text(path) {
            continue;
        }
        if let Some(text) = crate::git::git_read_file(git_root, repo_id, path).await? {
            let hits = secret_hits(&text);
            if !hits.is_empty() {
                let entry = format!("{path} ({})", hits.join(", "));
                if is_fixture(path) { fixture_secrets.push(entry) } else { secret_files.push(entry) }
            } else {
                contents.push((path.clone(), text));
            }
        }
    }
    let has = |n: &str| files.iter().any(|(p, _)| p.eq_ignore_ascii_case(n));
    let real_env = files.iter().filter(|(p, _)| is_env_file(p.rsplit('/').next().unwrap_or(p)));
    let mut checks = vec![];
    let env_files: Vec<String> = real_env.map(|(p, _)| p.clone()).collect();
    checks.push(if secret_files.is_empty() && env_files.is_empty() {
        Check { level: "ok".into(), name: "Secrets".into(), detail: "No keys or tokens found in the code.".into() }
    } else {
        let mut d = secret_files.clone();
        d.extend(env_files.iter().map(|p| format!("{p} (environment file committed)")));
        Check { level: "must".into(), name: "Secrets".into(), detail: format!("Remove credentials from: {}", d.join("; ")) }
    });
    if !fixture_secrets.is_empty() {
        let n = fixture_secrets.len();
        let shown: Vec<&String> = fixture_secrets.iter().take(5).collect();
        checks.push(Check {
            level: "suggest".into(),
            name: "Test keys".into(),
            detail: format!("Key-like strings in {n} test/doc file(s), e.g. {}. Make sure they are fake.", shown.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("; ")),
        });
    }
    checks.push(if has("README.md") {
        Check { level: "ok".into(), name: "README".into(), detail: "README.md found.".into() }
    } else {
        Check { level: "must".into(), name: "README".into(), detail: "Add a README.md with what the app does and how to install it.".into() }
    });
    checks.push(if has("Dockerfile") || has("package.json") || has("Cargo.toml") || has("requirements.txt") || has("go.mod") || has("index.html") {
        Check { level: "ok".into(), name: "Runnable".into(), detail: "Found a build/run entry point.".into() }
    } else {
        Check { level: "suggest".into(), name: "Runnable".into(), detail: "No Dockerfile, package.json or similar found: buyers may not know how to run it.".into() }
    });
    if !big.is_empty() {
        checks.push(Check { level: "suggest".into(), name: "Large files".into(), detail: format!("Files over 5 MB: {}", big.join(", ")) });
    }
    let has_tests = files.iter().any(|(p, _)| p.contains("test") || p.contains("spec"));
    checks.push(if has_tests {
        Check { level: "ok".into(), name: "Tests".into(), detail: "Test files found.".into() }
    } else {
        Check { level: "suggest".into(), name: "Tests".into(), detail: "No tests found.".into() }
    });

    // Choose files for the model: README, manifests, entry points, then other source.
    let score_path = |p: &str| -> i32 {
        let l = p.to_ascii_lowercase();
        if l == "readme.md" { 0 }
        else if ["package.json", "cargo.toml", "dockerfile", "fly.toml", "requirements.txt", "go.mod"].contains(&l.as_str()) { 1 }
        else if l.starts_with("src/") && ["server", "index", "main", "app", "mcp"].iter().any(|n| l.contains(n)) { 2 }
        else if l.starts_with("src/") { 3 }
        else if l.ends_with(".md") { 5 }
        else { 4 }
    };
    let mut ranked = contents.clone();
    ranked.sort_by_key(|(p, _)| (score_path(p), p.len()));
    let picked: Vec<(String, String)> = ranked.into_iter().take(10).collect();
    let tree: Vec<String> = files.iter().map(|(p, _)| p.clone()).take(200).collect();
    Ok(Scan { sha, checks, picked, tree })
}

/// Run a review of the repo's HEAD, store it, and return it.
pub async fn run(db: &Db, git_root: &str, repo_id: &str, team_id: &str, name: &str, description: &str, lang: &str) -> Result<Review, String> {
    let Scan { sha, checks, picked, tree } = scan(git_root, repo_id).await?;

    // AI review (Meta model).
    let (prov, model) = match model_provider_from_env() {
        Some(pm) => pm,
        None => match provider::provider_for(db, team_id).await {
            Ok(p) => {
                let m = provider::default_model_for(&p.preset).to_string();
                (p, m)
            }
            Err(e) => (Provider { preset: String::new(), base_url: String::new(), api_key: String::new() }, format!("ERR:{e}")),
        },
    };
    let (ai, ai_error) = if let Some(err) = model.strip_prefix("ERR:") {
        (None, format!("AI review unavailable: {err} (or set the server MODEL_API_KEY)."))
    } else {
        let msgs = build_prompt(name, description, lang, &tree, &picked);
        match crate::ai::complete_with_usage(&prov, &model, &msgs, None).await {
            Ok(c) => match parse_ai(&c.text) {
                Ok(r) => (Some(r), String::new()),
                Err(e) => (None, e),
            },
            Err(e) => (None, e),
        }
    };

    let model = if ai.is_some() { model } else { String::new() };
    store(db, repo_id, sha, checks, ai, ai_error, model, &picked).await
}

/// Demo review: real static checks of HEAD plus a hand-written AI part.
/// Stored with model "demo" so it is never mistaken for model output.
pub async fn store_demo(db: &Db, git_root: &str, repo_id: &str, ai: AiReview) -> Result<Review, String> {
    let Scan { sha, checks, picked, .. } = scan(git_root, repo_id).await?;
    store(db, repo_id, sha, checks, Some(ai), String::new(), DEMO_MODEL.to_string(), &picked).await
}

pub const DEMO_MODEL: &str = "demo";

#[allow(clippy::too_many_arguments)]
async fn store(db: &Db, repo_id: &str, sha: String, checks: Vec<Check>, ai: Option<AiReview>, ai_error: String, model: String, picked: &[(String, String)]) -> Result<Review, String> {
    let static_must = checks.iter().any(|c| c.level == "must");
    let ai_must = ai.as_ref().map(|a| !a.must_fix.is_empty()).unwrap_or(true);
    let verdict = if !static_must && !ai_must { "approved" } else { "changes" };
    let score = ai.as_ref().and_then(|a| a.score);
    let review = Review {
        id: crate::util::new_id(),
        repo_id: repo_id.to_string(),
        commit_sha: sha.clone(),
        verdict: verdict.to_string(),
        score,
        model,
        checks,
        ai,
        ai_error,
        files_reviewed: picked.iter().map(|(p, _)| p.clone()).collect(),
        created_at: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        current: true,
    };
    let body = serde_json::to_string(&review).map_err(|e| e.to_string())?;
    db.prepare("INSERT INTO listing_reviews (id, repo_id, commit_sha, verdict, score, model, review_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&[
            v_text(&review.id),
            v_text(repo_id),
            v_text(&sha),
            v_text(verdict),
            match score { Some(s) => crate::db::v_real(s), None => crate::db::v_null() },
            v_text(&review.model),
            v_text(&body),
            v_text(&review.created_at),
        ])
        .map_err(|e| e.to_string())?
        .run()
        .await
        .map_err(|e| e.to_string())?;
    Ok(review)
}

/// Latest review for a repo, flagged `current` when it matches HEAD.
pub async fn latest(db: &Db, git_root: &str, repo_id: &str) -> Result<Option<Review>, String> {
    let row: Option<Value> = db
        .prepare("SELECT review_json FROM listing_reviews WHERE repo_id = ? ORDER BY created_at DESC LIMIT 1")
        .bind(&[v_text(repo_id)])
        .map_err(|e| e.to_string())?
        .first(None)
        .await
        .map_err(|e| e.to_string())?;
    let Some(row) = row else { return Ok(None) };
    let raw = row.get("review_json").and_then(|v| v.as_str()).unwrap_or("{}");
    let mut r: Review = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    let head = crate::git::git_head_sha(git_root, repo_id).await.unwrap_or(None).unwrap_or_default();
    r.current = !head.is_empty() && head == r.commit_sha;
    Ok(Some(r))
}

/// Publishing gate: the current version must have an approved review.
pub async fn ensure_approved(db: &Db, git_root: &str, repo_id: &str) -> Result<(), String> {
    match latest(db, git_root, repo_id).await? {
        Some(r) if r.current && r.verdict == "approved" => Ok(()),
        Some(r) if r.current => Err("The AI review asked for changes. Fix the must-fix items, upload a new version, then request listing again.".into()),
        _ => Err("Request a listing review first: the current version has not been reviewed.".into()),
    }
}

pub fn to_json(r: &Review) -> Value {
    json!(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_secrets() {
        assert!(secret_hits("const k = 'sk-abcdefghijklmnopqrstuvwxyz123';").contains(&"OpenAI-style key"));
        assert!(secret_hits("API_KEY=abcdefghijklmnopqrstuvwxyz0123").contains(&"hard-coded API key assignment"));
        assert!(secret_hits("const apiKey = process.env.MODEL_API_KEY;").is_empty());
        assert!(secret_hits("task-runner and disk-usage").is_empty());
        // Names and patterns, not secrets.
        assert!(secret_hits("API_KEY_ENV = \"ANTHROPIC_API_KEY_OVERRIDE_NAME\"").is_empty());
        assert!(secret_hits("MIN_TTL = ACCESS_TOKEN_REFRESH_SKEW_SECONDS").is_empty());
        assert!(secret_hits("re.compile(r\"-----BEGIN[A-Z ]*PRIVATE KEY-----[\\s\\S]*?\")").is_empty());
        assert!(secret_hits("-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun\n").contains(&"private key block"));
        assert!(secret_hits("TOKEN = \"a8f3k2m9x7q4w1e6r5t0y2u8i3o\"").contains(&"hard-coded API key assignment"));
    }

    #[test]
    fn parses_fenced_json() {
        let r = parse_ai("Here you go:\n```json\n{\"score\": 8, \"summary\": \"ok\", \"strengths\": [\"a\"], \"must_fix\": [], \"suggestions\": [\"b\"]}\n```").unwrap();
        assert_eq!(r.score, Some(8.0));
        assert!(r.must_fix.is_empty());
        assert_eq!(r.suggestions, vec!["b".to_string()]);
    }

    #[test]
    fn ignores_vendor_and_lockfiles() {
        assert!(ignored("node_modules/x/index.js"));
        assert!(ignored("apps/a/node_modules/x.js"));
        assert!(ignored("bun.lock"));
        assert!(!ignored("src/server.ts"));
    }

    /// `SCAN_DIR=/path cargo test scan_dir -- --ignored --nocapture`: secret hits in a source tree.
    #[test]
    #[ignore]
    fn scan_dir() {
        fn walk(d: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for e in std::fs::read_dir(d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() { walk(&p, out) } else { out.push(p) }
            }
        }
        let root = std::path::PathBuf::from(std::env::var("SCAN_DIR").unwrap());
        let mut files = vec![];
        walk(&root, &mut files);
        for f in files {
            let rel = f.strip_prefix(&root).unwrap().to_string_lossy().to_string();
            if ignored(&rel) || !is_text(&rel) { continue }
            if let Ok(t) = std::fs::read_to_string(&f) {
                let h = secret_hits(&t);
                if !h.is_empty() { println!("{rel}: {h:?}") }
            }
        }
    }

    #[test]
    fn fixture_paths() {
        assert!(is_fixture("tests/tools/test_approval.py"));
        assert!(is_fixture("apps/desktop/e2e/a.spec.ts"));
        assert!(is_fixture("website/docs/guide.md"));
        assert!(is_fixture("src/foo.test.ts"));
        assert!(!is_fixture("hermes_cli/auth.py"));
        assert!(!is_fixture("src/server.ts"));
    }

    #[test]
    fn envrc_is_not_an_env_file() {
        assert!(is_env_file(".env"));
        assert!(is_env_file(".env.local"));
        assert!(!is_env_file(".env.example"));
        assert!(!is_env_file(".envrc"));
    }
}
