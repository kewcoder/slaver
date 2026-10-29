# Kategori yang Boleh + Rekomendasi (Hackathon Meta 2026)

Sumber aturan: [HACKATHON.md](HACKATHON.md). Pendamping: [META_MODELS.md](META_MODELS.md) + [BANNED_EXAMPLES.md](BANNED_EXAMPLES.md).

## 1. Dua track resmi (pilih satu saat submit)

### A. Build for Your World
Bawa model Meta ke domain yang kamu kenal. Selesaikan masalah nyata, hemat waktu / mental load, bikin hal yang sebelumnya tidak mungkin.
Contoh boleh: kos, warung/UMKM, freelance, kampus, komunitas, workflow pribadi.
Juri menilai: masalahnya real? Kamu paham user-nya? Dipakai beneran?

### B. Push the Frontier
Pakai model Meta untuk kasih kemampuan baru ke mesin / percepat eksperimen / pahami + kontrol sistem fisik.
Contoh boleh: segmentasi + tracking hardware, robot, manufaktur, energi, material, alat lab, computer use.
Juri menilai: ada kemampuan baru? Ada demo fisik / sistem nyata?

### Syarat lolos viability (Stage 1)
1. Masuk salah satu track di atas.
2. Pakai Meta Model API / open-weight secara masuk akal (bukan tempelan satu call).
3. Repo publik, new work 27 Okt – 4 Nov jelas, video 3 menit bisa diakses.

## 2. Pola yang aman (tidak masuk daftar banned)

- **Agen terverifikasi**: setiap klaim AI bisa diklik ke bukti (timestamp audio, box/mask SAM, sitasi tool).
- **Agen aksi**: bukan cuma jawab, tapi eksekusi (bikin PDF, kirim laporan, generate image after, buat PR/changelog).
- **Multimodal beneran**: gabung minimal 2 model, misal SAM 3.1 → Spark 1.3 → Image, atau Voice Transcribe → Spark.
- **Computer use / long-running**: Wonder untuk browser / repo besar / task berjam-jam.
- **Lokal / open-weight**: Glimmer 30B untuk always-on lokal, Spark Open untuk self-host / fine-tune via Fireworks/Baseten/Modal.

## 3. Rekomendasi untuk solo, 6 hari (29 Okt – 4 Nov)

### R1. Kos Detective (rekomendasi utama) — Build for Your World
- Masalah: anak kos vs pemilik soal jamur, retak, kabel, rembes. Bukti foto berantakan.
- Flow: upload foto kamar → SAM 3.1 segment (mask + box) → Spark 1.3 bikin laporan (lokasi, severity, estimasi, chat ke pemilik) → Muse Image bikin visual "sesudah diperbaiki".
- Kenapa menang: demo sangat visual, SAM jarang dipakai, jelas bukan "simple analyzer" karena ada mask + laporan + aksi.
- Stack: Next.js 1 page + Meta Model API (SAM + Spark + Image). Simpan PDF, tanpa auth.
- Demo 3 menit: 0:00 masalah → 0:30 upload → 1:00 mask muncul → 1:45 laporan PDF → 2:30 visual after → 2:50 stack Meta.

### R2. Rapat Warung — Build for Your World
- Masalah: voice note campur Indo-Jawa, keputusan hilang.
- Flow: upload audio → Voice Transcribe (speaker 20+, timestamp) → Spark ekstrak action item, tiap item klik → loncat ke detik audio.
- Kenapa menang: pas materi Agents 102 (verifiable agent), Bahasa Indonesia nilai plus.
- Stack: 1 page upload + player audio + list aksi. Tanpa RAG berat.
- Demo: putar audio → teks + speaker muncul live → klik aksi → audio loncat.

### R3. PCB Eye — Push the Frontier
- Masalah: servis elektronik lambat identifikasi komponen.
- Flow: foto PCB → SAM 3.1 segment tiap komponen → Wonder/Spark kasih nama + fungsi + langkah test + risiko.
- Kenapa menang: frontier beneran (kasih mesin penglihatan hardware), zero-shot tanpa training.
- Stack: sama kayak R1 tapi prompt fourniture elektronik. Butuh 1 PCB fisik buat video.
- Demo: foto → mask komponen → klik komponen → instruksi test.

### R4. Bukti Kerja — Push the Frontier (plan B / pendamping)
- Masalah: juri wajib lihat "new work only", susah buktiin manual.
- Flow: connect repo → Spark Open/Wonder bedakan commit 27 Okt–4 Nov → generate changelog verifiable + skrip video demo.
- Kenapa menang: meta, berguna untuk semua peserta, tunjukkan marathon planning Wonder.
- Risiko: terlihat seperti tooling, bukan produk user. Jadikan pendamping, bukan utama, kecuali kamu suka tooling.

## 4. Keputusan cepat

| Kalau kamu... | Pilih |
|---|---|
| Mau peluang menang terbesar solo | R1 Kos Detective |
| Kuat di audio / Bahasa Indonesia | R2 Rapat Warung |
| Punya PCB / suka hardware | R3 PCB Eye |
| Suka tooling developer | R4 sebagai fitur kedua R1 |

Rekomendasi final: **bangun R1, selipkan R2 sebagai tab kedua** (sama-sama Spark + 1 upload page). Satu codebase, dua demo, tetap solo-able.

## 5. Plan 6 hari (solo)

- 29 Okt: setup Meta API key + claim $150 credit, skeleton upload + tampilkan mask SAM.
- 30 Okt: laporan Spark + PDF.
- 31 Okt: Image after + polish UI.
- 1 Nov: voice tab (R2) kalau sempat.
- 2 Nov: rekam video 3 menit + rapikan README demo.
- 3 Nov: tanya troubleshooting terakhir di Discord.
- 4 Nov 21:00 ET: submit (repo publik + video accessible + anggota lengkap).
