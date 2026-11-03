//! Seed marketplace templates on first boot: each seeds/<name>/ dir becomes
//! a public template repo (bare git + initial commit).

use std::path::{Path, PathBuf};

fn new_id() -> String {
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

const SEEDS: &[(&str, &str)] = &[
    ("grocery-pos", "Grocery POS Lite — kasir + inventori warung, siap docker"),
    ("fb-ordering", "F&B Ordering Lite — pesan meja + tiket dapur, siap docker"),
    ("resto-ops", "Resto Ops — kasir + peta meja + booking DP + stok + HitPay, siap docker"),
];

pub async fn seed_templates(db: &crate::db::Db, git_root: &Path, seeds_dir: &str) {
    eprintln!("seed: checking templates (dir={seeds_dir})");
    let existing: i64 = match db
        .prepare("SELECT COUNT(*) AS n FROM repos WHERE template = 1")
        .bind(&[])
    {
        Ok(q) => match q.first::<CountRow>(None).await {
            Ok(Some(r)) => r.n,
            Ok(None) => {
                eprintln!("seed: count returned no rows");
                return;
            }
            Err(e) => {
                eprintln!("seed: count query failed: {e}");
                return;
            }
        },
        Err(e) => {
            eprintln!("seed: prepare failed: {e}");
            return;
        }
    };
    if existing > 0 {
        return;
    }
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
        let src = PathBuf::from(seeds_dir).join(dir_name);
        let src = match std::fs::canonicalize(&src) {
            Ok(p) => p,
            Err(_) => {
                eprintln!("seed: missing dir {}", src.display());
                continue;
            }
        };
        let name = match *dir_name {
            "grocery-pos" => "Grocery POS Lite",
            "fb-ordering" => "F&B Ordering Lite",
            "resto-ops" => "Resto Ops",
            other => other,
        };
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
}

#[derive(serde::Deserialize)]
struct CountRow {
    n: i64,
}
