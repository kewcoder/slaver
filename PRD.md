# PRD — Slaver AI-native Software Ecosystem

**Versi:** 1.0 · **Tanggal:** 3 Nov 2026 · **Status:** Draft untuk eksekusi
**Visi satu kalimat:** Orang tanpa skill teknis bisa beli aplikasi sekali, customize lewat tim AI, dan menjalankannya di VPS sendiri — tanpa langganan SaaS ke banyak company.

---

## 1. Ringkasan Eksekutif

Slaver berevolusi dari chatbot multi-bot menjadi **AI-native Software Development Platform** dengan 3 aplikasi yang saling terintegrasi — plus Workspace sebagai **menu di dalam Team**, bukan domain sendiri (workspace dan team terlalu mirip untuk dipisah):

| Aplikasi | Domain | Pertanyaan yang dijawab |
|---|---|---|
| `team.slaver.app` | Orchestration + Workspace (aplikasi utama) | Siapa yang mengerjakan, bagaimana caranya, dan di mana kode dijalankan? |
| `git.slaver.app` | Agent Git Service | Di mana source code dan riwayatnya? |
| `marketplace.slaver.app` | App Marketplace | Apa yang ingin saya bangun? |

Ditopang **Slaver Core Services** (satu backend bersama, bukan aplikasi kelima): Identity, Permissions, Billing, Agent API, MCP gateway, Event bus, Audit logs.

**Model bisnis:** user beli lisensi aplikasi **sekali** di marketplace → customize via AI team → deploy ke **VPS milik user sendiri** (bukan runtime kita) → support berkelanjutan dari pembuat app sesuai lisensi. Kita monetisasi dari: marketplace fee per penjualan lisensi + support subscription split + (opsional) managed build minutes.

**Target vertikal awal (ASEAN-first):** Grocery & daily retail, F&B, Transportation & mobility, Healthcare, Ecommerce & fashion, Education, Hospitality & tourism, Beauty & personal care. **Payment:** HitPay (ASEAN) + Stripe (global).

---

## 2. Masalah & Pengguna

### Masalah
1. **UMKM membayar banyak SaaS** (kasir, booking, katalog, dsb.) yang tidak pas 100% dengan bisnisnya, dan tidak bisa customize tanpa developer.
2. **App builder terkunci runtime** (ala Shopify): customize dalam batas template, data + hosting nempel di platform. Owner tidak punya keahlian untuk keluar dari situ.
3. **AI coding tool butuh skill teknis** (prompt engineering, Git, Docker, terminal, review PR) — tidak bisa dipakai owner warung/klinik/salon.

### Persona
| Persona | Butuh |
|---|---|
| **Owner bisnis non-teknis** (Bu Ani, warung/F&B/klinik) | Aplikasi jadi, customize pakai bahasa sehari-hari, jalan di VPS-nya, ada yang support kalau rusak |
| **Pembuat app / indie dev** (publisher) | Publish template sekali, dapat royalti lisensi + support recurring, tanpa urus infra user |
| **Operator/team bisnis** | Assign kerjaan ke AI, track progress kayak Linear, approve hasil |

### Prinsip produk (non-negotiable)
1. **User tidak pernah lihat Git/Docker/terminal/branch** — semua lewat percakapan + kanban.
2. **Team bukan chatbot multi-persona** — Team adalah sistem yang benar-benar mendelegasikan, menjalankan agent paralel, berbagi konteks repo, me-review, dan menyelesaikan sampai aplikasi jalan.
3. **App jalan di VPS user, bukan di kita.** Kita sediakan repo + build environment + orkestrasi. Ini pembeda vs Shopify/runtime-locked builders.
4. **Beli sekali, support terus** — lisensi memisahkan hak pakai vs hak support/update.

---

## 3. Arsitektur Sistem

### 3.1 Peta 3 aplikasi + Core

```
              team.slaver.app  (pusat UX: chat + kanban Projects + menu Workspace)
              /                  \
   git.slaver.app          marketplace.slaver.app
   (repos, forks,           (katalog, lisensi,
    commits, diffs)          support)
              \                  /
              Slaver Core Services (1 backend)

  Workspace = menu di Team (agent terminals, isolated env, preview, deploy).
  Harness view yang sudah ada adalah wujud awal menu ini.
```

