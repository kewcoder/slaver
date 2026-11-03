# Login dengan Slaver — Resto Ops

## 1. Daftarkan OAuth client (Slaver → Pengaturan → Login dengan Slaver)

- Nama aplikasi: mis. `Resto Ops Warung Saya`
- Redirect URI (WAJIB persis): `https://kasir.tokomu.com/oauth-callback.html`
- Simpan Client ID + Client Secret (sekali tampil).

## 2. Isi env lalu `docker compose up -d`

```sh
OAUTH_CLIENT_ID=...
OAUTH_CLIENT_SECRET=...
SLAVER_URL=https://www.slaver.app   # default ini bila dikosongkan
```

## 3. Hasilnya

Tombol "Masuk dengan Slaver" muncul di halaman login. Klik → consent di
Slaver → kembali → server menukar code + mengambil profil → masuk sebagai
staf (nama + email + tim + peran tersimpan di browser).

Tanpa env di atas, login tetap bisa dengan `APP_PASSWORD` kasir.
