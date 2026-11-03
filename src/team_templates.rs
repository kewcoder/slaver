//! Built-in team templates for onboarding.
//!
//! A new user picks a business category at sign-up and gets a team
//! pre-staffed with AI agents (name/role/memory preset for that trade).
//! Templates are code-builtin (not DB rows) so profiles stay versioned.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use crate::{
    db::{v_text, Db},
    provider, store,
};

#[derive(Deserialize, Serialize, Clone)]
pub struct TemplateAgent {
    pub name: String,
    pub role: String,
    pub memory: String,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct TeamTemplate {
    pub key: String,
    pub category: String,
    pub name: String,
    pub description: String,
    pub team_name: String,
    pub agents: Vec<TemplateAgent>,
}

pub fn all() -> Vec<TeamTemplate> {
    vec![saung_rangon(), blank()]
}

pub fn get(key: &str) -> Option<TeamTemplate> {
    all().into_iter().find(|t| t.key == key.trim())
}

/// F&B pertama: rumah makan Sunda "Saung Rangon", Kota Tasikmalaya.
fn saung_rangon() -> TeamTemplate {
    TeamTemplate {
        key: "saung-rangon".to_string(),
        category: "F&B".to_string(),
        name: "Rumah Makan Sunda".to_string(),
        description: "Tim AI siap pakai untuk rumah makan Sunda: kasir, booking meja + DP, pantau lantai, dan pelayan pencatat order. Contoh: Saung Rangon, Tasikmalaya."
            .to_string(),
        team_name: "Saung Rangon".to_string(),
        agents: vec![
            TemplateAgent {
                name: "Kasir".to_string(),
                role: "Kamu kasir Saung Rangon, rumah makan Sunda di Kota Tasikmalaya. Layani rekap penjualan harian, hitung total dan kembalian, catat metode bayar (tunai/QRIS/transfer). Jawab singkat, ramah, Bahasa Indonesia santai.".to_string(),
                memory: "Menu andalan: nasi timbel komplit, ayam goreng/bakar kampung, karedok, sayur asem, es teh manis, es jeruk. Jam buka 09.00-21.00 WIB. Booking meja wajib DP Rp 50.000 via HitPay; no-show = DP hangus.".to_string(),
            },
            TemplateAgent {
                name: "Booking".to_string(),
                role: "Kamu admin booking Saung Rangon. Terima reservasi meja (nama, no WA, tanggal, jam, jumlah orang), ingatkan DP Rp 50.000 via link bayar HitPay, tandai status lunas/booked, dan ingatkan H-1 via teks siap kirim.".to_string(),
                memory: "Kapasitas +-12 meja (4 besar, 8 kecil). DP minimal Rp 50.000, pelunasan di tempat. Aturan no-show: DP hangus, tertulis di form booking.".to_string(),
            },
            TemplateAgent {
                name: "Floor".to_string(),
                role: "Kamu pengawas lantai Saung Rangon. Pantau info meja kosong, usulkan promo happy hour saat jam sepi, dan tulis teks promo siap posting ke WhatsApp/story.".to_string(),
                memory: "Jam ramai: 11.30-13.30 dan 18.00-20.00. Jam sepi: 14.00-17.00 (kandidat happy hour). Status meja: Kosong/Terisi/Booked.".to_string(),
            },
            TemplateAgent {
                name: "Pelayan".to_string(),
                role: "Kamu pelayan Saung Rangon. Bantu catat pesanan via chat (contoh: 'tambah 2 es teh meja 5'), cek stok sebelum konfirmasi, tolak dengan sopan bila habis dan tawarkan pengganti.".to_string(),
                memory: "Stok kritis: es batu, ayam kampung, lalapan. Selalu konfirmasi ulang: menu x jumlah x nomor meja.".to_string(),
            },
        ],
    }
}

fn blank() -> TeamTemplate {
    TeamTemplate {
        key: "blank".to_string(),
        category: "Lainnya".to_string(),
        name: "Mulai dari nol".to_string(),
        description: "Tim kosong tanpa agen AI — tambah sendiri nanti dari Settings."
            .to_string(),
        team_name: "Tim Baruku".to_string(),
        agents: vec![],
    }
}

/// Create a team from a template, staffed with preset agents.
/// Returns the team plus the created bots.
pub async fn apply(
    db: &Db,
    user_id: &str,
    key: &str,
    team_name: &str,
) -> Result<(store::TeamRow, Vec<store::BotRow>)> {
    let tpl = get(key).ok_or_else(|| anyhow!("Unknown template."))?;
    let name: String = {
        let n = team_name.trim().chars().take(60).collect::<String>();
        if n.is_empty() {
            tpl.team_name.clone()
        } else {
            n
        }
    };
    let team = store::create_team(db, user_id, &name, false).await?;
    let preset = provider::preset_for_team(db, &team.id).await;
    let model = provider::effective_model(&preset, "");
    let mut bots = Vec::new();
    for a in &tpl.agents {
        let bot = store::create_bot(db, user_id, &team.id, &model, user_id).await?;
        let bname: String = a.name.trim().chars().take(40).collect();
        let bmem: String = a.memory.chars().take(4000).collect();
        db.prepare("UPDATE slavebots SET name = ?, role = ?, memory = ? WHERE id = ?")
            .bind(&[v_text(&bname), v_text(a.role.trim()), v_text(&bmem), v_text(&bot.id)])?
            .run()
            .await?;
        let full = store::get_bot_any(db, &bot.id)
            .await?
            .ok_or_else(|| anyhow!("bot insert failed"))?;
        bots.push(full);
    }
    Ok((team, bots))
}
