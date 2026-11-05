# F&B Suite

Aplikasi all-in-one untuk usaha makanan dan minuman (restoran, kafe, kedai kopi). Satu server, satu database SQLite, bisa diinstall sendiri dalam beberapa menit.

- **Menu & stok**: produk, add-on, stok per item (kosong = tak terbatas), restok.
- **Kasir (POS)**: pesanan dine-in, ambil, atau antar; tunai dengan kembalian; struk.
- **Meja & booking**: status meja, booking dengan DP, cek meja sesuai jumlah orang.
- **Kamera meja (AI)**: foto area makan dikirim ke model vision untuk melihat meja kosong. Hasilnya saran, status tidak berubah otomatis.
- **Iklan (AI)**: draf teks iklan dari produk atau promo, jadwal tayang, banner otomatis di toko.
- **Promo**: persen atau potongan tetap, minimal belanja, masa berlaku, batas pemakaian.
- **Pelanggan**: data dan riwayat belanja, dikunci per nomor HP.
- **Toko online**: menu dengan stok real, keranjang, checkout pickup atau antar, status pesanan, booking meja.
- **Tim & akun**: owner, manajer, kasir; login email dan password.
- **MCP**: semua fungsi tersedia sebagai tool MCP, termasuk untuk AI agent (tambah ke keranjang, cek stok, cek meja).

Tidak ada REST API. Admin, toko, dan AI agent semua bicara lewat MCP di `/mcp`.

## Install (lokal)

Butuh [Bun](https://bun.sh) 1.2 atau lebih baru.

```bash
cd apps/fnb-suite
bun run setup                       # install dependensi dan build
export ADMIN_TOKEN=$(openssl rand -hex 32)
bun run start                       # http://localhost:8080
```

Kunjungan pertama: buka `http://localhost:8080/admin/` dan ikuti **Siapkan usaha Anda**
(nama usaha, nama/email/password owner). Wizard ini hanya muncul sebelum owner
pertama dibuat — alternatifnya lewat CLI:

```bash
OWNER_PASSWORD='ganti-password-ini' bun run owner -- --email pemilik@usaha.id --name "Nama Pemilik" --business "Nama Usaha"
```

Untuk demo, ada data contoh **Saung Ranggon** (menu, harga, dan paket dari menu asli rumah makan):

```bash
bun run seed                        # login: demo@saung-ranggon.local, password ditampilkan sekali
```

Buka:
- `http://localhost:8080/admin/` untuk admin (login dengan email owner dari seed).
- `http://localhost:8080/` untuk toko online.
- `http://localhost:8080/mcp` untuk MCP.

## Install (Docker)

```bash
docker build -t fnb-suite .
docker run -p 8080:8080 \
  -e ADMIN_TOKEN=$(openssl rand -hex 32) \
  -v fnb-data:/data fnb-suite
docker exec -it <container> bun scripts/seed-sample.ts --db /data/fnb.db   # opsional: data contoh
```

Satu container per klien. SQLite hanya boleh satu writer, jadi jalankan satu instance per database. Contoh `fly.toml` ada untuk deploy ke Fly.io.

## Konfigurasi

| Variabel | Wajib | Keterangan |
|---|---|---|
| `ADMIN_TOKEN` | ya | Token owner darurat, minimal 32 karakter. Jangan dibagikan. |
| `MODEL_API_KEY` | tidak | Key [Meta Model API](https://dev.meta.ai). Tanpa key: iklan memakai template, kamera AI tidak aktif. |
| `AI_BASE_URL` | tidak | Default `https://api.meta.ai/v1`. Bisa diarahkan ke endpoint OpenAI-compatible lain. |
| `AI_TEXT_MODEL`, `AI_VISION_MODEL` | tidak | Default `muse-spark-1.3`. |
| `DB_PATH` | tidak | Default `./data/fnb.db`. |
| `PORT` | tidak | Default `8080`. |

Salin `.env.example` ke `.env` untuk mengisinya.

## Customize

Fitur ada di `src/`:

- `src/domain.ts`: aturan bisnis (stok, checkout, pembayaran, promo, laporan). Semua perubahan uang dan stok berjalan dalam transaksi.
- `src/mcp.ts`: daftar tool MCP dan role minimum tiap tool. Tool yang tidak diizinkan tidak muncul di `tools/list`.
- `src/accounts.ts`: akun, sesi (token disimpan dalam bentuk hash), dan role.
- `src/ads.ts`, `src/camera.ts`, `src/ai.ts`: fitur AI.
- `admin/src/`: admin React SPA. `store/src/`: toko Astro SSR.

Tambah tool: daftarkan dengan `reg("manager", "nama_tool", schema, handler)` di `src/mcp.ts`, lalu tambahkan test di `test/`.

Ubah menu, promo, meja, dan pengaturan toko lewat admin, atau langsung lewat MCP dari AI agent.

## Tes

```bash
bun test          # 59 tes: alur order, stok, promo, role, iklan, kamera, seed, routing
bun run typecheck
```

## Model Meta yang dipakai

Semua fitur AI memakai **Muse Spark 1.3** lewat Meta Model API (protokol Chat Completions):

- Generate teks iklan dari produk atau promo.
- Analisis foto meja untuk kamera AI (model vision).
- Review aplikasi saat submit (`scripts/review-app.ts` di root repo).

Belum dipakai: Muse Image, SAM, Voice Transcribe.

## Untuk hackathon

F&B Suite adalah app pertama di marketplace Slaver, dibangun selama Meta Global AI Developer Hackathon (27 Okt – 4 Nov 2026) bersama platform Slaver itu sendiri. App ini dipakai untuk mendemokan alur marketplace dari awal sampai akhir: review submission oleh Muse Spark, beli sekali, install ke server sendiri, lalu customize lewat AI di staging. Detail submission ada di [`SUBMISSION.md`](../../SUBMISSION.md).

## Keterbatasan

- Pembayaran QRIS, transfer, dan kartu dicatat manual oleh kasir. Belum ada integrasi gateway.
- Iklan tidak diposting otomatis ke media sosial. Teks dibuat dan dijadwalkan di sini, lalu diposting manual.
- Kamera AI hanya memberi saran per meja. Tidak mengubah status otomatis.
- Belum ada rate limit untuk endpoint publik.
- Status pesanan di toko memakai ID pesanan (acak, tapi tanpa login pelanggan).
