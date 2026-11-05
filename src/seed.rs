//! Seed marketplace templates on first boot: each apps/<name>/ dir becomes
//! a public template repo (bare git + initial commit).

use std::path::{Path, PathBuf};

fn new_id() -> String {
    crate::util::new_id()
}

// No bundled templates right now: the F&B Suite seed app was retired, and the
// only production listing (Hermes Agent, sold by Slaver Labs) is submitted
// through the normal seller API (scripts/submit-hermes.mjs), not from apps/.
const SEEDS: &[(&str, &str)] = &[];

pub async fn seed_templates(db: &crate::db::Db, git_root: &Path, apps_dir: &str) {
    eprintln!("seed: checking templates (dir={apps_dir})");
    // Seed per template name so new templates still land on old databases.
    let existing: Vec<String> = match db
        .prepare("SELECT name FROM repos WHERE template = 1")
        .bind(&[])
    {
        Ok(q) => match q.all().await {
            Ok(rows) => rows
                .results::<serde_json::Value>()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|v: serde_json::Value| {
                    v.get("name").and_then(|x| x.as_str()).map(|s| s.to_string())
                })
                .collect(),
            Err(e) => {
                eprintln!("seed: list query failed: {e}");
                return;
            }
        },
        Err(e) => {
            eprintln!("seed: prepare failed: {e}");
            return;
        }
    };
    // Templates live under a real system team so foreign keys hold in every
    // environment (this SQLite build enforces them).
    async fn exec(db: &crate::db::Db, sql: &str) -> Result<(), String> {
        db.prepare(sql)
            .bind(&[])
            .map_err(|e| e.to_string())?
            .run()
            .await
            .map_err(|e| e.to_string())
    }
    if let Err(e) = exec(db, "INSERT OR IGNORE INTO users (id, email, name, password_salt, password_hash) VALUES ('system', 'system@slaver.app', 'Slaver', '', '')").await {
        eprintln!("seed: cannot create system user: {e}");
        return;
    }
    if let Err(e) = exec(db, "INSERT OR IGNORE INTO teams (id, name, owner_user_id, personal) VALUES ('system-templates', 'Slaver Templates', 'system', 0)").await {
        eprintln!("seed: cannot create system team: {e}");
        return;
    }
    if let Err(e) = exec(db, "INSERT OR IGNORE INTO team_members (team_id, user_id, role) VALUES ('system-templates', 'system', 'owner')").await {
        eprintln!("seed: cannot add system member: {e}");
        return;
    }
    for (dir_name, desc) in SEEDS {
        let src = PathBuf::from(apps_dir).join(dir_name);
        let src = match std::fs::canonicalize(&src) {
            Ok(p) => p,
            Err(_) => {
                eprintln!("seed: missing dir {}", src.display());
                continue;
            }
        };
        let name = match *dir_name {
            other => other,
        };
        if existing.iter().any(|n| n == name) {
            continue;
        }
        let id = new_id();
        let ins: anyhow::Result<()> = async {
            db.prepare("INSERT INTO repos (id, team_id, name, description, template) VALUES (?, 'system-templates', ?, ?, 1)")
                .bind(&[crate::db::v_text(&id), crate::db::v_text(name), crate::db::v_text(desc)])?
                .run()
                .await?;
            Ok(())
        }
        .await;
        if let Err(e) = &ins {
            eprintln!("seed: insert failed for {name}: {e:#}");
            continue;
        }
        // Materialize: init bare repo -> temp clone -> copy seed files -> commit -> push.
        let bare = crate::platform::bare_repo_path(&git_root.to_string_lossy(), &id);
        if let Err(e) = crate::platform::ensure_bare_repo(&git_root.to_string_lossy(), &id).await {
            eprintln!("seed: cannot init bare repo for '{name}': {e}");
            continue;
        }
        let tmp = std::env::temp_dir().join(format!("slaver-seed-{id}"));
        let _ = tokio::fs::remove_dir_all(&tmp).await;
        if let Err(e) = tokio::fs::create_dir_all(&tmp).await {
            eprintln!("seed: tmpdir failed: {e}");
            continue;
        }
        let agent = format!("{}-seed", name.to_lowercase().replace(' ', "-"));
        let script = format!(
            "set -e; git init -q -b main . && git config user.email 'seed@slaver.app' && git config user.name 'slaver' && cp -r {src}/. . && git add -A && git commit -qm 'seed: {agent}' && git remote add origin {bare} && git push -q origin HEAD:main",
            src = src.display(),
            bare = bare.display(),
        );
        let out = tokio::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(&script)
            .current_dir(&tmp)
            .output()
            .await;
        // Fallback: plain init when shell/push fails.
        match out {
            Ok(o) if o.status.success() => eprintln!("seed: template '{name}' ready"),
            Ok(o) => {
                eprintln!(
                    "seed: template '{name}' script failed: {} {}",
                    String::from_utf8_lossy(&o.stdout),
                    String::from_utf8_lossy(&o.stderr)
                );
            }
            Err(e) => {
                eprintln!("seed: template '{name}' spawn failed: {e}");
            }
        }
        let _ = tokio::fs::remove_dir_all(&tmp).await;
    }
    ensure_demo_user(db).await;
    cleanup_fnb_suite(db, &git_root.to_string_lossy()).await;
    // Scanning a big repo takes minutes (one git read per file): never block boot on it.
    let (db, root) = (db.clone(), git_root.to_string_lossy().to_string());
    tokio::spawn(async move { ensure_demo_reviews(&db, &root).await });
}

