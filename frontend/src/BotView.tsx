import { useCallback, useEffect, useRef, useState } from "react";
import { BotAvatar, Spinner } from "./ui";
import {
  createSchedule,
  deleteSchedule,
  fetchBotDetail,
  fetchChildren,
  fetchSchedules,
  fetchSummaries,
  runSummary,
  spawnSubBot,
  updateBot,
  updateSchedule,
  uploadAvatar,
  type BotSchedule,
  type ProviderInfo,
  type SlaveBot,
  type Summaries,
} from "./api";

const AURA_VOICES = ["luna", "athena", "orion", "zeus", "hera", "perseus", "angus", "stella"];

export function SchedulesView({ botId }: { botId: string }) {
  const [schedules, setSchedules] = useState<BotSchedule[]>([]);
  const [kind, setKind] = useState("daily");
  const [time, setTime] = useState("07:00");
  const [days, setDays] = useState("all");
  const [interval, setInterval] = useState("60");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setSchedules(await fetchSchedules(botId));
    } catch {
      /* keep old list on transient failure */
    }
  }, [botId]);

  useEffect(() => {
    setSchedules([]);
    setError("");
    void load();
  }, [botId, load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;
    setBusy(true);
    setError("");
    try {
      await createSchedule(botId, {
        kind,
        time_hhmm: time,
        days,
        interval_minutes: Number(interval) || 60,
        prompt: prompt.trim(),
      });
      setPrompt("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create schedule.");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(s: BotSchedule) {
    setError("");
    try {
      await updateSchedule(s.id, !s.active);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update schedule.");
    }
  }

  async function remove(s: BotSchedule) {
    if (!window.confirm(`Delete schedule "${s.name}"?`)) return;
    setError("");
    try {
      await deleteSchedule(s.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete schedule.");
    }
  }

  const inputCls =
    "mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none";

  return (
    <div className="mb-8 rounded-lg border border-zinc-800 bg-zinc-900 p-5">
      <h3 className="font-semibold text-zinc-200">Jadwal otomatis</h3>
      <p className="mb-3 mt-1 text-xs text-zinc-500">
        Asisten mengerjakan ini sendiri sesuai jam Jakarta — cth. ringkasan pagi yang masuk ke riwayat chat.
        Bisa juga ketik <span className="text-zinc-300">/remind daily 07:00 ...</span> di chat, atau <span className="text-zinc-300">/schedules</span> untuk lihat daftar.
      </p>
      {schedules.length === 0 ? (
        <p className="mb-3 text-sm text-zinc-500">Belum ada jadwal.</p>
      ) : (
        <ul className="mb-4 flex flex-col gap-2">
          {schedules.map((s) => (
            <li key={s.id} className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm">
              <span className={`h-2 w-2 shrink-0 rounded-full ${s.active ? "bg-emerald-500" : "bg-zinc-600"}`} title={s.active ? "On" : "Off"} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-zinc-200">{s.name}</span>
                <span className="block truncate text-xs text-zinc-500">
                  {s.kind === "interval" ? `tiap ${s.interval_minutes} mnt` : `${s.kind} ${s.time_hhmm} (${s.days})`}
                  {" · berikut "}{s.next_run_at || "—"}
                  {" · "}{s.prompt}
                </span>
              </span>
              <button type="button" onClick={() => toggle(s)} className="rounded px-2 py-1 text-xs font-semibold text-zinc-300 hover:bg-zinc-800">
                {s.active ? "Jeda" : "Jalan"}
              </button>
              <button type="button" onClick={() => remove(s)} className="rounded px-2 py-1 text-xs font-semibold text-zinc-500 hover:bg-zinc-800 hover:text-red-400">
                Hapus
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={create} className="grid grid-cols-2 gap-2">
        <label className="col-span-2 text-sm font-semibold text-zinc-300">
          Tugas untuk asisten
          <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="cth. Kirim ringkasan pagi" maxLength={1000} className={inputCls} />
        </label>
        <label className="text-sm font-semibold text-zinc-300">
          Ulangi
          <select value={kind} onChange={(e) => setKind(e.target.value)} className={inputCls}>
            <option value="daily">Harian</option>
            <option value="once">Sekali</option>
            <option value="interval">Tiap N menit</option>
          </select>
        </label>
        {kind === "interval" ? (
          <label className="text-sm font-semibold text-zinc-300">
            Menit (5 atau lebih)
            <input value={interval} onChange={(e) => setInterval(e.target.value)} inputMode="numeric" className={inputCls} />
          </label>
        ) : (
          <label className="text-sm font-semibold text-zinc-300">
            Jam (Jakarta)
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={inputCls} />
          </label>
        )}
        {kind === "daily" && (
          <label className="col-span-2 text-sm font-semibold text-zinc-300">
            Hari
            <select value={days} onChange={(e) => setDays(e.target.value)} className={inputCls}>
              <option value="all">Setiap hari</option>
              <option value="weekdays">Senin–Jumat</option>
              <option value="weekends">Akhir pekan</option>
            </select>
          </label>
        )}
        <div className="col-span-2">
          <button type="submit" disabled={busy || !prompt.trim()} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
            {busy ? "Menambah..." : "Tambah jadwal"}
          </button>
        </div>
      </form>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </div>
  );
}

export function TeamView({ bot, onOpenBot, onTeamChanged }: { bot: SlaveBot; onOpenBot: (id: string) => void; onTeamChanged: () => void }) {
  const [children, setChildren] = useState<SlaveBot[]>([]);
  const [parent, setParent] = useState<SlaveBot | null>(null);
  const [subName, setSubName] = useState("");
  const [subRole, setSubRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setChildren(await fetchChildren(bot.id));
    } catch {
      /* keep old list */
    }
    if (bot.parent_id) {
      try {
        const detail = await fetchBotDetail(bot.parent_id);
        setParent(detail.slavebot);
      } catch {
        setParent(null);
      }
    } else {
      setParent(null);
    }
  }, [bot.id, bot.parent_id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function spawn(e: React.FormEvent) {
    e.preventDefault();
    if (!subName.trim()) return;
    setBusy(true);
    setError("");
    try {
      const child = await spawnSubBot(bot.id, { name: subName.trim(), role: subRole.trim() });
      setSubName("");
      setSubRole("");
      setChildren((prev) => [...prev, child]);
      onTeamChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not spawn sub-bot.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-8 rounded-lg border border-zinc-800 bg-zinc-900 p-5">
      <h3 className="font-semibold text-zinc-200">Tim kecil</h3>
      <p className="mb-3 mt-1 text-xs text-zinc-500">
        Asisten bisa punya anak buah untuk tugas khusus. Anak buah lapor ke atasannya dan bisa diajak rapat, dijadwal, dan dimasukkan grup seperti asisten biasa.
      </p>
      {parent && (
        <p className="mb-2 text-sm text-zinc-300">
          Atasan:{" "}
          <button type="button" onClick={() => onOpenBot(parent.id)} className="font-semibold text-emerald-400 hover:underline">
            {parent.name}
          </button>
          {parent.role && <span className="text-zinc-500"> · {parent.role}</span>}
        </p>
      )}
      {children.length > 0 ? (
        <ul className="mb-3 flex flex-col gap-2">
          {children.map((c) => (
            <li key={c.id} className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm">
              <BotAvatar bot={c} size="sm" />
              <button type="button" onClick={() => onOpenBot(c.id)} className="min-w-0 flex-1 text-left">
                <span className="block truncate font-semibold text-zinc-200">{c.name}</span>
                {(c.role || c.title) && <span className="block truncate text-xs text-zinc-500">{c.role || c.title}</span>}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-3 text-sm text-zinc-500">Belum ada anak buah.</p>
      )}
      <form onSubmit={spawn} className="grid grid-cols-2 gap-2">
        <label className="text-sm font-semibold text-zinc-300">
          Nama anak buah
          <input
            value={subName}
            onChange={(e) => setSubName(e.target.value)}
            placeholder="cth. Pramuniaga"
            maxLength={40}
            className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
          />
        </label>
        <label className="text-sm font-semibold text-zinc-300">
          Tugas
          <input
            value={subRole}
            onChange={(e) => setSubRole(e.target.value)}
            placeholder="cth. Catat harga kompetitor"
            maxLength={120}
            className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
          />
        </label>
        <div className="col-span-2">
          <button type="submit" disabled={busy || !subName.trim()} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
            {busy ? "Menambah..." : "Tambah anak buah"}
          </button>
        </div>
      </form>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </div>
  );
}
export function BotView({
  bot,
  providerInfo,
  partnerName,
  onSaved,
  onOpenBot,
  onTeamChanged,
}: {
  bot: SlaveBot;
  providerInfo: ProviderInfo | null;
  partnerName: string;
  onSaved: (bot: SlaveBot) => void;
  onOpenBot: (id: string) => void;
  onTeamChanged: () => void;
}) {
  const [name, setName] = useState(bot.name);
  const [memory, setMemory] = useState(bot.memory);
  const [role, setRole] = useState(bot.role || "");
  const [model, setModel] = useState(bot.model);
  const [voice, setVoice] = useState(bot.voice || "luna");
  const [activeDays, setActiveDays] = useState(bot.active_days || "all");
  const [activeStart, setActiveStart] = useState(bot.active_start || "");
  const [activeEnd, setActiveEnd] = useState(bot.active_end || "");
  const [relay, setRelay] = useState((bot.relay ?? 1) !== 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<Summaries | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setName(bot.name);
    setMemory(bot.memory);
    setRole(bot.role || "");
    setModel(bot.model);
    setVoice(bot.voice || "luna");
    setActiveDays(bot.active_days || "all");
    setActiveStart(bot.active_start || "");
    setActiveEnd(bot.active_end || "");
    setError("");
    setSummaries(null);
    fetchSummaries(bot.id).then(setSummaries).catch(() => {});
  }, [bot.id, bot.name, bot.memory, bot.role, bot.model, bot.voice, bot.active_days, bot.active_start, bot.active_end]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const updated = await updateBot(bot.id, {
        name,
        memory,
        role,
        model,
        voice,
        active_days: activeDays,
        active_start: activeStart,
        active_end: activeEnd,
        relay,
      });
      onSaved(updated);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleArchive() {
    setBusy(true);
    setError("");
    try {
      const updated = await updateBot(bot.id, { archived: !bot.archived });
      onSaved(updated);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update archive state.");
    } finally {
      setBusy(false);
    }
  }

  async function togglePin() {
    if (!bot.pinned && bot.archived) {
      setError("Restore the bot before pinning it.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const updated = await updateBot(bot.id, { pinned: !bot.pinned });
      onSaved(updated);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update pin state.");
    } finally {
      setBusy(false);
    }
  }

  async function summarizeNow() {
    setSummarizing(true);
    setError("");
    try {
      const res = await runSummary(bot.id);
      if (!res.summary) setError(res.note ?? "Nothing to summarize yet.");
      setSummaries(await fetchSummaries(bot.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Summarization failed.");
    } finally {
      setSummarizing(false);
    }
  }

  async function onAvatarFile(file: File | undefined) {
    if (!file) return;
    setAvatarBusy(true);
    setError("");
    try {
      await uploadAvatar(bot.id, file);
      const detail = await fetchBotDetail(bot.id);
      onSaved(detail.slavebot);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Avatar upload failed.");
    } finally {
      setAvatarBusy(false);
    }
  }

  const inputCls =
    "mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none";

  return (
    <div className="mx-auto w-full max-w-2xl p-6">
      <div className="mb-6 flex items-center gap-4">
        <BotAvatar bot={bot} size="lg" />
        <div>
          {titleEdit === null ? (
            <button
              type="button"
              onClick={() => setTitleEdit(bot.name)}
              title="Ganti nama asisten"
              className="rounded px-1 text-left text-xl font-bold text-zinc-100 hover:bg-zinc-800"
            >
              {bot.name}
            </button>
          ) : (
            <input
              value={titleEdit}
              onChange={(e) => setTitleEdit(e.target.value.slice(0, 40))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const next = titleEdit.trim();
                  if (next && next !== bot.name) {
                    setName(next);
                    void (async () => {
                      try {
                        const updated = await updateBot(bot.id, { name: next });
                        onSaved(updated);
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "Could not rename.");
                      }
                    })();
                  }
                  setTitleEdit(null);
                } else if (e.key === "Escape") {
                  setTitleEdit(null);
                }
              }}
              onBlur={() => setTitleEdit(null)}
              autoFocus
              maxLength={40}
              aria-label="Ganti nama asisten"
              className="w-full max-w-xs rounded-md border border-emerald-600 bg-zinc-800 px-2 py-0.5 text-xl font-bold text-zinc-100 focus:outline-none"
            />
          )}
          {bot.title && <p className="text-sm text-zinc-400">{bot.title}</p>}
          <p className="mt-0.5 text-xs text-zinc-500">◈ Partner: {partnerName} · ganti di Pengaturan → Tim</p>
        </div>
      </div>

      <form onSubmit={save} className="mb-8 flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-5">
        <h3 className="font-semibold text-zinc-200">Identitas</h3>
        <label className="text-sm font-semibold text-zinc-300">
          Nama
          <input value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} maxLength={40} className={inputCls} />
        </label>
        <label className="text-sm font-semibold text-zinc-300">
          Tugas
          <input
            value={role}
            onChange={(e) => { setRole(e.target.value); setSaved(false); }}
            placeholder="cth. Kasir — rekap penjualan harian"
            maxLength={120}
            className={inputCls}
          />
        </label>
        <p className="-mt-2 text-xs text-zinc-500">Tugas menentukan kapan asisten ikut rapat: hanya topik yang cocok dengan pekerjaannya. Asisten baru menanyakan ini di pesan pertama.</p>
        <label className="text-sm font-semibold text-zinc-300">
          Foto
          <span className="mt-1 flex items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="sr-only"
              onChange={(e) => onAvatarFile(e.target.files?.[0])}
            />
            <button type="button" disabled={avatarBusy} onClick={() => fileRef.current?.click()} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">
              {avatarBusy ? "Mengunggah..." : "Unggah foto (maks 2 MB)"}
            </button>
          </span>
        </label>
        <label className="text-sm font-semibold text-zinc-300">
          Model AI <span className="font-normal text-zinc-500">(nama persis dari penyedia AI)</span>
          <input value={model} onChange={(e) => { setModel(e.target.value); setSaved(false); }} list="bot-model-list" placeholder={providerInfo?.custom_allowed ? (providerInfo.example_models || "e.g. qwen3:8b") : "pick a model"} spellCheck={false} className={`${inputCls} font-mono ${!model.trim() ? "border-amber-600" : ""}`} />
          <datalist id="bot-model-list">
            {(providerInfo?.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </datalist>
          {providerInfo && (
            <span className="mt-1 block text-xs font-normal text-zinc-500">
              Penyedia: {providerInfo.provider_label ?? providerInfo.provider}
              {providerInfo.default ? ` · bawaan ${providerInfo.default}` : " · ketik manual"}
              {providerInfo.example_models ? ` · ${providerInfo.example_models}` : ""}
            </span>
          )}
          {!model.trim() && (
            <span className="mt-1 block rounded-md border border-amber-800 bg-amber-950/60 px-2 py-1 text-xs font-normal text-amber-200">
              Model belum diisi — chat akan gagal. Isi nama model yang persis, atau cek daftar di Tim → Simpan + tes koneksi.
            </span>
          )}
        </label>
        <label className="text-sm font-semibold text-zinc-300">
          Suara (balasan bersuara)
          <select value={voice} onChange={(e) => { setVoice(e.target.value); setSaved(false); }} className={inputCls}>
            {AURA_VOICES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <p className="-mt-2 text-xs text-zinc-500">Tombol Bicara dan chat hands-free memakai suara ini.</p>
        <label className="flex items-center gap-2 text-sm font-semibold text-zinc-300">
          <input
            type="checkbox"
            checked={relay}
            onChange={(e) => { setRelay(e.target.checked); setSaved(false); }}
            className="h-4 w-4 accent-emerald-600"
          />
          Biarkan {bot.name} bertanya ke asisten lain sendiri
        </label>
        <p className="-mt-2 text-xs font-normal text-zinc-500">Jika aktif, asisten boleh bertanya ke rekan timnya dulu sebelum menjawab. Kamu cukup chat ke satu asisten.</p>
        <div className="grid grid-cols-3 gap-2">
          <label className="text-sm font-semibold text-zinc-300">
            Hari aktif
            <select value={activeDays} onChange={(e) => { setActiveDays(e.target.value); setSaved(false); }} className={inputCls}>
              <option value="all">Setiap hari</option>
              <option value="weekdays">Senin–Jumat</option>
              <option value="weekends">Akhir pekan</option>
            </select>
          </label>
          <label className="text-sm font-semibold text-zinc-300">
            Aktif dari jam
            <input type="time" value={activeStart} onChange={(e) => { setActiveStart(e.target.value); setSaved(false); }} className={inputCls} />
          </label>
          <label className="text-sm font-semibold text-zinc-300">
            Aktif sampai jam
            <input type="time" value={activeEnd} onChange={(e) => { setActiveEnd(e.target.value); setSaved(false); }} className={inputCls} />
          </label>
        </div>
        <p className="-mt-2 text-xs text-zinc-500">Tugas terjadwal hanya jalan di jam ini (waktu Jakarta). Kosongkan agar selalu aktif.</p>
        <label className="text-sm font-semibold text-zinc-300">
          Ingatan
          <textarea
            value={memory}
            onChange={(e) => { setMemory(e.target.value); setSaved(false); }}
            placeholder={"cth. Pemilik suka jawaban singkat. Menu andalan: nasi timbel…"}
            rows={5}
            maxLength={4000}
            className={inputCls}
          />
        </label>
        <p className="-mt-1 text-xs text-zinc-500">Ingatan selalu dibaca asisten di setiap chat sebagai fakta tentang usahamu.</p>
        {error && <p className="text-sm text-red-400">{error}</p>}
        {saved && <p className="text-sm font-semibold text-emerald-400">Tersimpan.</p>}
        <div className="flex items-center gap-3">
          <button type="submit" disabled={busy} className="rounded-md bg-emerald-600 px-6 py-2 font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
            {busy ? "Menyimpan..." : "Simpan"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={togglePin}
            title={bot.pinned ? "Lepas: tidak ada asisten yang terbuka otomatis" : "Sematkan: asisten ini terbuka otomatis tiap kunjungan"}
            className={`rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-50 ${bot.pinned ? "border-emerald-600 text-emerald-400 hover:bg-emerald-950" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`}
          >
            {bot.pinned ? "Lepas" : "Sematkan"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={toggleArchive}
            title={bot.archived ? "Kembalikan asisten ke daftar aktif" : "Sembunyikan asisten (riwayat tetap ada)"}
            className={`rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-50 ${bot.archived ? "border-emerald-600 text-emerald-400 hover:bg-emerald-950" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`}
          >
            {bot.archived ? "Kembalikan" : "Arsipkan"}
          </button>
        </div>
      </form>

      <SchedulesView botId={bot.id} />

      <TeamView bot={bot} onOpenBot={onOpenBot} onTeamChanged={onTeamChanged} />

      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold text-zinc-200">Ringkasan obrolan</h3>
          <button type="button" disabled={summarizing} onClick={summarizeNow} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">
            {summarizing ? <Spinner /> : "Buat ringkasan"}
          </button>
        </div>
        <p className="mb-3 text-xs text-zinc-500">Ringkasan harian dibuat tiap malam; mingguan tiap Senin; bulanan tiap tanggal 1. Asisten membacanya sebagai ingatan lama.</p>
        {!summaries ? (
          <div className="space-y-2" aria-label="Loading summaries">
            <div className="loading-skeleton h-10 w-full" />
            <div className="loading-skeleton h-10 w-full" />
          </div>
        ) : summaries.daily.length + summaries.weekly.length + summaries.monthly.length === 0 ? (
          <p className="text-sm text-zinc-400">Belum ada ringkasan — chat dulu, lalu buat ringkasan.</p>
        ) : (
          (["monthly", "weekly", "daily"] as const).map((period) =>
            summaries[period].map((s) => (
              <details key={s.id} className="mb-2 rounded-md border border-zinc-800 bg-zinc-950 p-3">
                <summary className="cursor-pointer text-sm font-semibold text-zinc-300">
                  {period === "monthly" ? "Bulanan" : period === "weekly" ? "Mingguan" : "Harian"} · {s.period_key}
                </summary>
                <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-400">{s.content}</p>
              </details>
            )),
          )
        )}
      </div>
    </div>
  );
}
