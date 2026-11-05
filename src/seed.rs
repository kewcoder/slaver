//! Seed marketplace templates on first boot: each apps/<name>/ dir becomes
//! a public template repo (bare git + initial commit).

use std::path::{Path, PathBuf};

fn new_id() -> String {
    crate::util::new_id()
}

const SEEDS: &[(&str, &str)] = &[
    ("fnb-suite", "F&B Suite — all-in-one toko makanan & minuman: menu & stok, kasir, meja + kamera AI, booking, pelanggan, promo, iklan AI, toko online, MCP; install 1 perintah"),
];

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
            "fnb-suite" => "F&B Suite",
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
    ensure_demo(db, &git_root.to_string_lossy()).await;
    ensure_demo_reviews(db, &git_root.to_string_lossy()).await;
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
            "F&B Suite",
            "system@slaver.app",
            AiReview {
                score: Some(8.4),
                summary: "A complete, installable F&B app: admin, online store and AI agents all go through one MCP endpoint with role checks, and the README gets a new owner running in minutes.".into(),
                strengths: s(&[
                    "README.md has a working local install and a real sample menu (Saung Ranggon) via `bun run seed`.",
                    "Every action goes through MCP (src/mcp.ts) with role checks from src/accounts.ts, so admin, store and agents share one permission model.",
                    "src/server.ts refuses to start without an ADMIN_TOKEN of at least 32 characters.",
                    "Tests cover orders, promos, MCP tools, routes and scripts (test/).",
                ]),
                must_fix: vec![],
                suggestions: s(&[
                    "admin/src/pages.tsx is 800+ lines; splitting it per screen makes owner customizations smaller and safer.",
                    "src/domain.ts holds most business rules; separate modules for orders, bookings and promos would help buyers find what to change.",
                    "Document backing up and restoring the SQLite file (DB_PATH) in README.md.",
                ]),
            },
        ),
        (
            "Hermes Agent",
            LABS_EMAIL,
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
    for (name, owner_email, ai) in demos {
        // Only Slaver's own listings (owned by these accounts' teams), never a seller's look-alike.
        let rows: Vec<serde_json::Value> = match db
            .prepare("SELECT r.id FROM repos r JOIN teams t ON t.id = r.team_id JOIN users u ON u.id = t.owner_user_id WHERE r.name = ? AND u.email = ? AND r.fork_of = ''")
            .bind(&[crate::db::v_text(name), crate::db::v_text(owner_email)])
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

/// Demo F&B account (used by the login-page demo button): resto@slaver.app
/// owns a "Saung Ranggon" team that already owns the F&B Suite app. Idempotent —
/// skipped when the user already exists.
async fn ensure_demo(db: &crate::db::Db, git_root: &str) {
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
    if let Some(uid) = row.as_ref().and_then(|r| r.get("id")).and_then(|v| v.as_str()) {
        repair_demo(db, git_root, uid).await;
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
    let team = match crate::store::create_team(db, &id, "Saung Ranggon", false).await {
        Ok(t) => t,
        Err(e) => {
            eprintln!("seed: demo team failed: {e}");
            return;
        }
    };
    give_demo_app(db, git_root, &team.id, &id).await;
}

/// Older demo accounts (from the AI-agent era) had a "Saung Rangon" team with
/// bots and no apps: fix the name and give it the F&B Suite app once.
async fn repair_demo(db: &crate::db::Db, git_root: &str, user_id: &str) {
    if let Ok(q) = db.prepare("UPDATE teams SET name = 'Saung Ranggon' WHERE owner_user_id = ? AND name = 'Saung Rangon'").bind(&[crate::db::v_text(user_id)]) {
        let _ = q.run().await;
    }
    if let Ok(q) = db.prepare("UPDATE users SET name = 'Saung Ranggon (demo)' WHERE id = ? AND name = 'Saung Rangon (demo)'").bind(&[crate::db::v_text(user_id)]) {
        let _ = q.run().await;
    }
    let team: Option<serde_json::Value> = match db
        .prepare("SELECT t.id FROM teams t WHERE t.owner_user_id = ? AND t.personal = 0 AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.team_id = t.id) ORDER BY t.created_at LIMIT 1")
        .bind(&[crate::db::v_text(user_id)])
    {
        Ok(q) => q.first(None).await.unwrap_or(None),
        Err(_) => None,
    };
    if let Some(tid) = team.and_then(|v| v.get("id").and_then(|x| x.as_str()).map(String::from)) {
        give_demo_app(db, git_root, &tid, user_id).await;
    }
}

async fn give_demo_app(db: &crate::db::Db, git_root: &str, team_id: &str, user_id: &str) {
    let tpl: Option<serde_json::Value> = match db.prepare("SELECT id FROM repos WHERE template = 1 AND name LIKE 'F&B Suite%' ORDER BY created_at LIMIT 1").bind(&[]) {
        Ok(q) => q.first(None).await.unwrap_or(None),
        Err(_) => None,
    };
    if let Some(tid) = tpl.and_then(|v| v.get("id").and_then(|x| x.as_str()).map(String::from)) {
        match crate::platform::buy_bundle(db, git_root, team_id, user_id, &tid, "mock", 0).await {
            Ok(_) => eprintln!("seed: demo team owns F&B Suite"),
            Err(e) => eprintln!("seed: demo license failed: {e}"),
        }
    }
}
