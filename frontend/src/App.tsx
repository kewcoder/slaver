import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  addDomain,
  addGroupMembers,
  appendMemory,
  connectFly,
  destroyFlyMachine,
  disconnectFly,
  fetchAvatar,
  fetchDomains,
  fetchFlyAccounts,
  fetchFlyMachines,
  fetchTeamTemplates,
  applyTeamTemplate,
  createBot,
  createOAuthClient,
  createGroup,
  createMeeting,
  createProject,
  createSchedule,
  createTeam,
  clearTeamProvider,
  deleteGroup,
  deleteMeeting,
  deleteSchedule,
  deleteTeam,
  fetchBotDetail,
  fetchBots,
  fetchChildren,
  fetchGroupDetail,
  fetchGroups,
  fetchProject,
  fetchProjects,
  fetchMeetingDetail,
  fetchMeetings,
  fetchMe,
  fetchOAuthClients,
  fetchProviderModels,
  fetchPublicGroups,
  fetchSchedules,
  fetchSupportGroup,
  fetchSummaries,
  provisionFly,
  removeDomain,
  fetchTeam,
  fetchTeamActivity,
  fetchTeams,
  grantBotAccess,
  inviteMember,
  removeMember,
  revokeBotAccess,
  revokeOAuthClient,
  setGroupProject,
  setGroupVisibility,
  setMemberRole,
  formatUsd,
  groupChat,
  meetingChat,
  login,
  sendChat,
  register,
  removeGroupMember,
  renameGroup,
  runSummary,
  setTeamProvider,
  testTeamProvider,
  setToken,
  speakVoice,
  spawnSubBot,
  transcribeVoice,
  transferBot,
  updateBot,
  updateSchedule,
  uploadAvatar,
  type BotSchedule,
  type CustomDomain,
  type FlyAccount,
  type FlyMachine,
  type Group,
  type GroupDetail,
  type Meeting,
  type MeetingDetail,
  type ActivityItem,
  type OAuthClient,
  type Project,
  type ProviderInfo,
  type PublicGroup,
  type SlaveBot,
  type Team,
  type TeamDetail,
  type Summaries,
  type TeamTemplate,
  type User,
} from "./api";
import {
  playAudioBlob,
  recordConversationTurn,
  speak,
  startRecording,
  stopSpeaking,
  warmUpVoices,
  type Recorder,
} from "./voice";
import AppsView from "./AppsView";
import KanbanBoard from "./KanbanBoard";
import CodeView from "./CodeView";
import MarketView from "./MarketView";

const AURA_VOICES = ["luna", "athena", "orion", "zeus", "hera", "perseus", "angus", "stella"];

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