### 3.2 Slaver Core Services (satu backend, modular monolith → split belakangan)
- **Identity & organization:** user, organization/team (reuse `users`, `team_members` yang ada), roles owner/admin/staff + publisher.
- **Agent orchestration API:** buat run, assign agent, status, cancel; dipakai Team + Workspace.
- **Repository permissions:** siapa boleh baca/tulis/fork tiap repo (terhubung ke team roles + lisensi).
- **Model/provider management:** BYOK per team (sudah ada) + fallback; dipakai semua agent.
- **Usage metering & billing:** catat LLM tokens, build minutes, preview hours → tagih/kuota (reuse `usage_logs`).
- **Event bus (in-process dulu):** event run.created/step/commit/review/done → update kanban otomatis, notifikasi.
- **MCP gateway:** `POST /mcp` yang sudah ada diperluas (repos, runs, issues, licenses).
- **Audit logs:** siapa/apa/kapan (penting untuk trust + support dispute).

**Keputusan arsitektur:** mulai sebagai **modular monolith Rust** (satu binary, modul `team(+workspace)/git/marketplace/core`, satu DB SQLite/Postgres) di satu VPS. Alasan: solo dev, butuh iterasi cepat, kontrak antar-app belum stabil. Split ke service/deploy independen hanya setelah kontrak API + event stabil. Subdomain (`team./git./marketplace.`) di-routing oleh reverse proxy (Caddy) ke binary yang sama dulu, bisa dipecah belakangan tanpa ubah URL.

### 3.3 Data model baru (tambahan dari skema yang ada)
- `organizations` (id, name, owner) — tim bisnis; 1 org ↔ 1+ projects.
- `projects` (id, org_id, repo_id, status) — 1 project = 1 app yang di-customize.
- `issues` (id, project_id, title, body, state, assignee_bot_id, reporter, priority, labels) — unit kerja kanban; state: `backlog → todo → in_progress → in_review → done`.
- `runs` (sudah ada) += `issue_id`, `repo_id`, `branch` — run terikat issue.
- `repos` (id, org_id, name, default_branch, public_template?) + git storage di disk (`/data/git/<id>.git`, bare repos).
- `forks` (repo_id → parent_repo_id, license_id) — fork dari marketplace template.
- `licenses` (id, org_id, app_id/template_repo_id, type: perpetual/support, support_until, status).
- `support_entitlements` (license_id → update/support window, SLA tier).
- `vps_targets` (id, org_id, host, user, ssh_key_ref, compose_hash, last_deploy) — VPS milik user.
- `deployments` (id, project_id, vps_target_id, commit_sha, status, preview_url).

---

## 4. Alur Kerja Antar-Aplikasi (happy path)

Contoh: owner F&B ingin SaaS CRM untuk bisnisnya.

1. **Marketplace** — menemukan template "CRM Retail", klik **Buy once** (HitPay/Stripe) → dapat lisensi perpetual + 12 bulan support/update.
2. **Git Service** — Slaver membuat **fork repo pribadi** milik org user (full history template).
3. **Team** — user prompt (bahasa sehari-hari): *"Ubah CRM ini jadi multi-tenant SaaS dengan subscription billing, team management, dan analytics."* Orchestrator memecah jadi issues di kanban → assign ke agent (Architect, Backend, Frontend, QA).
4. **Workspace (menu di Team)** — tiap agent dapat isolated env + repo checkout di branch-nya → coding → push commits.
5. **Git Service** — perubahan tersimpan sebagai commits + diff + branch; agent reviewer membuka "review run".
6. **Team** — QA agent testing di preview; issue pindah `in_review → done` otomatis bila checks hijau; user approve di kanban.
7. **Workspace (menu di Team)** — preview URL dibagikan; tombol **Deploy to my VPS** → agent generate `docker-compose.yml` → deploy via SSH ke VPS user → health check hijau.

**Alur support:** app rusak → user buka issue "support" di Team (tertagih ke entitlement lisensi) → agent reproduce di workspace clone → fix → PR ke repo user → deploy ulang. Publisher bisa ambil alih manual bila perlu (audit log mencatat semua).

**Alur deploy-ke-VPS-user (pembeda utama):** user daftarkan VPS (IP + SSH key, one-time setup dipandu). Agent: deteksi OS/docker → generate compose + Caddyfile + backup script → `docker compose up` via SSH → verifikasi endpoint → simpan fingerprint di `deployments`. Update berikutnya = pull + rebuild + migrate. VPS tidak pernah dipegang manusia.

---

## 5. Team App — Pusat Pengalaman (aplikasi yang ada, dikembangkan)

Team adalah aplikasi utama. Tiga permukaan: **Chat tim** (sudah ada: slaveBots) + **Projects kanban** (baru) + **menu Workspace** (Harness view yang sudah ada: agent terminals, isolated env, preview, deploy).

