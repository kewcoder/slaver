# SLAVER — FEATURE.md (UI flows, screen-by-screen)

> Tujuan dokumen ini: **desain UI dulu, baru kode**. Setiap fitur di bawah
> didefinisikan sebagai alur layar (screen flow): titik masuk → aksi →
> hasil → empty/error state. Prinsip: **sidebar hanya navigasi**,
> semua pengaturan di **Settings**, bahasa sederhana non-teknis.
>
> Visi (dari IDEAS.md): *Don't just connect software. Own it.* —
> beli sekali di Marketplace → customize via AI → jalan di VPS sendiri,
> dengan opsi sewa developer/agency bila butuh bantuan manusia.

---

## 0. Prinsip desain (mengikat semua layar)

1. Sidebar = navigasi saja (search, DM, Channels, Huddles, Support). Tidak ada form, tidak ada footer berisik.
2. Semua konfigurasi di **Settings** (Profile, New bot, Teams, Usage, Developer).
3. Bahasa manusia, bukan jargon: "Direct messages" bukan "bot_access matrix", "Beli" bukan "provision license".
4. Setiap layar punya 3 kondisi: **isi**, **kosong** (dengan CTA jelas), **error** (kalimat + tombol coba lagi).
5. Satu aksi utama per layar (tombol hijau). Aksi sekunder berupa teks/link.
6. Tidak ada aksi destruktif tanpa konfirmasi (`window.confirm` minimal).

---

## 1. Global shell

### 1.1 Top bar (selalu terlihat)
- Kiri: hamburger (mobile saja) + logo **Slaver**.
- Tengah (scroll horizontal di mobile): **Home ⌂ · Harness ⌁ · Projects ▤ · Code </> · Market ◈ · Settings ⚙**.
- Kanan: sisa kredit (`$X left`, emerald) + avatar huruf depan (tooltip = email).
- Aturan aktif: Home aktif untuk chat/group/huddle/bot-settings; tiap menu lain aktif di view-nya.

