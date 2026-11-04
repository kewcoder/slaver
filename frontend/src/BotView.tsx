import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useLang } from "./i18n";
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
  const { t } = useLang();
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
      setError(err instanceof Error ? err.message : t("bot.errSchedCreate"));
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
      setError(err instanceof Error ? err.message : t("bot.errSchedUpdate"));
    }
  }

  async function remove(s: BotSchedule) {
    if (!window.confirm(t("bot.schedDeleteConfirm").replace("{name}", s.name))) return;
    setError("");
    try {
      await deleteSchedule(s.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bot.errSchedDelete"));
    }
  }

  const inputCls =
    "mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none";

  function daysLabel(d: string): string {
    if (d === "weekdays") return t("bot.schedDaysWeek");
    if (d === "weekends") return t("bot.schedDaysEnd");
    return t("bot.schedDaysAll");
  }

  function kindLabel(k: string): string {
    if (k === "once") return t("bot.schedOnce");
    if (k === "interval") return t("bot.schedInterval");
    return t("bot.schedDaily");
  }

  return (
    <div className="mb-8 rounded-lg border border-zinc-800 bg-zinc-900 p-5">
      <h3 className="font-semibold text-zinc-200">{t("bot.schedTitle")}</h3>
      <p className="mb-3 mt-1 text-xs text-zinc-500">
        {t("bot.schedBody").split(/(\{remind\}|\{list\})/).map((part, i) =>
          part === "{remind}" ? (
            <span key={i} className="text-zinc-300">/remind daily 07:00 ...</span>
          ) : part === "{list}" ? (
            <span key={i} className="text-zinc-300">/schedules</span>
          ) : (
            <Fragment key={i}>{part}</Fragment>
          ),
        )}
      </p>
      {schedules.length === 0 ? (
        <p className="mb-3 text-sm text-zinc-500">{t("bot.noSched")}</p>
      ) : (
        <ul className="mb-4 flex flex-col gap-2">
          {schedules.map((s) => (
            <li key={s.id} className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm">
              <span className={`h-2 w-2 shrink-0 rounded-full ${s.active ? "bg-emerald-500" : "bg-zinc-600"}`} title={s.active ? "On" : "Off"} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-zinc-200">{s.name}</span>
                <span className="block truncate text-xs text-zinc-500">
                  {s.kind === "interval" ? t("bot.schedEvery").replace("{n}", String(s.interval_minutes)) : `${kindLabel(s.kind)} ${s.time_hhmm} (${daysLabel(s.days)})`}
                  {" · "}{t("bot.schedNext")} {s.next_run_at || "—"}
                  {" · "}{s.prompt}
                </span>
              </span>
              <button type="button" onClick={() => toggle(s)} className="rounded px-2 py-1 text-xs font-semibold text-zinc-300 hover:bg-zinc-800">
                {s.active ? t("bot.schedPause") : t("bot.schedResume")}
              </button>
              <button type="button" onClick={() => remove(s)} className="rounded px-2 py-1 text-xs font-semibold text-zinc-500 hover:bg-zinc-800 hover:text-red-400">
                {t("bot.schedDelete")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={create} className="grid grid-cols-2 gap-2">
        <label className="col-span-2 text-sm font-semibold text-zinc-300">
          {t("bot.schedTask")}
          <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t("bot.schedTaskPh")} maxLength={1000} className={inputCls} />
        </label>
        <label className="text-sm font-semibold text-zinc-300">
          {t("bot.schedRepeat")}
          <select value={kind} onChange={(e) => setKind(e.target.value)} className={inputCls}>
            <option value="daily">{t("bot.schedDaily")}</option>
            <option value="once">{t("bot.schedOnce")}</option>
            <option value="interval">{t("bot.schedInterval")}</option>
          </select>
        </label>
        {kind === "interval" ? (
          <label className="text-sm font-semibold text-zinc-300">
            {t("bot.schedMinutes")}
            <input value={interval} onChange={(e) => setInterval(e.target.value)} inputMode="numeric" className={inputCls} />
          </label>
        ) : (
          <label className="text-sm font-semibold text-zinc-300">
            {t("bot.schedTime")}
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={inputCls} />
          </label>
        )}
        {kind === "daily" && (
          <label className="col-span-2 text-sm font-semibold text-zinc-300">
            {t("bot.schedDays")}
            <select value={days} onChange={(e) => setDays(e.target.value)} className={inputCls}>
              <option value="all">{t("bot.schedDaysAll")}</option>
              <option value="weekdays">{t("bot.schedDaysWeek")}</option>
              <option value="weekends">{t("bot.schedDaysEnd")}</option>
            </select>
          </label>
        )}
        <div className="col-span-2">
          <button type="submit" disabled={busy || !prompt.trim()} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
            {busy ? t("bot.schedAdding") : t("bot.schedAdd")}
          </button>
        </div>
      </form>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </div>
  );
}

export function TeamView({ bot, onOpenBot, onTeamChanged }: { bot: SlaveBot; onOpenBot: (id: string) => void; onTeamChanged: () => void }) {
  const { t } = useLang();
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
      setError(err instanceof Error ? err.message : t("bot.errSpawn"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-8 rounded-lg border border-zinc-800 bg-zinc-900 p-5">
      <h3 className="font-semibold text-zinc-200">{t("bot.teamTitle")}</h3>
      <p className="mb-3 mt-1 text-xs text-zinc-500">
        {t("bot.teamBody")}
      </p>
      {parent && (
        <p className="mb-2 text-sm text-zinc-300">
          {t("bot.teamReports")}{" "}
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
        <p className="mb-3 text-sm text-zinc-500">{t("bot.noChildren")}</p>
      )}
      <form onSubmit={spawn} className="grid grid-cols-2 gap-2">
        <label className="text-sm font-semibold text-zinc-300">
          {t("bot.childName")}
          <input
            value={subName}
            onChange={(e) => setSubName(e.target.value)}
            placeholder={t("bot.childNamePh")}
            maxLength={40}
            className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
          />
        </label>
        <label className="text-sm font-semibold text-zinc-300">
          {t("bot.childRole")}
          <input
            value={subRole}
            onChange={(e) => setSubRole(e.target.value)}
            placeholder={t("bot.childRolePh")}
            maxLength={120}
            className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
          />
        </label>
        <div className="col-span-2">
          <button type="submit" disabled={busy || !subName.trim()} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
            {busy ? t("bot.childAdding") : t("bot.childAdd")}
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
  const { t } = useLang();
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
      setError(err instanceof Error ? err.message : t("bot.errSave"));
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
      setError(err instanceof Error ? err.message : t("bot.errArchive"));
    } finally {
      setBusy(false);
    }
  }

  async function togglePin() {
    if (!bot.pinned && bot.archived) {
      setError(t("bot.errPinArchived"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const updated = await updateBot(bot.id, { pinned: !bot.pinned });
      onSaved(updated);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bot.errPin"));
    } finally {
      setBusy(false);
    }
  }

  async function summarizeNow() {
    setSummarizing(true);
    setError("");
    try {
      const res = await runSummary(bot.id);
      if (!res.summary) setError(res.note ?? t("bot.errRecapEmpty"));
      setSummaries(await fetchSummaries(bot.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bot.errRecap"));
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
      setError(err instanceof Error ? err.message : t("bot.errAvatar"));
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
              title={t("bot.renameTitle")}
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
                        setError(err instanceof Error ? err.message : t("bot.errRename"));
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
              aria-label={t("bot.renameTitle")}
              className="w-full max-w-xs rounded-md border border-emerald-600 bg-zinc-800 px-2 py-0.5 text-xl font-bold text-zinc-100 focus:outline-none"
            />
          )}
          {bot.title && <p className="text-sm text-zinc-400">{bot.title}</p>}
          <p className="mt-0.5 text-xs text-zinc-500">{t("bot.ownerLine").replace("{name}", partnerName)}</p>
        </div>
      </div>

      <form onSubmit={save} className="mb-8 flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-5">
        <h3 className="font-semibold text-zinc-200">{t("bot.identity")}</h3>
        <label className="text-sm font-semibold text-zinc-300">
          {t("bot.name")}
          <input value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} maxLength={40} className={inputCls} />
        </label>
        <label className="text-sm font-semibold text-zinc-300">
          {t("bot.role")}
          <input
            value={role}
            onChange={(e) => { setRole(e.target.value); setSaved(false); }}
            placeholder={t("bot.rolePh")}
            maxLength={120}
            className={inputCls}
          />
        </label>
        <p className="-mt-2 text-xs text-zinc-500">{t("bot.roleHint")}</p>
        <label className="text-sm font-semibold text-zinc-300">
          {t("bot.avatar")}
          <span className="mt-1 flex items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="sr-only"
              onChange={(e) => onAvatarFile(e.target.files?.[0])}
            />
            <button type="button" disabled={avatarBusy} onClick={() => fileRef.current?.click()} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">
              {avatarBusy ? t("bot.avatarUpBusy") : t("bot.avatarUp")}
            </button>
          </span>
        </label>
        <label className="text-sm font-semibold text-zinc-300">
          {t("bot.model")} <span className="font-normal text-zinc-500">{t("bot.modelHint")}</span>
          <input value={model} onChange={(e) => { setModel(e.target.value); setSaved(false); }} list="bot-model-list" placeholder={providerInfo?.custom_allowed ? (providerInfo.example_models || "e.g. qwen3:8b") : t("bot.modelPick")} spellCheck={false} className={`${inputCls} font-mono ${!model.trim() ? "border-amber-600" : ""}`} />
          <datalist id="bot-model-list">
            {(providerInfo?.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </datalist>
          {providerInfo && (
            <span className="mt-1 block text-xs font-normal text-zinc-500">
              {t("bot.provider")}: {providerInfo.provider_label ?? providerInfo.provider}
              {providerInfo.default ? ` · ${t("bot.modelDefault")} ${providerInfo.default}` : ` · ${t("bot.modelFree")}`}
              {providerInfo.example_models ? ` · ${providerInfo.example_models}` : ""}
            </span>
          )}
          {!model.trim() && (
            <span className="mt-1 block rounded-md border border-amber-800 bg-amber-950/60 px-2 py-1 text-xs font-normal text-amber-200">
              {t("bot.modelEmpty")}
            </span>
          )}
        </label>
        <label className="text-sm font-semibold text-zinc-300">
          {t("bot.voice")}
          <select value={voice} onChange={(e) => { setVoice(e.target.value); setSaved(false); }} className={inputCls}>
            {AURA_VOICES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <p className="-mt-2 text-xs text-zinc-500">{t("bot.voiceHint")}</p>
        <label className="flex items-center gap-2 text-sm font-semibold text-zinc-300">
          <input
            type="checkbox"
            checked={relay}
            onChange={(e) => { setRelay(e.target.checked); setSaved(false); }}
            className="h-4 w-4 accent-emerald-600"
          />
          {t("bot.relay").replace("{name}", bot.name)}
        </label>
        <p className="-mt-2 text-xs font-normal text-zinc-500">{t("bot.relayHint")}</p>
        <div className="grid grid-cols-3 gap-2">
          <label className="text-sm font-semibold text-zinc-300">
            {t("bot.days")}
            <select value={activeDays} onChange={(e) => { setActiveDays(e.target.value); setSaved(false); }} className={inputCls}>
              <option value="all">{t("bot.daysAll")}</option>
              <option value="weekdays">{t("bot.daysWeek")}</option>
              <option value="weekends">{t("bot.daysEnd")}</option>
            </select>
          </label>
          <label className="text-sm font-semibold text-zinc-300">
            {t("bot.from")}
            <input type="time" value={activeStart} onChange={(e) => { setActiveStart(e.target.value); setSaved(false); }} className={inputCls} />
          </label>
          <label className="text-sm font-semibold text-zinc-300">
            {t("bot.until")}
            <input type="time" value={activeEnd} onChange={(e) => { setActiveEnd(e.target.value); setSaved(false); }} className={inputCls} />
          </label>
        </div>
        <p className="-mt-2 text-xs text-zinc-500">{t("bot.windowHint")}</p>
        <label className="text-sm font-semibold text-zinc-300">
          {t("bot.memory")}
          <textarea
            value={memory}
            onChange={(e) => { setMemory(e.target.value); setSaved(false); }}
            placeholder={t("bot.memoryPh")}
            rows={5}
            maxLength={4000}
            className={inputCls}
          />
        </label>
        <p className="-mt-1 text-xs text-zinc-500">{t("bot.memoryHint")}</p>
        {error && <p className="text-sm text-red-400">{error}</p>}
        {saved && <p className="text-sm font-semibold text-emerald-400">{t("bot.saved")}</p>}
        <div className="flex items-center gap-3">
          <button type="submit" disabled={busy} className="rounded-md bg-emerald-600 px-6 py-2 font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
            {busy ? t("bot.saving") : t("bot.save")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={togglePin}
            title={bot.pinned ? t("bot.unpinTitle") : t("bot.pinTitle")}
            className={`rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-50 ${bot.pinned ? "border-emerald-600 text-emerald-400 hover:bg-emerald-950" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`}
          >
            {bot.pinned ? t("bot.unpin") : t("bot.pin")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={toggleArchive}
            title={bot.archived ? t("bot.restoreTitle") : t("bot.archiveTitle")}
            className={`rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-50 ${bot.archived ? "border-emerald-600 text-emerald-400 hover:bg-emerald-950" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`}
          >
            {bot.archived ? t("bot.restore") : t("bot.archive")}
          </button>
        </div>
      </form>

      <SchedulesView botId={bot.id} />

      <TeamView bot={bot} onOpenBot={onOpenBot} onTeamChanged={onTeamChanged} />

      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold text-zinc-200">{t("bot.recapTitle")}</h3>
          <button type="button" disabled={summarizing} onClick={summarizeNow} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">
            {summarizing ? <Spinner /> : t("bot.recapNow")}
          </button>
        </div>
        <p className="mb-3 text-xs text-zinc-500">{t("bot.recapBody")}</p>
        {!summaries ? (
          <div className="space-y-2" aria-label={t("common.loading")}>
            <div className="loading-skeleton h-10 w-full" />
            <div className="loading-skeleton h-10 w-full" />
          </div>
        ) : summaries.daily.length + summaries.weekly.length + summaries.monthly.length === 0 ? (
          <p className="text-sm text-zinc-400">{t("bot.recapEmpty")}</p>
        ) : (
          (["monthly", "weekly", "daily"] as const).map((period) =>
            summaries[period].map((s) => (
              <details key={s.id} className="mb-2 rounded-md border border-zinc-800 bg-zinc-950 p-3">
                <summary className="cursor-pointer text-sm font-semibold text-zinc-300">
                  {period === "monthly" ? t("bot.perMonth") : period === "weekly" ? t("bot.perWeek") : t("bot.perDay")} · {s.period_key}
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