/// Slaver's own seller account that submits Hermes Agent to the marketplace.
pub const LABS_EMAIL: &str = "labs@slaver.app";

/// Demo listing reviews (hand-written AI part, real static checks), stored with
/// model "demo". Only for the original listings below, and only when their
/// current version has no review yet, so a real Muse Spark review is never
/// overwritten.
async fn ensure_demo_reviews(db: &crate::db::Db, git_root: &str) {
    use crate::review::AiReview;
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    let demos = [
        (
            "Hermes Agent",
            AiReview {
                score: Some(8.6),
                summary: "A mature, well-tested self-hosted AI companion with a clear install path. The codebase is large, so buyers will rely on the README and the Docker setup.".into(),
                strengths: s(&[
                    "README.md explains install, model providers and the messaging gateway (Telegram, Discord, Slack, WhatsApp, Signal) clearly, with translations.",
                    "Large test suite under tests/ plus SECURITY.md with a private disclosure process.",
                    "Dockerfile pins base images by digest and verifies the SQLite source by SHA-256.",
                    "MIT LICENSE and provider-agnostic: owners can point it at their own model endpoint.",
                ]),
                must_fix: vec![],
                suggestions: s(&[
                    "The repo root has 140+ entries, including scratch modules (hermes_constants_scratch*.py); moving them out of the root makes customization easier.",
                    ".env.example is 500+ lines; add a short 'minimal setup' block for a single-messenger deploy (e.g. Telegram only).",
                    "A slim Docker target for gateway-only use would cut build time on small servers.",
                ]),
            },
        ),
    ];
    for (name, ai) in demos {
        // Only Slaver's own listings (owned by these accounts' teams), never a seller's look-alike.
        let rows: Vec<serde_json::Value> = match db
            .prepare("SELECT r.id FROM repos r JOIN teams t ON t.id = r.team_id JOIN users u ON u.id = t.owner_user_id WHERE r.name = ? AND u.email IN ('system@slaver.app', ?) AND r.fork_of = ''")
            .bind(&[crate::db::v_text(name), crate::db::v_text(LABS_EMAIL)])
        {
            Ok(q) => match q.all().await {
                Ok(r) => r.results().unwrap_or_default(),
                Err(_) => continue,
            },
            Err(_) => continue,
        };
        for row in rows {
            let Some(rid) = row.get("id").and_then(|v| v.as_str()) else { continue };
            match crate::review::latest(db, git_root, rid).await {
                Ok(Some(r)) if r.current => continue,
                Err(_) => continue,
                _ => {}
            }
            if crate::git::git_head_sha(git_root, rid).await.ok().flatten().is_none() {
                continue; // no code yet
            }
            match crate::review::store_demo(db, git_root, rid, ai.clone()).await {
                Ok(r) => eprintln!("seed: demo review for '{name}' ({}): {}", &r.commit_sha[..8.min(r.commit_sha.len())], r.verdict),
                Err(e) => eprintln!("seed: demo review for '{name}' failed: {e}"),
            }
        }
    }
}

