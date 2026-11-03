# SLAVER — FEATURE.md (UI flows, screen-by-screen)

> Tujuan dokumen ini: **desain UI dulu, baru kode**. Setiap fitur di bawah
> didefinisikan sebagai alur layar (screen flow): titik masuk → aksi →
> hasil → empty/error state. Prinsip: **sidebar hanya navigasi**,
> semua pengaturan di **Settings**, bahasa sederhana non-teknis.
>
> Visi (dari IDEAS.md): *Don't just connect software. Own it.* —
> beli sekali di Marketplace → customize via AI → jalan di infrastruktur sendiri.
>
> Model bisnis: **tanpa kredit/subscription AI**. Tiap team membawa API key
> sendiri (BYOK). Tidak ada saldo, tidak ada potongan, tidak ada halaman Usage.

---

## 0. Prinsip desain (mengikat semua layar)

1. Sidebar = navigasi saja (search, DM, Channels, Meetings, Support). Tidak ada form, tidak ada footer berisik.
2. Semua konfigurasi di **Settings** (Profile, New bot, Teams, Fly.io, Developer).
3. Bahasa manusia, bukan jargon: "Direct messages" bukan "bot_access matrix", "Beli" bukan "provision license".
4. Setiap layar punya 3 kondisi: **isi**, **kosong** (dengan CTA jelas), **error** (kalimat + tombol coba lagi).
5. Satu aksi utama per layar (tombol hijau). Aksi sekunder berupa teks/link.
6. Tidak ada aksi destruktif tanpa konfirmasi (`window.confirm` minimal).
7. Demo-first: reviewer bisa login dalam 1 klik tanpa registrasi.

---

## 1. Global shell

### 1.1 Top bar (selalu terlihat)
- Kiri: hamburger (mobile saja) + logo **Slaver**.
- Tengah (scroll horizontal di mobile): **Apps ⌂ · Chat 💬 · Harness ⌁ · Projects ▤ · Code </> · Market ◈ · Settings ⚙**.
- Kanan: avatar huruf depan (tooltip = email). Tidak ada badge kredit.
- Aturan aktif: Chat aktif untuk DM/channel/meeting/bot-settings; tiap menu lain aktif di view-nya.