### 5.1 Struktur agent ( peran, bukan persona )
| Agent | Tanggung jawab | Tools utama |
|---|---|---|
| Product Manager | Memahami requirement, menulis acceptance criteria ke issue | repo read, web search |
| Architect | Memutuskan arsitektur + memecah jadi issues | repo read/write, decisions log |
| Frontend Developer | Membangun UI | workspace exec, preview |
| Backend Developer | API + business logic | workspace exec, DB migrate |
| Database Engineer | Schema + migration | workspace exec, migrate review |
| QA Engineer | Testing (unit + e2e di preview) | workspace exec, browser test |
| Code Reviewer | Review + security pass | diff read, static checks |

- User bisa atur **model/provider per agent** (termasuk BYOK) — reuse Teams settings.
- **Tidak semua agent aktif tiap pekerjaan.** Orchestrator memilih subset sesuai kebutuhan (mis. typo UI → hanya Frontend + Reviewer).

### 5.2 Orchestrator (ini yang membedakan dari "chatbot banyak persona")
1. Terima prompt user → klarifikasi bila ambigu (PM) → tulis issues dengan acceptance criteria.
2. Pilih agent + buat run paralel dengan dependensi (DAG sederhana: Backend+Frontend paralel → Reviewer → QA).
3. **Konteks repo bersama:** semua agent baca repo/branch yang sama; decision log + interface contract ditulis ke repo (`/docs/decisions/`) agar tidak konflik.
4. Review gate: tidak ada merge ke `main` tanpa Reviewer + checks hijau.
5. Selesai = preview hidup + acceptance criteria terpenuhi + user approve di kanban.

### 5.3 Projects — kanban ala Linear
- **Board:** Backlog / Todo / In Progress / In Review / Done + WIP limit per kolom.
- **Issue:** title, deskripsi (support bahasa sehari-hari + attachment gambar), assignee (slaveBot atau manusia), priority, labels, linked branch/PR/preview, activity feed.
- **Otomatisasi status:** run dimulai → `in_progress`; PR review dibuka → `in_review`; checks hijau + approve → `done`. Semua via event bus (tanpa klik manual).
- **Tracking:** progress bar per project (% issues done), burndown sederhana, estimasi vs aktual per agent, riwayat setiap perubahan (audit).
- **Interaksi:** user bisa drag issue, re-assign ke agent lain, komentar "@bot tolong …" yang menjadi instruksi run baru.

### 5.4 Anti-pattern yang dilarang
Team **dilarang** menjadi sekadar ganti-ganti persona dalam satu chat tanpa: delegasi nyata, eksekusi paralel, konteks repo bersama, dan penyelesaian sampai berjalan. Setiap klaim "selesai" harus tertaut ke preview/commit/check hijau yang bisa diklik.

---

## 6. Git Service (`git.slaver.app`)

Git-native (bukan tiruan): bare repos di disk server (`/data/git/<id>.git`), protokol HTTP smart (`git clone/push/pull` standar via `git-http-backend` atau implementasi `upload-pack/receive-pack` di Rust; mulai dari shell-out ke `git` binary — sederhana + battle-tested).

- **Repos:** per org/private default; template flag untuk marketplace.
- **Forks:** full clone + relasi parent; fork dari template butuh `license_id` valid (dicek Core permissions).
- **Commits/diffs/branches/releases:** API + UI baca (log, diff per commit, compare, tag release `vX.Y.Z` dengan changelog auto dari commits).
- **Agent-friendly:** branch per issue (`issue/<id>-<slug>`), protected `main` (hanya via review run), signed-by-agent trailer di commit message (`Co-authored-by: <bot>`), PR = "review run" bukan klik manual.
- **Permissions:** baca/tulis mengikuti team roles + lisensi (fork template = tulis ke fork sendiri, tidak ke upstream).
- **Fase awal:** cukup clone/push/pull via HTTPS + token org + UI log/diff/branch. PR UI penuh belakangan.

---

## 7. Workspace — menu di Team (bukan domain sendiri)

Workspace dan Team terlalu mirip untuk dipisah: user memberi perintah di Team, agent bekerja di Workspace, hasilnya kembali ke Team. Satu aplikasi, satu konteks.

