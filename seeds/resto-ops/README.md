# Resto Ops (template)

Kasir + peta meja + booking ber-DP + stok untuk restoran dine-in. Jalan dengan `docker compose up`.

**Wajib sebelum jalan (pembayaran):**
```sh
export HITPAY_API_KEY="sk_sandbox_..."   # dari dashboard.sandbox.hit-pay.com > Settings > API Keys
docker compose up
```
Buka http://localhost:8080 — tab Kasir/Meja/Booking/Stok.

- **Kasir**: pesan → bayar via HitPay (QRIS/VA/e-wallet/kartu), stok otomatis berkurang.
- **Meja**: klik untuk toggle Kosong/Terisi/Booked; hitung meja kosong untuk ide promo.
- **Booking**: nama + WA + tanggal/jam + DP Rp 50.000 via HitPay; webhook (`/api/hook`) menandai lunas setelah verifikasi server-side.
- **Stok**: peringatan saat menipis + stok opname (+/-).
- Semua data operasional tersimpan di browser (localStorage) — cocok untuk 1 outlet; naikkan ke DB saat scale-up.

**Kustomisasi via Slaver Team:** buat issue ("tambah diskon member", "laporan harian WA") → Start agent run → review → deploy ke VPS restoran.