function BotAvatar({ bot, size = "md" }: { bot: SlaveBot; size?: "sm" | "md" | "lg" }) {
  const [url, setUrl] = useState<string | null>(null);
  const dims = size === "lg" ? "h-16 w-16 text-2xl" : size === "sm" ? "h-8 w-8 text-sm" : "h-10 w-10 text-base";
  useEffect(() => {
    if (!bot.avatar_key) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    fetchAvatar(bot.id).then((u) => {
      if (!cancelled) setUrl(u);
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

/** Small inline spinner for busy buttons. */
function Spinner() {
  return (
    <svg className="inline h-4 w-4 animate-spin text-current" viewBox="0 0 24 24" fill="none" aria-label="Loading">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

/** ChatGPT-style composer glyphs. */
function PlusIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

function WaveIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="4" y="10" width="2.4" height="4" rx="1.2" />
      <rect x="8.2" y="7" width="2.4" height="10" rx="1.2" />
      <rect x="12.4" y="4" width="2.4" height="16" rx="1.2" />
      <rect x="16.6" y="8" width="2.4" height="8" rx="1.2" />
    </svg>
  );
}

/** Three bouncing dots for "bot is typing". Motion is disabled when the OS asks for reduced motion. */
function TypingDots() {
  return (
    <span className="typing-dots" aria-label="Bot is typing">
      <span />
      <span />
      <span />
    </span>
  );
}

function AuthView({ onAuth }: { onAuth: (user: User) => void }) {
  // Demo-first: reviewer langsung login tanpa registrasi.
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("resto@slaver.app");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("demo1234");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pendingUser, setPendingUser] = useState<User | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res =
        mode === "register"
          ? await register(email, password, name)
          : await login(email, password);
      if (mode === "register") {
        setPendingUser(res.user);
      } else {
        onAuth(res.user);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (pendingUser) {
    return <OnboardingView user={pendingUser} onDone={() => onAuth(pendingUser)} />;
  }

  const inputCls =
    "mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none";

  function fillDemo() {
    setMode("login");
    setError("");
    setEmail("resto@slaver.app");
    setPassword("demo1234");
  }

  return (
    <div className="flex min-h-screen bg-zinc-950">
      <div className="hidden flex-1 flex-col justify-center bg-gradient-to-br from-zinc-950 via-zinc-900 to-emerald-950 p-12 lg:flex">
        <div className="text-3xl font-black tracking-tight text-zinc-100">
          Slaver<span className="text-emerald-400">.</span>
        </div>
        <h1 className="mt-6 max-w-md text-4xl font-bold leading-tight text-zinc-100">
          Don&apos;t just connect software. <span className="text-emerald-400">Own it.</span>
        </h1>
        <ul className="mt-8 flex flex-col gap-4 text-[15px] text-zinc-300">
          <li className="flex gap-3"><span className="text-emerald-400">◈</span><span><b>Marketplace</b> — beli aplikasi sekali, jadi milikmu selamanya.</span></li>
          <li className="flex gap-3"><span className="text-emerald-400">▤</span><span><b>AI team</b> — agen yang customize, review, dan deploy untukmu.</span></li>
          <li className="flex gap-3"><span className="text-emerald-400">⌁</span><span><b>Server sendiri</b> — jalan di servermu, bukan sewa SaaS.</span></li>
        </ul>
      </div>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900 p-8">
          <div className="text-2xl font-bold text-zinc-100 lg:hidden">Slaver<span className="text-emerald-400">.</span></div>
          <p className="mb-5 mt-1 text-sm text-zinc-400">Masuk untuk mengelola usaha dan asisten AI-mu.</p>
          <button type="button" onClick={fillDemo} className="mb-4 w-full rounded-md border border-dashed border-zinc-700 px-3 py-2 text-left text-xs text-zinc-400 hover:border-emerald-600 hover:text-zinc-200">
            <span className="font-bold text-emerald-400">Coba demo rumah makan →</span><br />
            <span className="font-mono">resto@slaver.app / demo1234</span>
          </button>
          <div className="mb-4 flex gap-2">
            {(["login", "register"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
                  mode === m ? "bg-zinc-100 text-zinc-900" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {m === "register" ? "Daftar" : "Masuk"}
              </button>
            ))}
          </div>
          <form onSubmit={submit} className="flex flex-col gap-3">
            {mode === "register" && (
              <label className="text-sm font-semibold text-zinc-300">
                Nama
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama kamu" autoComplete="name" className={inputCls} />
              </label>
            )}
            <label className="text-sm font-semibold text-zinc-300">
              Email
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="kamu@usaha.com" autoComplete="email" className={inputCls} />
            </label>
            <label className="text-sm font-semibold text-zinc-300">
              Kata sandi
              <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Minimal 8 karakter" autoComplete={mode === "register" ? "new-password" : "current-password"} className={inputCls} />
            </label>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button type="submit" disabled={busy} className="rounded-md bg-emerald-600 px-3 py-2.5 font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
              {busy ? "Tunggu..." : mode === "register" ? "Buat akun" : "Masuk"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function OnboardingView({ user, onDone }: { user: User; onDone: () => void }) {
  const [templates, setTemplates] = useState<TeamTemplate[]>([]);
  const [teamName, setTeamName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchTeamTemplates().then(setTemplates).catch((err) => setError(err instanceof Error ? err.message : "Could not load templates."));
  }, []);

  async function pick(key: string, fallbackName: string) {
    setBusy(true);
    setError("");
    try {
      await applyTeamTemplate(key, teamName.trim() || fallbackName);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create team.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-6">
      <div className="w-full max-w-2xl">
        <div className="text-3xl font-black tracking-tight text-zinc-100">Slaver<span className="text-emerald-400">.</span></div>
        <h1 className="mt-2 text-2xl font-bold text-zinc-100">Halo, {user.name || user.email} — mau mulai usaha apa?</h1>
        <p className="mt-1 text-sm text-zinc-400">Pilih template tim: dapat team + agen AI yang profilnya sudah diset sesuai kategori bisnis. Bisa diganti nanti.</p>
        <label className="mt-4 block text-sm font-semibold text-zinc-300">
          Nama tim / usahamu
          <input value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="cth. Saung Rangon" className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
        </label>
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {templates.map((t) => (
            <div key={t.key} className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              <div className="text-xs font-bold uppercase tracking-wide text-emerald-400">{t.category}</div>
              <div className="mt-1 font-bold text-zinc-100">{t.name}</div>
              <p className="mt-1 flex-1 text-xs text-zinc-400">{t.description}</p>
              {t.agents.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {t.agents.map((a) => (
                    <span key={a.name} className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">{a.name}</span>
                  ))}
                </div>
              )}
              <button type="button" onClick={() => pick(t.key, t.team_name)} disabled={busy} className="mt-3 rounded-md bg-emerald-600 px-3 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
                {busy ? "Menyiapkan..." : `Pakai: ${t.team_name}`}
              </button>
            </div>
          ))}
        </div>
        <button type="button" onClick={onDone} disabled={busy} className="mt-4 text-sm text-zinc-500 hover:text-zinc-200">
          Lewati — masuk tanpa template
        </button>
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

function GroupView({
  groupId,
  bots,
  teamId,
  onDeleted,
  onVisibilityChanged,
}: {
  groupId: string;
  bots: SlaveBot[];
  teamId: string | null;
  onDeleted: () => void;
  onVisibilityChanged: () => void;
}) {
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [task, setTask] = useState("");
  const [saveMemory, setSaveMemory] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedNote, setSavedNote] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [pickFilter, setPickFilter] = useState("");
  const [tab, setTab] = useState<"chat" | "board">("chat");
  const [boardFull, setBoardFull] = useState(false);
  const [teamProjects, setTeamProjects] = useState<Project[]>([]);
  const [newProjName, setNewProjName] = useState("");
  const [attachBusy, setAttachBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDetail(await fetchGroupDetail(groupId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load group.");
    }
  }, [groupId]);

  useEffect(() => {
    setDetail(null);
    setError("");
    setTab("chat");
    setBoardFull(false);
    if (localStorage.getItem("group_open_board") === groupId) {
      localStorage.removeItem("group_open_board");
      setTab("board");
    }
    refresh();
  }, [groupId, refresh]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [detail?.messages.length]);

  async function sendTask(e?: React.FormEvent) {
    e?.preventDefault();
    const text = task.trim();
    if (!text || busy) return;
    setError("");
    setSavedNote("");
    setTask("");
    setBusy(true);
    try {
      const res = await groupChat(groupId, text, undefined, saveMemory);
      await refresh();
      if (saveMemory) {
        setSavedNote(
          res.saved_to_memory.length > 0
            ? `Tersimpan di ingatan: ${res.saved_to_memory.join(", ")}`
            : "Terkirim. (Tidak ada ingatan yang diubah — butuh pemilik/admin.)",
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Group chat failed.");
    } finally {
      setBusy(false);
    }
  }

  async function saveReply(botId: string | null | undefined, botName: string | null | undefined, content: string) {
    if (!botId) return;
    setError("");
    setSavedNote("");
    try {
      await appendMemory(botId, content.slice(0, 2000));
      setSavedNote(`Tersimpan di ingatan ${botName ?? "asisten"}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save to memory.");
    }
  }

  async function doAdd() {
    if (picked.length === 0 || busy) return;
    setError("");
    setBusy(true);
    try {
      await addGroupMembers(groupId, picked);
      setPicked([]);
      setPickFilter("");
      setAddOpen(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add member.");
    } finally {
      setBusy(false);
    }
  }

  function togglePick(id: string) {
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function doRemove(botId: string) {
    setError("");
    try {
      await removeGroupMember(groupId, botId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove member.");
    }
  }

  async function doDelete() {
    if (!window.confirm("Delete this group? Its discussion history will be gone.")) return;
    try {
      await deleteGroup(groupId);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete group.");
    }
  }

  async function loadTeamProjects() {
    if (!teamId) return;
    try {
      const list = await fetchProjects(teamId);
      setTeamProjects(list.map((p) => p.project));
    } catch {
      /* ignore */
    }
  }

  async function attach(pid: string) {
    if (!pid || attachBusy) return;
    setAttachBusy(true);
    setError("");
    try {
      setDetail({ ...(detail as GroupDetail), group: await setGroupProject(groupId, pid) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not attach board (owner/admin only).");
    } finally {
      setAttachBusy(false);
    }
  }

  async function createAndAttach(e?: React.FormEvent) {
    e?.preventDefault();
    if (!teamId || !newProjName.trim() || attachBusy) return;
    setAttachBusy(true);
    setError("");
    try {
      const p = await createProject(teamId, newProjName.trim());
      setNewProjName("");
      setDetail({ ...(detail as GroupDetail), group: await setGroupProject(groupId, p.id) });
      void loadTeamProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create board.");
    } finally {
      setAttachBusy(false);
    }
  }

  function openBoard() {
    setTab("board");
    if (!detail?.group.project_id) void loadTeamProjects();
  }

  /** Chat thread + composer. Minimized = composer only (board fullscreen). */
  function ChatPane({ minimized }: { minimized: boolean }) {
    if (!detail) return null;
    return (
      <>
        {!minimized && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {detail.messages.length === 0 && (
              <p className="py-8 text-center text-zinc-500">Belum ada obrolan. Beri tugas ke tim di bawah.</p>
            )}
            {detail.messages.map((m) => (
              <div key={m.id} className="group flex gap-3 rounded px-2 py-3 hover:bg-zinc-800/50">
                {m.slavebot_id ? (
                  <BotAvatar bot={({ id: m.slavebot_id, name: m.bot_name ?? "?", title: "", model: "", memory: "", role: "", parent_id: "", pinned: 0, pinned_by: "", owner_user_id: "", relay: 1, user_id: "u", team_id: "", avatar_key: bots.find((b) => b.id === m.slavebot_id)?.avatar_key ?? "", archived: 0, voice: "luna", active_days: "all", active_start: "", active_end: "", created_at: "", updated_at: "" }) as SlaveBot} size="sm" />
                ) : (
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-600 text-sm font-bold text-white">Y</div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-bold">{m.slavebot_id ? (m.bot_name ?? "Asisten") : "Anda"}</span>
                    <span className="text-xs text-zinc-500">{new Date(m.created_at).toLocaleString()}</span>
                    {m.slavebot_id && (
                      <button
                        type="button"
                        onClick={() => saveReply(m.slavebot_id, m.bot_name, m.content)}
                        title="Simpan jawaban ini ke ingatan asisten"
                        className="rounded px-1 text-xs text-zinc-500 hover:bg-zinc-700 hover:text-emerald-400"
                      >
                        Simpan ke ingatan
                      </button>
                    )}
                  </div>
                  <div className="whitespace-pre-wrap break-words text-[15px] text-zinc-200">{m.content}</div>
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}
        {error && <p className="py-1 text-sm text-red-400">{error}</p>}
        {savedNote && <p className="py-1 text-sm text-emerald-400">{savedNote}</p>}
        <form onSubmit={sendTask} className="mt-2 flex items-end gap-1 rounded-[28px] border border-zinc-700 bg-[#2b2d31] p-2 pl-4 shadow-lg focus-within:border-zinc-500">
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendTask();
              }
            }}
            placeholder="Tulis pesan untuk grup… (semua asisten menjawab)"
            rows={1}
            disabled={busy}
            className="max-h-40 flex-1 resize-none bg-transparent px-2 py-2 text-[15px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none disabled:opacity-40"
          />
          <label className="flex shrink-0 cursor-pointer items-center gap-1 px-1 text-xs text-zinc-400" title="Also append this message to every member's memory">
            <input type="checkbox" checked={saveMemory} onChange={(e) => setSaveMemory(e.target.checked)} className="accent-emerald-500" />
            +memory
          </label>
          <button type="submit" disabled={!task.trim() || busy} title="Send" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-700 disabled:text-zinc-500">
            {busy ? <Spinner /> : <ArrowUpIcon />}
          </button>
        </form>
      </>
    );
  }

  if (!detail) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-2 p-8" aria-label="Loading group">
        <div className="loading-skeleton h-8 w-1/3" />
        <div className="loading-skeleton h-24 w-full" />
        <div className="loading-skeleton h-24 w-full" />
      </div>
    );
  }
  const outsiders = bots.filter((b) => !b.archived && !detail.members.some((m) => m.id === b.id));

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col px-4 py-4">
      <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-900 p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          {renaming ? (
            <form
              onSubmit={(e) => { e.preventDefault(); if (newName.trim()) void (async () => { try { await renameGroup(groupId, newName.trim()); setRenaming(false); await refresh(); } catch (err) { setError(err instanceof Error ? err.message : "Could not rename group."); } })(); }}
              className="flex min-w-0 flex-1 items-center gap-2"
            >
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") setRenaming(false); }}
                maxLength={40}
                autoFocus
                className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
              />
              <button type="submit" disabled={!newName.trim()} className="shrink-0 rounded-md bg-emerald-600 px-2 py-1 text-xs font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
                Save
              </button>
              <button type="button" onClick={() => setRenaming(false)} className="shrink-0 rounded px-1 text-xs text-zinc-400 hover:text-zinc-200">
                Cancel
              </button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => { setNewName(detail.group.name); setRenaming(true); }}
              title="Rename group"
              className="min-w-0 flex-1 truncate rounded px-1 text-left font-bold text-zinc-100 hover:bg-zinc-800"
            >
              {detail.group.name}
            </button>
          )}
          {!renaming && detail.group.is_public ? (
            <span title="Grup bantuan umum — terlihat semua orang" className="shrink-0 rounded border border-emerald-700 px-2 py-0.5 text-[11px] font-bold text-emerald-400">
              BANTUAN UMUM
            </span>
          ) : null}
          {!renaming && (
            <div className="flex shrink-0 items-center">
              <button type="button" onClick={() => { setNewName(detail.group.name); setRenaming(true); }} title="Ganti nama grup" className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
                Ganti nama
              </button>
              <button
                type="button"
                onClick={() => {
                  setError("");
                  void (async () => {
                    try {
                      await setGroupVisibility(groupId, !detail.group.is_public);
                      await refresh();
                      onVisibilityChanged();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "Could not change visibility (owner/admin only).");
                    }
                  })();
                }}
                title={detail.group.is_public ? "Tutup untuk umum" : "Buka untuk umum — siapa pun bisa bertanya, asistenmu menjawab"}
                className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-emerald-400"
              >
                {detail.group.is_public ? "Tutup" : "Buka umum"}
              </button>
              <button type="button" onClick={doDelete} className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400">
                Hapus
              </button>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {detail.members.map((m) => (
            <span key={m.id} className="flex items-center gap-1.5 rounded-full bg-zinc-800 py-1 pl-1 pr-2 text-sm">
              <BotAvatar bot={m} size="sm" />
              <span className="text-zinc-200">{m.name}</span>
              <button type="button" onClick={() => doRemove(m.id)} title={`Keluarkan ${m.name}`} className="text-zinc-500 hover:text-red-400">
                ×
              </button>
            </span>
          ))}
          {outsiders.length > 0 && (
            <button
              type="button"
              onClick={() => { setPicked([]); setPickFilter(""); setAddOpen(true); }}
              className="rounded-full border border-dashed border-zinc-700 px-3 py-1 text-sm text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
            >
              + Tambah anggota
            </button>
          )}
          {addOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Tambah anggota">
              <div className="absolute inset-0 bg-black/60" onClick={() => { if (!busy) setAddOpen(false); }} />
              <div className="relative flex max-h-[80vh] w-full max-w-md flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-xl">
                <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
                  <h3 className="font-bold text-zinc-100">Tambah anggota ke {detail.group.name}</h3>
                  <button type="button" onClick={() => setAddOpen(false)} disabled={busy} title="Tutup" className="rounded px-2 py-1 text-lg leading-none text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40">
                    ×
                  </button>
                </div>
                <div className="border-b border-zinc-800 px-4 py-2">
                  <input
                    value={pickFilter}
                    onChange={(e) => setPickFilter(e.target.value)}
                    placeholder="Cari asisten..."
                    autoFocus
                    className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
                  />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {outsiders
                    .filter((b) => !pickFilter.trim() || `${b.name} ${b.role} ${b.title}`.toLowerCase().includes(pickFilter.trim().toLowerCase()))
                    .map((b) => {
                      const on = picked.includes(b.id);
                      return (
                        <button
                          key={b.id}
                          type="button"
                          onClick={() => togglePick(b.id)}
                          aria-pressed={on}
                          className={`flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-zinc-800 ${on ? "bg-zinc-800" : ""}`}
                        >
                          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs font-bold ${on ? "border-emerald-500 bg-emerald-600 text-white" : "border-zinc-600 text-transparent"}`}>
                            ✓
                          </span>
                          <BotAvatar bot={b} size="sm" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold text-zinc-100">{b.name}</span>
                            {(b.role || b.title) && <span className="block truncate text-xs text-zinc-500">{b.role || b.title}</span>}
                          </span>
                        </button>
                      );
                    })}
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-zinc-800 px-4 py-3">
                  <span className="text-xs text-zinc-500">
                    {picked.length === 0 ? "Pilih asisten untuk ditambah" : `${picked.length} dipilih`}
                  </span>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setAddOpen(false)} disabled={busy} className="rounded-md px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40">
                      Batal
                    </button>
                    <button type="button" onClick={doAdd} disabled={picked.length === 0 || busy} className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40">
                      {busy ? "Menambah..." : `Tambah${picked.length > 0 ? ` (${picked.length})` : ""}`}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
          <div className="mt-2 flex items-center gap-1 border-t border-zinc-800 pt-2">
          <button type="button" onClick={() => setTab("chat")} className={`rounded-md px-3 py-1 text-xs font-bold ${tab === "chat" ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-200"}`}>
            💬 Chat
          </button>
          <button type="button" onClick={openBoard} className={`rounded-md px-3 py-1 text-xs font-bold ${tab === "board" ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-200"}`}>
            ▤ Tugas{detail.group.project_id ? "" : " +"}
          </button>
          {tab === "board" && detail.group.project_id && (
            <button type="button" onClick={() => setBoardFull((v) => !v)} title={boardFull ? "Tampilkan chat di samping" : "Tugas layar penuh, chat mengecil"} className="ml-auto rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
              {boardFull ? "⇲ Samping" : "⛶ Penuh"}
            </button>
          )}
        </div>
      </div>

      {tab === "chat" ? (
        <ChatPane minimized={false} />
      ) : !detail.group.project_id ? (
        <div className="rounded-xl border border-dashed border-zinc-700 bg-zinc-900/60 p-8 text-center">
          <div className="text-2xl">▤</div>
          <h3 className="mt-2 font-bold text-zinc-100">Channel ini belum punya daftar tugas</h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-zinc-400">Tempel daftar yang sudah ada, atau buat baru — tugas otomatis hanya untuk channel ini.</p>
          {teamProjects.length > 0 && (
            <div className="mx-auto mt-3 flex max-w-md gap-2">
              <select
                value=""
                onChange={(e) => attach(e.target.value)}
                disabled={attachBusy}
                className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none disabled:opacity-40"
              >
                <option value="">Pilih daftar tugas…</option>
                {teamProjects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          )}
          <form onSubmit={createAndAttach} className="mx-auto mt-2 flex max-w-md gap-2">
            <input
              value={newProjName}
              onChange={(e) => setNewProjName(e.target.value)}
              placeholder="atau nama daftar baru…"
              className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
            />
            <button type="submit" disabled={!newProjName.trim() || attachBusy} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40">
              {attachBusy ? "…" : "Buat"}
            </button>
          </form>
        </div>
      ) : boardFull ? (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <KanbanBoard projectId={detail.group.project_id} teamId={teamId} bots={bots} />
          </div>
          <div className="border-t border-zinc-800 pt-1">
            <ChatPane minimized />
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3">
          <div className="flex min-w-0 flex-1 flex-col">
            <ChatPane minimized={false} />
          </div>
          <div className="hidden w-[420px] shrink-0 overflow-y-auto border-l border-zinc-800 pl-3 md:block">
            <KanbanBoard projectId={detail.group.project_id} teamId={teamId} bots={bots} />
          </div>
        </div>
      )}
    </div>
  );
}

function MeetingView({
  meetingId,
  bots,
  teamId,
  onCreated,
  onChanged,
  onDeleted,
  onOpenBot,
}: {
  meetingId: string | null;
  bots: SlaveBot[];
  teamId: string | null;
  onCreated: (id: string) => Promise<void>;
  onChanged: () => Promise<void>;
  onDeleted: () => Promise<void>;
  onOpenBot: (id: string) => void;
}) {
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [topic, setTopic] = useState("");
  const [picked, setPicked] = useState<string[] | null>(null);
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedNote, setSavedNote] = useState("");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const activeBots = bots.filter((b) => !b.archived);
  const selected = picked ?? activeBots.map((b) => b.id);

  const load = useCallback(async () => {
    if (!meetingId) {
      setDetail(null);
      return;
    }
    try {
      setDetail(await fetchMeetingDetail(meetingId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load meeting.");
    }
  }, [meetingId]);

  useEffect(() => {
    setError("");
    setSavedNote("");
    setPicked(null);
    void load();
  }, [meetingId, load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [detail?.messages.length]);

  function avatarFor(botId: string | null, name: string | null): SlaveBot {
    const found = botId ? bots.find((b) => b.id === botId) : undefined;
    if (found) return found;
    return {
      id: botId ?? "u", name: name ?? "?", title: "", model: "", memory: "",
      role: "", parent_id: "", pinned: 0, pinned_by: "", owner_user_id: "", relay: 1, user_id: "u", team_id: "", avatar_key: "", archived: 0, voice: "luna",
      active_days: "all", active_start: "", active_end: "", created_at: "", updated_at: "",
    };
  }

  function togglePick(id: string) {
    setPicked((prev) => {
      const cur = prev ?? activeBots.map((b) => b.id);
      return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    });
  }

  async function start(e?: React.FormEvent) {
    e?.preventDefault();
    if (!topic.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const created = await createMeeting(topic.trim(), selected, teamId ?? undefined);
      setTopic("");
      setPicked(null);
      await onCreated(created.meeting.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start meeting.");
    } finally {
      setBusy(false);
    }
  }

  async function sendTask(e?: React.FormEvent) {
    e?.preventDefault();
    if (!task.trim() || busy || !detail) return;
    setBusy(true);
    setError("");
    setSavedNote("");
    try {
      const res = await meetingChat(detail.meeting.id, task.trim());
      setTask("");
      setSavedNote(`Dijawab ${res.replies.length} asisten · ${formatUsd(res.total_cost_usd)}`);
      await load();
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Meeting chat failed.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!detail || !window.confirm(`Delete meeting "${detail.meeting.topic}"?`)) return;
    try {
      await deleteMeeting(detail.meeting.id);
      await onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete meeting.");
    }
  }

  if (!meetingId) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
        <div>
          <h2 className="text-xl font-bold">Mulai rapat</h2>
          <p className="mt-1 text-sm text-zinc-400">
            Beri tahu asisten tentang suatu topik. Masing-masing membaca tugasnya lalu memutuskan ikut atau tidak.
            Maksimal 8 asisten per rapat.
          </p>
        </div>
        {activeBots.length === 0 && <p className="text-sm text-zinc-400">Buat asisten dulu — belum ada yang bisa diajak rapat.</p>}
        <form onSubmit={start} className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-5">
          <label className="text-sm font-semibold text-zinc-300">
            Topik
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="cth. Rencana promo akhir pekan"
              maxLength={500}
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
            />
          </label>
          {activeBots.length > 0 && (
            <div className="text-sm">
              <div className="mb-1 font-semibold text-zinc-300">Beri tahu (masing-masing memutuskan ikut/tidak)</div>
              <div className="flex flex-col gap-1">
                {activeBots.map((b) => (
                  <label key={b.id} className="flex cursor-pointer items-center gap-2 text-zinc-200">
                    <input type="checkbox" checked={selected.includes(b.id)} onChange={() => togglePick(b.id)} className="accent-emerald-500" />
                    <BotAvatar bot={b} size="sm" />
                    <span>{b.name}</span>
                    {b.role && <span className="truncate text-xs text-zinc-500">{b.role}</span>}
                  </label>
                ))}
              </div>
            </div>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button type="submit" disabled={busy || !topic.trim() || selected.length === 0} className="self-start rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
            {busy ? "Menanyakan asisten..." : "Mulai rapat"}
          </button>
        </form>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-2 p-8" aria-label="Loading meeting">
        <div className="loading-skeleton h-8 w-1/3" />
        <div className="loading-skeleton h-24 w-full" />
        <div className="loading-skeleton h-24 w-full" />
      </div>
    );
  }

  const joined = detail.participants.filter((p) => p.decision === "join");
  const declined = detail.participants.filter((p) => p.decision !== "join");

  return (
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-3 p-4">
      <div>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-bold">{detail.meeting.topic}</h2>
          <button type="button" onClick={remove} className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400">
            Hapus
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {joined.map((p) => (
            <button
              key={p.slavebot_id}
              type="button"
              onClick={() => onOpenBot(p.slavebot_id)}
              title={p.reason || "ikut"}
              className="flex items-center gap-1.5 rounded-full border border-emerald-800 bg-emerald-950 py-1 pl-1 pr-2 text-sm hover:bg-emerald-900"
            >
              <BotAvatar bot={avatarFor(p.slavebot_id, p.bot_name)} size="sm" />
              <span className="text-emerald-200">{p.bot_name ?? "?"}</span>
            </button>
          ))}
          {declined.map((p) => (
            <button
              key={p.slavebot_id}
              type="button"
              onClick={() => onOpenBot(p.slavebot_id)}
              title={p.reason ? `Tidak ikut: ${p.reason}` : "Tidak ikut"}
              className="flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 py-1 pl-1 pr-2 text-sm opacity-70 hover:opacity-100"
            >
              <BotAvatar bot={avatarFor(p.slavebot_id, p.bot_name)} size="sm" />
              <span className="text-zinc-400 line-through">{p.bot_name ?? "?"}</span>
            </button>
          ))}
        </div>
        {declined.length > 0 && (
          <p className="mt-1 text-xs text-zinc-500">Arahkan kursor ke yang tidak ikut untuk tahu alasannya.</p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {detail.messages.length === 0 && (
          <p className="py-8 text-center text-zinc-500">Asisten yang ikut sudah siap. Sapa mereka untuk mulai diskusi.</p>
        )}
        {detail.messages.map((m) => (
          <div key={m.id} className="group flex gap-3 rounded px-2 py-3 hover:bg-zinc-800/50">
            {m.slavebot_id ? (
              <BotAvatar bot={avatarFor(m.slavebot_id, m.bot_name)} size="sm" />
            ) : (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-600 text-sm font-bold text-white">Y</div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-bold">{m.slavebot_id ? (m.bot_name ?? "Asisten") : "Anda"}</span>
                <span className="text-xs text-zinc-500">{new Date(m.created_at).toLocaleString()}</span>
              </div>
              <div className="whitespace-pre-wrap break-words text-[15px] text-zinc-200">{m.content}</div>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {error && <p className="py-1 text-sm text-red-400">{error}</p>}
      {savedNote && <p className="py-1 text-sm text-emerald-400">{savedNote}</p>}

      <form onSubmit={sendTask} className="mt-2 flex items-end gap-1 rounded-[28px] border border-zinc-700 bg-[#2b2d31] p-2 pl-4 shadow-lg focus-within:border-zinc-500">
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendTask();
            }
          }}
          placeholder={joined.length === 0 ? "Nobody joined — nothing to discuss" : "Talk to the bots that joined..."}
          rows={1}
          disabled={busy || joined.length === 0}
          className="max-h-40 flex-1 resize-none bg-transparent px-2 py-2 text-[15px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none disabled:opacity-40"
        />
        <button type="submit" disabled={!task.trim() || busy} title="Send" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-700 disabled:text-zinc-500">
          {busy ? <Spinner /> : <ArrowUpIcon />}
        </button>
      </form>
    </div>
  );
}

function SchedulesView({ botId }: { botId: string }) {
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

function TeamView({ bot, onOpenBot, onTeamChanged }: { bot: SlaveBot; onOpenBot: (id: string) => void; onTeamChanged: () => void }) {
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

const TEAM_PROVIDER_PRESETS = [
  { id: "meta", label: "Meta (disarankan)", needs_url: false, placeholder: "", help: "Satu kunci dari dev.meta.ai. Model: muse-spark-1.3, muse-wonder-1.0." },
  { id: "openrouter", label: "OpenRouter (cadangan)", needs_url: false, placeholder: "", help: "Kunci sk-or-v1-… dari openrouter.ai/keys. Daftar model tetap." },
  { id: "opencode", label: "OpenCode (langganan Go / kredit Console)", needs_url: true, placeholder: "https://opencode.ai/inference/go/openai/v1", help: "Pelanggan Go: https://opencode.ai/inference/go/openai/v1. Bayar per pakai: https://opencode.ai/inference/openai/v1 (butuh kredit console). Jangan tambah /chat/completions." },
  { id: "ollama", label: "Ollama (lokal, tanpa kunci)", needs_url: true, placeholder: "http://localhost:11434/v1", help: "Ollama lokal. Tanpa kunci. Model harus diunduh dulu — jalankan `ollama list` lalu pakai id persisnya di pengaturan Asisten." },
  { id: "baseten", label: "Baseten", needs_url: true, placeholder: "https://inference.baseten.co/v1", help: "Alamat + kunci API deployment Baseten milikmu." },
  { id: "modal", label: "Modal", needs_url: true, placeholder: "https://<you>--<app>.modal.run/v1", help: "Alamat fungsi Modal milikmu (akar API) + kunci." },
  { id: "custom", label: "Lainnya (server OpenAI-compatible)", needs_url: true, placeholder: "http://127.0.0.1:1234/v1", help: "Server OpenAI-compatible apa pun (vLLM, LM Studio, …). Alamat harus berakhiran /v1. Kunci boleh kosong hanya untuk localhost." },
];

function isLocalHost(v: string): boolean {
  const s = v.trim().toLowerCase();
  return (
    s.includes("localhost") || s.includes("127.0.0.1") || s.includes("0.0.0.0") || s.includes("192.168.") || s.includes("10.") || s.includes(".local")
  );
}

function TeamProviderSection({ team, onChanged }: { team: TeamDetail["team"]; onChanged: () => void }) {
  const [preset, setPreset] = useState(team.provider || "meta");
  const [baseUrl, setBaseUrl] = useState(team.provider_base_url || "");
  const [apiKey, setApiKey] = useState("");
  const [testModel, setTestModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string; endpoint?: string; model?: string; models?: string[]; notes?: string[] } | null>(null);
  const meta = TEAM_PROVIDER_PRESETS.find((x) => x.id === preset) ?? TEAM_PROVIDER_PRESETS[0];
  const needsUrl = meta.needs_url;
  const keyOptional = preset === "ollama" || (needsUrl && isLocalHost(baseUrl));

  function normalizedEndpoint(): string {
    let b = baseUrl.trim();
    if (!b && !needsUrl) {
      b = preset === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.meta.ai/v1";
    }
    b = b.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
    return b ? `${b}/chat/completions` : "";
  }

  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setTestResult(null);
    try {
      await setTeamProvider(team.id, { preset, base_url: needsUrl ? baseUrl.trim() : undefined, api_key: apiKey.trim() || undefined });
      setApiKey("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save provider.");
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    if (testing) return;
    setTesting(true);
    setError("");
    setTestResult(null);
    try {
      // Save first so the test hits the latest config (keep existing key when blank).
      await setTeamProvider(team.id, { preset, base_url: needsUrl ? baseUrl.trim() : undefined, api_key: apiKey.trim() || undefined });
      setApiKey("");
      onChanged();
      const res = await testTeamProvider(team.id, testModel.trim() || undefined);
      setTestResult(res);
      if (!res.ok) setError(res.error || "Connection test failed.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Connection test failed.";
      setError(msg);
      setTestResult({ ok: false, error: msg });
    } finally {
      setTesting(false);
    }
  }

  async function remove() {
    if (!window.confirm("Hapus kunci AI tim ini? Asisten tidak bisa menjawab sampai ada kunci baru.")) return;
    setBusy(true);
    setError("");
    try {
      await clearTeamProvider(team.id);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove key.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-bold uppercase tracking-wide text-zinc-500">Kunci AI</h4>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${team.provider_key_set || keyOptional ? "bg-emerald-950 text-emerald-300" : "bg-amber-950 text-amber-300"}`}>
          {team.provider_key_set ? "sudah ada" : keyOptional ? "tanpa kunci OK" : "belum ada"}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-zinc-500">Agar asisten bisa menjawab, tim ini butuh kunci dari penyedia AI (mis. Meta, OpenRouter). Satu kunci untuk satu tim.</p>
      <form onSubmit={save} className="mt-3 space-y-3">
        <label className="block text-xs font-semibold text-zinc-300">
          Penyedia
          <select value={preset} onChange={(e) => { setPreset(e.target.value); setTestResult(null); }} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none">
            {TEAM_PROVIDER_PRESETS.map((x) => (
              <option key={x.id} value={x.id}>{x.label}</option>
            ))}
          </select>
        </label>
        <p className="text-[11px] leading-snug text-zinc-500">{meta.help}</p>
        {needsUrl && (
          <label className="block text-xs font-semibold text-zinc-300">
            Alamat server <span className="font-normal text-zinc-500">(berakhiran /v1)</span>
            <input value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setTestResult(null); }} placeholder={meta.placeholder || "https://..."} autoComplete="off" spellCheck={false} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 font-mono text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
          </label>
        )}
        <label className="block text-xs font-semibold text-zinc-300">
          Kunci {team.provider_key_set ? "(sudah tersimpan — isi baru untuk ganti)" : keyOptional ? "(boleh kosong untuk server lokal)" : "(wajib diisi)"}
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={team.provider_key_set ? "••••••••" : keyOptional ? "kosongkan untuk lokal" : "tempel kunci..."} autoComplete="off" className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
        </label>
        {needsUrl && baseUrl.trim() && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2">
            <div className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">Akan menghubungi</div>
            <div className="mt-0.5 break-all font-mono text-[12px] text-emerald-300">{normalizedEndpoint() || "—"}</div>
            {baseUrl.trim().endsWith("/chat/completions") && (
              <div className="mt-1 text-[11px] text-amber-300">Alamat kepanjangan — akhiran /chat/completions kami buang otomatis.</div>
            )}
          </div>
        )}
        <label className="block text-xs font-semibold text-zinc-300">
          Model untuk tes <span className="font-normal text-zinc-500">(nama persis dari server)</span>
          <input value={testModel} onChange={(e) => setTestModel(e.target.value)} placeholder="cth. qwen3:8b — kosongkan untuk pakai yang pertama" autoComplete="off" spellCheck={false} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 font-mono text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" disabled={busy || testing} className="rounded-md bg-zinc-700 px-3 py-1.5 text-sm font-bold text-white hover:bg-zinc-600 disabled:opacity-50">
            {busy ? "Menyimpan..." : "Simpan"}
          </button>
          <button type="button" onClick={runTest} disabled={testing || busy} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
            {testing ? "Mengetes..." : "Simpan + tes koneksi"}
          </button>
          {team.provider_key_set && (
            <button type="button" onClick={remove} disabled={busy || testing} className="rounded px-2 py-1 text-xs text-zinc-500 hover:text-red-400 disabled:opacity-50">
              Hapus kunci
            </button>
          )}
        </div>
        {testResult && (
          <div className={`rounded-lg border px-3 py-2 text-[12px] ${testResult.ok ? "border-emerald-800 bg-emerald-950/60 text-emerald-200" : "border-red-800 bg-red-950/50 text-red-200"}`}>
            <div className="font-bold">{testResult.ok ? "Koneksi OK" : "Koneksi gagal"}</div>
            {testResult.endpoint && <div className="mt-0.5 break-all font-mono text-[11px] opacity-80">{testResult.endpoint}{testResult.model ? ` · ${testResult.model}` : ""}</div>}
            {testResult.models && testResult.models.length > 0 && (
              <div className="mt-1 opacity-90">Model di server: <span className="font-mono">{testResult.models.slice(0, 8).join(", ")}</span>{testResult.models.length > 8 ? ` +${testResult.models.length - 8} lagi` : ""}</div>
            )}
            {testResult.notes?.map((n, i) => <div key={i} className="mt-0.5 opacity-80">{n}</div>)}
            {!testResult.ok && testResult.error && <div className="mt-1">{testResult.error}</div>}
          </div>
        )}
        <p className="text-[11px] text-zinc-500">
          {team.provider_key_set ? "Kunci aktif — tagihan AI dibayar langsung oleh kunci ini." : keyOptional ? "Belum ada kunci — boleh kosong hanya untuk server lokal." : "Belum ada kunci — asisten tidak bisa menjawab sampai pemilik/admin menambahkan."}
          {" "}Error 404? Nama model harus persis sama dengan di server, dan alamat harus akar /v1.
        </p>
        {error && !testResult && <p className="text-xs text-red-400">{error}</p>}
      </form>
    </div>
  );
}

function TeamsView({
  teams,
  teamId,
  userId,
  onChanged,
  onSelect,
}: {
  teams: Team[];
  teamId: string | null;
  userId: string;
  onChanged: () => Promise<void>;
  onSelect: (id: string) => void;
}) {
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [name, setName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("staff");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const activeId = teamId ?? teams[0]?.id ?? null;

  useEffect(() => {
    if (!activeId) {
      setDetail(null);
      return;
    }
    fetchTeam(activeId)
      .then((d) => {
        setDetail(d);
        if (d.my_role === "owner" || d.my_role === "admin") {
          fetchTeamActivity(activeId).then(setActivity).catch(() => {});
        } else {
          setActivity([]);
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load team."));
  }, [activeId, teams.length]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      if (activeId) {
        setDetail(await fetchTeam(activeId));
        if (myRole === "owner" || myRole === "admin") {
          fetchTeamActivity(activeId).then(setActivity).catch(() => {});
        }
      }
      await onChanged();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Team action failed.");
    } finally {
      setBusy(false);
    }
  }

  const myRole = detail?.my_role ?? "staff";
  const canManage = myRole === "owner" || myRole === "admin";

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h2 className="text-xl font-bold">Tim</h2>
      <p className="mt-1 text-sm text-zinc-400">Satu tim punya asisten AI, grup, dan rapatnya sendiri. Pemilik dan admin mengatur semuanya; anggota biasa hanya melihat asisten yang dibagikan ke mereka.</p>
      <form
        onSubmit={(e) => { e.preventDefault(); if (name.trim()) void run(() => createTeam(name.trim())); setName(""); }}
        className="mt-4 flex gap-2"
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nama tim baru, cth. Warung Bu Tini"
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
        />
        <button type="submit" disabled={busy || !name.trim()} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
          Buat
        </button>
      </form>
      <div className="mt-3 flex flex-wrap gap-2">
        {teams.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id)}
            className={`rounded-md border px-3 py-1.5 text-sm font-semibold ${t.id === activeId ? "border-emerald-600 bg-zinc-800 text-zinc-100" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}
          >
            {t.name} <span className="text-xs text-zinc-500">{t.role}{t.personal ? " · pribadi" : ""}</span>
          </button>
        ))}
      </div>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      {detail && (
        <div className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold">{detail.team.name}</h3>
            {canManage && !detail.team.personal && (
              <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Hapus tim ${detail.team.name}? Asistennya diarsipkan; grup dan rapat dihapus.`)) void run(() => deleteTeam(detail.team.id)); }} className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400 disabled:opacity-50">
                Hapus tim
              </button>
            )}
          </div>
          {canManage && (
            <TeamProviderSection
              key={detail.team.id}
              team={detail.team}
              onChanged={() => { void (async () => { setDetail(await fetchTeam(activeId!)); await onChanged(); })(); }}
            />
          )}
          {!canManage && (
            <p className="mt-4 rounded-md border border-zinc-800 bg-zinc-800/40 px-3 py-2 text-xs text-zinc-500">
              Kunci AI: {detail.team.provider || "meta"}{detail.team.provider_key_set ? " · sudah ada" : " · belum ada — minta pemilik/admin menambahkan"}.
            </p>
          )}
          <h4 className="mt-4 text-sm font-bold uppercase tracking-wide text-zinc-500">Anggota ({detail.members.length})</h4>
          <ul className="mt-2 space-y-1">
            {detail.members.map((m) => (
              <li key={m.user_id} className="flex items-center gap-2 rounded-md bg-zinc-800/60 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{m.name || m.email} <span className="text-xs text-zinc-500">{m.email}</span></span>
                {canManage && m.user_id !== userId ? (
                  <select value={m.role} disabled={busy} onChange={(e) => void run(() => setMemberRole(detail.team.id, m.user_id, e.target.value))} className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 focus:border-emerald-500 focus:outline-none">
                    <option value="admin">admin</option>
                    <option value="staff">staff</option>
                  </select>
                ) : (
                  <span className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400">{m.role}</span>
                )}
                {canManage && m.user_id !== userId && (
                  <button type="button" disabled={busy} onClick={() => void run(() => removeMember(detail.team.id, m.user_id))} className="rounded px-1 text-xs text-zinc-500 hover:text-red-400 disabled:opacity-50">Keluarkan</button>
                )}
              </li>
            ))}
          </ul>
          {canManage && (
            <form
              onSubmit={(e) => { e.preventDefault(); if (inviteEmail.trim()) void run(() => inviteMember(detail.team.id, inviteEmail.trim(), inviteRole)); setInviteEmail(""); }}
              className="mt-3 flex gap-2"
            >
              <input
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="teammate@example.com"
                autoComplete="off"
                className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
              />
              <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none">
                <option value="admin">admin</option>
                <option value="staff">staff</option>
              </select>
              <button type="submit" disabled={busy || !inviteEmail.trim()} className="rounded-md bg-zinc-700 px-3 py-2 text-sm font-bold text-white hover:bg-zinc-600 disabled:opacity-50">
                Undang
              </button>
            </form>
          )}
          <h4 className="mt-5 text-sm font-bold uppercase tracking-wide text-zinc-500">Asisten AI ({detail.bots.length})</h4>
          <ul className="mt-2 space-y-1">
            {detail.bots.map((b) => {
              const owner = detail.members.find((m) => m.user_id === b.owner_user_id);
              return (
              <li key={b.id} className="rounded-md bg-zinc-800/60 px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-semibold">{b.name}</span>
                  <span className="shrink-0 text-xs text-zinc-500">◈ {owner ? (owner.name || owner.email) : "unassigned"}</span>
                </div>
                {canManage && (
                  <label className="mt-1 flex items-center gap-2 text-xs text-zinc-400">
                    Partner (penanggung jawab)
                    <select
                      value={b.owner_user_id}
                      disabled={busy}
                      onChange={(e) => void run(() => transferBot(b.id, e.target.value))}
                      className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 focus:border-emerald-500 focus:outline-none"
                    >
                      {detail.members.map((m) => (
                        <option key={m.user_id} value={m.user_id}>{m.name || m.email} ({m.role})</option>
                      ))}
                    </select>
                  </label>
                )}
                {canManage && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {detail.members.filter((m) => m.role === "staff").map((m) => {
                      const has = m.bot_ids.includes(b.id);
                      return (
                        <button
                          key={m.user_id}
                          type="button"
                          disabled={busy}
                          title={has ? `Cabut akses ${b.name} dari ${m.email}` : `Beri akses ${b.name} ke ${m.email}`}
                          onClick={() => void run(() => has ? revokeBotAccess(detail.team.id, b.id, m.user_id, m.bot_ids) : grantBotAccess(detail.team.id, b.id, m.user_id, m.bot_ids))}
                          className={`rounded border px-2 py-0.5 text-xs ${has ? "border-emerald-700 text-emerald-400" : "border-zinc-700 text-zinc-500 hover:text-zinc-200"}`}
                        >
                          {m.email}: {has ? "boleh" : "beri akses"}
                        </button>
                      );
                    })}
                  </div>
                )}
              </li>
              );
            })}
            {detail.bots.length === 0 && <p className="text-sm text-zinc-600">Belum ada asisten di tim ini.</p>}
          </ul>
          {canManage && (
            <>
              <h4 className="mt-5 text-sm font-bold uppercase tracking-wide text-zinc-500">Obrolan terakhir (semua asisten)</h4>
              {activity.length === 0 ? (
                <p className="mt-1 text-sm text-zinc-600">Belum ada obrolan asisten.</p>
              ) : (
                <ul className="mt-2 max-h-96 space-y-1 overflow-y-auto">
                  {activity.map((a, i) => (
                    <li key={i} className="rounded-md bg-zinc-800/60 px-3 py-2 text-sm">
                      <div className="flex items-baseline gap-2">
                        <span className="font-semibold">{a.bot_name}</span>
                        <span className={`rounded px-1 text-[10px] font-bold uppercase ${a.role === "assistant" ? "bg-emerald-900/60 text-emerald-300" : "bg-zinc-700 text-zinc-300"}`}>{a.role}</span>
                        <span className="text-xs text-zinc-500">{a.created_at ? new Date(a.created_at).toLocaleString() : ""}</span>
                      </div>
                      <p className="mt-0.5 whitespace-pre-wrap break-words text-[13px] text-zinc-300">{a.content.length > 300 ? `${a.content.slice(0, 300)}…` : a.content}</p>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function dayLabel(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

function dayKey(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function renderMentions(content: string): ReactNode[] {
  return content.split(/(@[\w.-]+)/g).map((part, i) =>
    part.startsWith("@") && part.length > 1 ? (
      <span key={i} className="rounded bg-emerald-900/60 px-0.5 font-semibold text-emerald-300">{part}</span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

function BotView({
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

function FlySection({ teamId }: { teamId: string | null }) {
  const [accounts, setAccounts] = useState<FlyAccount[]>([]);
  const [machines, setMachines] = useState<FlyMachine[]>([]);
  const [domains, setDomains] = useState<CustomDomain[]>([]);
  const [name, setName] = useState("");
  const [org, setOrg] = useState("");
  const [token, setTokenInput] = useState("");
  const [slug, setSlug] = useState("");
  const [sub, setSub] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!teamId) { setAccounts([]); setMachines([]); setDomains([]); return; }
    try {
      const [a, m, d] = await Promise.all([fetchFlyAccounts(teamId), fetchFlyMachines(teamId), fetchDomains(teamId)]);
      setAccounts(a); setMachines(m); setDomains(d);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not load Fly state."); }
  }, [teamId]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    if (!teamId || !token.trim() || busy) return;
    setBusy(true); setError("");
    try {
      await connectFly(teamId, { name: name.trim() || "fly", org: org.trim(), api_token: token.trim() });
      setName(""); setOrg(""); setTokenInput("");
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : "Fly connect failed."); }
    finally { setBusy(false); }
  }

  async function provision(accountId: string) {
    if (!teamId || !slug.trim() || busy) return;
    setBusy(true); setError("");
    try { await provisionFly(teamId, { account_id: accountId, name: slug.trim().toLowerCase() }); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : "Provision failed."); }
    finally { setBusy(false); }
  }

  return (
    <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="mb-1 text-sm font-bold uppercase tracking-wide text-zinc-500">Server (Fly.io)</h3>
      <p className="mb-2 text-xs text-zinc-500">Sambungkan akun Fly.io milik usaha. Slaver menyiapkan 2 mesin terpisah: <b>prod</b> (stabil, untuk aplikasi yang dilihat pelanggan) + <b>dev</b> (untuk coba-coba). Token tersimpan aman di server.</p>
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      <form onSubmit={connect} className="flex flex-col gap-2">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama akun, cth. warung" disabled={!teamId} className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none disabled:opacity-40" />
          <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Kode organisasi (opsional)" disabled={!teamId} className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none disabled:opacity-40" />
        </div>
        <input value={token} onChange={(e) => setTokenInput(e.target.value)} placeholder="Token Fly (fo1_...)" type="password" disabled={!teamId} className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none disabled:opacity-40" />
        <div><button type="submit" disabled={!token.trim() || !teamId || busy} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40">{busy ? "Menyimpan..." : "Sambungkan"}</button></div>
      </form>
      {accounts.map((a) => (
        <div key={a.id} className="mt-3 rounded-md bg-zinc-800/60 p-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-zinc-100">{a.name}</span>
            <span className="font-mono text-zinc-500">{a.org || "default org"} · token ✓</span>
            <button type="button" onClick={() => teamId && disconnectFly(teamId, a.id).then(refresh)} className="ml-auto text-zinc-500 hover:text-red-400">Putuskan</button>
          </div>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="nama pendek, cth. warung" className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
            <button type="button" onClick={() => provision(a.id)} disabled={!slug.trim() || busy} className="rounded-md bg-sky-600 px-3 py-1.5 font-bold text-white hover:bg-sky-500 disabled:opacity-40">Buatkan 2 mesin</button>
          </div>
          <p className="mt-1 text-zinc-500">Membuat <span className="font-mono">{slug || "slug"}-prod</span> (asli) + <span className="font-mono">{slug || "slug"}-dev</span> (uji coba).</p>
        </div>
      ))}
      {machines.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {machines.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-2 rounded-md bg-zinc-800/60 px-3 py-2 font-mono text-xs">
              <span className={m.role === "prod" ? "font-bold text-emerald-400" : "font-bold text-sky-400"}>{m.role}</span>
              <span className="text-zinc-100">{m.app_name}</span>
              <span className="text-zinc-500">{m.machine_id.slice(0, 8)} · {m.image} · {m.cpus}cpu/{m.memory_mb}MB · {m.status}</span>
              <button type="button" onClick={() => teamId && destroyFlyMachine(teamId, m.id, false).then(refresh)} className="ml-auto text-zinc-500 hover:text-red-400">Hapus</button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 border-t border-zinc-800 pt-3">
        <div className="mb-1 text-xs font-bold uppercase tracking-wide text-zinc-500">Alamat web — {`{nama}.slaver.app`}</div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input value={sub} onChange={(e) => setSub(e.target.value)} placeholder="nama depan, cth. kasirku" className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
          <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="tujuan: xxx.fly.dev atau IP" className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
          <button type="button" onClick={async () => { if (!teamId || !sub.trim() || !target.trim()) return; setError(""); try { await addDomain(teamId, { subdomain: sub.trim().toLowerCase(), target: target.trim() }); setSub(""); setTarget(""); await refresh(); } catch (err) { setError(err instanceof Error ? err.message : "Gagal pasang alamat."); } }} className="rounded-md bg-zinc-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-zinc-600">Pasang alamat</button>
        </div>
        {domains.map((d) => (
          <div key={d.id} className="mt-1 flex items-center gap-2 font-mono text-xs text-zinc-400">
            <span className="text-zinc-100">{d.hostname}</span><span>→ {d.target}</span><span className="text-zinc-600">[{d.status}]</span>
            <button type="button" onClick={() => teamId && removeDomain(teamId, d.id).then(refresh)} className="ml-auto text-zinc-600 hover:text-red-400">lepas</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function DeveloperSection({ teamId }: { teamId: string | null }) {
  const [clients, setClients] = useState<OAuthClient[]>([]);
  const [name, setName] = useState("");
  const [redirects, setRedirects] = useState("");
  const [newSecret, setNewSecret] = useState<{ id: string; secret: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!teamId) {
      setClients([]);
      return;
    }
    try {
      setClients(await fetchOAuthClients(teamId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load OAuth clients.");
    }
  }, [teamId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!teamId || !name.trim() || !redirects.trim() || busy) return;
    setBusy(true);
    setError("");
    setNewSecret(null);
    try {
      const res = await createOAuthClient(teamId, name.trim(), redirects.trim());
      setNewSecret({ id: res.client.id, secret: res.client_secret });
      setName("");
      setRedirects("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create client.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(clientId: string) {
    if (!teamId || !window.confirm("Cabut akses ini? Pelanggan yang sedang masuk langsung keluar.")) return;
    setError("");
    try {
      await revokeOAuthClient(teamId, clientId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke client.");
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="mb-1 text-sm font-bold uppercase tracking-wide text-zinc-500">Login dengan Slaver</h3>
      <p className="mb-2 text-xs text-zinc-500">
        Pelanggan bisa masuk ke aplikasimu dengan akun Slaver-nya. Aplikasi menerima nama, email, tim, dan peran mereka.
      </p>
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      {newSecret && (
        <div className="mb-2 rounded-md border border-amber-700 bg-amber-950/60 p-2 text-xs text-amber-200">
          <div className="font-bold">Salin kunci rahasia sekarang — hanya tampil sekali.</div>
          <div className="mt-1 break-all font-mono">client_id: {newSecret.id}</div>
          <div className="break-all font-mono">client_secret: {newSecret.secret}</div>
        </div>
      )}
      <form onSubmit={create} className="flex flex-col gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nama aplikasi, cth. Kasir Warung Saya"
          disabled={!teamId}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none disabled:opacity-40"
        />
        <input
          value={redirects}
          onChange={(e) => setRedirects(e.target.value)}
          placeholder="Alamat kembali, pisah koma — https://aplikasi.com/oauth/callback"
          disabled={!teamId}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none disabled:opacity-40"
        />
        <div>
          <button type="submit" disabled={!name.trim() || !redirects.trim() || !teamId || busy} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40">
            {busy ? "Membuat..." : "Buat akses login"}
          </button>
        </div>
      </form>
      {clients.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1">
          {clients.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-md bg-zinc-800/60 px-3 py-2 text-xs">
              <span className="font-semibold text-zinc-100">{c.name}</span>
              <span className="font-mono text-zinc-500">{c.id}</span>
              <span className="truncate text-zinc-500">{c.redirect_uris}</span>
              <button type="button" onClick={() => revoke(c.id)} className="ml-auto text-zinc-500 hover:text-red-400">
                Cabut
              </button>
            </li>
          ))}
        </ul>
      )}
      {!teamId && <p className="mt-1 text-xs text-zinc-500">Pilih tim dulu (khusus pemilik/admin).</p>}
    </div>
  );
}

function SettingsView({
  user,
  teams,
  teamId,
  memberNames,
  onPickTeam,
  onTeamsChanged,
  onCreateBot,
  onLogout,
}: {
  user: User;
  teams: Team[];
  teamId: string | null;
  memberNames: Record<string, string>;
  onPickTeam: (id: string) => void;
  onTeamsChanged: () => Promise<void>;
  onCreateBot: (ownerId: string) => Promise<void>;
  onLogout: () => void;
}) {
  const [createOwner, setCreateOwner] = useState(user.id);
  const [creating, setCreating] = useState(false);

  async function create() {
    if (creating) return;
    setCreating(true);
    try {
      await onCreateBot(createOwner || user.id);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <h2 className="text-xl font-bold text-zinc-100">Pengaturan</h2>

      <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-zinc-500">Profil</h3>
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-zinc-800 text-lg font-bold text-zinc-200">
            {(user.name || user.email || "?").slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold text-zinc-100">{user.name || "Unnamed"}</div>
            <div className="truncate text-xs text-zinc-500">{user.email}</div>
          </div>
          <button type="button" onClick={onLogout} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">
            Keluar
          </button>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <h3 className="mb-1 text-sm font-bold uppercase tracking-wide text-zinc-500">Asisten AI baru</h3>
        <p className="mb-2 text-xs text-zinc-500">Asisten tinggal di tim yang dipilih dan muncul di Chat.</p>
        <div className="flex gap-2">
          <select
            value={createOwner}
            onChange={(e) => setCreateOwner(e.target.value)}
            title="Partner (penanggung jawab)"
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
          >
            <option value={user.id}>{memberNames[user.id] ?? "Saya"}</option>
            {Object.entries(memberNames).filter(([id]) => id !== user.id).map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
          <button type="button" onClick={create} disabled={creating || !teamId} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40">
            {creating ? "Membuat..." : "Buat"}
          </button>
        </div>
        {!teamId && <p className="mt-1 text-xs text-amber-300">Pilih tim dulu.</p>}
      </div>

      <div className="mt-4">
        <TeamsView
          teams={teams}
          teamId={teamId}
          userId={user.id}
          onChanged={onTeamsChanged}
          onSelect={onPickTeam}
        />
      </div>

      <FlySection teamId={teamId} />

      <DeveloperSection teamId={teamId} />
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [providerInfo, setProviderInfo] = useState<ProviderInfo | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [view, setView] = useState<"apps" | "chat" | "group" | "meeting" | "bot" | "settings" | "code" | "market">("apps");
  const [bots, setBots] = useState<SlaveBot[]>([]);
  const [botId, setBotId] = useState<string | null>(null);
  const [bot, setBot] = useState<SlaveBot | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [recorder, setRecorder] = useState<Recorder | null>(null);
  const [recSecs, setRecSecs] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [conversing, setConversing] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [speakingKey, setSpeakingKey] = useState<number | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const [teamMenuOpen, setTeamMenuOpen] = useState(false);

  function pickTeam(id: string | null) {
    setTeamId(id);
    setBotId(null);
    setBot(null);
    setGroupId(null);
    setMeetingId(null);
    setMessages([]);
    setTeamMenuOpen(false);
  }
  const [plusOpen, setPlusOpen] = useState(false);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const keyRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const recTimer = useRef<number | null>(null);
  const converseRef = useRef(false);
  const audioRef = useRef<{ stop: () => void } | null>(null);
  const autoOpenedRef = useRef(false);

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

  const refreshGroups = useCallback(async () => {
    try {
      setGroups(await fetchGroups());
    } catch {
      /* keep old list on transient failure */
    }
  }, []);

  const refreshMeetings = useCallback(async () => {
    try {
      setMeetings(await fetchMeetings());
    } catch {
      /* keep old list on transient failure */
    }
  }, []);

  useEffect(() => {
    warmUpVoices();
    refreshUser().finally(() => setChecking(false));
    fetchProviderModels().then(setProviderInfo).catch(() => {});
    fetchTeams().then((list) => {
      setTeams(list);
      if (list.length > 0) {
        setTeamId((prev) => {
          const next = prev ?? list[0].id;
          fetchTeam(next).then((d) => {
            const names: Record<string, string> = {};
            for (const m of d.members) names[m.user_id] = m.name || m.email || m.user_id;
            setMemberNames(names);
          }).catch(() => {});
          return next;
        });
      }
    }).catch(() => {});
  }, [refreshUser]);

  useEffect(() => {
    if (teams.length > 0 || teamId) {
      fetchProviderModels(teamId ?? undefined).then(setProviderInfo).catch(() => {});
    }
  }, [teamId, teams.length]);

  useEffect(() => {
    if (user) {
      autoOpenedRef.current = false;
      // First load per login: open the pinned bot automatically, if any.
      void (async () => {
        try {
          const list = await fetchBots();
          setBots(list);
          if (!autoOpenedRef.current) {
            autoOpenedRef.current = true;
            const pinned = list.find((b) => b.pinned && b.pinned_by === user.id && !b.archived);
            if (pinned) await openBot(pinned.id);
          }
        } catch {
          /* keep old list on transient failure */
        }
      })();
      refreshGroups();
      refreshMeetings();
      if (teamId) {
        fetchTeam(teamId).then((d) => {
          const names: Record<string, string> = {};
          for (const m of d.members) names[m.user_id] = m.name || m.email || m.user_id;
          setMemberNames(names);
        }).catch(() => {});
      }
    } else {
      setBots([]);
      setGroups([]);
      setMeetings([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, teamId]);

  useEffect(() => {
    if (user) {
      fetchPublicGroups().then(setSupportGroups).catch(() => {});
    } else {
      setSupportGroups([]);
    }
  }, [user]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [messages]);

  useEffect(() => {
    return () => {
      if (recTimer.current !== null) window.clearInterval(recTimer.current);
      converseRef.current = false;
      audioRef.current?.stop();
      stopSpeaking();
    };
  }, []);

  function stopAudio() {
    audioRef.current?.stop();
    audioRef.current = null;
    stopSpeaking();
  }

  function stopConverse() {
    converseRef.current = false;
    setConversing(false);
    setMicLevel(0);
    stopAudio();
  }

  /** Spoken reply: server Aura voice first, built-in browser voice as fallback. */
  async function speakReply(content: string, key: number | null, useServer: boolean) {
    const text = content.trim().slice(0, 2000);
    if (!text) return;
    stopAudio();
    if (key !== null) setSpeakingKey(key);
    try {
      if (useServer && bot) {
        const res = await speakVoice(text, bot.voice || "luna");
        const player = playAudioBlob(res.audio);
        audioRef.current = player;
        await player.done;
        return;
      }
    } catch (err) {
      if (err instanceof Error && /key|config|credential|permission|credit/i.test(err.message)) {
        setError(`Server voice unavailable (${err.message}) — using the built-in voice.`);
      }
    } finally {
      if (key !== null) setSpeakingKey((k) => (k === key ? null : k));
    }
    speak(text);
  }

  async function openGroup(id: string | null) {
    setSideOpen(false);
    setError("");
    stopConverse();
    if (recorder) {
      recorder.cancel();
      stopRecordingUi();
    }
    setGroupId(id);
    setMeetingId(null);
    setBotId(null);
    setBot(null);
    setMessages([]);
    setView("group");
  }

  function openMeeting(id: string | null) {
    setSideOpen(false);
    setError("");
    stopConverse();
    if (recorder) {
      recorder.cancel();
      stopRecordingUi();
    }
    setMeetingId(id);
    setGroupId(null);
    setView("meeting");
  }

  async function newGroup() {
    setError("");
    try {
      const created = await createGroup("Grup baru", teamId ?? undefined);
      await refreshGroups();
      await openGroup(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create group.");
    }
  }

  /** Boards live in channels: open the channel holding this project,
      creating + attaching one when none exists yet. */
  async function openProjectChannel(pid: string) {
    setError("");
    try {
      const gs = await fetchGroups();
      let g = gs.find((x) => x.project_id === pid);
      if (!g) {
        const p = await fetchProject(pid);
        g = await createGroup(p.name, teamId ?? undefined);
        g = await setGroupProject(g.id, pid);
      }
      await refreshGroups();
      localStorage.setItem("group_open_board", g.id);
      await openGroup(g.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open board.");
    }
  }

  async function openBot(id: string | null) {
    setSideOpen(false);
    setError("");
    stopConverse();
    if (recorder) {
      recorder.cancel();
      stopRecordingUi();
    }
    setBotId(id);
    setGroupId(null);
    setMeetingId(null);
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

  const [supportGroups, setSupportGroups] = useState<PublicGroup[]>([]);

  async function newBot(ownerId?: string) {
    setError("");
    try {
      const fallbackModel = (providerInfo?.default?.trim() || (providerInfo?.custom_allowed ? "" : "muse-spark-1.3") || "muse-spark-1.3");
      const created = await createBot(fallbackModel, teamId ?? undefined, ownerId || undefined);
      await refreshBots();
      await openBot(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create slaveBot.");
    }
  }

  const stopSpeakingAudio = useCallback(() => {
    stopSpeaking();
    stopAudio();
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
    if (streaming || transcribing || conversing || !bot) return;
    if (recorder) {
      const rec = recorder;
      stopRecordingUi();
      setTranscribing(true);
      setError("");
      try {
        const wav = await rec.stop();
        const res = await transcribeVoice(wav, teamId ?? undefined);
        setInput((prev) => (prev ? `${prev} ${res.transcript}` : res.transcript));
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

  /** Slash commands (/remind, /schedules, /unschedule, /archive, /help) run server-side without the model. */
  async function sendCommand(text: string) {
    if (!bot) return;
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
    try {
      const res = await sendChat(bot.id, text, bot.model);
      const reply = res.reply ?? "";
      setMessages((prev) => prev.map((m) => (m.key === assistantKey ? { ...m, content: reply } : m)));
      if (text.startsWith("/archive")) {
        await refreshBots();
        const detail = await fetchBotDetail(bot.id);
        setBot(detail.slavebot);
      }
      if (voiceOn && reply.trim()) speak(reply);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Command failed.");
      setMessages((prev) => prev.filter((m) => m.key !== assistantKey));
    } finally {
      setStreaming(false);
    }
  }

  /** Single-input chat: one MCP call, the assistant bubble shows a typing indicator meanwhile. */
  async function sendText(text: string, fromVoice = false) {
    if (!text || streaming || !bot) return;
    stopAudio();
    setError("");
    const userKey = ++keyRef.current;
    const assistantKey = ++keyRef.current;
    setMessages((prev) => [
      ...prev,
      { key: userKey, role: "user", content: text },
      { key: assistantKey, role: "assistant", content: "" },
    ]);
    setStreaming(true);
    try {
      const res = await sendChat(bot.id, text, bot.model);
      const content = res.reply ?? "";
      setMessages((prev) => prev.map((m) => (m.key === assistantKey ? { ...m, content } : m)));
      await refreshBots();
      const detail = await fetchBotDetail(bot.id);
      setBot(detail.slavebot);
      if (fromVoice) {
        await speakReply(content, null, true);
      } else if (voiceOn && content.trim()) {
        speak(content);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chat failed.");
      setMessages((prev) => prev.filter((m) => m.key !== assistantKey));
      throw err;
    } finally {
      setStreaming(false);
    }
  }

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || streaming || !bot) return;
    if (text.startsWith("/")) {
      await sendCommand(text);
      return;
    }
    setInput("");
    try {
      await sendText(text);
    } catch {
      /* error already shown */
    }
  }

  /** Hands-free loop: listen until you pause, send automatically, hear the reply, repeat. */
  async function toggleConverse() {
    if (conversing) {
      stopConverse();
      return;
    }
    if (!bot || streaming || transcribing || recorder) return;
    setError("");
    setInput("");
    converseRef.current = true;
    setConversing(true);
    try {
      while (converseRef.current) {
        let turn: { wav: Blob } | null = null;
        try {
          turn = await recordConversationTurn(setMicLevel);
        } catch (err) {
          if (!converseRef.current) break;
          setError(err instanceof Error ? err.message : "Microphone error.");
          break;
        } finally {
          setMicLevel(0);
        }
        if (!converseRef.current || !turn) break;
        try {
          const res = await transcribeVoice(turn.wav, teamId ?? undefined);
          if (!converseRef.current) break;
          if (!res.transcript.trim()) continue;
          await sendText(res.transcript, true);
        } catch (err) {
          if (!converseRef.current) break;
          if ((err as Error).name === "AbortError") break;
          setError(err instanceof Error ? err.message : "Conversation failed.");
          break;
        }
      }
    } finally {
      converseRef.current = false;
      setConversing(false);
      setMicLevel(0);
    }
  }

  function logout() {
    autoOpenedRef.current = false;
    stopConverse();
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
    setGroups([]);
    setGroupId(null);
    setMeetings([]);
    setMeetingId(null);
  }

  if (checking) return <div className="flex min-h-screen items-center justify-center text-zinc-400">Memuat...</div>;
  if (!user) return <AuthView onAuth={setUser} />;

  // Team scope: only rows of the selected team ("" = legacy row, shown as fallback).
  const inTeam = (t: string) => !teamId || t === teamId || t === "";
  const teamGroups = groups.filter((g) => inTeam(g.team_id));
  const teamMeetings = meetings.filter((h) => inTeam(h.team_id));
  const activeBots = bots.filter((b) => !b.archived && inTeam(b.team_id));
  const archivedBots = bots.filter((b) => b.archived && inTeam(b.team_id));
  const childMap = new Map<string, SlaveBot[]>();
  for (const b of activeBots) {
    if (b.parent_id) {
      const list = childMap.get(b.parent_id) ?? [];
      list.push(b);
      childMap.set(b.parent_id, list);
    }
  }
  const topBots = activeBots.filter((b) => !b.parent_id);
  const orphanBots = activeBots.filter((b) => b.parent_id && !activeBots.some((p) => p.id === b.parent_id));

  const ownerName = (b: SlaveBot) => (b.owner_user_id && b.owner_user_id !== user.id ? (memberNames[b.owner_user_id] ?? "teammate") : "");
  function botRow(b: SlaveBot, indented: boolean) {
    const partner = ownerName(b);
    return (
      <button
        key={b.id}
        type="button"
        onClick={() => openBot(b.id)}
        title={(b.role ? `${b.role} — ` : "") + (b.title || b.name) + (partner ? ` (partner: ${partner})` : "")}
        className={`flex items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-zinc-800 ${b.id === botId ? "bg-zinc-800" : ""} ${indented ? "ml-5 border-l border-zinc-800" : ""}`}
      >
        <span className="relative shrink-0">
          <BotAvatar bot={b} size="sm" />
          <span title="Active" className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-zinc-950 bg-emerald-500" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{b.name}</span>
          <span className="block truncate text-xs text-zinc-500">
            {[b.role || b.title, partner ? `◈ ${partner}` : ""].filter(Boolean).join("  ")}
          </span>
        </span>
        {b.pinned ? (
          <span title="Pinned — opens automatically on visit" className="shrink-0 rounded border border-emerald-700 px-1 text-[10px] font-bold text-emerald-400">PIN</span>
        ) : null}
      </button>
    );
  }

  const topBtn = (active: boolean) =>
    `flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-2 text-sm ${active ? "bg-zinc-800 font-semibold text-zinc-100" : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"}`;


  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      {/* Top bar — logo = team switcher, then workspace nav */}
      <header className="flex h-13 shrink-0 items-center gap-1 border-b border-zinc-800 bg-zinc-950 px-2 py-1">
        <button type="button" onClick={() => setSideOpen((v) => !v)} title="Obrolan" className="shrink-0 rounded-md px-2 py-2 text-lg text-zinc-300 hover:bg-zinc-800 md:hidden">
          ☰
        </button>
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setTeamMenuOpen((v) => !v)}
            title={teams.find((t) => t.id === teamId)?.name ? `Team: ${teams.find((t) => t.id === teamId)?.name} — ganti team` : "Pilih team"}
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600 text-sm font-black text-white hover:bg-emerald-500"
          >
            {(teams.find((t) => t.id === teamId)?.name || "S").slice(0, 1).toUpperCase()}
          </button>
          {teamMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setTeamMenuOpen(false)} />
              <div className="absolute left-0 top-10 z-50 w-60 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-xl">
                <div className="border-b border-zinc-800 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-zinc-500">Ganti team</div>
                <div className="max-h-64 overflow-y-auto p-1">
                  {teams.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => pickTeam(t.id)}
                      className={`flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-zinc-800 ${t.id === teamId ? "bg-zinc-800" : ""}`}
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-900 text-xs font-black text-emerald-300">
                        {t.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-zinc-100">{t.name}</span>
                        <span className="block text-[11px] text-zinc-500">{t.role}</span>
                      </span>
                      {t.id === teamId && <span className="shrink-0 text-xs text-emerald-400">✓</span>}
                    </button>
                  ))}
                  {teams.length === 0 && <p className="px-3 py-2 text-xs text-zinc-500">Belum ada team — buat di Settings.</p>}
                </div>
              </div>
            </>
          )}
        </div>
        <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          <button type="button" onClick={() => setView("apps")} className={topBtn(view === "apps")}><span aria-hidden="true">⌂</span> Aplikasi</button>
          <button type="button" onClick={() => setView("chat")} className={topBtn(view === "chat" || view === "group" || view === "bot" || view === "meeting")}><span aria-hidden="true">💬</span> Chat</button>
          <button type="button" onClick={() => setView("code")} className={topBtn(view === "code")}><span aria-hidden="true">{"</>"}</span> File</button>
          <button type="button" onClick={() => setView("market")} className={topBtn(view === "market")}><span aria-hidden="true">◈</span> Toko</button>
          <button type="button" onClick={() => setView("settings")} className={topBtn(view === "settings")}><span aria-hidden="true">⚙</span> Pengaturan</button>
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-800 text-sm font-bold text-zinc-200" title={user.email}>
            {(user.name || user.email || "?").slice(0, 1).toUpperCase()}
          </span>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
      {/* Sidebar — workspace sections */}
      {sideOpen && (
        <div className="fixed inset-0 z-30 bg-black/60 md:hidden" onClick={() => setSideOpen(false)} />
      )}
      <aside className={`${sideOpen ? "fixed inset-y-0 left-0 z-40 flex w-72" : "hidden"} shrink-0 flex-col border-r border-zinc-800 bg-zinc-950 md:static md:flex md:w-60`}>
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3" title={teams.find((t) => t.id === teamId)?.name ?? user.email}>
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-900 text-xs font-black text-emerald-300">
            {(teams.find((t) => t.id === teamId)?.name || "S").slice(0, 1).toUpperCase()}
          </span>
          <span className="truncate text-sm font-bold text-zinc-100">{teams.find((t) => t.id === teamId)?.name ?? "SlaveBots"}</span>
        </div>
        <div className="flex items-center justify-between px-4 pb-1 pt-3">
          <div className="text-xs font-bold uppercase tracking-wide text-zinc-500">Chat</div>
          <button type="button" onClick={() => { setView("settings"); setSideOpen(false); }} title="Tambah asisten baru di Pengaturan" className="rounded px-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
            +
          </button>
        </div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
          {topBots.flatMap((b) => [botRow(b, false), ...(childMap.get(b.id) ?? []).map((c) => botRow(c, true))])}
          {orphanBots.map((b) => botRow(b, false))}
          {activeBots.length === 0 && <p className="px-2 py-2 text-sm text-zinc-500">Belum ada asisten — buat satu untuk mulai.</p>}
          {archivedBots.length > 0 && (
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              className="mt-1 rounded-md px-2 py-1.5 text-left text-xs font-semibold text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
            >
              {showArchived ? "▾ Arsip" : `▸ Arsip (${archivedBots.length})`}
            </button>
          )}
          {showArchived &&
            archivedBots.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => openBot(b.id)}
                title={`${b.title || b.name} (arsip)`}
                className={`flex items-center gap-2.5 rounded-md px-2 py-2 text-left opacity-60 hover:bg-zinc-800 hover:opacity-100 ${b.id === botId ? "bg-zinc-800" : ""}`}
              >
                <BotAvatar bot={b} size="sm" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{b.name}</span>
                  <span className="block truncate text-xs text-zinc-500">arsip</span>
                </span>
              </button>
            ))}
        </nav>
        <div className="flex items-center justify-between border-t border-zinc-800 px-4 pb-1 pt-3">
          <div className="text-xs font-bold uppercase tracking-wide text-zinc-500">Grup</div>
          <button type="button" onClick={newGroup} title="Buat grup baru" className="rounded px-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
            + Baru
          </button>
        </div>
        <nav className="flex max-h-40 flex-col gap-1 overflow-y-auto p-2 pt-1">
          {teamGroups.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => openGroup(g.id)}
              title={g.name}
              className={`truncate rounded-md px-2 py-2 text-left text-sm hover:bg-zinc-800 ${g.id === groupId ? "bg-zinc-800 font-semibold" : "text-zinc-300"}`}
            >
              <span className="mr-1 text-zinc-500">##</span>{g.name}
            </button>
          ))}
          {teamGroups.length === 0 && <p className="px-2 pb-1 text-xs text-zinc-600">Belum ada grup.</p>}
        </nav>
        <div className="flex items-center justify-between border-t border-zinc-800 px-4 pb-1 pt-3">
          <div className="text-xs font-bold uppercase tracking-wide text-zinc-500">Rapat</div>
          <button type="button" onClick={() => openMeeting(null)} title="Mulai rapat baru" className="rounded px-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
            + Baru
          </button>
        </div>
        <nav className="flex max-h-40 flex-col gap-1 overflow-y-auto p-2 pt-1">
          {teamMeetings.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => openMeeting(h.id)}
              title={h.topic}
              className={`truncate rounded-md px-2 py-2 text-left text-sm hover:bg-zinc-800 ${h.id === meetingId ? "bg-zinc-800 font-semibold" : "text-zinc-300"}`}
            >
              <span className="mr-1 text-zinc-500">◉</span>{h.topic.length > 40 ? `${h.topic.slice(0, 40)}…` : h.topic}
            </button>
          ))}
          {teamMeetings.length === 0 && <p className="px-2 pb-1 text-xs text-zinc-600">Belum ada rapat.</p>}
        </nav>
        <div className="border-t border-zinc-800 px-4 pb-1 pt-3">
          <div className="text-xs font-bold uppercase tracking-wide text-zinc-500">Bantuan</div>
          <div className="text-[11px] text-zinc-600">Tempat tanya jawab umum</div>
        </div>
        <nav className="flex max-h-32 flex-col gap-1 overflow-y-auto p-2 pt-1">
          {supportGroups.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => openGroup(g.id)}
              title={`${g.name} · by ${g.team_name}`}
              className={`truncate rounded-md px-2 py-2 text-left text-sm hover:bg-zinc-800 ${g.id === groupId ? "bg-zinc-800 font-semibold" : "text-zinc-300"}`}
            >
              <span className="mr-1 text-emerald-500">✚</span>{g.name}
              <span className="ml-1 text-[11px] text-zinc-500">{g.team_name}</span>
            </button>
          ))}
          {supportGroups.length === 0 && <p className="px-2 pb-1 text-xs text-zinc-600">Belum ada channel bantuan.</p>}
        </nav>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col bg-zinc-900">
        <header className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2 md:px-4">
          <div className="flex min-w-0 items-center gap-1">
            {view === "bot" && bot ? (
              <button type="button" onClick={() => setView("chat")} title="Kembali ke chat" className="min-w-0 truncate rounded px-1 text-left font-semibold hover:bg-zinc-800">
                ← {bot.name} <span className="text-xs font-normal text-zinc-500">pengaturan</span>
              </button>
            ) : view === "group" ? (
              <span className="truncate px-1 font-semibold"><span className="mr-1 font-bold text-zinc-300">#</span>{groups.find((g) => g.id === groupId)?.name ?? "group"}</span>
            ) : view === "meeting" ? (
              <span className="truncate px-1 font-semibold"><span className="mr-1 text-zinc-300">◉</span>{meetings.find((h) => h.id === meetingId)?.topic.slice(0, 40) ?? "meeting"}</span>
            ) : view === "settings" ? (
              <span className="px-1 font-semibold">Pengaturan</span>
            ) : view === "code" ? (
              <span className="px-1 font-semibold">File</span>
            ) : view === "market" ? (
              <span className="px-1 font-semibold">Toko</span>
            ) : view === "apps" ? (
              <span className="px-1 font-semibold">Aplikasi</span>
            ) : (
              <button type="button" onClick={() => bot && setView("bot")} disabled={!bot} title={bot ? "Pengaturan asisten" : undefined} className="min-w-0 truncate rounded px-1 text-left font-semibold hover:bg-zinc-800 disabled:hover:bg-transparent">
                <span className="mr-1 font-bold text-zinc-300">#</span>{bot ? bot.name : "pilih asisten"}
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => { if (voiceOn) stopSpeaking(); setVoiceOn((v) => !v); }}
            title="Balasan bersuara nyala/mati"
            className={`rounded-md border px-2 py-1 text-xs font-semibold ${voiceOn ? "border-emerald-600 text-emerald-400" : "border-zinc-700 text-zinc-400"}`}
          >
              {voiceOn ? "Suara nyala" : "Suara mati"}
          </button>
        </header>

        {view === "apps" ? (
          <main className="flex-1 overflow-y-auto">
            <AppsView
              teamId={teamId}
              onOpenProject={(pid) => openProjectChannel(pid)}
              onGoMarket={() => setView("market")}
              onGoChat={() => setView("chat")}
            />
          </main>
        ) : view === "settings" ? (
          <main className="flex-1 overflow-y-auto">
            <SettingsView
              user={user}
              teams={teams}
              teamId={teamId}
              memberNames={memberNames}
              onPickTeam={(id) => setTeamId(id)}
              onTeamsChanged={async () => {
                const list = await fetchTeams();
                setTeams(list);
                if (!list.some((t) => t.id === teamId)) setTeamId(list[0]?.id ?? null);
              }}
              onCreateBot={(ownerId) => newBot(ownerId)}
              onLogout={logout}
            />
          </main>
        ) : view === "code" ? (
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <CodeView teamId={teamId} teamRole={teams.find((t) => t.id === teamId)?.role ?? ""} />
          </main>
        ) : view === "market" ? (
          <main className="flex-1 overflow-y-auto">
            <MarketView
              teamId={teamId}
              onOpenProject={(pid) => openProjectChannel(pid)}
              onOpenSupport={async (repoId) => {
                const g = await fetchSupportGroup(repoId);
                await openGroup(g.id);
              }}
            />
          </main>
        ) : view === "group" && groupId ? (
          <main className="flex-1 overflow-y-auto">
            <GroupView
              groupId={groupId}
              bots={bots}
              teamId={teamId}
              onDeleted={async () => {
                setGroupId(null);
                await refreshGroups();
                setView("chat");
              }}
              onVisibilityChanged={() => {
                fetchPublicGroups().then(setSupportGroups).catch(() => {});
                void refreshGroups();
              }}
            />
          </main>
        ) : view === "meeting" ? (
          <main className="flex-1 overflow-y-auto">
            <MeetingView
              meetingId={meetingId}
              bots={bots}
              teamId={teamId}
              onCreated={async (id) => {
                await refreshMeetings();
                openMeeting(id);
              }}
              onChanged={refreshMeetings}
              onDeleted={async () => {
                setMeetingId(null);
                await refreshMeetings();
                setView("chat");
              }}
              onOpenBot={openBot}
            />
          </main>
        ) : view === "bot" && bot ? (
          <main className="flex-1 overflow-y-auto">
            <BotView
              bot={bot}
              providerInfo={providerInfo}
              partnerName={bot.owner_user_id === user.id ? "you" : (memberNames[bot.owner_user_id] ?? "teammate")}
              onSaved={(updated) => {
                setBot(updated);
                setBots((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
              }}
              onOpenBot={openBot}
              onTeamChanged={() => {
                void refreshBots();
              }}
            />
          </main>
        ) : (
          <>
            <main className="flex-1 overflow-y-auto px-4 py-4">
              {!bot ? (
                <div className="mx-auto max-w-xl py-16">
                  <h2 className="text-xl font-bold">Halo, {user.name || user.email}.</h2>
                  <p className="mt-2 text-zinc-400">Pilih asisten di kiri untuk lanjut ngobrol — atau buat yang baru. Tiap asisten punya riwayat dan ingatannya sendiri.</p>
                  <button type="button" onClick={() => newBot()} className="mt-4 rounded-md bg-emerald-600 px-4 py-2 font-semibold text-white hover:bg-emerald-500">
                    + Asisten baru
                  </button>
                </div>
              ) : (
                messages.length === 0 && (
                  <div className="mx-auto max-w-xl py-16">
                    <h2 className="text-xl font-bold">{bot.name} siap.</h2>
                    <p className="mt-2 text-zinc-400">Ketik atau dikte pesan di bawah. Atur ingatan di tab Asisten dan {bot.name} akan mengingatnya di semua obrolan.</p>
                  </div>
                )
              )}
              {messages.map((m, i) => {
                const prev = i > 0 ? messages[i - 1] : null;
                const showDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
                return (
                  <Fragment key={m.key}>
                    {showDay && (
                      <div className="flex items-center gap-3 px-2 py-2">
                        <div className="h-px flex-1 bg-zinc-800" />
                        <span className="rounded-full border border-zinc-700 px-3 py-0.5 text-xs font-semibold text-zinc-300">{dayLabel(m.created_at)}</span>
                        <div className="h-px flex-1 bg-zinc-800" />
                      </div>
                    )}
                <div className="group flex gap-3 rounded px-2 py-3 hover:bg-zinc-800/50">
                  <BotAvatar bot={bot ?? { id: "u", name: m.role === "user" ? (user.name || "Anda") : "A", title: "", model: "", memory: "", role: "", parent_id: "", pinned: 0, pinned_by: "", owner_user_id: "", relay: 1, user_id: "u", team_id: "", avatar_key: "", archived: 0, voice: "luna", active_days: "all", active_start: "", active_end: "", created_at: "", updated_at: "" } as SlaveBot} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-bold">{m.role === "user" ? (user.name || "Anda") : (bot?.name ?? "Asisten")}</span>
                      {m.created_at && <span className="text-xs text-zinc-500">{new Date(m.created_at).toLocaleString()}</span>}
                      {m.role === "assistant" && m.content.trim() && bot && (
                        <button
                          type="button"
                          onClick={() => {
                            if (speakingKey === m.key) {
                              stopAudio();
                              setSpeakingKey(null);
                            } else {
                              void speakReply(m.content, m.key, true);
                            }
                          }}
                          title="Dengarkan jawaban ini dengan suara asisten"
                          className="rounded px-1 text-xs text-zinc-500 hover:bg-zinc-700 hover:text-emerald-400"
                        >
                          {speakingKey === m.key ? "Stop" : "Bicara"}
                        </button>
                      )}
                    </div>
                    <div className="whitespace-pre-wrap break-words text-[15px] text-zinc-200">{m.content ? renderMentions(m.content) : m.role === "assistant" && streaming ? <TypingDots /> : ""}</div>
                  </div>
                </div>
                  </Fragment>
                );
              })}
              <div ref={bottomRef} />
            </main>

            {error && <p className="mx-auto w-full max-w-3xl px-4 text-sm text-red-400">{error}</p>}

            <div className="px-4 pb-4">
              <form onSubmit={send} className="mx-auto flex max-w-3xl items-end gap-1 rounded-[28px] border border-zinc-700 bg-[#2b2d31] p-2 pl-2 shadow-lg focus-within:border-zinc-500">
                <div className="relative shrink-0">
                  <button
                    type="button"
                    onClick={() => setPlusOpen((v) => !v)}
                    title="Aksi lain"
                    className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100"
                  >
                    <PlusIcon />
                  </button>
                  {plusOpen && (
                    <>
                      <div className="fixed inset-0 z-30" onClick={() => setPlusOpen(false)} />
                      <div className="absolute bottom-11 left-0 z-40 w-52 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 py-1 shadow-xl">
                        <button type="button" onClick={() => { setPlusOpen(false); setView("settings"); }} className="block w-full px-4 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800">
                          Asisten baru
                        </button>
                        <button type="button" onClick={() => { setPlusOpen(false); newGroup(); }} className="block w-full px-4 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800">
                          Grup baru
                        </button>
                        <button type="button" onClick={() => { setPlusOpen(false); openMeeting(null); }} className="block w-full px-4 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800">
                          Rapat baru
                        </button>
                      </div>
                    </>
                  )}
                </div>
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder={bot ? `Pesan untuk ${bot.name}...` : "Pilih asisten dulu"}
                  rows={1}
                  disabled={!bot}
                  className="max-h-40 flex-1 resize-none bg-transparent px-2 py-2 text-[15px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none disabled:opacity-40"
                />
                {conversing && (
                  <span title="Mic level" className="mx-1 flex h-8 w-1.5 shrink-0 self-center overflow-hidden rounded-full bg-zinc-700">
                    <span className="mt-auto w-full bg-emerald-500" style={{ height: `${Math.round(micLevel * 100)}%` }} />
                  </span>
                )}
                <button
                  type="button"
                  onClick={toggleMic}
                  disabled={streaming || transcribing || conversing || !bot}
                  title={recorder ? `Berhenti merekam (${recSecs.toFixed(0)} dtk)` : "Dikte dengan mikrofon"}
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full hover:bg-zinc-700 disabled:opacity-40 ${recorder ? "text-red-400" : "text-zinc-300"}`}
                >
                  {recorder ? <span className="flex items-center gap-1 text-xs font-bold tabular-nums"><span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />{recSecs.toFixed(0)}</span> : transcribing ? <Spinner /> : <MicIcon />}
                </button>
                {input.trim() || streaming ? (
                  <button
                    type="submit"
                    disabled={!input.trim() || !bot || streaming}
                    title="Kirim"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-700 disabled:text-zinc-500"
                  >
                    {streaming ? <Spinner /> : <ArrowUpIcon />}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={toggleConverse}
                    disabled={!bot || streaming || transcribing || !!recorder}
                    title={conversing ? "Berhenti mode hands-free" : "Chat suara hands-free"}
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white disabled:opacity-40 ${conversing ? "bg-red-500 hover:bg-red-400" : "bg-blue-500 hover:bg-blue-400"}`}
                  >
                    <WaveIcon />
                  </button>
                )}
              </form>
            </div>
          </>
        )}
      </div>
      </div>
    </div>
  );
}