- **Isolated env per run/project:** workdir terisolasi per run (mulai dari eksekusi proses lokal seperti harness hari ini; naik ke container/microVM per project saat multi-tenant publik).
- **Agent terminals:** exec + file tools (sudah ada di Harness view) + perintah domain (install deps, migrate, seed). Terminal tampil inline di menu Workspace + tertaut ke issue yang sedang dikerjakan.
- **Preview:** tiap project dapat URL preview (`https://<project>-<run>.preview.slaver.app`) via reverse proxy + port mapping; auto-sleep saat idle (hemat biaya).
- **Deploy ke VPS user:** generate `docker-compose.yml` + Caddyfile dari repo → SSH deploy → health check → catat di `deployments`. Target: satu tombol "Deploy" dari kanban/preview.
- **Web testing (fase 2):** e2e di preview pakai headless Chromium (dipakai QA agent); ditagih per menit browser.
- **Batasan sadar:** workspace cloud untuk *build & preview*; runtime produksi = VPS user. Tidak ada lock-in hosting.

---

## 8. Marketplace (`marketplace.slaver.app`)

- **Katalog:** template apps per vertikal (mulai 2–3 seed berkualitas, bukan ratusan template asal): deskripsi, demo preview hidup, screenshot, stack, kebutuhan VPS minimum, rating, changelog.
- **Lisensi buy-once:** bayar sekali → hak pakai perpetual + fork pribadi. Harga per template ditentukan publisher (kisaran awal $29–$149).
- **Support entitlement:** tiap lisensi termasuk support/update X bulan (default 12) → issue support di Team ditagih ke entitlement; perpanjangan support = subscription tahunan (~30–40% harga lisensi).
- **Fork mechanics:** beli → fork otomatis ke org user → Team langsung bisa customize. Update template upstream → user dapat "update run" (agent merge + resolve konflik + test) selama entitlement aktif.
- **Publisher flow:** submit repo template → review kurasi (kualitas + keamanan + bisa jalan di VPS 1GB) → publish → dashboard penjualan + support queue. Revenue split awal: **85% publisher / 15% platform** (dari lisensi + perpanjangan support).
- **Distribusi tanpa runtime kita:** yang didistribusikan = source + compose + migrasi. User bebas pindah VPS kapan saja — ini argumen penjualan utama vs Shopify.
- **Public support channels (lintas team):** tiap template/repo bisa punya channel support publik — user dari team mana pun bisa bertanya, bot milik team penjual yang menjawab (dibiayai key penjual). Diatur per-group oleh owner/admin; auto-suggest saat publish template.
- **Login with Slaver (OAuth team-level):** app yang di-deploy di VPS user bisa pakai "Login with Slaver" — end user login dengan akun Slaver dan app menerima `{ sub, email, name, team_id, team_name, role }`, sehingga permission/role Slaver berlaku di app customer tanpa user database terpisah. Client dibuat per team di Settings → Developer; flow standar authorize → code → token → userinfo.

---

## 9. Model Bisnis & Pembayaran

| Aliran | Mekanisme | Gateway |
|---|---|---|
| Beli lisensi template | Sekali bayar per app | HitPay (ASEAN incl. QRIS/VA/e-wallet) + Stripe (global, kartu) |
| Perpanjangan support/update | Subscription tahunan per lisensi aktif | sama |
| Platform fee | 15% dari lisensi + support | dipotong otomatis saat payout publisher |
| Build/preview minutes (opsional, fase 2) | Kuota gratis + top-up | sama |

**Kenapa HitPay + Stripe:** HitPay menutup pembayaran lokal ASEAN (QRIS, VA bank, e-wallet) yang kartu-kredit-only tidak menjangkau target UMKM; Stripe untuk global + payout publisher multi-negara. Keduanya mendukung subscription (support renewal) dan split/payout.

**Unit economics (target):** CAC via template gratis/demo + konten vertikal; LTV = lisensi + N×perpanjangan support; payback < 6 bulan per publisher aktif.

---

## 10. Vertikal & Template Seed

Delapan vertikal prioritas: Grocery & daily retail, F&B, Transportation & mobility, Healthcare, Ecommerce & fashion, Education, Hospitality & tourism, Beauty & personal care.

**MVP marketplace (2–3 seed saja, kualitas > kuantitas):**
1. **Grocery POS + stok** (grocery/retail) — kasir, inventori, laporan harian; jalan di VPS 1GB.
2. **F&B ordering + QR table** (F&B) — menu, order dapur, pembayaran HitPay/Stripe.
3. (opsional ke-3) **Klinik booking + rekam kunjungan** (healthcare) — tanpa modul diagnosis (hindari klaim medis).

