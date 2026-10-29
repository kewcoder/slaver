# Contoh Aplikasi yang Dilarang (Meta Global AI Hackathon)

Sumber aturan: [HACKATHON.md](/Users/aribahtiar/Documents/slaver-fresh/HACKATHON.md) bagian 4.
Intinya: juri langsung **diskualifikasi** kalau masuk kategori ini, walau teknisnya jalan.

> Aturan umum: repo harus publik, maks 4 orang, demo hanya highlight yang dibangun 27 Okt – 4 Nov, new work only, dilarang melanggar hukum/etik/kebijakan platform atau pakai kode/data/aset tanpa hak.

---

## 1. AI pemberi nasihat medis

Dilarang: diagnosa, rekomendasi obat, interpretasi lab/radiologi untuk pasien.

- ❌ "DokterKos" — upload foto luka + gejala → AI bilang "ini infeksi ringan, minum antibiotik X".
- ❌ "LabReader" — upload hasil darah → AI simpulkan penyakit + dosis.
- ❌ "SehatChat" — chatbot tanya-jawab "kepala pusing kenapa, obatnya apa".

Kenapa gugur: risiko keselamatan, kebijakan platform.

## 2. Basic RAG Application (RAG tempel dokumen)

Dilarang: upload PDF → tanya-jawab standar tanpa kemampuan baru.

- ❌ "TanyaPDF" — upload SOP perusahaan → chatbot jawab pakai retrieval biasa.
- ❌ "SkripsiGPT" — upload jurnal → ringkas + Q&A tanpa verifikasi / agen.
- ❌ "CS Docs Bot" — tempel help-center → widget chat, tanpa tool call / grounding / aksi.

Catatan: RAG masih boleh **kalau** ada nilai agen nyata ( tool call paralel, citation + timestamp terverifikasi, aksi ke sistem ). Tapi kalau cuma Q&A dokumen = jangan.

## 3. Simple Image Analyzer (analisis gambar simpel)

Dilarang: klasifikasi / caption / deteksi objek generik tanpa tindak lanjut.

- ❌ "FotoIniApa" — upload foto → "ini kucing, confidence 98%".
- ❌ "CacatProduk Basic" — upload foto → "ada cacat / tidak", tanpa segment mask, tanpa laporan, tanpa aksi.
- ❌ "PlantSnap Clone" — foto daun → "ini monstera", selesai.

Catatan: pakai **SAM 3.1 mask + tracking + laporan + aksi** (kayak Kos Detective / PCB Eye) itu keluar dari zona "simple". Label doang yang dilarang.

## 4. AI for Education chatbot simpel

Dilarang: chatbot pelajaran generik tanpa pedagogi / verifikasi.

- ❌ "Belajar MTK" — "jawab soal aljabar ini" → kasih jawaban langsung.
- ❌ "EssayKu" — "buatkan esai 500 kata tentang Pancasila".
- ❌ "QuizGen Basic" — paste materi → keluar 10 soal pilihan ganda, tanpa adaptasi / penilaian.

## 5. AI Job Application Screener

Dilarang: filter / ranking pelamar kerja otomatis.

- ❌ "CV Ranker" — upload 100 CV → ranking "siapa layak interview".
- ❌ "CoverLetter Scorer" — skor kepribadian / kecocokan dari surat lamaran.
- ❌ "Interview Filter" — analisis video interview → "lolos / tidak".

Kenapa gugur: bias rekrutmen + kategori eksplisit dilarang.

## 6. AI Nutrition Coach

Dilarang: saran diet / kalori / meal plan personal.

- ❌ "DietKu" — foto makanan → hitung kalori + "kamu harus defisit 500 kkal".
- ❌ "MealPlan AI" — input berat/tinggi → menu diet 7 hari + suplemen.
- ❌ "GymNutrition" — chat "makan apa biar sixpack".

## 7. Personality Analyzer

Dilarang: tebak kepribadian / MBTI / kecocokan dari teks, wajah, sosmed.

- ❌ "WajahBond" — upload selfie → "kamu INTJ, cocok jadi programmer".
- ❌ "TweetPsycho" — input username X → analisis kepribadian + ramalan karir.
- ❌ "JodohAI" — dua foto + chat → skor kecocokan jodoh.

## 8. Sports analyzer / coach

Dilarang: analisis / pelatih olahraga generik.

- ❌ "FormCheck Bola" — upload video tendangan → "postur kamu 7/10, perbaiki lutut".
- ❌ "LariCoach" — input pace → plan marathon + koreksi gaya.
- ❌ "FantasySport AI" — prediksi skor / saran tim fantasy.

## 9. Politik / perang

Dilarang: apa pun yang politis atau terkait perang.

- ❌ "CekHoax Pemilu" — analisis kampanye / citra capres.
- ❌ "DebatAI" — bot debat pro/kontra RUU.
- ❌ "DroneVision" — deteksi target / kendaraan militer dari drone.
- ❌ "Propaganda Tracker" — peta sentimen perang.

## 10. Pelanggaran umum (otomatis gugur)

- ❌ Pakai dataset / API / aset bajakan tanpa lisensi.
- ❌ App yang melanggar kebijakan Meta / hukum (deepfake non-konsensual, bypass safety, scraping ilegal).
- ❌ Demo menampilkan kode lama sebagai "baru". Wajib jelas apa yang dibangun saat hackathon.
- ❌ Repo privat saat submit, video demo tidak bisa diakses, atau asal comot template tanpa kontribusi baru yang jelas.

---

## Checklist cepat sebelum build

1. Ada di daftar 1–9 di atas? Kalau ya, ganti ide.
2. Cuma "upload → label / jawab" tanpa aksi / mask / tool / verifikasi? Itu Simple Analyzer / Basic RAG. Tambahkan agen + aksi nyata.
3. Bisa tunjukkan di video 3 menit apa yang baru dibangun 27 Okt – 4 Nov? Kalau tidak, perjelas scope.