/// Demo buyer account (used by the login-page demo button): resto@slaver.app
/// owns a "Saung Ranggon" team. It used to come with the F&B Suite app
/// pre-installed; since that app was retired the account is created empty.
/// Idempotent — skipped when the user already exists.
async fn ensure_demo_user(db: &crate::db::Db) {
    let email = "resto@slaver.app";
    let row: Option<serde_json::Value> = match db
        .prepare("SELECT id FROM users WHERE email = ?")
        .bind(&[crate::db::v_text(email)])
    {
        Ok(q) => q.first(None).await.unwrap_or(None),
        Err(e) => {
            eprintln!("seed: demo lookup failed: {e}");
            return;
        }
    };
    if row.is_some() {
        return;
    }
    let mut salt_b = [0u8; 16];
    if getrandom::getrandom(&mut salt_b).is_err() {
        eprintln!("seed: demo salt failed");
        return;
    }
    let salt = hex::encode(salt_b);
    let digest = {
        use sha2::Digest;
        let mut h = sha2::Sha256::new();
        h.update(salt.as_bytes());
        h.update(b":");
        h.update(b"demo1234");
        hex::encode(h.finalize())
    };
    let id = new_id();
    let inserted = match db
        .prepare("INSERT INTO users (id, email, name, password_salt, password_hash) VALUES (?, 'resto@slaver.app', 'Saung Ranggon (demo)', ?, ?)")
        .bind(&[crate::db::v_text(&id), crate::db::v_text(&salt), crate::db::v_text(&digest)])
    {
        Ok(q) => q.run().await.map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    if let Err(e) = inserted {
        eprintln!("seed: demo insert failed: {e}");
        return;
    }
    if let Err(e) = crate::store::create_team(db, &id, "Saung Ranggon", false).await {
        eprintln!("seed: demo team failed: {e}");
    }
}

/// Remove every trace of the retired F&B Suite app so that Hermes Agent is the
/// only production listing:
/// - the "F&B Suite" template listing, its listing reviews and its bare git repo;
/// - the demo buyer account's (resto@slaver.app) installed copy: projects plus
///   their installs, customize runs and local runs, licenses, payments and
///   fork repos (DB rows + bare git repos).
/// Forks owned by any other team are deliberately left alone: buyers keep what
/// they bought, they just can no longer buy it anew. Idempotent.
async fn cleanup_fnb_suite(db: &crate::db::Db, git_root: &str) {
    // Sub-selects (inlined into the statements below; no user input involved).
    const TPL: &str = "SELECT id FROM repos WHERE template = 1 AND (name LIKE 'F&B Suite%' OR name LIKE 'fnb-suite%')";
    const DEMO_TEAMS: &str = "SELECT t.id FROM teams t JOIN users u ON u.id = t.owner_user_id WHERE u.email = 'resto@slaver.app'";
    const DEMO_FORKS: &str = "SELECT id FROM repos WHERE fork_of IN (SELECT id FROM repos WHERE template = 1 AND (name LIKE 'F&B Suite%' OR name LIKE 'fnb-suite%')) AND team_id IN (SELECT t.id FROM teams t JOIN users u ON u.id = t.owner_user_id WHERE u.email = 'resto@slaver.app')";
    const DEMO_PROJECTS: &str = "SELECT p.id FROM projects p WHERE p.team_id IN (SELECT t.id FROM teams t JOIN users u ON u.id = t.owner_user_id WHERE u.email = 'resto@slaver.app') AND (p.repo_id IN (SELECT id FROM repos WHERE template = 1 AND (name LIKE 'F&B Suite%' OR name LIKE 'fnb-suite%')) OR p.repo_id IN (SELECT id FROM repos WHERE fork_of IN (SELECT id FROM repos WHERE template = 1 AND (name LIKE 'F&B Suite%' OR name LIKE 'fnb-suite%'))) OR p.name LIKE '%F&B Suite%' OR p.name LIKE '%Saung Ranggon%')";

    async fn exec(db: &crate::db::Db, sql: &str) {
        // Failures are logged, never fatal: boot must not die on cleanup.
        match db.prepare(sql).bind(&[]) {
            Ok(q) => {
                if let Err(e) = q.run().await {
                    eprintln!("seed: fnb cleanup failed ({sql}): {e}");
                }
            }
            Err(e) => eprintln!("seed: fnb cleanup prepare failed: {e}"),
        }
    }
    async fn ids(db: &crate::db::Db, sql: &str) -> Vec<String> {
        match db.prepare(sql).bind(&[]) {
            Ok(q) => match q.all().await {
                Ok(rows) => rows
                    .results::<serde_json::Value>()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|v| {
                        v.get("id")
                            .and_then(|x| x.as_str())
                            .map(|s| s.to_string())
                    })
                    .collect(),
                Err(e) => {
                    eprintln!("seed: fnb cleanup query failed: {e}");
                    vec![]
                }
            },
            Err(e) => {
                eprintln!("seed: fnb cleanup prepare failed: {e}");
                vec![]
            }
        }
    }

    // Collect bare-repo ids before deleting their rows.
    let mut doomed: Vec<String> = ids(db, TPL).await;
    doomed.extend(ids(db, DEMO_FORKS).await);

    // Demo projects and everything hanging off them. (Note: the issues and
    // deployments tables were dropped in migration 0011, so they are not here.)
    for child in [
        "customize_changes WHERE project_id",
        "installs WHERE project_id",
        "local_runs WHERE project_id",
        "payments WHERE project_id",
    ] {
        exec(db, &format!("DELETE FROM {child} IN ({DEMO_PROJECTS})")).await;
    }
    exec(db, &format!("DELETE FROM projects WHERE id IN ({DEMO_PROJECTS})")).await;
    // Demo licenses/payments referencing the template or its forks.
    exec(
        db,
        &format!("DELETE FROM licenses WHERE repo_id IN ({TPL}) AND team_id IN ({DEMO_TEAMS})"),
    )
    .await;
    exec(
        db,
        &format!(
            "DELETE FROM payments WHERE team_id IN ({DEMO_TEAMS}) AND (repo_id IN ({TPL}) OR fork_repo_id IN ({DEMO_FORKS}))"
        ),
    )
    .await;
    // Reviews, then the fork rows and the template rows themselves.
    exec(db, &format!("DELETE FROM listing_reviews WHERE repo_id IN ({TPL})")).await;
    exec(db, &format!("DELETE FROM repos WHERE id IN ({DEMO_FORKS})")).await;
    exec(db, &format!("DELETE FROM repos WHERE id IN ({TPL})")).await;

    let mut removed_dirs = 0;
    for rid in &doomed {
        let path = crate::platform::bare_repo_path(git_root, rid);
        if path.exists() {
            match tokio::fs::remove_dir_all(&path).await {
                Ok(()) => removed_dirs += 1,
                Err(e) => eprintln!("seed: cannot remove bare repo {rid}: {e}"),
            }
        }
    }
    if !doomed.is_empty() {
        eprintln!("seed: retired F&B Suite ({} repo rows, {} bare repos removed)", doomed.len(), removed_dirs);
    }
}