Setiap seed wajib: bisa jalan via 1 perintah compose, ada demo preview, ada test QA agent yang hijau, ada panduan customize ("coba prompt X di Team").

---

## 11. Strategi Pembangunan (urutan sesuai keputusan)

1. **Fase 0 — Core keras (fondasi, 1–2 minggu):** orgs, repo permissions, metering/billing hook, event bus in-process, MCP gateway diperluas, audit logs. Tanpa ini 3 app rapuh.
2. **Fase 1 — Git Service (paralel: Marketplace sederhana):** bare repos + HTTPS clone/push + UI log/diff/branch + forks + lisensi buy-once minimal (katalog statis + tombol beli + fork). Marketplace "sederhana" = halaman katalog + checkout + fork; discovery/search penuh belakangan.
3. **Fase 2 — Workspace (menu di Team):** workdir per project + preview URL + deploy-ke-VPS via SSH + compose generator. (Harness view yang ada = fondasi tool exec-nya; tinggal tambah tab terminal + link ke issue.)
4. **Fase 3 — Team (puncak):** Projects kanban + orchestrator (dekomposisi, DAG paralel, shared repo context, review gate) + role agents + tracking. Ini yang didemo-kan.
5. **Fase 4 — Marketplace penuh:** search/discovery, rating, publisher dashboard, support queue + entitlement, update runs, payout.

Aturan slicing: tiap fase harus menghasilkan **demo end-to-end yang bisa diklik** (bukan komponen mati).

---

## 12. Rencana Hackathon (kirim sebelum deadline)

**Catatan waktu:** submission due 4 Nov 9PM ET. Fokus pada *new work* yang bisa didemo 3 menit.

**Slice yang disubmit (satu alur, ujung-ke-ujung):**
Marketplace (1 template seed: Grocery POS) → Buy (mock) → Fork (git service) → Team prompt customize ("tambah QRIS + laporan harian") → agent kerja di Workspace (exec + commit terlihat) → Reviewer + QA hijau → Preview hidup → Deploy (mock ke VPS).

**Checklist submit:** repo publik, video 3 menit (masalah → fork → prompt → agent kerja → preview → deploy), semua model via Meta Model API (Spark/Wonder), hindari kategori banned (bukan medical/finance-advice/RAG tempel), tulis jelas "new work" yang dibangun saat hackathon.

**Jika waktu mepet:** potong deploy-VPS asli → tunjukkan compose generated + health check lokal; potong QA browser → unit test saja. Jangan potong alur fork→customize→preview (itu inti cerita).

---

## 13. Risiko & Mitigasi

| Risiko | Mitigasi |
|---|---|
| Agent merusak repo / deploy gagal | Branch per issue, protected main, review gate wajib, deploy hanya dari commit hijau; rollback = redeploy tag sebelumnya |
| Secret bocor (SSH VPS, API keys) | Secret hanya di server + keychain desktop; tidak pernah ke log/LLM prompt (redaksi otomatis); akses repo per-org |
| Billing dispute (support vs bug) | Audit log lengkap + definisi "bug garansi 30 hari" di lisensi; support queue terukur |
| Kualitas template jelek | Kurasi manual + QA agent wajib hijau + syarat VPS 1GB sebelum publish |
| Scope creep 3 app sekaligus | Modular monolith + slice demo per fase; marketplace penuh terakhir |
| Ketergantungan model/provider | BYOK + multi-provider sudah ada; orchestrator tidak hardcode 1 model |

---

## 14. Metrik Sukses

- **Aktivasi:** % org baru yang menyelesaikan fork→customize→preview pertama kali (< 30 menit).
- **Keberhasilan agent:** % run yang mencapai `done` tanpa intervensi manusia; median steps/run.
- **Marketplace:** template terjual, attach rate support renewal, rating ≥ 4.5.
- **Retensi support:** % lisensi yang perpanjang support tahun ke-2.
- **Unit ekonomi:** kontribusi margin per org > 0 pada bulan ke-3 (infra + fee vs lisensi/support).

---

## 15. Keputusan Terbuka

1. Split platform fee final (mulai 15%, evaluasi setelah 100 transaksi)?
2. VPS minimum yang didukung resmi (mulai: 1 vCPU/1GB Ubuntu 22.04 + Docker)?
3. Garansi bug vs support berbayar — batas 30 hari cukup?
4. Desktop app (Tauri) untuk harness lokal — tetap di roadmap pasca-hackathon?
5. Bahasa UI awal: Indonesia + Inggris?

---

*Dokumen ini hidup. Update tiap fase dengan keputusan + tanggal.*
