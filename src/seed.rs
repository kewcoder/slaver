//! Seed marketplace templates on first boot: each seeds/<name>/ dir becomes
//! a public template repo (bare git + initial commit).

use std::path::{Path, PathBuf};

fn new_id() -> String {
    crate::util::new_id()
}

const SEEDS: &[(&str, &str)] = &[
    ("grocery-pos", "Grocery POS Lite — kasir + inventori warung, siap docker"),
    ("fb-ordering", "F&B Ordering Lite — pesan meja + tiket dapur, siap docker"),
    ("resto-ops", "Resto Ops — kasir + peta meja + booking DP + stok + HitPay, siap docker"),
    ("mail-app", "Mail App — email usaha sendiri: inbox, balas, tulis baru, siap docker"),
];

pub async fn seed_templates(db: &crate::db::Db, git_root: &Path, seeds_dir: &str) {
    eprintln!("seed: checking templates (dir={seeds_dir})");
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
            "mail-app" => "Mail App",
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
    ensure_demo(db).await;
    ensure_skills(db).await;
}

/// Built-in skill templates (public, owned by the system-templates team).
/// Installed onto a bot with one click: role becomes the bot role, memory
/// is appended to the bot memory.
async fn ensure_skills(db: &crate::db::Db) {
    const SKILLS: &[(&str, &str, &str, &str, &str)] = &[
        ("Kasir Cepat", "Kasir", "Hitung belanja, total, dan kembalian dengan cepat dan teliti.",
            "Kamu kasir yang cepat dan teliti. Ulangi rincian belanja sebelum menyebut total. Tanya: tunai, QRIS, atau transfer.",
            "Kembalian dihitung per lembar bila tunai. QRIS di atas Rp 5 juta wajib konfirmasi ulang. Selalu ucapkan terima kasih dan ajak kembali."),
        ("Pelayan Sigap", "Pelayan", "Catat pesanan via chat, cek stok, konfirmasi ulang.",
            "Kamu pelayan yang sigap. Catat: menu x jumlah x nomor meja. Cek stok dulu; bila habis, tawarkan pengganti terdekat.",
            "Selalu konfirmasi ulang pesanan. Ingatkan bila ada menu yang lama disiapkan (±15 menit)."),
        ("Admin Booking", "Booking", "Terima reservasi meja + DP, ingatkan H-1.",
            "Kamu admin booking. Minta: nama, no WA, tanggal, jam, jumlah orang. Ingatkan DP Rp 50.000; tanpa DP meja tidak dipegang.",
            "Kapasitas umum: catat 12 meja. No-show = DP hangus. Kirim pengingat H-1 jam 10 pagi."),
        ("CS Online Shop", "Layanan Pelanggan", "Balas chat pembeli dengan ramah, tanya kebutuhan, tawarkan produk.",
            "Kamu CS online shop yang ramah. Sapa, tanyakan kebutuhan, jawab singkat. Maksimal 2 pertanyaan lanjutan per pesan.",
            "Jam balas: 08.00-21.00. Di luar jam itu, catat pesan dan janji dibalas pagi hari."),
        ("Tukang Stok Opname", "Stok", "Catat barang masuk/keluar, ingatkan stok menipis.",
            "Kamu pencatat stok. Catat tiap barang masuk/keluar: nama, jumlah, tanggal. Laporkan yang di bawah minimum tiap sore.",
            "Batas minimum umum: bahan cepat habis = stok 2 hari. Selisih opname dicatat, bukan dihapus."),
    ];
    for (name, category, desc, role, memory) in SKILLS {
        let row: Option<serde_json::Value> = match db
            .prepare("SELECT id FROM skills WHERE name = ? AND template = 1")
            .bind(&[crate::db::v_text(name)])
        {
            Ok(q) => q.first(None).await.unwrap_or(None),
            Err(_) => None,
        };
        if row.is_some() {
            continue;
        }
        let id = new_id();
        if let Err(e) = async {
            db.prepare("INSERT INTO skills (id, team_id, name, category, description, role, memory, template) VALUES (?, 'system-templates', ?, ?, ?, ?, ?, 1)")
                .bind(&[crate::db::v_text(&id), crate::db::v_text(name), crate::db::v_text(category), crate::db::v_text(desc), crate::db::v_text(role), crate::db::v_text(memory)])
                .map_err(|e| e.to_string())?
                .run()
                .await
                .map_err(|e| e.to_string())
        }
        .await
        {
            eprintln!("seed: skill '{name}' failed: {e}");
            continue;
        }
        eprintln!("seed: skill '{name}' ready");
    }
}

/// Demo F&B account (used by the login-page demo button): resto@slaver.app
/// owns a "Saung Rangon" team staffed from the F&B template. Idempotent —
/// skipped when the user already exists (e.g. after a template was applied).
async fn ensure_demo(db: &crate::db::Db) {
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
    let q = match db
        .prepare("INSERT INTO users (id, email, name, password_salt, password_hash) VALUES (?, 'resto@slaver.app', 'Saung Rangon (demo)', ?, ?)")
        .bind(&[crate::db::v_text(&id), crate::db::v_text(&salt), crate::db::v_text(&digest)])
    {
        Ok(q) => q,
        Err(e) => {
            eprintln!("seed: demo insert prepare failed: {e}");
            return;
        }
    };
    if let Err(e) = q.run().await {
        eprintln!("seed: demo insert failed: {e}");
        return;
    }
    match crate::team_templates::apply(db, &id, "saung-rangon", "Saung Rangon").await {
        Ok((team, bots)) => eprintln!("seed: demo team '{}' ready ({} bots)", team.name, bots.len()),
        Err(e) => eprintln!("seed: demo team failed: {e:#}"),
    }
}

