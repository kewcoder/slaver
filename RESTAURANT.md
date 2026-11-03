# Resto Plan — Use Case Pertama: Bisnis Restoran

> Fokus: restoran dine-in (transaksi di tempat, bukan order online).
> Tujuan: pemilik restoran tidak perlu ahli IT — tim AI + 1 aplikasi operasional
> menangani kasir, booking, meja kosong, orderan pelayan, dan stok.

## 1. Kenapa restoran dulu

- Transaksi terjadi **di tempat** → butuh kasir + meja + dapur, bukan katalog online.
- Masalah nyata & harian: antrian kasir, no-show booking, meja kosong di jam sepi tanpa promo, orderan salah catat, stok habis mendadak.
- Satu template ("Resto Ops") menjawab semuanya → demo paling gampang dipahami juri/user.

## 2. Tim + agen (Team: resto owner)

| Agen | Peran | Trigger / kerja |
|---|---|---|
| **Kasir** | Operasikan POS, rekap harian, struk | Chat: "rekap hari ini"; baca data penjualan |
| **Booking** | Terima booking meja + wajib DP min. Rp 50.000 via HitPay | Form booking → link bayar → tandai lunas |
| **Floor** | Pantau meja kosong real-time | Meja kosong ≥ N → usulkan promo happy-hour; kirim teks promo siap posting |
| **Pelayan** | Bantu catat order via chat/suara + cek stok real | "tambah 2 nasi goreng meja A3" → cek stok → tolak bila habis |

Semua agen = slaveBot dalam 1 team milik owner. Owner atur model/provider per agen (BYOK).

## 3. Aplikasi pendukung (Marketplace → fork → customize)

**Template: Resto Ops** (`seeds/resto-ops`) — 1 docker compose:
- `web` (Caddy, static): tab **Kasir** (menu, keranjang, total), **Meja** (peta status Kosong/Terisi/Booked, klik toggle), **Booking** (nama/WA/tanggal/jam/meja + DP), **Stok** (peringatan menipis + opname).
- `pay` (Node 1-file `server.js`): `POST /api/pay` → HitPay payment-request (sandbox default; ganti `HITPAY_BASE_URL` + key untuk produksi), `GET /api/status?reference=`, `POST /api/hook` (verifikasi server-side sebelum tandai lunas).
- State operasional di `localStorage` (1 outlet). Scale-up path: ganti ke DB + sinkron multi-kasir.

Alur uang (semua via HitPay, bukan mock):
1. **Bayar di meja**: kasir → total → link bayar HitPay (QRIS/VA/e-wallet/kartu) → pelanggan scan → webhook tandai lunas.
2. **DP booking**: Rp 50.000 saat booking → status "DP lunas" → meja jadi Booked. No-show = DP hangus (aturan tertulis di form).
3. **Rekonsiliasi**: tiap pembayaran tercatat dengan `reference` (`dinein-*` / `booking-*`).

## 4. Integrasi Slaver (yang sudah jalan)

- Marketplace: template Resto Ops bisa dibeli → auto-fork + project.
- Support channel publik per template: pembeli tanya, bot penjual jawab.
- Harness: Start agent run dari issue ("tambah diskon member") → clone repo → edit → commit di branch issue → review → Deploy ke VPS restoran.
- Login with Slaver: app resto yang di-deploy bisa pakai akun Slaver + role team.

## 5. Demo script (3 menit, untuk video/pitch)

1. **0:00 Masalah** — "Restoran sibuk, kasir antre, booking no-show, meja kosong tak termanfaatkan."
2. **0:30 Marketplace** — beli Resto Ops → fork + project otomatis.
3. **1:00 Kasir** — pesan 2 menu → bayar via HitPay sandbox (kartu test 4242…) → lunas.
4. **1:40 Booking** — booking meja + DP Rp 50.000 → status berubah.
5. **2:10 AI team** — tanya bot Floor: "meja kosong jam 3?" → bot jawab + tawarkan promo; bot Pelayan cek stok via voice.
6. **2:40 Customize** — issue "tambah diskon member" → agent run → commit → deploy.
7. **2:55 Visi** — "Own your restaurant stack. Built with Slaver."

## 6. Tahapan

- **Sekarang (v1):** template + 4 agen deskripsi + HitPay sandbox + support channel. ✅ (repo ini)
- **Berikutnya:** akun demo (`demo@slaver.app`) + team resto contoh (seed via server), halaman booking publik (link tanpa login untuk pelanggan), laporan harian otomatis via schedule, multi-kasir sync (ganti localStorage → DB kecil), printer struk (Bluetooth/thermal via browser).
- **Butuh dari user:** HitPay sandbox API key (dashboard.sandbox.hit-pay.com → Settings → API Keys) untuk coba bayar beneran; akun HitPay produksi + verifikasi bisnis untuk go-live.

## 7. Kriteria sukses use case ini

- Kasir bisa checkout → bayar → lunas tanpa sentuh kode (≤ 5 menit setup compose).
- Booking tanpa DP tidak bisa lock meja (aturan + teknis).
- Meja kosong terlihat ≤ 5 detik; saran promo keluar otomatis saat ≥ 3 meja kosong.
- Order via chat ditolak otomatis saat stok habis (cek stok real, bukan karangan).
