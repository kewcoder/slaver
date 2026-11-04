# Resto Ops — Super App Restoran Dine-in (1 kategori bisnis)

Kasir + peta 2 area makan + booking online + stok + pembayaran HitPay.
**Sengaja TIDAK ada order online / delivery** — order hanya dicatat kasir di
tempat, supaya tim dapur tidak kebanjiran order tak terduga.

Jalan dengan `docker compose up` (perlu `APP_PASSWORD` + `HITPAY_API_KEY`):

```sh
export APP_PASSWORD="kasir123"
export HITPAY_API_KEY="sk_sandbox_..."   # dashboard.sandbox.hit-pay.com > Settings > API Keys
docker compose up
```

Buka http://localhost:8080 — masuk sebagai kasir.

## 2 area makan

- **Dalam (indoor, AC)**: meja D1–D6
- **Saung / Teras (outdoor)**: meja S1–S6
- Status: Kosong (hijau) / Terisi (merah) / Booked (kuning). Klik = toggle Kosong ↔ Terisi; Booked hanya via booking (agen/web).

## Alur utama (dine-in)

1. **Booking online** (tamu dari rumah / via asisten AI): nama + WA + tanggal/jam + jumlah orang + area → meja dikunci (BOOKED) + DP Rp 50.000 via HitPay. Tamu datang → langsung duduk, tanpa antre.
2. **Kasir**: pilih meja → pesan → bayar QRIS/VA/e-wallet → stok berkurang, meja jadi Terisi.
3. **Selesai**: meja dibebaskan (klik / agen via MCP).
4. **Stok**: peringatan menipis + stok opname (+/-).

## MCP connector (wajib untuk semua app Slaver)

App ini expose `POST /mcp` (JSON-RPC `tools/list` + `tools/call`).
Tool: `tables_list`, `menu_list`, `booking_list`, `table_book {name, date, time, [phone, party, area, table]}`, `table_release {table}`.
Daftarkan app yang sudah deploy di Slaver (MCP `connectors_add`), lalu agen
bisa booking meja / cek meja kosong / lihat menu — tanpa software luar.

## Login dengan Slaver

Lihat `OAUTH.md`. Setelah client terdaftar, tombol "Masuk dengan Slaver"
muncul otomatis di halaman login (tukar code di server, secret tidak pernah
ke browser).

## Kustomisasi via Slaver

Template dibeli → fork + project + channel board otomatis. Contoh issue:
"tambah diskon member", "laporan harian WA", "tambah area VIP".
Agen mengerjakan via MCP app ini juga (cek meja, buat booking uji).
