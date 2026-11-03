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
3. Bahasa manusia (Indonesia santai), bukan jargon: "Chat" bukan "Direct messages", "Asisten AI" bukan "slaveBot", "Beli" bukan "provision license", "Tugas" bukan "kanban/issues", "Toko" bukan "marketplace", "Kunci AI" bukan "provider", "Server" bukan "VPS/Fly machine", "Tayangkan" bukan "deploy", "Rapat" bukan "huddle/meeting", "Bantuan" bukan "support channel". Istilah teknis (model id, base URL, token) tetap apa adanya tapi selalu disertai contoh.
4. Setiap layar punya 3 kondisi: **isi**, **kosong** (dengan CTA jelas), **error** (kalimat + tombol coba lagi).
5. Satu aksi utama per layar (tombol hijau). Aksi sekunder berupa teks/link.
6. Tidak ada aksi destruktif tanpa konfirmasi (`window.confirm` minimal).
7. Demo-first: reviewer bisa login dalam 1 klik tanpa registrasi.

---

## 1. Global shell

### 1.1 Top bar (selalu terlihat)
- Kiri: hamburger (mobile saja) + **logo ikon huruf tim** — klik = dropdown ganti tim (nama + role, tanpa pindah halaman). Tidak ada teks nama "Slaver".
- Tengah (scroll horizontal di mobile): **Aplikasi ⌂ · Chat 💬 · File </> · Toko ◈ · Pengaturan ⚙**. Tidak ada menu Projects (kanban di channel §4.3) dan tidak ada menu Harness (dihapus, kerja agent di File).
- Kanan: avatar huruf depan (tooltip = email). Tidak ada badge kredit.
- Aturan aktif: Chat aktif untuk DM/channel/meeting/bot-settings; tiap menu lain aktif di view-nya.

