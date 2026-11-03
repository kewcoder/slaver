# Mail App — email usaha sendiri (kirim + terima)

Webmail ringan untuk 1 mailbox usaha: baca inbox, balas, tulis baru,
tandai dibaca, folder Terkirim otomatis. Backend Python kecil **tanpa
dependensi** (stdlib saja) yang bicara IMAP/SMTP ke server email milikmu.

## 1. Butuh apa

- Server email yang jalan (lihat `../../mail/` — docker-mailserver di VPS,
  atau server IMAP/SMTP mana pun). Catat: host, port, user, password.
- 1 VPS untuk app ini (bisa sekamar dengan server email, beda port).

## 2. Jalankan (isi env dulu)

```bash
APP_PASSWORD=kunci-buka-aplikasi \
IMAP_HOST=mail.tokomu.com IMAP_USER=halo@tokomu.com IMAP_PASS=xxxx \
SMTP_HOST=mail.tokomu.com SMTP_USER=halo@tokomu.com SMTP_PASS=xxxx \
MAIL_FROM=halo@tokomu.com \
docker compose up -d
```

Buka `http://IP-VPS:8080` → login pakai `APP_PASSWORD` → inbox muncul.

Variabel opsional: `IMAP_PORT` (bawaan 993), `SMTP_PORT` (bawaan 587),
`SMTP_SSL=1` bila server pakai SSL langsung port 465,
`SLAVER_URL` + `OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET` untuk tombol
"Masuk dengan Slaver" (lihat `OAUTH.md`).

## 3. Cara pakai (untuk pemilik usaha)

- **Baca**: klik email di daftar. Tombol ← Kembali di HP.
- **Balas**: tombol Balas (subjek otomatis "Re:", kutipan ikut).
- **Tulis baru**: tombol hijau "+ Tulis" kanan bawah.
- **Sudah/belum dibaca**: email baru tebal + label "baru"; tombol di dalam
  email untuk ubah status.
- **Folder**: Masuk + Terkirim + folder IMAP lain otomatis kebaca.

## 4. Batasan v1 (jujur)

- 1 mailbox per install (mailbox usaha, mis. `halo@tokomu.com`).
- Lampiran tidak ditampilkan (ada catatan "[lampiran tidak ditampilkan]").
- Tanpa pencarian server-side (daftar 50 terbaru).
- HTML email ditampilkan sebagai teks polos (aman, anti-tracking pixel).
- Multi-user penuh + webmail cantik = tahap berikut (lihat `mail/README.md` §8).

## 5. Kustomisasi via Slaver

Beli template ini di Marketplace → otomatis jadi aplikasi + project.
Contoh issue untuk agen: "tambah pencarian email", "tampilkan lampiran
sebagai unduhan", "tambah folder Sampah + hapus permanen", "mode gelap
untuk tabel". Start agent run dari board channel → review → deploy ulang.
