# Detail Fitur AI Model Meta (Hackathon 2026)

Sumber utama: [dev.meta.ai](https://dev.meta.ai/docs/overview), halaman model resmi per 29 Okt 2026.
Semua model API diakses via **Meta Model API** (satu key, satu billing, kompatibel OpenAI SDK).

---

## 1. Muse Spark 1.3 — agent coding + multimodal generalis

Halaman: [muse-spark](https://dev.meta.ai/models/muse-spark)

- Fokus: **agentic workflow long-horizon**. Ingat konteks + hasil tool sebelumnya, bisa jalan bereskan input berantakan, dan nanya balik kalau butuh.
- Coding kompetitif: first-attempt accuracy tinggi, fewer unnecessary turns, output bersih. Benchmark internal: unggul di DeepSWE v1.1, Terminal-Bench 2.1, SWEAtlas, MRCR 256K-1M vs Spark 1.2 dan kompetitif vs GPT 5.6 / Opus 5.
- Multimodal native: paham **video, image, dokumen**. Visual reasoning jalan di execution environment beneran, bukan scripted steps. Kasih screenshot / clip, dia bisa build.
- Context window: **1M token**.
- Harga API: **$0.10 / 1M input, $0.002 / 1M cached input** (output lihat docs pricing).
- Cocok buat: otak utama app (planner, reasoner, tool caller), verifiable agent dengan citation.

## 2. Muse Wonder / Wonder Full — frontier agent + computer use

Halaman: [muse-wonder](https://dev.meta.ai/models/muse-wonder)

- Dua varian:
  - **Wonder**: coding frontier, long-running agent, advanced computer use. Context 1M. Harga **$4 input / $0.20 cached / $20 output per 1M token**.
  - **Wonder Full**: paling canggih, SOTA di DeepSWE & SWE-Marathon. Akses **hanya via langganan Muse Code** (plan Power / Maximum Usage), bukan API pay-per-token.
- Fitur kunci:
  - **Marathon planning**: delegasi ke sub-agent, parallel tool call, recover dari error, jalan berjam-jam tanpa putus.
  - **Coding multi-file paralel**:แก้ repo besar, verifikasi perubahan lintas file.
  - **Advanced computer use**: lihat + operasikan browser, desktop, mobile app.
  - **Active memory**: bawa konteks penting antar turn, tetap fokus ke goal.
- Cocok buat: task berat multi-step (refactor repo, riset + eksekusi, otomatisasi browser).

## 3. Muse Image — agentic image generation

Halaman: [muse-image](https://dev.meta.ai/models/muse-image)

- Bukan render langsung: **reason dulu baru render**. Bikin plan, ambil referensi web (search grounding), generate + jalanin kode kalau butuh presisi (misal tipografi), cek hasil sebelum balikin.
- Fitur:
  - **Text-to-image** dari deskripsi.
  - **Precise editing**: ubah hanya yang diminta, sisanya utuh.
  - **Anchored composition**: kunci karakter / style / setting dari beberapa reference image biar konsisten antar generasi.
  - **Multi-turn refinement**: iterasi edit beruntun (contoh live di fal).
- Harga: **$0.01 / image**, sudah termasuk search grounding + reasoning. Dibuat untuk volume produksi (varian katalog, personalisasi per user).
- Cocok buat: visual before/after, katalog UMKM, avatar konsisten.

## 4. Muse Voice Transcribe — speech-to-text streaming

Halaman: [muse-voice-transcribe](https://dev.meta.ai/models/muse-voice-transcribe)

- Fokus: **streaming accuracy + latency kompetitif**. WER streaming terdepan di benchmark internal.
- Fitur:
  - **Speaker attribution 20+ speaker + end-of-speech detection** di dalam model recognition (bukan batch pass di akhir).
  - **Contextual & keyword biasing**: akurat di kosakata khusus tanpa fine-tuning.
  - Streaming + punctuation + speech-boundary detection + speaker turn.
- Harga: **$3.00 / 1.000 menit = $0.18 / jam**. Satu model saja.
- Cookbook: [voice_api_fundamentals](https://github.com/meta-models/meta-model-cookbook/tree/main/06_muse_voice/01_voice_api_fundamentals)
- Cocok buat: rapat campur bahasa, voice note warung, grounding timestamp audio.

## 5. SAM 3.1 — Segment Anything (detection + segment + track)

Halaman: [sam-3-1](https://dev.meta.ai/models/sam-3-1)

- Satu model untuk **detect + segmentasi pixel-presisi + tracking video dengan ID preservasi**, zero-shot tanpa training data / tuning / hosting.
- Cara pakai: kasih **noun phrase pendek** ("jamur dinding", "kabel semrawut"), dapat box + mask per match. Bisa juga via prompt lain (lihat docs segmenting).
- Arsitektur DETR, inference purpose-built, throughput produksi hari pertama.
- Terintegrasi satu envelope/key/docs/billing dengan model Meta lain. Gampang digabung: SAM → Spark/Wonder reasoning → Image generate.
- Playground: [coba SAM 3.1](https://dev.meta.ai/playground/segmentation)
- Harga: **$2.50 / 1k images, $0.20 / 1k frames video**.
- Cocok buat: pembeda utama demo visual (Kos Detective, PCB Eye). Jarang dipakai = menonjol di juri.

## 6. Muse Spark Open — open-weight paling capable (US lab)

Halaman: [muse-spark-open](https://dev.meta.ai/models/muse-spark-open)

- Klaim: **open-weight paling capable dari lab US**. Komitmen Meta ke kontrol developer (pilih sendiri mau build di mana).
- Deploy di mana saja: AMD, AWS SageMaker, Baseten, Fireworks, GCP, Groq, HuggingFace, vLLM, Intel, Azure, Modal, Nebius, dll.
- Download: [platform download](https://dev.meta.ai/platform/models/download/muse-spark-open) + [HuggingFace meta-models](https://huggingface.co/collections/meta-models/muse-spark-open)
- Cocok buat: jalur Push the Frontier yang butuh self-host / fine-tune / post-training. Kredit inference Fireworks / Baseten / Modal $100 bisa dipakai di sini.

## 7. Muse Glimmer 30B — open model local always-on agent

Halaman: [muse-glimmer](https://dev.meta.ai/models/muse-glimmer)

- **30B param, lisensi Apache 2.0, jalan di 1 GPU konsumen / Mac**. Dibuat untuk always-on local agent.
- Fitur: reliable tool-calling, persistent state across restart, self-managed memory sesi berjam-jam, multimodal perception built-in.
- Benchmark: unggul vs Gemma4-31B & Qwen3.6-27B di MCP Atlas (75.5), DeepSearch QA (74.6), SWE-Bench Verified (76.0), TerminalBench 2.1 (51.7).
- Download: [Muse-Glimmer-30B](https://huggingface.co/meta-models/Muse-Glimmer-30B). Bisa via transformers, llama.cpp, vLLM, Ollama, Colab.
- Cocok buat: agent lokal / offline, coding lokal, pendamping tanpa biaya API.

## 8. Muse Code — coding agent di terminal

Docs: [muse-code](https://dev.meta.ai/docs/muse-code)

- Multi-agent coding di terminal, dibangun untuk Wonder + Spark.
- Fitur: interactive agent, workflows, session messaging, rewind conversation, config + context, permissions/safety, extend/automate.
- Wonder Full hanya bisa diakses via subscription Muse Code.
- Wajib dipakai selama hackathon (syarat "code faster with Muse Code").

## 9. Kemampuan API yang bisa dikombinasikan

Dari [docs overview](https://dev.meta.ai/docs/overview):

- Tool calling + tool search, search grounding, image understanding, image generation, speech-to-text, video understanding, media segmentation, file handling, reasoning (max/high), structured output, prompt caching, token counting.
- Protokol: Responses API, Chat Completions API, Messages API. Kompatibel OpenAI SDK → quickstart <5 menit.

## 10. Cara pakai buat ide kita (solo, 6 hari)

- Otak default: **Spark 1.3** (murah, konteks 1M, tool-call bagus).
- Naik ke **Wonder** kalau butuh marathon / computer use / repo besar.
- Pembeda demo: **SAM 3.1** (visual mask) + **Voice Transcribe** (timestamp verifiable).
- Visual after: **Muse Image** ($0.01/gambar, aman buat banyak generate).
- Hemat / offline: **Glimmer 30B** lokal, **Spark Open** di Fireworks/Baseten/Modal.
