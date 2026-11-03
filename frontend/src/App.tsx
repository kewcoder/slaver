import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  addGroupMembers,
  appendMemory,
  fetchAvatar,
  createBot,
  createGroup,
  createHuddle,
  createSchedule,
  createTeam,
  clearTeamProvider,
  deleteGroup,
  deleteHuddle,
  deleteSchedule,
  deleteTeam,
  fetchBotDetail,
  fetchBots,
  fetchChildren,
  fetchGroupDetail,
  fetchGroups,
  fetchHuddleDetail,
  fetchHuddles,
  fetchMe,
  fetchProviderModels,
  fetchSchedules,
  fetchSummaries,
  fetchTeam,
  fetchTeamActivity,
  fetchTeams,
  fetchUsage,
  grantBotAccess,
  inviteMember,
  removeMember,
  revokeBotAccess,
  setMemberRole,
  formatUsd,
  groupChat,
  huddleChat,
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
  type Group,
  type GroupDetail,
  type Huddle,
  type HuddleDetail,
  type ActivityItem,
  type ProviderInfo,
  type SlaveBot,
  type Team,
  type TeamDetail,
  type Summaries,
  type UsageSummary,
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
import HarnessView from "./HarnessView";

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
  if (!summary) {
    return (
      <div className="space-y-2 p-8" aria-label="Loading usage">
        <div className="loading-skeleton h-6 w-1/2" />
        <div className="loading-skeleton h-20 w-full" />
        <div className="loading-skeleton h-20 w-full" />
      </div>
    );
  }
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

