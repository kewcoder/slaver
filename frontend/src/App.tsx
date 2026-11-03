import { useCallback, useEffect, useRef, useState } from "react";
import {
  avatarUrl,
  createBot,
  fetchBotDetail,
  fetchBots,
  fetchMe,
  fetchModels,
  fetchSummaries,
  fetchUsage,
  finishChat,
  formatUsd,
  login,
  register,
  runSummary,
  setToken,
  streamChat,
  transcribeVoice,
  updateBot,
  uploadAvatar,
  type SlaveBot,
  type Summaries,
  type UsageSummary,
  type User,
} from "./api";
import { speak, startRecording, stopSpeaking, warmUpVoices, type Recorder } from "./voice";

const AVATAR_COLORS = [
  "bg-emerald-600",
  "bg-sky-600",
  "bg-amber-600",
  "bg-rose-600",
  "bg-orange-600",
  "bg-teal-600",
  "bg-indigo-600",
];

function avatarColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

const avatarCache = new Map<string, string>();

function BotAvatar({ bot, size = "md" }: { bot: SlaveBot; size?: "sm" | "md" | "lg" }) {
  const [url, setUrl] = useState<string | null>(null);
  const dims = size === "lg" ? "h-16 w-16 text-2xl" : size === "sm" ? "h-8 w-8 text-sm" : "h-10 w-10 text-base";
  useEffect(() => {
    if (!bot.avatar_key) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    const cacheKey = `${bot.id}:${bot.avatar_key}`;
    const cached = avatarCache.get(cacheKey);
    if (cached) {
      setUrl(cached);
      return;
    }
    const headers: Record<string, string> = {};
    const t = localStorage.getItem("slaver_token");
    if (t) headers.Authorization = `Bearer ${t}`;
    fetch(avatarUrl(bot.id), { headers })
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        if (cancelled) return;
        if (blob) {
          const objectUrl = URL.createObjectURL(blob);
          avatarCache.set(cacheKey, objectUrl);
          setUrl(objectUrl);
        } else {
          setUrl(null);
        }
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [bot.id, bot.avatar_key]);
  if (url) {
    return (
      <img
        src={url}
        alt={bot.name}
        className={`${dims} shrink-0 rounded-full object-cover`}
      />
    );
  }
  return (
    <div className={`${dims} ${avatarColor(bot.id)} flex shrink-0 items-center justify-center rounded-full font-bold text-white`}>
      {(bot.name || "?").slice(0, 1).toUpperCase()}
    </div>
  );
}

function AuthView({ onAuth }: { onAuth: (user: User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("register");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res =
        mode === "register"
          ? await register(email, password, name)
          : await login(email, password);
      onAuth(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none";

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-6">
      <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900 p-8">
        <h1 className="text-2xl font-bold text-zinc-100">Slaver</h1>
        <p className="mb-5 mt-1 text-sm text-zinc-400">Sign up or log in to meet your slaveBots.</p>
        <div className="mb-4 flex gap-2">
          {(["register", "login"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
                mode === m ? "bg-zinc-100 text-zinc-900" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {m === "register" ? "Sign up" : "Log in"}
            </button>
          ))}
        </div>
        <form onSubmit={submit} className="flex flex-col gap-3">
          {mode === "register" && (
            <label className="text-sm font-semibold text-zinc-300">
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoComplete="name" className={inputCls} />
            </label>
          )}
          <label className="text-sm font-semibold text-zinc-300">
            Email
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" className={inputCls} />
          </label>
          <label className="text-sm font-semibold text-zinc-300">
            Password
            <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete={mode === "register" ? "new-password" : "current-password"} className={inputCls} />
          </label>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button type="submit" disabled={busy} className="rounded-md bg-emerald-600 px-3 py-2.5 font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
            {busy ? "Please wait..." : mode === "register" ? "Create account" : "Log in"}
          </button>
        </form>
      </div>
    </div>
  );
}

interface UiMessage {
  key: number;
  role: string;
  content: string;
  created_at?: string;
}

function LogsView({ summary }: { summary: UsageSummary | null }) {
  if (!summary) return <div className="p-8 text-center text-zinc-400">Loading usage...</div>;
  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      <div className="mb-3 flex gap-3">
        <div className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <div className="text-xs font-bold uppercase tracking-wide text-zinc-400">Remaining credit</div>
          <div className="mt-1 text-3xl font-bold text-zinc-100">{formatUsd(summary.credit_usd)}</div>
        </div>
        <div className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <div className="text-xs font-bold uppercase tracking-wide text-zinc-400">Spent (demo)</div>
          <div className="mt-1 text-3xl font-bold text-zinc-100">{formatUsd(summary.spent_usd)}</div>
        </div>
      </div>
      <p className="mb-3 text-sm text-zinc-400">Every account starts with $10 demo credit. Costs are estimated from provider token usage.</p>
      {summary.logs.length === 0 ? (
        <p className="text-zinc-400">No usage yet — send a chat message first.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-400">
                <th className="px-3 py-2">Time</th>
                <th className="px-3 py-2">SlaveBot</th>
                <th className="px-3 py-2">Model</th>
                <th className="px-3 py-2 text-right">In</th>
                <th className="px-3 py-2 text-right">Out</th>
                <th className="px-3 py-2 text-right">Cost</th>
              </tr>
            </thead>
            <tbody className="bg-zinc-900 text-zinc-200">
              {summary.logs.map((l) => (
                <tr key={l.id} className="border-t border-zinc-800">
                  <td className="whitespace-nowrap px-3 py-2">{new Date(l.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2">{l.audio_seconds > 0 ? "Voice input" : (l.slavebot_name ?? "—")}{l.estimated ? " (est.)" : ""}</td>
                  <td className="whitespace-nowrap px-3 py-2">{l.model}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.audio_seconds > 0 ? `${l.audio_seconds.toFixed(1)}s` : l.prompt_tokens.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.completion_tokens.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatUsd(l.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BotView({
  bot,
  models,
  onSaved,
}: {
  bot: SlaveBot;
  models: { id: string; label: string }[];
  onSaved: (bot: SlaveBot) => void;
}) {
  const [name, setName] = useState(bot.name);
  const [memory, setMemory] = useState(bot.memory);
  const [model, setModel] = useState(bot.model);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [summaries, setSummaries] = useState<Summaries | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setName(bot.name);
    setMemory(bot.memory);
    setModel(bot.model);
    setSaved(false);
    setError("");
    setSummaries(null);
    fetchSummaries(bot.id).then(setSummaries).catch(() => {});
  }, [bot.id, bot.name, bot.memory, bot.model]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const updated = await updateBot(bot.id, { name, memory, model });
      onSaved(updated);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
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
          <h2 className="text-xl font-bold text-zinc-100">{bot.name}</h2>
          {bot.title && <p className="text-sm text-zinc-400">{bot.title}</p>}
        </div>
      </div>

      <form onSubmit={save} className="mb-8 flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-5">
        <h3 className="font-semibold text-zinc-200">Identity</h3>
        <label className="text-sm font-semibold text-zinc-300">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} className={inputCls} />
        </label>
        <label className="text-sm font-semibold text-zinc-300">
          Avatar
          <span className="mt-1 flex items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="sr-only"
              onChange={(e) => onAvatarFile(e.target.files?.[0])}
            />
            <button type="button" disabled={avatarBusy} onClick={() => fileRef.current?.click()} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">
              {avatarBusy ? "Uploading..." : "Upload image (max 2 MB)"}
            </button>
          </span>
        </label>
        <label className="text-sm font-semibold text-zinc-300">
          Model
          <select value={model} onChange={(e) => setModel(e.target.value)} className={inputCls}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-semibold text-zinc-300">
          Memory
          <textarea
            value={memory}
            onChange={(e) => setMemory(e.target.value)}
            placeholder={"e.g. Owner prefers concise answers. Building a warung POS; stack: ..."}
            rows={5}
            maxLength={4000}
            className={inputCls}
          />
        </label>
        <p className="-mt-1 text-xs text-zinc-500">Memory is fed to the model as persistent context on every message.</p>
        {error && <p className="text-sm text-red-400">{error}</p>}
        {saved && <p className="text-sm font-semibold text-emerald-400">Saved.</p>}
        <button type="submit" disabled={busy} className="self-start rounded-md bg-emerald-600 px-6 py-2 font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
          {busy ? "Saving..." : "Save"}
        </button>
      </form>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold text-zinc-200">Conversation recaps</h3>
          <button type="button" disabled={summarizing} onClick={summarizeNow} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">
            {summarizing ? "Summarizing..." : "Summarize now"}
          </button>
        </div>
        <p className="mb-3 text-xs text-zinc-500">Daily recaps are generated every night; weekly on Mondays; monthly on the 1st. The bot reads these as older context.</p>
        {!summaries ? (
          <p className="text-sm text-zinc-400">Loading...</p>
        ) : summaries.daily.length + summaries.weekly.length + summaries.monthly.length === 0 ? (
          <p className="text-sm text-zinc-400">No recaps yet — chat first, then summarize.</p>
        ) : (
          (["monthly", "weekly", "daily"] as const).map((period) =>
            summaries[period].map((s) => (
              <details key={s.id} className="mb-2 rounded-md border border-zinc-800 bg-zinc-950 p-3">
                <summary className="cursor-pointer text-sm font-semibold text-zinc-300">
                  {period} · {s.period_key}
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

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [view, setView] = useState<"chat" | "bot" | "logs">("chat");
  const [bots, setBots] = useState<SlaveBot[]>([]);
  const [botId, setBotId] = useState<string | null>(null);
  const [bot, setBot] = useState<SlaveBot | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [recorder, setRecorder] = useState<Recorder | null>(null);
  const [recSecs, setRecSecs] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const keyRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const recTimer = useRef<number | null>(null);

  const refreshUser = useCallback(async () => {
    try {
      setUser(await fetchMe());
    } catch {
      setToken(null);
      setUser(null);
    }
  }, []);

  const refreshBots = useCallback(async () => {
    try {
      setBots(await fetchBots());
    } catch {
      /* keep old list on transient failure */
    }
  }, []);

  useEffect(() => {
    warmUpVoices();
    refreshUser().finally(() => setChecking(false));
    fetchModels().then(setModels).catch(() => {});
  }, [refreshUser]);

  useEffect(() => {
    if (user) refreshBots();
    else setBots([]);
  }, [user, refreshBots]);

  useEffect(() => {
    if (view === "logs" && user) {
      fetchUsage().then(setUsage).catch(() => {});
    }
  }, [view, user]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [messages]);

  useEffect(() => {
    return () => {
      if (recTimer.current !== null) window.clearInterval(recTimer.current);
      stopSpeaking();
    };
  }, []);

  async function openBot(id: string | null) {
    setError("");
    stopSpeaking();
    if (recorder) {
      recorder.cancel();
      stopRecordingUi();
    }
    setBotId(id);
    setView("chat");
    if (!id) {
      setBot(null);
      setMessages([]);
      return;
    }
    try {
      const detail = await fetchBotDetail(id);
      setBot(detail.slavebot);
      setMessages(
        detail.messages.map((m) => ({ key: ++keyRef.current, role: m.role, content: m.content, created_at: m.created_at })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open slaveBot.");
    }
  }

  async function newBot() {
    setError("");
    try {
      const created = await createBot(models[0]?.id ?? "muse-spark-1.3");
      await refreshBots();
      await openBot(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create slaveBot.");
    }
  }

  const stop = useCallback(() => {
    abortRef.current?.abort();
    stopSpeaking();
  }, []);

  const stopRecordingUi = useCallback(() => {
    if (recTimer.current !== null) {
      window.clearInterval(recTimer.current);
      recTimer.current = null;
    }
    setRecorder(null);
    setRecSecs(0);
  }, []);

  async function toggleMic() {
    if (streaming || transcribing || !bot) return;
    if (recorder) {
      const rec = recorder;
      stopRecordingUi();
      setTranscribing(true);
      setError("");
      try {
        const wav = await rec.stop();
        const res = await transcribeVoice(wav);
        setInput((prev) => (prev ? `${prev} ${res.transcript}` : res.transcript));
        await refreshUser();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Transcription failed.");
      } finally {
        setTranscribing(false);
      }
      return;
    }
    setError("");
    try {
      const rec = await startRecording();
      setRecorder(rec);
      setRecSecs(0);
      recTimer.current = window.setInterval(() => setRecSecs(rec.elapsed()), 250);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not access the microphone.");
    }
  }

  let content = "";
  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || streaming || !bot) return;
    stopSpeaking();
    setError("");
    setInput("");
    const userKey = ++keyRef.current;
    const assistantKey = ++keyRef.current;
    setMessages((prev) => [
      ...prev,
      { key: userKey, role: "user", content: text },
      { key: assistantKey, role: "assistant", content: "" },
    ]);
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let streamUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null = null;

    const patchAssistant = (c: string) =>
      setMessages((prev) => prev.map((m) => (m.key === assistantKey ? { ...m, content: c } : m)));

    try {
      const returnedId = await streamChat(bot.id, text, bot.model, {
        signal: controller.signal,
        onToken: (delta) => {
          content += delta;
          patchAssistant(content);
        },
        onUsage: (u) => {
          streamUsage = u;
        },
      });
      const finalId = returnedId || bot.id;
      await finishChat(finalId, content, streamUsage);
      await refreshBots();
      await refreshUser();
      const detail = await fetchBotDetail(finalId);
      setBot(detail.slavebot);
      if (voiceOn && content.trim()) speak(content);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        patchAssistant(`${content}\n— stopped.`);
        setError("Stream stopped. The partial reply was not saved.");
      } else {
        setError(err instanceof Error ? err.message : "Chat failed.");
        setMessages((prev) => prev.filter((m) => m.key !== assistantKey));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function logout() {
    stopSpeaking();
    if (recorder) {
      recorder.cancel();
      stopRecordingUi();
    }
    setToken(null);
    setUser(null);
    setMessages([]);
    setBots([]);
    setBotId(null);
    setBot(null);
    setUsage(null);
  }

  if (checking) return <div className="flex min-h-screen items-center justify-center text-zinc-400">Loading...</div>;
  if (!user) return <AuthView onAuth={setUser} />;

  const tabCls = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm font-medium ${active ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`;

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      {/* Sidebar — bot list */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div className="font-bold">SlaveBots</div>
          <button type="button" onClick={newBot} className="rounded-md px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
            + New
          </button>
        </div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
          {bots.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => openBot(b.id)}
              title={b.title || b.name}
              className={`flex items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-zinc-800 ${b.id === botId ? "bg-zinc-800" : ""}`}
            >
              <BotAvatar bot={b} size="sm" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">{b.name}</span>
                {b.title && <span className="block truncate text-xs text-zinc-500">{b.title}</span>}
              </span>
            </button>
          ))}
          {bots.length === 0 && <p className="px-2 py-2 text-sm text-zinc-500">No slaveBots yet — create one to start.</p>}
        </nav>
        <div className="flex flex-col items-start gap-2 border-t border-zinc-800 p-3">
          <button type="button" onClick={() => { setView("logs"); fetchUsage().then(setUsage).catch(() => {}); }} className="rounded-md px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
            Usage &amp; logs
          </button>
          <div className="px-2 text-sm font-bold text-emerald-400">{formatUsd(user.credit_usd)} left</div>
          <div className="px-2 text-xs text-zinc-500">{user.email}</div>
          <button type="button" onClick={logout} className="rounded-md px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
            Log out
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col bg-zinc-900">
        <header className="flex items-center justify-between gap-2 border-b border-zinc-800 px-4 py-2">
          <div className="flex items-center gap-1">
            <span className="px-1 font-bold text-zinc-300">#</span>
            <span className="font-semibold">{bot ? bot.name : "pick a slaveBot"}</span>
            <button type="button" onClick={() => setView("chat")} className={tabCls(view === "chat")}>Chat</button>
            <button type="button" onClick={() => bot && setView("bot")} disabled={!bot} className={`${tabCls(view === "bot")} disabled:opacity-40`}>Bot</button>
            <button type="button" onClick={() => setView("logs")} className={tabCls(view === "logs")}>Logs</button>
          </div>
          <button
            type="button"
            onClick={() => { if (voiceOn) stopSpeaking(); setVoiceOn((v) => !v); }}
            title="Spoken replies on/off"
            className={`rounded-md border px-2 py-1 text-xs font-semibold ${voiceOn ? "border-emerald-600 text-emerald-400" : "border-zinc-700 text-zinc-400"}`}
          >
            {voiceOn ? "Voice on" : "Voice off"}
          </button>
        </header>

        {view === "logs" ? (
          <main className="flex-1 overflow-y-auto"><LogsView summary={usage} /></main>
        ) : view === "bot" && bot ? (
          <main className="flex-1 overflow-y-auto">
            <BotView
              bot={bot}
              models={models}
              onSaved={(updated) => {
                setBot(updated);
                setBots((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
              }}
            />
          </main>
        ) : (
          <>
            <main className="flex-1 overflow-y-auto px-4 py-4">
              {!bot ? (
                <div className="mx-auto max-w-xl py-16">
                  <h2 className="text-xl font-bold">Hi, {user.name || user.email}.</h2>
                  <p className="mt-2 text-zinc-400">Select a slaveBot on the left to continue the conversation — or create a new one. Each bot keeps its own history and memory.</p>
                  <button type="button" onClick={newBot} className="mt-4 rounded-md bg-emerald-600 px-4 py-2 font-semibold text-white hover:bg-emerald-500">
                    + New slaveBot
                  </button>
                </div>
              ) : (
                messages.length === 0 && (
                  <div className="mx-auto max-w-xl py-16">
                    <h2 className="text-xl font-bold">{bot.name} is ready.</h2>
                    <p className="mt-2 text-zinc-400">Type or dictate a message below. Set memory in the Bot tab and {bot.name} will remember it across conversations.</p>
                  </div>
                )
              )}
              {messages.map((m) => (
                <div key={m.key} className="group flex gap-3 rounded px-2 py-3 hover:bg-zinc-800/50">
                  <BotAvatar bot={bot ?? { id: "u", name: m.role === "user" ? (user.name || "You") : "A", title: "", model: "", memory: "", avatar_key: "", created_at: "", updated_at: "" } as SlaveBot} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-bold">{m.role === "user" ? (user.name || "You") : (bot?.name ?? "Assistant")}</span>
                      {m.created_at && <span className="text-xs text-zinc-500">{new Date(m.created_at).toLocaleString()}</span>}
                    </div>
                    <div className="whitespace-pre-wrap break-words text-[15px] text-zinc-200">{m.content || (streaming ? "…" : "")}</div>
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </main>

            {error && <p className="mx-auto w-full max-w-3xl px-4 text-sm text-red-400">{error}</p>}

            <div className="px-4 pb-4">
              <form onSubmit={send} className="mx-auto flex max-w-3xl items-end gap-2 rounded-lg bg-zinc-800 p-2">
                <button
                  type="button"
                  onClick={toggleMic}
                  disabled={streaming || transcribing || !bot}
                  title={recorder ? `Stop recording (${recSecs.toFixed(0)}s)` : "Dictate with microphone"}
                  className={`shrink-0 rounded-md px-3 py-2 text-sm font-bold ${recorder ? "text-red-400" : "text-zinc-300 hover:bg-zinc-700"} disabled:opacity-40`}
                >
                  {recorder ? `● ${recSecs.toFixed(0)}s` : transcribing ? "…" : "Mic"}
                </button>
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder={bot ? `Message ${bot.name}...` : "Select a slaveBot first"}
                  rows={1}
                  disabled={!bot}
                  className="max-h-40 flex-1 resize-none bg-transparent px-1 py-2 text-[15px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none disabled:opacity-40"
                />
                {streaming ? (
                  <button type="button" onClick={stop} className="shrink-0 rounded-md bg-red-700 px-4 py-2 text-sm font-bold text-white hover:bg-red-600">
                    Stop
                  </button>
                ) : (
                  <button type="submit" disabled={!input.trim() || !bot} className="shrink-0 rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40">
                    Send
                  </button>
                )}
              </form>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