### 1.2 Sidebar (navigasi saja — media komunikasi)
- Header: nama team aktif + role user di team itu (`owner/admin/staff`).
- Dropdown ganti team (select). Ganti team → reset chat/channel/meeting/bot yang terbuka.
- Search box "Find a conversation..." (filter DM by nama/role/title, client-side).
- Section **Direct messages** (+ di kanan judul → ke Settings#new-bot).
  - Baris bot: avatar + presence dot hijau + nama + subteks (role/title, partner `◈ nama` bila bukan milik sendiri) + badge PIN bila pinned.
  - Baris user: avatar huruf + nama (DM user-to-user, 1 team).
  - Sub-bot (punya parent): indent + garis kiri.
  - "Archived (N)" collapsible di bawah.
- Section **Channels** (+ New → langsung buat, lalu buka).
  - Baris: `## nama`. Hanya channel milik team aktif. Member campuran user + AI agent.
- Section **Meetings** (+ New → form topik di main view).
  - Baris: `◉ topik (40 char…)`.
- Section **Support channels** (tanpa tombol +).
  - Baris: `✚ nama` + nama team pemilik (abu-abu). Ini channel **publik lintas team**.
- TIDAK ADA di sidebar: link Teams, email, note provider, tombol logout, form inline apapun. Semua itu di Settings.

### 1.3 Main header (kontekstual per view)
- Menampilkan judul konteks: nama app / nama bot / `#channel` / `◉ meeting` / nama view.
- Kanan: toggle **Voice on/off** (hanya relevan di chat; tidak apa-apa selalu tampil).
- Mobile: hamburger sudah pindah ke top bar, jadi header main bersih.

---

## 2. Auth + Onboarding

### 2.1 Login (default, demo prefill)
- Satu layar, dua tab. Tab **Log in** default dengan email + password **sudah terisi akun demo** (`resto@slaver.app / demo1234`) → reviewer klik Log in langsung masuk.
- Tombol "Try the restaurant demo →" mengisi ulang kredensial demo kapan saja.
- Error: pesan merah di atas tombol ("Wrong email or password.").
- Token JWT disimpan di `localStorage`; semua request bawa `Authorization: Bearer`.

### 2.2 Register → Onboarding template
- Tab **Sign up**: Name, Email, Password (min 8). → sukses: **tidak langsung masuk**, tapi ke layar onboarding.
- **Onboarding**: "Mau mulai usaha apa?" — input nama team/usaha + kartu template:
  - Tiap kartu: kategori, nama, deskripsi, daftar agen (chip nama), tombol "Pakai: {team_name}".
  - Pilih → `templates_apply` (buat team + agen berprofil) → masuk Apps.
  - Link "Lewati — masuk tanpa template".
- Template pertama: **Rumah Makan Sunda** (`saung-rangon`) — team "Saung Rangon" + 4 agen (Kasir, Booking, Floor, Pelayan) dengan role + memory khas resto Sunda Tasikmalaya. Template `blank` = team kosong.
- Tambah template baru = tambah fungsi di `team_templates.rs` (versioned di kode, bukan DB).

### 2.3 Logout
- Hanya ada di **Settings → Profile → Log out**. Membersihkan token + state lokal.

---

## 3. Apps ⌂ (Home — layar pertama)

Daftar aplikasi milik team aktif. Satu project = satu aplikasi.

- **Grid kartu**: nama, deskripsi, badge `LIVE` (hijau, bila prod_url terisi) / `NO URL` / `DEV`, progress `done/total` issue.
- Klik kartu → **panel preview**: toggle **PROD/DEV**, iframe aplikasi (`sandbox="allow-scripts allow-same-origin allow-forms allow-popups"`), tombol **Open full ↗** (tab baru), tombol **Project ▤** (lompat ke Projects), tombol **Set URL** (form prod_url + dev_url, tersimpan via `projects_set_urls`).
- URL kosong → empty state di panel: "Belum ada URL — klik Set URL", dengan hint sumber URL (deploy VPS via Code/Deploy, atau Fly machine via Settings → Fly.io).
- **Empty state** (belum ada project): ilustrasi + "Belum ada aplikasi" → tombol hijau **Lihat Marketplace** + sekunder **Buat project**.
- Tanpa team → "Pick a team to see its apps."

---

## 4. Chat 💬 (media komunikasi)

Sidebar memilih target; main view menampilkan thread. Sub-view: DM, channel, meeting, bot settings.

### 4.1 DM dengan slaveBot (jalur utama)
- Empty state (belum pilih bot): salam personal + tombol "+ New slaveBot" (→ Settings).
- Empty state (bot baru): "{nama} is ready." + hint set memory.
- Pesan: avatar + nama + timestamp. Bot mengetik: indikator tiga titik.
- Slash commands: `/remind`, `/schedules`, `/unschedule`, `/archive`, `/spawn`, `/help` (jalan server-side tanpa model call).
- DM user-to-user: thread 1-on-1 dalam 1 team (via `dm_history` / `dm_send`).

### 4.2 Composer (gaya ChatGPT, pill)
- Kiri: tombol **+** → menu: New slaveBot (→ Settings), New channel (langsung), New meeting (langsung).
- Tengah: textarea autosize, Enter=kirim, Shift+Enter=baris baru. Placeholder: "Message {bot}…".
- Kanan: ikon mic (dikte push-to-talk; saat merekam jadi timer merah) + tombol bundar:
  - kosong → biru 🔊 = hands-free converse (dengan meter level),
  - ada teks / streaming → putih dengan panah ↑ (kirim; disabled saat streaming).
- Error chat: teks merah di atas composer. Tanpa key di team → error jelas "tambah key di Teams settings" (tidak ada lagi error kredit).

### 4.3 Group channel (termasuk public support)
- Header internal: nama (klik = rename inline), badge **PUBLIC SUPPORT** (hijau, bila publik), tombol Rename / **Make public|private** / Delete.
- Daftar member = avatar (bot × hapus; user) + "+ Add members" (bot) / tambah user ke channel campuran.
- Checkbox `+memory`: tiap pesan juga disimpan ke memory semua member.
- **Support channel**: user dari team manapun bisa baca + posting; semua bot member membalas (dibiayai key team pemilik). Pesan customer tidak pernah hilang walau provider error.
- Pesan bot bisa "Save to memory".

### 4.4 Meeting
- Tanpa ID: form "Start a meeting" (topik + checklist bot yang di-notify; tiap bot memutuskan join/decline dari role-nya).
- Aktif: daftar join (hijau) vs decline (coret + tooltip alasan) → thread diskusi → composer.
- Tombol Delete meeting (owner tim terkait).

### 4.5 Bot settings (← nama bot)
- Header: avatar besar + nama (klik = rename inline) + title + "Partner: X".
- Form Identity: Name, Role, Avatar upload, Model (bebas isi; warning kuning bila kosong + contoh ID sesuai provider), Voice, relay toggle, active days/window, Memory.
- Tombol: Save / Pin-Unpin / Archive-Restore.
- Kartu Schedules, Team (sub-bot: parent + children + spawn), Conversation recaps + Summarize now.

---

## 5. Harness (⌁ — agent coding runs)

- Form: model (default `glm-5.3-flash`, tersimpan), textarea prompt, tombol "Run in sandbox" / "Stop".
- Banner konteks bila datang dari Projects: issue + repo tertaut (dengan tombol unlink).
- Transcript terminal: prompt → step dividers → teks agent → `$ tool + args` (hijau) → hasil (collapsible) → "✓ Done · N steps" / error merah.
- Past runs: daftar 20 terakhir (status dot) → klik = muat transcript tersimpan.
- Batasan v1 (jujur di UI): model harus support function calling via chat/completions (daftar contoh di placeholder); model responses-only (keluarga Spark) tidak bisa dipakai harness.

---

## 6. Projects (▤ — kanban ala Linear)

- Bar + selector project + "New project" inline + progress (`done/total`, bar %, persen).
- Info repo tertaut (select ganti) + deskripsi.
- Board 5 kolom: Backlog, Todo, In Progress, In Review, Done (drag-drop antar kolom + jumlah per kolom).
- Kartu: judul + badge priority + assignee (`◈ nama` / unassigned). Klik = panel detail.
- Form "New issue": title + body (acceptance criteria) + assignee select.
- Panel detail: body, assignee select, tombol pindah kolom, tombol hijau **"▶ Start agent run"** (prefill prompt + repo + issue → pindah ke Harness).
- Aturan status otomatis: run dimulai → In Progress; run selesai → In Review; approve manual → Done.
- URL deploy project (prod/dev) diedit dari **Apps → Set URL** (satu sumber kebenaran).

---

## 7. Code (</> — git service)

- Kiri: daftar repo team + form nama + deskripsi + Create.
- Kanan: nama repo, badge template, tombol Fork / Publish-Unpublish (owner/admin), clone URL (`https://<token>@host/git/<id>` + catatan token = JWT login; push butuh owner/admin).
- Branches (chips), Commits (sha + subject + author + tanggal; klik = diff), diff viewer (max 30k char, monospace).
- Deploy ke VPS: pilih target + Start deploy → log streaming via `deployments_list`.
- Empty: "Select a repo…" / repo kosong ("clone and push to see history").

---

## 8. Marketplace (◈)

- Header + tagline buy-once. **Template cards**: nama, deskripsi, badge OWNED / BUY ONCE, tombol **💬 Support** (buka support channel template; dibuatkan otomatis saat butuh oleh owner), tombol **Buy & fork** atau **Open project** bila sudah punya.
- Catatan kecil: "Includes 12 months updates + support".
- **My licenses**: list lisensi (repo short-id, kind, status, support-until, provider).
- Flow beli: klik → checkout HitPay (atau mock instan bila tanpa API key) → bayar di tab HitPay → webhook + polling verifikasi status server-side → license perpetual + support 12 bulan + fork repo + project "X (custom)" → lompat ke Projects. Kembali dari HitPay (`?payment=`): aktivasi otomatis bila sudah lunas. Webhook tanpa HMAC valid / payment gagal tidak pernah membuat lisensi.

---

## 9. Settings (⚙ — semua konfigurasi)

Satu layar scroll, kartu per seksi:

1. **Profile**: avatar huruf, nama, email (tanpa sisa kredit), tombol Log out.
2. **New slaveBot**: select Partner (owner) + Create (muncul di DM).
3. **Teams** (reuse penuh): daftar team + role, buat team, hapus team, detail team terpilih:
   - AI provider (preset Meta/Baseten/Modal/OpenRouter/OpenCode/Ollama/Custom + base URL + key + endpoint preview + **Save + test connection** dengan hasil + daftar model server). Tanpa key → bot team itu tidak bisa chat (error jelas, bukan error kredit).
   - Members + invite + role + hapus,
   - SlaveBots + transfer partner + grant/revoke per staff,
   - Recent activity (owner/admin).
4. **Fly.io — team machines**: connect API token team (disimpan server-side, tak pernah tampil lagi) → Provision **prod + dev** (prod stabil untuk iframe publik, dev sandbox untuk harness/computer-use, terisolasi) → list machines + destroy. Custom domains `{uuid}.slaver.app` (CNAME ke Fly, dibuat otomatis bila Cloudflare dikonfigurasi).
5. **Developer**: OAuth clients (buat/hapus, copy ID/secret, redirect URI).
6. TIDAK ADA: kartu Usage/logs, sisa kredit, spent. (Telemetry token tetap dicatat server-side, tak ditampilkan.)

---

## 10. Team-level OAuth — "Login with Slaver" (untuk app yang di-deploy)

**Masalah yang diselesaikan (dari IDEAS.md):** aplikasi yang dibeli/di-deploy user berjalan di VPS/user sendiri, tapi user-nya harus bisa login **sebagai user di team Slaver itu, lengkap dengan role-nya** — tanpa bikin akun baru di tiap app.

### 10.1 Alur untuk pemilik app (sekali, di Settings → Developer)
1. "New OAuth client" → nama app + redirect URI(s) → dapat **Client ID + Client Secret** (secret tampil sekali, simpan).
2. Daftar client + tombol revoke. Redirect URI harus match persis (tanpa wildcard).

### 10.2 Alur untuk end user (tiap login di app yang di-deploy)
1. User klik "Login with Slaver" di app → redirect ke `https://www.slaver.app/oauth/authorize?client_id=…&redirect_uri=…&scope=openid+profile+email+team&state=…`.
2. Bila belum login Slaver → layar login dulu (demo prefill) → kembali ke consent.
3. Layar consent: "App X meminta: nama, email, team + role kamu di team Y" → [Allow] / [Deny].
4. Redirect balik ke app dengan `?code=…&state=…` (code sekali pakai, 10 menit).
5. App tukar code di `POST /oauth/token` (auth = client_id:secret) → `access_token` (+ `refresh_token` opsional v2).
6. App panggil `GET /oauth/userinfo` (Bearer token) → `{ sub, email, name, team_id, team_name, role }` → app membuat sesi lokal dengan role tersebut.

### 10.3 Kontrak keamanan (v1)
- Scope: `openid profile email team:<id|active>` — role selalu team aktif user saat consent.
- Code: acak 256-bit, sekali pakai, kedaluwarsa 10 menit, terikat client + redirect_uri.
- Token: opaque 256-bit, kedaluwarsa 30 hari, bisa revoke (hapus = logout paksa).
- Hanya owner/admin team yang boleh buat/revoke client (staff tidak).
- Rate-limit endpoint token; log setiap penerbitan (audit).
- v2 (nanti): PKCE untuk public client, refresh-token rotation, "Login with Slaver" button snippet siap tempel.

### 10.4 Integrasi di template marketplace
- Setiap template wajib sediakan tombol "Login with Slaver" + file `OAUTH.md` (client registration steps). QA agent memverifikasi alur login saat review template.

---

## 11. Services directory (rencana — dari IDEAS.md §Services)

- Katalog developer/agency terverifikasi: profil, skill, rate, rating, portofolio fork.
- Hire flow: dari issue → "Hire help" → brief otomatis dari issue → penawaran → escrow via platform fee → hasil di-review QA agent + owner.
- Status: **belum dibangun** (setelah marketplace penuh + OAuth stabil).

---

## 12. Matriks peran (ringkas, berlaku di semua layar)

| Aksi | owner | admin | staff | non-member |
|---|---|---|---|---|
| Chat DM / channel team sendiri | ✅ | ✅ | ✅ granted | ❌ |
| Baca + posting support channel publik | ✅ | ✅ | ✅ | ✅ |
| Bot membalas di support channel | ✅ (member) | ✅ (member) | ✅ (member) | — (bot team pemilik) |
| Buat repo / project / issue | ✅ | ✅ | ✅ | ❌ |
| Publish template / hapus team / deploy VPS / set provider / invite / set URL | ✅ | ✅* | ❌ | ❌ |
| Connect Fly token / provision machines / destroy machine | ✅ | ✅ | ❌ | ❌ |
| Invite role admin | ✅ | ❌ | ❌ | ❌ |
| Buat/revoke OAuth client | ✅ | ✅ | ❌ | ❌ |
| Buat support channel template | ✅ | ✅ | ❌ | ❌ |

\* admin tidak bisa: hapus personal team, invite admin, ganti role owner.

---

## 13. Inventaris layar (checklist buat UI designer)

Topbar (7): Apps, Chat, Harness, Projects, Code, Market, Settings (+ Voice toggle di header main).
Sidebar (4 section + search): DMs (bot + user), Channels, Meetings, Support.
Auth (login prefill demo + register 2 tab) + Onboarding (template picker) + Settings (5 kartu: Profile, New slaveBot, Teams, Fly.io, Developer — tanpa Usage).
Home = Apps: grid kartu + preview iframe (PROD/DEV) + Set URL + Open full.
Chat: DM empty ×2, thread, composer pill, GroupView (+public badge), MeetingView (+form), BotView (identity/schedules/team/recaps).
Harness: form + transcript + history + prefill banner.
Projects: board 5 kolom, kartu, form issue, panel detail + Start agent run.
Code: list + detail (branches/log/diff/clone info) + deploy VPS.
Marketplace: katalog + licenses + support button + HitPay flow.
OAuth: consent screen + login-then-consent (2 layar).
Dialog/confirm: delete group/meeting/team/schedule/machine, remove key, archive bot.
States wajib per layar: loading skeleton, empty + CTA, error + retry.

---

*Dokumen hidup. Update tiap fase (lihat PRD.md untuk strategi pembangunan).*