function GroupView({
  groupId,
  bots,
  onCredit,
  onDeleted,
}: {
  groupId: string;
  bots: SlaveBot[];
  onCredit: () => void;
  onDeleted: () => void;
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
            ? `Saved to memory of: ${res.saved_to_memory.join(", ")}`
            : "Sent. (No memories updated — needs owner/admin.)",
        );
      }
      onCredit();
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
      setSavedNote(`Saved to ${botName ?? "bot"}'s memory.`);
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
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-4 py-4">
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
          {!renaming && (
            <div className="flex shrink-0 items-center">
              <button type="button" onClick={() => { setNewName(detail.group.name); setRenaming(true); }} title="Rename group" className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
                Rename
              </button>
              <button type="button" onClick={doDelete} className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400">
                Delete
              </button>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {detail.members.map((m) => (
            <span key={m.id} className="flex items-center gap-1.5 rounded-full bg-zinc-800 py-1 pl-1 pr-2 text-sm">
              <BotAvatar bot={m} size="sm" />
              <span className="text-zinc-200">{m.name}</span>
              <button type="button" onClick={() => doRemove(m.id)} title={`Remove ${m.name}`} className="text-zinc-500 hover:text-red-400">
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
              + Add members
            </button>
          )}
          {addOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Add members">
              <div className="absolute inset-0 bg-black/60" onClick={() => { if (!busy) setAddOpen(false); }} />
              <div className="relative flex max-h-[80vh] w-full max-w-md flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-xl">
                <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
                  <h3 className="font-bold text-zinc-100">Add members to {detail.group.name}</h3>
                  <button type="button" onClick={() => setAddOpen(false)} disabled={busy} title="Close" className="rounded px-2 py-1 text-lg leading-none text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40">
                    ×
                  </button>
                </div>
                <div className="border-b border-zinc-800 px-4 py-2">
                  <input
                    value={pickFilter}
                    onChange={(e) => setPickFilter(e.target.value)}
                    placeholder="Search slaveBots..."
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
                    {picked.length === 0 ? "Select slaveBots to add" : `${picked.length} selected`}
                  </span>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setAddOpen(false)} disabled={busy} className="rounded-md px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40">
                      Cancel
                    </button>
                    <button type="button" onClick={doAdd} disabled={picked.length === 0 || busy} className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40">
                      {busy ? "Adding..." : `Add${picked.length > 0 ? ` (${picked.length})` : ""}`}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {detail.messages.length === 0 && (
          <p className="py-8 text-center text-zinc-500">No discussion yet. Give the team a task below.</p>
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
                <span className="text-sm font-bold">{m.slavebot_id ? (m.bot_name ?? "SlaveBot") : "You"}</span>
                <span className="text-xs text-zinc-500">{new Date(m.created_at).toLocaleString()}</span>
                {m.slavebot_id && (
                  <button
                    type="button"
                    onClick={() => saveReply(m.slavebot_id, m.bot_name, m.content)}
                    title="Save this reply into the bot's memory"
                    className="rounded px-1 text-xs text-zinc-500 hover:bg-zinc-700 hover:text-emerald-400"
                  >
                    Save to memory
                  </button>
                )}
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
          placeholder="Message the group... (every bot replies, each billed)"
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
    </div>
  );
}

function HuddleView({
  huddleId,
  bots,
  teamId,
  onCreated,
  onChanged,
  onDeleted,
  onOpenBot,
}: {
  huddleId: string | null;
  bots: SlaveBot[];
  teamId: string | null;
  onCreated: (id: string) => Promise<void>;
  onChanged: () => Promise<void>;
  onDeleted: () => Promise<void>;
  onOpenBot: (id: string) => void;
}) {
  const [detail, setDetail] = useState<HuddleDetail | null>(null);
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
    if (!huddleId) {
      setDetail(null);
      return;
    }
    try {
      setDetail(await fetchHuddleDetail(huddleId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load huddle.");
    }
  }, [huddleId]);

  useEffect(() => {
    setError("");
    setSavedNote("");
    setPicked(null);
    void load();
  }, [huddleId, load]);

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
      const created = await createHuddle(topic.trim(), selected, teamId ?? undefined);
      setTopic("");
      setPicked(null);
      await onCreated(created.huddle.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start huddle.");
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
      const res = await huddleChat(detail.huddle.id, task.trim());
      setTask("");
      setSavedNote(`Heard by ${res.replies.length} bot(s) · ${formatUsd(res.total_cost_usd)}`);
      await load();
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Huddle chat failed.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!detail || !window.confirm(`Delete huddle "${detail.huddle.topic}"?`)) return;
    try {
      await deleteHuddle(detail.huddle.id);
      await onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete huddle.");
    }
  }

  if (!huddleId) {
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
        <div>
          <h2 className="text-xl font-bold">Start a huddle</h2>
          <p className="mt-1 text-sm text-zinc-400">
            Notify your slaveBots about a topic. Each bot reads its role and decides by itself whether to join.
            Up to 8 bots are asked per huddle.
          </p>
        </div>
        {activeBots.length === 0 && <p className="text-sm text-zinc-400">Create a slaveBot first — there is nobody to huddle with yet.</p>}
        <form onSubmit={start} className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-5">
          <label className="text-sm font-semibold text-zinc-300">
            Topic
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="e.g. Plan next week's launch content"
              maxLength={500}
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
            />
          </label>
          {activeBots.length > 0 && (
            <div className="text-sm">
              <div className="mb-1 font-semibold text-zinc-300">Notify (each decides to join or not)</div>
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
            {busy ? "Asking bots to join..." : "Start huddle"}
          </button>
        </form>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-2 p-8" aria-label="Loading huddle">
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
          <h2 className="text-lg font-bold">{detail.huddle.topic}</h2>
          <button type="button" onClick={remove} className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400">
            Delete
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {joined.map((p) => (
            <button
              key={p.slavebot_id}
              type="button"
              onClick={() => onOpenBot(p.slavebot_id)}
              title={p.reason || "joined"}
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
              title={p.reason ? `Declined: ${p.reason}` : "Declined"}
              className="flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 py-1 pl-1 pr-2 text-sm opacity-70 hover:opacity-100"
            >
              <BotAvatar bot={avatarFor(p.slavebot_id, p.bot_name)} size="sm" />
              <span className="text-zinc-400 line-through">{p.bot_name ?? "?"}</span>
            </button>
          ))}
        </div>
        {declined.length > 0 && (
          <p className="mt-1 text-xs text-zinc-500">Hover a declined bot to see why it sat out.</p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {detail.messages.length === 0 && (
          <p className="py-8 text-center text-zinc-500">The bots that joined are listening. Say something to start the discussion.</p>
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
                <span className="text-sm font-bold">{m.slavebot_id ? (m.bot_name ?? "SlaveBot") : "You"}</span>
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
      <h3 className="font-semibold text-zinc-200">Schedules</h3>
      <p className="mb-3 mt-1 text-xs text-zinc-500">
        The bot runs these by itself on Jakarta time — e.g. a morning briefing posted into its history.
        You can also type <span className="text-zinc-300">/remind daily 07:00 ...</span> in chat, or <span className="text-zinc-300">/schedules</span> to list.
      </p>
      {schedules.length === 0 ? (
        <p className="mb-3 text-sm text-zinc-500">No schedules yet.</p>
      ) : (
        <ul className="mb-4 flex flex-col gap-2">
          {schedules.map((s) => (
            <li key={s.id} className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm">
              <span className={`h-2 w-2 shrink-0 rounded-full ${s.active ? "bg-emerald-500" : "bg-zinc-600"}`} title={s.active ? "On" : "Off"} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-zinc-200">{s.name}</span>
                <span className="block truncate text-xs text-zinc-500">
                  {s.kind === "interval" ? `every ${s.interval_minutes}m` : `${s.kind} ${s.time_hhmm} (${s.days})`}
                  {" · next "}{s.next_run_at || "—"}
                  {" · "}{s.prompt}
                </span>
              </span>
              <button type="button" onClick={() => toggle(s)} className="rounded px-2 py-1 text-xs font-semibold text-zinc-300 hover:bg-zinc-800">
                {s.active ? "Pause" : "Resume"}
              </button>
              <button type="button" onClick={() => remove(s)} className="rounded px-2 py-1 text-xs font-semibold text-zinc-500 hover:bg-zinc-800 hover:text-red-400">
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={create} className="grid grid-cols-2 gap-2">
        <label className="col-span-2 text-sm font-semibold text-zinc-300">
          Task for the bot
          <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. Post a morning briefing" maxLength={1000} className={inputCls} />
        </label>
        <label className="text-sm font-semibold text-zinc-300">
          Repeat
          <select value={kind} onChange={(e) => setKind(e.target.value)} className={inputCls}>
            <option value="daily">Daily</option>
            <option value="once">Once</option>
            <option value="interval">Every N minutes</option>
          </select>
        </label>
        {kind === "interval" ? (
          <label className="text-sm font-semibold text-zinc-300">
            Minutes (5 or more)
            <input value={interval} onChange={(e) => setInterval(e.target.value)} inputMode="numeric" className={inputCls} />
          </label>
        ) : (
          <label className="text-sm font-semibold text-zinc-300">
            Time (Jakarta)
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={inputCls} />
          </label>
        )}
        {kind === "daily" && (
          <label className="col-span-2 text-sm font-semibold text-zinc-300">
            Days
            <select value={days} onChange={(e) => setDays(e.target.value)} className={inputCls}>
              <option value="all">Every day</option>
              <option value="weekdays">Weekdays</option>
              <option value="weekends">Weekends</option>
            </select>
          </label>
        )}
        <div className="col-span-2">
          <button type="submit" disabled={busy || !prompt.trim()} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
            {busy ? "Adding..." : "Add schedule"}
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
      <h3 className="font-semibold text-zinc-200">Team</h3>
      <p className="mb-3 mt-1 text-xs text-zinc-500">
        Managers grow sub-bots for specific tasks. Sub-bots report to their manager and can be huddled, scheduled, and grouped like any bot.
      </p>
      {parent && (
        <p className="mb-2 text-sm text-zinc-300">
          Reports to{" "}
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
        <p className="mb-3 text-sm text-zinc-500">No sub-bots yet.</p>
      )}
      <form onSubmit={spawn} className="grid grid-cols-2 gap-2">
        <label className="text-sm font-semibold text-zinc-300">
          Sub-bot name
          <input
            value={subName}
            onChange={(e) => setSubName(e.target.value)}
            placeholder="e.g. Scout"
            maxLength={40}
            className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
          />
        </label>
        <label className="text-sm font-semibold text-zinc-300">
          Task / role
          <input
            value={subRole}
            onChange={(e) => setSubRole(e.target.value)}
            placeholder="e.g. Track competitor prices"
            maxLength={120}
            className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
          />
        </label>
        <div className="col-span-2">
          <button type="submit" disabled={busy || !subName.trim()} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
            {busy ? "Spawning..." : "Spawn sub-bot"}
          </button>
        </div>
      </form>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </div>
  );
}

const TEAM_PROVIDER_PRESETS = [
  { id: "meta", label: "Meta (Spark / Wonder) — default", needs_url: false, placeholder: "", help: "One key from dev.meta.ai. Models: muse-spark-1.3, muse-wonder-1.0." },
  { id: "openrouter", label: "OpenRouter (last resort)", needs_url: false, placeholder: "", help: "Key sk-or-v1-… from openrouter.ai/keys. Fixed model list." },
  { id: "opencode", label: "OpenCode (Go subscription or Console credits)", needs_url: true, placeholder: "https://opencode.ai/inference/go/openai/v1", help: "Go subscribers: https://opencode.ai/inference/go/openai/v1. Pay-as-you-go instead: https://opencode.ai/inference/openai/v1 (needs console credits). Do NOT append /chat/completions." },
  { id: "ollama", label: "Ollama (local, no key)", needs_url: true, placeholder: "http://localhost:11434/v1", help: "Local Ollama. No key needed. Model must be pulled first — run `ollama list` and use that exact id in Bot settings." },
  { id: "baseten", label: "Baseten", needs_url: true, placeholder: "https://inference.baseten.co/v1", help: "Your Baseten deployment base URL + API key." },
  { id: "modal", label: "Modal", needs_url: true, placeholder: "https://<you>--<app>.modal.run/v1", help: "Your deployed Modal function URL (API root) + key." },
  { id: "custom", label: "Custom (any OpenAI-compatible server)", needs_url: true, placeholder: "http://127.0.0.1:1234/v1", help: "Any OpenAI-compatible server (vLLM, LM Studio, …). Root must end in /v1. Key optional only for localhost." },
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
    if (!window.confirm("Remove this team's API key? Bots in this team will stop working until a new key is added.")) return;
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
        <h4 className="text-sm font-bold uppercase tracking-wide text-zinc-500">AI provider</h4>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${team.provider_key_set || keyOptional ? "bg-emerald-950 text-emerald-300" : "bg-amber-950 text-amber-300"}`}>
          {team.provider_key_set ? "key saved" : keyOptional ? "keyless local OK" : "key missing"}
        </span>
      </div>
      <form onSubmit={save} className="mt-3 space-y-3">
        <label className="block text-xs font-semibold text-zinc-300">
          Preset
          <select value={preset} onChange={(e) => { setPreset(e.target.value); setTestResult(null); }} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none">
            {TEAM_PROVIDER_PRESETS.map((x) => (
              <option key={x.id} value={x.id}>{x.label}</option>
            ))}
          </select>
        </label>
        <p className="text-[11px] leading-snug text-zinc-500">{meta.help}</p>
        {needsUrl && (
          <label className="block text-xs font-semibold text-zinc-300">
            Base URL <span className="font-normal text-zinc-500">(API root ending in /v1)</span>
            <input value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setTestResult(null); }} placeholder={meta.placeholder || "https://..."} autoComplete="off" spellCheck={false} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 font-mono text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
          </label>
        )}
        <label className="block text-xs font-semibold text-zinc-300">
          API key {team.provider_key_set ? "(saved — enter a new one to replace)" : keyOptional ? "(optional for local)" : "(required)"}
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={team.provider_key_set ? "••••••••" : keyOptional ? "leave empty for local" : "paste key..."} autoComplete="off" className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
        </label>
        {needsUrl && baseUrl.trim() && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2">
            <div className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">Requests will POST to</div>
            <div className="mt-0.5 break-all font-mono text-[12px] text-emerald-300">{normalizedEndpoint() || "—"}</div>
            {baseUrl.trim().endsWith("/chat/completions") && (
              <div className="mt-1 text-[11px] text-amber-300">You pasted the full endpoint — we strip the trailing /chat/completions automatically.</div>
            )}
          </div>
        )}
        <label className="block text-xs font-semibold text-zinc-300">
          Test model <span className="font-normal text-zinc-500">(exact id from your server's /v1/models)</span>
          <input value={testModel} onChange={(e) => setTestModel(e.target.value)} placeholder="e.g. qwen3:8b — leave empty to use first listed model" autoComplete="off" spellCheck={false} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 font-mono text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" disabled={busy || testing} className="rounded-md bg-zinc-700 px-3 py-1.5 text-sm font-bold text-white hover:bg-zinc-600 disabled:opacity-50">
            {busy ? "Saving..." : "Save provider"}
          </button>
          <button type="button" onClick={runTest} disabled={testing || busy} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
            {testing ? "Testing..." : "Save + test connection"}
          </button>
          {team.provider_key_set && (
            <button type="button" onClick={remove} disabled={busy || testing} className="rounded px-2 py-1 text-xs text-zinc-500 hover:text-red-400 disabled:opacity-50">
              Remove key
            </button>
          )}
        </div>
        {testResult && (
          <div className={`rounded-lg border px-3 py-2 text-[12px] ${testResult.ok ? "border-emerald-800 bg-emerald-950/60 text-emerald-200" : "border-red-800 bg-red-950/50 text-red-200"}`}>
            <div className="font-bold">{testResult.ok ? "Connection OK" : "Connection failed"}</div>
            {testResult.endpoint && <div className="mt-0.5 break-all font-mono text-[11px] opacity-80">{testResult.endpoint}{testResult.model ? ` · ${testResult.model}` : ""}</div>}
            {testResult.models && testResult.models.length > 0 && (
              <div className="mt-1 opacity-90">Server models: <span className="font-mono">{testResult.models.slice(0, 8).join(", ")}</span>{testResult.models.length > 8 ? ` +${testResult.models.length - 8} more` : ""}</div>
            )}
            {testResult.notes?.map((n, i) => <div key={i} className="mt-0.5 opacity-80">{n}</div>)}
            {!testResult.ok && testResult.error && <div className="mt-1">{testResult.error}</div>}
          </div>
        )}
        <p className="text-[11px] text-zinc-500">
          {team.provider_key_set ? "Team key active — this key pays the provider directly, demo credit untouched." : keyOptional ? "No key saved — OK for keyless local servers only." : "No key yet — bots in this team cannot chat until an owner or admin adds one."}
          {" "}Fixing a 404? The model id must exactly match your server, and the base URL must be the /v1 root.
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
      <h2 className="text-xl font-bold">Teams</h2>
      <p className="mt-1 text-sm text-zinc-400">Each team owns its slaveBots, groups, and huddles. Owners and admins manage everything; staff only see bots granted to them.</p>
      <form
        onSubmit={(e) => { e.preventDefault(); if (name.trim()) void run(() => createTeam(name.trim())); setName(""); }}
        className="mt-4 flex gap-2"
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New team name"
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
        />
        <button type="submit" disabled={busy || !name.trim()} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
          Create
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
            {t.name} <span className="text-xs text-zinc-500">{t.role}{t.personal ? " · personal" : ""}</span>
          </button>
        ))}
      </div>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      {detail && (
        <div className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold">{detail.team.name}</h3>
            {canManage && !detail.team.personal && (
              <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Delete team ${detail.team.name}? Its bots are archived; groups and huddles are removed.`)) void run(() => deleteTeam(detail.team.id)); }} className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400 disabled:opacity-50">
                Delete team
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
              AI provider: {detail.team.provider || "meta"}{detail.team.provider_key_set ? " · key set" : " · no key yet — ask an owner or admin to add one"}.
            </p>
          )}
          <h4 className="mt-4 text-sm font-bold uppercase tracking-wide text-zinc-500">Members ({detail.members.length})</h4>
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
                  <button type="button" disabled={busy} onClick={() => void run(() => removeMember(detail.team.id, m.user_id))} className="rounded px-1 text-xs text-zinc-500 hover:text-red-400 disabled:opacity-50">Remove</button>
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
                Invite
              </button>
            </form>
          )}
          <h4 className="mt-5 text-sm font-bold uppercase tracking-wide text-zinc-500">SlaveBots ({detail.bots.length})</h4>
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
                    Partner
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
                          title={has ? `Revoke ${b.name} from ${m.email}` : `Grant ${b.name} to ${m.email}`}
                          onClick={() => void run(() => has ? revokeBotAccess(detail.team.id, b.id, m.user_id, m.bot_ids) : grantBotAccess(detail.team.id, b.id, m.user_id, m.bot_ids))}
                          className={`rounded border px-2 py-0.5 text-xs ${has ? "border-emerald-700 text-emerald-400" : "border-zinc-700 text-zinc-500 hover:text-zinc-200"}`}
                        >
                          {m.email}: {has ? "granted" : "grant"}
                        </button>
                      );
                    })}
                  </div>
                )}
              </li>
              );
            })}
            {detail.bots.length === 0 && <p className="text-sm text-zinc-600">No bots in this team yet.</p>}
          </ul>
          {canManage && (
            <>
              <h4 className="mt-5 text-sm font-bold uppercase tracking-wide text-zinc-500">Recent activity (all bots)</h4>
              {activity.length === 0 ? (
                <p className="mt-1 text-sm text-zinc-600">No bot conversations yet.</p>
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
              title="Rename slaveBot"
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
              aria-label="Rename slaveBot"
              className="w-full max-w-xs rounded-md border border-emerald-600 bg-zinc-800 px-2 py-0.5 text-xl font-bold text-zinc-100 focus:outline-none"
            />
          )}
          {bot.title && <p className="text-sm text-zinc-400">{bot.title}</p>}
          <p className="mt-0.5 text-xs text-zinc-500">◈ Partner: {partnerName} · transfer in Teams settings</p>
        </div>
      </div>

      <form onSubmit={save} className="mb-8 flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-5">
        <h3 className="font-semibold text-zinc-200">Identity</h3>
        <label className="text-sm font-semibold text-zinc-300">
          Name
          <input value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} maxLength={40} className={inputCls} />
        </label>
        <label className="text-sm font-semibold text-zinc-300">
          Role (personal identity)
          <input
            value={role}
            onChange={(e) => { setRole(e.target.value); setSaved(false); }}
            placeholder="e.g. Sales manager — tracks leads and reminds me to follow up"
            maxLength={120}
            className={inputCls}
          />
        </label>
        <p className="-mt-2 text-xs text-zinc-500">The role guides huddle join decisions: bots join only when the topic fits their job. New bots ask for this in their first message.</p>
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
          Model <span className="font-normal text-zinc-500">(exact id your server exposes)</span>
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
              Provider: {providerInfo.provider_label ?? providerInfo.provider}
              {providerInfo.default ? ` · default ${providerInfo.default}` : " · no fixed list — free-form id"}
              {providerInfo.example_models ? ` · ${providerInfo.example_models}` : ""}
            </span>
          )}
          {!model.trim() && (
            <span className="mt-1 block rounded-md border border-amber-800 bg-amber-950/60 px-2 py-1 text-xs font-normal text-amber-200">
              No model set — chat will fail with a 404 until you save an exact model id here (check Teams → Save + test connection for the server's model list).
            </span>
          )}
        </label>
        <label className="text-sm font-semibold text-zinc-300">
          Voice (spoken replies)
          <select value={voice} onChange={(e) => { setVoice(e.target.value); setSaved(false); }} className={inputCls}>
            {AURA_VOICES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <p className="-mt-2 text-xs text-zinc-500">Per-message Speak buttons and hands-free chat use this Aura voice via server TTS (billed per character); the Voice on toggle stays on the free built-in browser voice.</p>
        <label className="flex items-center gap-2 text-sm font-semibold text-zinc-300">
          <input
            type="checkbox"
            checked={relay}
            onChange={(e) => { setRelay(e.target.checked); setSaved(false); }}
            className="h-4 w-4 accent-emerald-600"
          />
          Let {bot.name} consult other bots on its own
        </label>
        <p className="-mt-2 text-xs font-normal text-zinc-500">When on, the bot may message teammates itself before replying. You send to one bot only.</p>
        <div className="grid grid-cols-3 gap-2">
          <label className="text-sm font-semibold text-zinc-300">
            Active days
            <select value={activeDays} onChange={(e) => { setActiveDays(e.target.value); setSaved(false); }} className={inputCls}>
              <option value="all">Every day</option>
              <option value="weekdays">Weekdays</option>
              <option value="weekends">Weekends</option>
            </select>
          </label>
          <label className="text-sm font-semibold text-zinc-300">
            Active from
            <input type="time" value={activeStart} onChange={(e) => { setActiveStart(e.target.value); setSaved(false); }} className={inputCls} />
          </label>
          <label className="text-sm font-semibold text-zinc-300">
            Active until
            <input type="time" value={activeEnd} onChange={(e) => { setActiveEnd(e.target.value); setSaved(false); }} className={inputCls} />
          </label>
        </div>
        <p className="-mt-2 text-xs text-zinc-500">Scheduled tasks only fire inside this window (Jakarta time). Leave times empty for always-on.</p>
        <label className="text-sm font-semibold text-zinc-300">
          Memory
          <textarea
            value={memory}
            onChange={(e) => { setMemory(e.target.value); setSaved(false); }}
            placeholder={"e.g. Owner prefers concise answers. Building a warung POS; stack: ..."}
            rows={5}
            maxLength={4000}
            className={inputCls}
          />
        </label>
        <p className="-mt-1 text-xs text-zinc-500">Memory is fed to the model as persistent context on every message.</p>
        {error && <p className="text-sm text-red-400">{error}</p>}
        {saved && <p className="text-sm font-semibold text-emerald-400">Saved.</p>}
        <div className="flex items-center gap-3">
          <button type="submit" disabled={busy} className="rounded-md bg-emerald-600 px-6 py-2 font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
            {busy ? "Saving..." : "Save"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={togglePin}
            title={bot.pinned ? "Unpin: no bot auto-opens on visit" : "Pin: this bot opens automatically on every visit"}
            className={`rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-50 ${bot.pinned ? "border-emerald-600 text-emerald-400 hover:bg-emerald-950" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`}
          >
            {bot.pinned ? "Unpin bot" : "Pin bot"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={toggleArchive}
            title={bot.archived ? "Restore this bot to the active list" : "Hide this bot from lists, groups, and crons (history is kept)"}
            className={`rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-50 ${bot.archived ? "border-emerald-600 text-emerald-400 hover:bg-emerald-950" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`}
          >
            {bot.archived ? "Restore bot" : "Archive bot"}
          </button>
        </div>
      </form>

      <SchedulesView botId={bot.id} />

      <TeamView bot={bot} onOpenBot={onOpenBot} onTeamChanged={onTeamChanged} />

      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold text-zinc-200">Conversation recaps</h3>
          <button type="button" disabled={summarizing} onClick={summarizeNow} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50">
            {summarizing ? <Spinner /> : "Summarize now"}
          </button>
        </div>
        <p className="mb-3 text-xs text-zinc-500">Daily recaps are generated every night; weekly on Mondays; monthly on the 1st. The bot reads these as older context.</p>
        {!summaries ? (
          <div className="space-y-2" aria-label="Loading summaries">
            <div className="loading-skeleton h-10 w-full" />
            <div className="loading-skeleton h-10 w-full" />
          </div>
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
  const [providerInfo, setProviderInfo] = useState<ProviderInfo | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [view, setView] = useState<"chat" | "group" | "huddle" | "bot" | "logs" | "teams" | "harness">("chat");
  const [bots, setBots] = useState<SlaveBot[]>([]);
  const [botId, setBotId] = useState<string | null>(null);
  const [bot, setBot] = useState<SlaveBot | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [huddles, setHuddles] = useState<Huddle[]>([]);
  const [huddleId, setHuddleId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [recorder, setRecorder] = useState<Recorder | null>(null);
  const [recSecs, setRecSecs] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [conversing, setConversing] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [speakingKey, setSpeakingKey] = useState<number | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const [plusOpen, setPlusOpen] = useState(false);
  const [botFilter, setBotFilter] = useState("");
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

  const refreshHuddles = useCallback(async () => {
    try {
      setHuddles(await fetchHuddles());
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
      refreshHuddles();
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
      setHuddles([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, teamId]);

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
        setUser((u) => (u ? { ...u, credit_usd: res.credit_usd } : u));
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
    setHuddleId(null);
    setBotId(null);
    setBot(null);
    setMessages([]);
    setView("group");
  }

  function openHuddle(id: string | null) {
    setSideOpen(false);
    setError("");
    stopConverse();
    if (recorder) {
      recorder.cancel();
      stopRecordingUi();
    }
    setHuddleId(id);
    setGroupId(null);
    setView("huddle");
  }

  async function newGroup() {
    setError("");
    try {
      const created = await createGroup("", teamId ?? undefined);
      await refreshGroups();
      await openGroup(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create group.");
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
    setHuddleId(null);
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

  const [creating, setCreating] = useState(false);
  const [createOwner, setCreateOwner] = useState("");

  async function newBot(ownerId?: string) {
    setError("");
    try {
      const fallbackModel = (providerInfo?.default?.trim() || (providerInfo?.custom_allowed ? "" : "muse-spark-1.3") || "muse-spark-1.3");
      const created = await createBot(fallbackModel, teamId ?? undefined, ownerId || undefined);
      await refreshBots();
      setCreating(false);
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
      setUser((u) => (u ? { ...u, credit_usd: res.credit_usd } : u));
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
      await refreshUser();
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
          await refreshUser();
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
    setHuddles([]);
    setHuddleId(null);
    setUsage(null);
  }

  if (checking) return <div className="flex min-h-screen items-center justify-center text-zinc-400">Loading...</div>;
  if (!user) return <AuthView onAuth={setUser} />;

  // Team scope: only rows of the selected team ("" = legacy row, shown as fallback).
  const inTeam = (t: string) => !teamId || t === teamId || t === "";
  const teamGroups = groups.filter((g) => inTeam(g.team_id));
  const teamHuddles = huddles.filter((h) => inTeam(h.team_id));
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
    if (botFilter.trim() && !`${b.name} ${b.role} ${b.title}`.toLowerCase().includes(botFilter.trim().toLowerCase())) return null;
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

  const railBtn = (active: boolean) =>
    `flex h-10 w-10 items-center justify-center rounded-lg text-lg ${active ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-200"}`;

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      {/* App rail — Slack-style workspace nav */}
      <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-zinc-800 bg-zinc-950 py-3">
        <button type="button" onClick={() => setView("chat")} title="Home" className={railBtn(view === "chat" || view === "group" || view === "bot")}>⌂</button>
        <button type="button" onClick={() => openHuddle(null)} title="New huddle" className={railBtn(false)}>◉</button>
        <button type="button" onClick={() => setView("harness")} title="Harness (agent runs)" className={railBtn(view === "harness")}>⌁</button>
        <button type="button" onClick={() => setView("teams")} title="Teams" className={railBtn(view === "teams")}>▦</button>
        <button type="button" onClick={() => { setView("logs"); fetchUsage().then(setUsage).catch(() => {}); }} title="Usage & logs" className={railBtn(view === "logs")}>≡</button>
        <div className="mt-auto flex flex-col items-center gap-2">
          <span className="rounded px-1 text-[11px] font-bold text-emerald-400" title="Demo credit left">{formatUsd(user.credit_usd)}</span>
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-800 text-sm font-bold text-zinc-200" title={user.email}>
            {(user.name || user.email || "?").slice(0, 1).toUpperCase()}
          </span>
        </div>
      </nav>
      {/* Sidebar — workspace sections */}
      {sideOpen && (
        <div className="fixed inset-0 z-30 bg-black/60 md:hidden" onClick={() => setSideOpen(false)} />
      )}
      <aside className={`${sideOpen ? "fixed inset-y-0 left-0 z-40 flex w-72" : "hidden"} shrink-0 flex-col border-r border-zinc-800 bg-zinc-950 md:static md:flex md:w-60`}>
        <div className="border-b border-zinc-800 px-4 py-3">
          <div className="truncate font-bold">{teams.find((t) => t.id === teamId)?.name ?? "SlaveBots"}</div>
          <div className="truncate text-xs text-zinc-500">{teams.find((t) => t.id === teamId)?.role ?? user.email}</div>
        </div>
        <div className="border-b border-zinc-800 px-3 py-2">
          <label className="block text-[11px] font-bold uppercase tracking-wide text-zinc-500">
            Team
            <select
              value={teamId ?? ""}
              onChange={(e) => { setTeamId(e.target.value || null); setBotId(null); setBot(null); setGroupId(null); setHuddleId(null); setMessages([]); }}
              className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs font-semibold text-zinc-100 focus:border-emerald-500 focus:outline-none"
            >
              {teams.map((t) => (
                <option key={t.id} value={t.id}>{t.name} ({t.role})</option>
              ))}
              {teams.length === 0 && <option value="">No team yet</option>}
            </select>
          </label>
          <input
            value={botFilter}
            onChange={(e) => setBotFilter(e.target.value)}
            placeholder="Find a conversation..."
            className="mt-2 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
          />
        </div>
        <div className="flex items-center justify-between px-4 pb-1 pt-3">
          <div className="text-xs font-bold uppercase tracking-wide text-zinc-500">Direct messages</div>
          <button type="button" onClick={() => { setCreating((v) => !v); setCreateOwner(user.id); }} title="New slaveBot" className="rounded px-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
            +
          </button>
        </div>
        {creating && (
          <div className="mx-2 mb-1 rounded-md border border-zinc-800 bg-zinc-900 p-2">
            <label className="block text-[11px] font-bold uppercase tracking-wide text-zinc-500">
              Partner (owner)
              <select
                value={createOwner}
                onChange={(e) => setCreateOwner(e.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-100 focus:border-emerald-500 focus:outline-none"
              >
                <option value={user.id}>{memberNames[user.id] ?? "Me"}</option>
                {Object.entries(memberNames).filter(([id]) => id !== user.id).map(([id, name]) => (
                  <option key={id} value={id}>{name}</option>
                ))}
              </select>
            </label>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => newBot(createOwner)} className="flex-1 rounded-md bg-emerald-600 px-2 py-1.5 text-xs font-bold text-white hover:bg-emerald-500">
                Create
              </button>
              <button type="button" onClick={() => setCreating(false)} className="rounded-md px-2 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800">
                Cancel
              </button>
            </div>
          </div>
        )}
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
          {topBots.flatMap((b) => [botRow(b, false), ...(childMap.get(b.id) ?? []).map((c) => botRow(c, true))])}
          {orphanBots.map((b) => botRow(b, false))}
          {activeBots.length === 0 && <p className="px-2 py-2 text-sm text-zinc-500">No slaveBots yet — create one to start.</p>}
          {archivedBots.length > 0 && (
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              className="mt-1 rounded-md px-2 py-1.5 text-left text-xs font-semibold text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
            >
              {showArchived ? "▾ Archived" : `▸ Archived (${archivedBots.length})`}
            </button>
          )}
          {showArchived &&
            archivedBots.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => openBot(b.id)}
                title={`${b.title || b.name} (archived)`}
                className={`flex items-center gap-2.5 rounded-md px-2 py-2 text-left opacity-60 hover:bg-zinc-800 hover:opacity-100 ${b.id === botId ? "bg-zinc-800" : ""}`}
              >
                <BotAvatar bot={b} size="sm" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{b.name}</span>
                  <span className="block truncate text-xs text-zinc-500">archived</span>
                </span>
              </button>
            ))}
        </nav>
        <div className="flex items-center justify-between border-t border-zinc-800 px-4 pb-1 pt-3">
          <div className="text-xs font-bold uppercase tracking-wide text-zinc-500">Channels</div>
          <button type="button" onClick={newGroup} className="rounded px-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
            + New
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
          {teamGroups.length === 0 && <p className="px-2 pb-1 text-xs text-zinc-600">No groups yet.</p>}
        </nav>
        <div className="flex items-center justify-between border-t border-zinc-800 px-4 pb-1 pt-3">
          <div className="text-xs font-bold uppercase tracking-wide text-zinc-500">Huddles</div>
          <button type="button" onClick={() => openHuddle(null)} className="rounded px-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
            + New
          </button>
        </div>
        <nav className="flex max-h-40 flex-col gap-1 overflow-y-auto p-2 pt-1">
          {teamHuddles.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => openHuddle(h.id)}
              title={h.topic}
              className={`truncate rounded-md px-2 py-2 text-left text-sm hover:bg-zinc-800 ${h.id === huddleId ? "bg-zinc-800 font-semibold" : "text-zinc-300"}`}
            >
              <span className="mr-1 text-zinc-500">◉</span>{h.topic.length > 40 ? `${h.topic.slice(0, 40)}…` : h.topic}
            </button>
          ))}
          {teamHuddles.length === 0 && <p className="px-2 pb-1 text-xs text-zinc-600">No huddles yet.</p>}
        </nav>
        <div className="flex flex-col items-start gap-2 border-t border-zinc-800 p-3">
          <div className="flex gap-1 px-2">
            <button type="button" onClick={() => { setView("teams"); setSideOpen(false); }} className="flex-1 rounded-md px-2 py-1 text-left text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
              Teams
            </button>
            <button type="button" onClick={() => { setView("logs"); fetchUsage().then(setUsage).catch(() => {}); setSideOpen(false); }} className="flex-1 rounded-md px-2 py-1 text-left text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
              Usage &amp; logs
            </button>
          </div>
          <div className="px-2 text-sm font-bold text-emerald-400">{formatUsd(user.credit_usd)} left</div>
          <div className="px-2 text-xs text-zinc-500">{user.email}</div>
          <p className="px-2 text-[11px] leading-snug text-zinc-500">AI keys live in Teams settings — open the Teams tab, pick a team, and configure its provider.</p>
          <button type="button" onClick={logout} className="rounded-md px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
            Log out
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col bg-zinc-900">
        <header className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2 md:px-4">
          <div className="flex min-w-0 items-center gap-1">
            <button type="button" onClick={() => setSideOpen((v) => !v)} title="Conversations" className="rounded-md px-2 py-1 text-lg text-zinc-300 hover:bg-zinc-800 md:hidden">
              ☰
            </button>
            {view === "bot" && bot ? (
              <button type="button" onClick={() => setView("chat")} title="Back to chat" className="min-w-0 truncate rounded px-1 text-left font-semibold hover:bg-zinc-800">
                ← {bot.name} <span className="text-xs font-normal text-zinc-500">settings</span>
              </button>
            ) : view === "group" ? (
              <span className="truncate px-1 font-semibold"><span className="mr-1 font-bold text-zinc-300">#</span>{groups.find((g) => g.id === groupId)?.name ?? "group"}</span>
            ) : view === "huddle" ? (
              <span className="truncate px-1 font-semibold"><span className="mr-1 text-zinc-300">◉</span>{huddles.find((h) => h.id === huddleId)?.topic.slice(0, 40) ?? "huddle"}</span>
            ) : view === "teams" ? (
              <span className="px-1 font-semibold">Teams</span>
            ) : view === "harness" ? (
              <span className="px-1 font-semibold">Harness</span>
            ) : view === "logs" ? (
              <span className="px-1 font-semibold">Usage &amp; logs</span>
            ) : (
              <button type="button" onClick={() => bot && setView("bot")} disabled={!bot} title={bot ? "Bot settings" : undefined} className="min-w-0 truncate rounded px-1 text-left font-semibold hover:bg-zinc-800 disabled:hover:bg-transparent">
                <span className="mr-1 font-bold text-zinc-300">#</span>{bot ? bot.name : "pick a slaveBot"}
              </button>
            )}
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
        ) : view === "harness" ? (
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden"><HarnessView teamId={teamId} /></main>
        ) : view === "teams" ? (
          <main className="flex-1 overflow-y-auto">
            <TeamsView
              teams={teams}
              teamId={teamId}
              userId={user.id}
              onChanged={async () => {
                const list = await fetchTeams();
                setTeams(list);
                if (!list.some((t) => t.id === teamId)) setTeamId(list[0]?.id ?? null);
              }}
              onSelect={(id) => { setTeamId(id); setView("chat"); }}
            />
          </main>
        ) : view === "group" && groupId ? (
          <main className="flex-1 overflow-y-auto">
            <GroupView
              groupId={groupId}
              bots={bots}
              onCredit={refreshUser}
              onDeleted={async () => {
                setGroupId(null);
                await refreshGroups();
                setView("chat");
              }}
            />
          </main>
        ) : view === "huddle" ? (
          <main className="flex-1 overflow-y-auto">
            <HuddleView
              huddleId={huddleId}
              bots={bots}
              teamId={teamId}
              onCreated={async (id) => {
                await refreshHuddles();
                openHuddle(id);
              }}
              onChanged={refreshHuddles}
              onDeleted={async () => {
                setHuddleId(null);
                await refreshHuddles();
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
                  <h2 className="text-xl font-bold">Hi, {user.name || user.email}.</h2>
                  <p className="mt-2 text-zinc-400">Select a slaveBot on the left to continue the conversation — or create a new one. Each bot keeps its own history and memory.</p>
                  <button type="button" onClick={() => newBot()} className="mt-4 rounded-md bg-emerald-600 px-4 py-2 font-semibold text-white hover:bg-emerald-500">
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
                  <BotAvatar bot={bot ?? { id: "u", name: m.role === "user" ? (user.name || "You") : "A", title: "", model: "", memory: "", role: "", parent_id: "", pinned: 0, pinned_by: "", owner_user_id: "", relay: 1, user_id: "u", team_id: "", avatar_key: "", archived: 0, voice: "luna", active_days: "all", active_start: "", active_end: "", created_at: "", updated_at: "" } as SlaveBot} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-bold">{m.role === "user" ? (user.name || "You") : (bot?.name ?? "Assistant")}</span>
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
                          title="Hear this reply in the bot's voice"
                          className="rounded px-1 text-xs text-zinc-500 hover:bg-zinc-700 hover:text-emerald-400"
                        >
                          {speakingKey === m.key ? "Stop" : "Speak"}
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
                    title="More actions"
                    className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100"
                  >
                    <PlusIcon />
                  </button>
                  {plusOpen && (
                    <>
                      <div className="fixed inset-0 z-30" onClick={() => setPlusOpen(false)} />
                      <div className="absolute bottom-11 left-0 z-40 w-52 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 py-1 shadow-xl">
                        <button type="button" onClick={() => { setPlusOpen(false); setCreating(true); setCreateOwner(user.id); }} className="block w-full px-4 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800">
                          New slaveBot
                        </button>
                        <button type="button" onClick={() => { setPlusOpen(false); newGroup(); }} className="block w-full px-4 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800">
                          New channel
                        </button>
                        <button type="button" onClick={() => { setPlusOpen(false); openHuddle(null); }} className="block w-full px-4 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800">
                          New huddle
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
                  placeholder={bot ? `Message ${bot.name}...` : "Select a slaveBot first"}
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
                  title={recorder ? `Stop recording (${recSecs.toFixed(0)}s)` : "Dictate with microphone"}
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full hover:bg-zinc-700 disabled:opacity-40 ${recorder ? "text-red-400" : "text-zinc-300"}`}
                >
                  {recorder ? <span className="flex items-center gap-1 text-xs font-bold tabular-nums"><span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />{recSecs.toFixed(0)}</span> : transcribing ? <Spinner /> : <MicIcon />}
                </button>
                {input.trim() || streaming ? (
                  <button
                    type="submit"
                    disabled={!input.trim() || !bot || streaming}
                    title="Send"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-700 disabled:text-zinc-500"
                  >
                    {streaming ? <Spinner /> : <ArrowUpIcon />}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={toggleConverse}
                    disabled={!bot || streaming || transcribing || !!recorder}
                    title={conversing ? "Stop hands-free chat" : "Hands-free voice chat"}
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
  );
}
