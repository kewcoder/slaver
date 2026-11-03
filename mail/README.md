# Slaver Mail — server email sendiri (anti bayar per email)

Satu container `docker-mailserver` (Postfix + Dovecot + OpenDKIM + SpamAssassin).
Slaver mengirim lewat SMTP port 587; menerima email (IMAP 993) sudah siap
untuk email-app tahap berikutnya. Biaya: harga 1 VPS saja, email unlimited.

> Jujur dulu: email dari server baru 90% masuk spam 2–4 minggu pertama.
> Itu normal (IP belum punya reputasi). Ikuti bagian "Pemanasan" di bawah.

## 0. Syarat VPS (WAJIB, cek sebelum mulai)

1. **Port 25 outbound TERBUKA.** Banyak provider (termasuk sebagian paket murah)
   memblokir port 25. Tes dari VPS: `telnet gmail-smtp-in.l.google.com 25`
   harus tersambung (banner `220 ...`). Kalau timeout → minta buka ke provider
   atau pindah VPS. Port 587/993 inbound juga dibuka di firewall.
2. **IP publik statis + reverse DNS (PTR).** Minta ke provider VPS agar IP
   me-resolve ke nama host mail, mis. `mail.slaver.app`. Tanpa PTR, Gmail
   langsung menolak.
3. **Bukan shared IP reputation buruk.** Cek IP di `multirbl.valli.org` —
   kalau sudah masuk blacklist, minta IP baru.

Slaver (Fly) TIDAK bisa jadi mail server: Fly memblokir port 25 dan tidak
memberi PTR. Mail stack ini jalan di VPS via flow deploy biasa.

## 1. Deploy (5 menit)

```bash
cp mail/.env.example mail/.env   # isi MAIL_DOMAIN dkk
docker compose --env-file mail/.env -f mail/docker-compose.yml up -d
```

## 2. Buat akun email (di VPS)

```bash
docker exec -ti slaver-mail setup email add notif@mail.slaver.app 'PASSWORD-KUAT'
docker exec -ti slaver-mail setup alias add postmaster@mail.slaver.app notif@mail.slaver.app
```

## 3. DNS — cukup ini saja (di Cloudflare, zone slaver.app)

Ganti `mail` dengan subdomain pilihanmu. `<selector>` didapat dari langkah 4.

| Type | Name                    | Content                                              | TTL  | Proxy |
|------|-------------------------|------------------------------------------------------|------|-------|
| A    | mail                    | `<IP-VPS>`                                           | Auto | OFF (abu-abu) |
| MX   | mail (atau @)           | `mail.slaver.app` (priority 10)                      | Auto | n/a   |
| TXT  | mail                    | `v=spf1 mx ~all`                                     | Auto | n/a   |
| TXT  | `<selector>._domainkey.mail` | `v=DKIM1; k=rsa; p=<KUNCI-PUBLIK>`              | Auto | n/a   |
| TXT  | _dmarc.mail             | `v=DMARC1; p=none; rua=mailto:postmaster@mail.slaver.app` | Auto | n/a |

Catatan penting:

- **Jangan proxy (jangan awan oranye)** untuk A `mail` — mail server butuh
  IP asli, bukan IP Cloudflare.
- SPF `~all` (softfail) dulu selama pemanasan; naikkan ke `-all` setelah
  1 bulan stabil.
- DMARC `p=none` dulu (mode pantau); naikkan ke `quarantine` → `reject`
  setelah yakin SPF+DKIM lolos semua.

## 4. DKIM (tanda tangan tiap email keluar)

Di VPS, generate kunci lalu ambil DNS record-nya:

```bash
docker exec -ti slaver-mail setup config dkim
cat /var/lib/docker/volumes/mail_config/_data/opendkim/keys/mail.slaver.app/mail.txt
# -> isi "p=..." ditempel ke TXT <selector>._domainkey.mail (lihat tabel di atas)
```

Restart container setelah config berubah:
`docker compose -f mail/docker-compose.yml restart`.

## 5. Tes kirim (dari laptop/VPS mana pun)

```bash
curl -s -X POST https://slaver.fly.dev/mcp -H 'Content-Type: application/json' \
  -H "Authorization: Bearer <JWT-MU>" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call",
    "params":{"name":"mail_send","arguments":{
      "to":"email-pribadi@gmail.com","subject":"Tes Slaver Mail","text":"Halo dari server sendiri!"}}}'
```

Cek header email yang diterima: harus ada `Authentication-Results`
`spf=pass`, `dkim=pass`, `dmarc=pass`. Cek juga di
`https://www.mail-tester.com` (kirim ke alamat yang diberikannya).

## 6. Pemanasan IP (JANGAN kirim 1 juta langsung)

Minggu 1–2: maks ~100–300 email/hari ke alamat yang pasti dibuka
(akun sendiri, tim). Minta dibuka + jangan ditandai spam.
Minggu 3–4: naikkan 2x lipat tiap 3–4 hari sambil pantau bounce.
Baru setelah itu gas volume besar. IP yang langsung gas 1 juta email
di hari pertama = diblokir Gmail dalam hitungan jam.

## 7. Sambungkan ke Slaver

Di Fly (atau `.env` lokal):

```bash
fly secrets set MAIL_SMTP_HOST="mail.slaver.app" MAIL_SMTP_PORT="587" \
  MAIL_SMTP_USER="notif@mail.slaver.app" MAIL_SMTP_PASS="PASSWORD-KUAT" \
  MAIL_FROM="notif@mail.slaver.app" -a slaver
```

Tanpa 4 secret ini, tool `mail_send` menolak dengan pesan jelas
("mail server belum dikonfigurasi") — tidak ada fallback diam-diam.

## 8. Berikutnya (email app: kirim + terima)

Sisi terima sudah siap (IMAP 993 + alias). Tahap berikut: aplikasi email
di Slaver (inbox per user/team, baca via IMAP, balas via `mail_send`)
— saat itu barulah spam-filtering (SpamAssassin sudah jalan) dan
webmail jadi relevan.
