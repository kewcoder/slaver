# Login dengan Slaver — Mail App

Tombol **"Masuk dengan Slaver"** di halaman login memakai OAuth Slaver
(`team: <id>` scope default: profil + email user). Langkah owner sekali saja:

## 1. Daftarkan OAuth client (di Slaver → Pengaturan → Login dengan Slaver)

- Nama aplikasi: mis. `Webmail Toko Saya`
- Redirect URI (WAJIB persis, tanpa wildcard):
  `https://mail.tokomu.com/oauth-callback.html`
  (ganti dengan domain/IP tempat app ini di-deploy; untuk uji lokal:
  `http://localhost:8080/oauth-callback.html`)
- Simpan **Client ID** + **Client Secret** (secret tampil sekali).

## 2. Isi env di `docker-compose.yml` lalu `up -d` ulang

```yaml
- SLAVER_URL=https://www.slaver.app
- OAUTH_CLIENT_ID=<client_id>
- OAUTH_CLIENT_SECRET=<client_secret>
```

Setelah itu tombol "Masuk dengan Slaver" otomatis muncul di halaman login.
Alurnya: klik → consent di Slaver → kembali ke `/oauth-callback.html` →
server menukar code dengan token (secret tidak pernah ke browser) →
dapat cookie sesi → langsung ke inbox.

## 3. Catatan keamanan

- Tanpa OAuth pun aplikasi tetap terkunci `APP_PASSWORD` (wajib diisi).
- Client secret hanya hidup di env server, tidak pernah dikirim ke browser.
- Untuk multi-user penuh (inbox per user), butuh mailbox per user di
  server IMAP + pemetaan user Slaver → akun IMAP (rencana v2).