### 1.2 Sidebar (navigasi saja — media komunikasi)
- Header: ikon huruf + nama tim aktif saja (tanpa role, tanpa dropdown, tanpa search — ganti tim via logo di top bar). Ganti tim → reset chat/grup/rapat/asisten yang terbuka.
- Section **Chat** (+ di kanan judul → ke Pengaturan#asisten-baru).
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

### 4.3 Group channel (termasuk public support + board)
- Header internal: nama (klik = rename inline), badge **PUBLIC SUPPORT** (hijau, bila publik), tombol Rename / **Make public|private** / Delete.
- Tab **[💬 Chat | ▤ Board]**: Chat = thread + composer seperti biasa. Board = kanban project yang ditempel ke channel ini (selalu terfilter 1 project itu).
- **Attach board**: channel tanpa project → panel "Channel ini belum punya board": pilih project team (select) atau buat board baru (input nama + Buat → project dibuat + langsung ditempel). Hanya owner/admin.
- **Mode Side** (default): chat kiri + board kanan (panel 400px, kolom kanban scroll horizontal). Cocok untuk diskusi sambil lihat task.
- **Mode Full** (⛶): board fullscreen, chat mengecil jadi composer saja di bawah. Toggle ⇲ kembali ke Side.
- Isi board = `KanbanBoard` penuh: progress done/total, repo tertaut (select ganti), 5 kolom drag-drop (Backlog/Todo/In Progress/In Review/Done), kartu (judul + priority + assignee), form New issue (title + acceptance criteria + assignee bot), panel Issue detail (assign, pindah kolom). Pengerjaan issue dilakukan di Code (git: clone → branch → commit → push), lalu kartu dipindah manual ke In Review/Done.
- Buka board dari luar channel: tombol **Board ▤** di Apps dan **Open board ▤** di Marketplace → buka channel pemilik project (bila belum ada channel, dibuatkan otomatis bernama sama + ditempel) langsung di tab Board.
- Checkbox `+memory`: tiap pesan juga disimpan ke memory semua member.
- **Support channel**: user dari team manapun bisa baca + posting; semua member bot membalas (dibiayai key team pemilik). Pesan customer tidak pernah hilang walau provider error.
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

## 5. Projects (dihapus sebagai menu — pindah ke channel)

- Tidak ada lagi top bar **Projects**. Kanban hidup di **Channel → tab Board** (§4.3): satu channel pegang satu project (`groups.project_id`, via tool `groups_set_project`, owner/admin only), task otomatis terfilter channel itu.
- Semua kemampuan kanban lama tetap ada di komponen `KanbanBoard` yang dipakai di dalam channel: 5 kolom drag-drop, kartu (judul + priority + assignee), form New issue, panel Issue detail + **▶ Start agent run** (prefill → Harness), repo tertaut, auto-status In Progress/In Review.
- Project dibuat dari: Marketplace (otomatis saat beli), channel ("Buat board baru" di panel attach), atau tool MCP `projects_create`.
- Membuka project dari Apps (**Board ▤**) / Marketplace (**Open board ▤**) → buka channel pemiliknya langsung di tab Board (dibuatkan otomatis bila belum ada).
- URL deploy project (prod/dev) tetap diedit di **Apps → Set URL** (satu sumber kebenaran).

---

## 7. Code (</> — git service)

- Kiri: daftar repo team + form nama + deskripsi + Create.
- Kanan: nama repo, badge template, tombol Fork / Publish-Unpublish (owner/admin), clone URL (`https://<token>@host/git/<id>` + catatan token = JWT login; push butuh owner/admin).
- Branches (chips), Commits (sha + subject + author + tanggal; klik = diff), diff viewer (max 30k char, monospace).
- Deploy ke VPS: pilih target + Start deploy → log streaming via `deployments_list`.
- Empty: "Select a repo…" / repo kosong ("clone and push to see history").

---

## 8. Marketplace (◈)

- Header + tagline buy-once. **Template cards**: nama, deskripsi, badge OWNED / BUY ONCE, tombol **💬 Support** (buka support channel template; dibuatkan otomatis saat butuh oleh owner), tombol **Buy & fork** atau **Open board ▤** bila sudah punya.
- Catatan kecil: "Includes 12 months updates + support".
- **My licenses**: list lisensi (repo short-id, kind, status, support-until, provider).
- Flow beli: klik → checkout HitPay (atau mock instan bila tanpa API key) → bayar di tab HitPay → webhook + polling verifikasi status server-side → license perpetual + support 12 bulan + fork repo + project "X (custom)" → lompat ke Apps. Kembali dari HitPay (`?payment=`): aktivasi otomatis bila sudah lunas. Webhook tanpa HMAC valid / payment gagal tidak pernah membuat lisensi.

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

Topbar (5): logo-ikon ganti tim + Aplikasi, Chat, File, Toko, Pengaturan (+ Voice toggle di header main).
Sidebar (4 section, tanpa search): ikon+nama team, DMs (bot + user), Channels, Meetings, Support.
Auth (login prefill demo + register 2 tab) + Onboarding (template picker) + Settings (5 kartu: Profile, New slaveBot, Teams, Fly.io, Developer — tanpa Usage).
Home = Apps: grid kartu + preview iframe (PROD/DEV) + Set URL + Open full + Board ▤.
Chat: DM empty ×2, thread, composer pill, GroupView (tab Chat|Board + public badge + mode side/full), MeetingView (+form), BotView (identity/schedules/team/recaps).
Board (di channel): attach/select/create project, 5 kolom drag-drop, kartu, form issue, issue detail (assign + pindah kolom).
Code: list + detail (branches/log/diff/clone info) + deploy VPS.
Marketplace: katalog + licenses + support button + HitPay flow + Open board ▤.
OAuth: consent screen + login-then-consent (2 layar).
Dialog/confirm: delete group/meeting/team/schedule/machine, board detach, remove key, archive bot.
States wajib per layar: loading skeleton, empty + CTA, error + retry.

---

*Dokumen hidup. Update tiap fase (lihat PRD.md untuk strategi pembangunan).*