### 1.2 Sidebar (navigasi saja)
- Header: nama team aktif + role user di team itu (`owner/admin/staff`).
- Dropdown ganti team (select). Ganti team → reset chat/group/huddle/bot yang terbuka.
- Search box "Find a conversation..." (filter DM by nama/role/title, client-side).
- Section **Direct messages** (+ di kanan judul → ke Settings#new-bot).
  - Baris bot: avatar + presence dot hijau + nama + subteks (role/title, partner `◈ nama` bila bukan milik sendiri) + badge PIN bila pinned.
  - Sub-bot (punya parent): indent + garis kiri.
  - "Archived (N)" collapsible di bawah.
- Section **Channels** (+ New → langsung buat, lalu buka).
  - Baris: `## nama`. Hanya channel milik team aktif.
- Section **Huddles** (+ New → form topik di main view).
  - Baris: `◉ topik (40 char…)`.
- Section **Support channels** (tanpa tombol +).
  - Baris: `✚ nama` + nama team pemilik (abu-abu). Ini channel **publik lintas team**.
- TIDAK ADA di sidebar: link Teams/Usage, sisa kredit, email, note provider, tombol logout, form inline apapun. Semua itu di Settings.

### 1.3 Main header (kontekstual per view)
- Menampilkan judul konteks: nama bot / `#channel` / `◉ huddle` / `← nama (settings)` / nama view ("Projects", "Harness", dst).
- Kanan: toggle **Voice on/off** (hanya relevan di chat; tidak apa-apa selalu tampil).
- Mobile: hamburger sudah pindah ke top bar, jadi header main bersih.

---

## 2. Auth

### 2.1 Register / Login (satu layar, dua tab)
- Tab **Sign up** (default): Name, Email, Password (min 8). → sukses: masuk Home + bot sambutan.
- Tab **Log in**: Email, Password.
- Error: pesan merah di atas tombol ("Email already registered…", "Wrong email or password.").
- Token JWT disimpan di `localStorage`; semua request bawa `Authorization: Bearer`.

### 2.2 Logout
- Hanya ada di **Settings → Profile → Log out**. Membersihkan token + state lokal.

---

## 3. Home / Chat

### 3.1 DM dengan slaveBot (jalur utama)
- Empty state (belum pilih bot): salam personal + tombol "+ New slaveBot" (→ Settings).
- Empty state (bot baru): "{nama} is ready." + hint set memory.
- Pesan: avatar + nama + timestamp + tombol **Speak** (bot) / **Save to memory**? (tidak ada di DM; memory via Bot settings).
- Bot mengetik: indikator tiga titik.
- Slash commands: `/remind`, `/schedules`, `/unschedule`, `/archive`, `/spawn`, `/help`.

### 3.2 Composer (gaya ChatGPT, pill)
- Kiri: tombol **+** → menu: New slaveBot (→ Settings), New channel (langsung), New huddle (langsung).
- Tengah: textarea autosize, Enter=kirim, Shift+Enter=baris baru. Placeholder: "Message {bot}…".
- Kanan: ikon mic (dikte push-to-talk; saat merekam jadi timer merah) + tombol bundar:
  - kosong → biru 🔊 = hands-free converse (dengan meter level),
  - ada teks / streaming → putih dengan panah ↑ (kirim; disabled saat streaming).
- Error chat: teks merah di atas composer.

### 3.3 Group channel (termasuk public support)
- Header internal: nama (klik = rename inline), badge **PUBLIC SUPPORT** (hijau, bila publik), tombol Rename / **Make public|private** / Delete.
- Daftar member = avatar bot + tombol × hapus; "+ Add members" (modal multi-select + search) bila ada bot luar.
- Checkbox `+memory`: tiap pesan juga disimpan ke memory semua member.
- **Support channel**: user dari team manapun bisa baca + posting; semua bot member membalas (dibiayai key team pemilik). Pesan customer tidak pernah hilang walau provider error.
- Pesan bot bisa "Save to memory".

### 3.4 Huddle
- Tanpa ID: form "Start a huddle" (topik + checklist bot yang di-notify; tiap bot memutuskan join/decline dari role-nya).
- Aktif: daftar join (hijau) vs decline (coret + tooltip alasan) → thread diskusi → composer.
- Tombol Delete huddle (owner tim terkait).

### 3.5 Bot settings (← nama bot)
- Header: avatar besar + nama (klik = rename inline) + title + "Partner: X".
- Form Identity: Name, Role, Avatar upload, Model (bebas isi; warning kuning bila kosong + contoh ID sesuai provider), Voice, relay toggle, active days/window, Memory.
- Tombol: Save / Pin-Unpin / Archive-Restore.
- Kartu Schedules, Team (sub-bot: parent + children + spawn), Conversation recaps + Summarize now.

---

## 4. Harness (⌁ — agent coding runs)

- Form: model (default `glm-5.3-flash`, tersimpan), textarea prompt, tombol "Run in sandbox" / "Stop".
- Banner konteks bila datang dari Projects: issue + repo tertaut (dengan tombol unlink).
- Transcript terminal: prompt → step dividers → teks agent → `$ tool + args` (hijau) → hasil (collapsible) → "✓ Done · N steps" / error merah.
- Past runs: daftar 20 terakhir (status dot) → klik = muat transcript tersimpan.
- Batasan v1 (jujur di UI): model harus support function calling via chat/completions (daftar contoh di placeholder); model responses-only (keluarga Spark) tidak bisa dipakai harness.

---

## 5. Projects (▤ — kanban ala Linear)

- Bar + selector project + "New project" inline + progress (`done/total`, bar %, persen).
- Info repo tertaut (select ganti) + deskripsi.
- Board 5 kolom: Backlog, Todo, In Progress, In Review, Done (drag-drop antar kolom + jumlah per kolom).
- Kartu: judul + badge priority + assignee (`◈ nama` / unassigned). Klik = panel detail.
- Form "New issue": title + body (acceptance criteria) + assignee select.
- Panel detail: body, assignee select, tombol pindah kolom, tombol hijau **"▶ Start agent run"** (prefill prompt + repo + issue → pindah ke Harness).
- Aturan status otomatis: run dimulai → In Progress; run selesai → In Review; approve manual → Done.

---

## 6. Code (</> — git service)

- Kiri: daftar repo team + form nama + deskripsi + Create.
- Kanan: nama repo, badge template, tombol Fork / Publish-Unpublish (owner/admin), clone URL (`https://<token>@host/git/<id>` + catatan token = JWT login; push butuh owner/admin).
- Branches (chips), Commits (sha + subject + author + tanggal; klik = diff), diff viewer (max 30k char, monospace).
- Empty: "Select a repo…" / repo kosong ("clone and push to see history").

---

## 7. Marketplace (◈)

- Header + tagline buy-once. **Template cards**: nama, deskripsi, badge OWNED / BUY ONCE, tombol **💬 Support** (buka support channel template; dibuatkan otomatis saat butuh oleh owner), tombol **Buy & fork** (mock checkout → lisensi + fork + project) atau **Open project** bila sudah punya.
- Catatan kecil: "Includes 12 months updates + support".
- **My licenses**: list lisensi (repo short-id, kind, status, support-until, provider).
- Flow beli (v1 mock): klik → license perpetual + support 12 bulan + fork repo + project "X (custom)" → lompat ke Projects.

---

## 8. Settings (⚙ — semua konfigurasi)

Satu layar scroll, kartu per seksi:

1. **Profile**: avatar huruf, nama, email, sisa kredit, tombol Log out.
2. **New slaveBot**: select Partner (owner) + Create (muncul di DM).
3. **Teams** (reuse penuh): daftar team + role, buat team, hapus team, detail team terpilih:
   - AI provider (preset Meta/Baseten/Modal/OpenRouter/OpenCode/Ollama/Custom + base URL + key + endpoint preview + **Save + test connection** dengan hasil + daftar model server),
   - Members + invite + role + hapus,
   - SlaveBots + transfer partner + grant/revoke per staff,
   - Recent activity (owner/admin).
4. **Usage & logs**: sisa kredit, terpakai, tabel log (waktu, bot, model, token in/out, cost).
5. **Developer** (direncanakan §10): OAuth clients (buat/hapus, copy ID/secret, redirect URI).

---

## 9. Team-level OAuth — "Login with Slaver" (untuk app yang di-deploy)

**Masalah yang diselesaikan (dari IDEAS.md):** aplikasi yang dibeli/di-deploy user berjalan di VPS user sendiri, tapi user-nya harus bisa login **sebagai user di team Slaver itu, lengkap dengan role-nya** — tanpa bikin akun baru di tiap app.

### 9.1 Alur untuk pemilik app (sekali, di Settings → Developer)
1. "New OAuth client" → nama app + redirect URI(s) → dapat **Client ID + Client Secret** (secret tampil sekali, simpan).
2. Daftar client + tombol revoke. Redirect URI harus match persis (tanpa wildcard).

### 9.2 Alur untuk end user (tiap login di app yang di-deploy)
1. User klik "Login with Slaver" di app → redirect ke `https://slaver.fly.dev/oauth/authorize?client_id=…&redirect_uri=…&scope=openid+profile+email+team&state=…`.
2. Bila belum login Slaver → layar login dulu → kembali ke consent.
3. Layar consent: "App X meminta: nama, email, team + role kamu di team Y" → [Allow] / [Deny].
4. Redirect balik ke app dengan `?code=…&state=…` (code sekali pakai, 10 menit).
5. App tukar code di `POST /oauth/token` (auth = client_id:secret) → `access_token` (+ `refresh_token` opsional v2).
6. App panggil `GET /oauth/userinfo` (Bearer token) → `{ sub, email, name, team_id, team_name, role }` → app membuat sesi lokal dengan role tersebut.

### 9.3 Kontrak keamanan (v1)
- Scope: `openid profile email team:<id|active>` — role selalu team aktif user saat consent.
- Code: acak 256-bit, sekali pakai, kedaluwarsa 10 menit, terikat client + redirect_uri.
- Token: opaque 256-bit, kedaluwarsa 30 hari, bisa revoke (hapus = logout paksa).
- Hanya owner/admin team yang boleh buat/revoke client (staff tidak).
- Rate-limit endpoint token; log setiap penerbitan (audit).
- v2 (nanti): PKCE untuk public client, refresh-token rotation, "Login with Slaver" button snippet siap tempel.

### 9.4 Integrasi di template marketplace
- Setiap template wajib sediakan tombol "Login with Slaver" + file `OAUTH.md` (client registration steps). QA agent memverifikasi alur login saat review template.

---

## 10. Services directory (rencana — dari IDEAS.md §Services)

- Katalog developer/agency terverifikasi: profil, skill, rate, rating, portofolio fork.
- Hire flow: dari issue → "Hire help" → brief otomatis dari issue → penawaran → escrow via platform fee → hasil di-review QA agent + owner.
- Status: **belum dibangun** (setelah marketplace penuh + OAuth stabil).

---

## 11. Matriks peran (ringkas, berlaku di semua layar)

| Aksi | owner | admin | staff | non-member |
|---|---|---|---|---|
| Chat DM / channel team sendiri | ✅ | ✅ | ✅ granted | ❌ |
| Baca + posting support channel publik | ✅ | ✅ | ✅ | ✅ |
| Bot membalas di support channel | ✅ (member) | ✅ (member) | ✅ (member) | — (bot team pemilik) |
| Buat repo / project / issue | ✅ | ✅ | ✅ | ❌ |
| Publish template / hapus team / deploy VPS / set provider / invite | ✅ | ✅* | ❌ | ❌ |
| Invite role admin | ✅ | ❌ | ❌ | ❌ |
| Buat/revoke OAuth client | ✅ | ✅ | ❌ | ❌ |
| Buat support channel template | ✅ | ✅ | ❌ | ❌ |

\* admin tidak bisa: hapus personal team, invite admin, ganti role owner.

---

## 12. Inventaris layar (checklist buat UI designer)

Topbar (7): Home, Harness, Projects, Code, Market, Settings (+ Voice toggle di header main).
Sidebar (4 section + search): DMs, Channels, Huddles, Support.
Auth (1 layar, 2 tab) + Settings (5 kartu: Profile, New slaveBot, Teams, Usage, Developer).
Home: DM empty ×2, thread, composer pill, GroupView (+public badge), HuddleView (+form), BotView (6 kartu).
Harness: form + transcript + history + prefill banner.
Projects: board 5 kolom, kartu, form issue, panel detail.
Code: list + detail (branches/log/diff/clone info).
Marketplace: katalog + licenses + support button.
OAuth: consent screen + login-then-consent (2 layar).
Dialog/confirm: delete group/huddle/team/schedule, remove key, archive bot.
States wajib per layar: loading skeleton, empty + CTA, error + retry.

---

*Dokumen hidup. Update tiap fase (lihat PRD.md untuk strategi pembangunan).*
