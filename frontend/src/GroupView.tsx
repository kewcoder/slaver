import { useCallback, useEffect, useRef, useState } from "react";
import KanbanBoard from "./KanbanBoard";
import { useLang } from "./i18n";
import { ArrowUpIcon, BotAvatar, Spinner } from "./ui";
import {
  addGroupMembers,
  appendMemory,
  createProject,
  deleteGroup,
  fetchGroupDetail,
  fetchProjects,
  groupChat,
  markRead,
  removeGroupMember,
  renameGroup,
  setGroupProject,
  setGroupVisibility,
  type GroupDetail,
  type GroupMessage,
  type InboxEvent,
  type Project,
  type SlaveBot,
} from "./api";

export function GroupView({
  groupId,
  bots,
  teamId,
  meId,
  feed,
  onDeleted,
  onVisibilityChanged,
  onMarked,
}: {
  groupId: string;
  bots: SlaveBot[];
  teamId: string | null;
  meId: string;
  feed: InboxEvent | null;
  onDeleted: () => void;
  onVisibilityChanged: () => void;
  onMarked: () => void;
}) {
  const { t } = useLang();
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [task, setTask] = useState("");
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
  const seenRef = useRef<Set<number>>(new Set());
  const markedRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const d = await fetchGroupDetail(groupId);
      for (const m of d.messages) seenRef.current.add(m.id);
      setDetail(d);
      const maxId = d.messages.reduce((a, m) => Math.max(a, m.id), 0);
      if (maxId > markedRef.current) {
        markedRef.current = maxId;
        await markRead("group", d.group.team_id, d.group.id, maxId).catch(() => {});
        onMarked();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("chat.errLoad"));
    }
  }, [groupId, onMarked]);

  useEffect(() => {
    setDetail(null);
    setError("");
    setTab("chat");
    setBoardFull(false);
    seenRef.current = new Set();
    markedRef.current = 0;
    if (localStorage.getItem("group_open_board") === groupId) {
      localStorage.removeItem("group_open_board");
      setTab("board");
    }
    refresh();
  }, [groupId, refresh]);

  // Live append from inbox stream + auto-mark read while open.
  useEffect(() => {
    if (!feed || feed.kind !== "group" || feed.group_id !== groupId) return;
    if (seenRef.current.has(feed.id)) return;
    seenRef.current.add(feed.id);
    const row: GroupMessage = {
      id: feed.id,
      slavebot_id: feed.slavebot_id ?? null,
      bot_name: feed.bot_name ?? null,
      user_id: feed.user_id ?? null,
      user_name: feed.user_name ?? null,
      role: feed.role || "assistant",
      content: feed.content,
      created_at: feed.created_at,
    };
    setDetail((prev) => {
      if (!prev || prev.messages.some((m) => m.id === row.id)) return prev;
      return { ...prev, messages: [...prev.messages, row] };
    });
    if (feed.id > markedRef.current && detail) {
      markedRef.current = feed.id;
      void markRead("group", detail.group.team_id, detail.group.id, feed.id)
        .catch(() => {})
        .then(() => onMarked());
    }
  }, [feed, groupId, detail, onMarked]);

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
      await groupChat(groupId, text);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("chat.errChat"));
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
      setSavedNote(t("chat.savedMemory").replace("{name}", botName ?? t("chat.assistantFallback")));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("chat.errMemory"));
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
      setError(err instanceof Error ? err.message : t("chat.errAdd"));
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
      setError(err instanceof Error ? err.message : t("chat.errRemove"));
    }
  }

  async function doDelete() {
    if (!window.confirm(t("chat.deleteConfirm"))) return;
    try {
      await deleteGroup(groupId);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("chat.errDelete"));
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
      setError(err instanceof Error ? err.message : t("chat.errAttach"));
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
      setError(err instanceof Error ? err.message : t("chat.errBoard"));
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
            <p className="py-8 text-center text-zinc-500">{t("chat.noDiscussion")}</p>
          )}
          {detail.messages.map((m) => (
              <div key={m.id} className="group flex gap-3 rounded px-2 py-3 hover:bg-zinc-800/50">
                {m.slavebot_id ? (
                  <BotAvatar bot={({ id: m.slavebot_id, name: m.bot_name ?? "?", title: "", model: "", memory: "", role: "", parent_id: "", pinned: 0, pinned_by: "", owner_user_id: "", relay: 1, user_id: "u", team_id: "", avatar_key: bots.find((b) => b.id === m.slavebot_id)?.avatar_key ?? "", archived: 0, voice: "luna", active_days: "all", active_start: "", active_end: "", created_at: "", updated_at: "" }) as SlaveBot} size="sm" />
                ) : (
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-600 text-sm font-bold text-white">
                    {((m.user_id && m.user_id !== meId ? m.user_name : t("common.you")) || "?").slice(0, 1).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-bold">{m.slavebot_id ? (m.bot_name ?? t("chat.assistantFallback")) : m.user_id && m.user_id !== meId ? (m.user_name || t("chat.peerFallback")) : t("common.you")}</span>
                    <span className="text-xs text-zinc-500">{new Date(m.created_at).toLocaleString()}</span>
                    {m.slavebot_id && (
                      <button
                        type="button"
                        onClick={() => saveReply(m.slavebot_id, m.bot_name, m.content)}
                        title={t("chat.saveMemoryTitle")}
                        className="rounded px-1 text-xs text-zinc-500 hover:bg-zinc-700 hover:text-emerald-400"
                      >
                        {t("chat.saveMemory")}
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
            placeholder={t("chat.groupPlaceholderLive")}
            rows={1}
            disabled={busy}
            className="max-h-40 flex-1 resize-none bg-transparent px-2 py-2 text-[15px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none disabled:opacity-40"
          />
          <button type="submit" disabled={!task.trim() || busy} title={t("chat.send")} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-700 disabled:text-zinc-500">
            {busy ? <Spinner /> : <ArrowUpIcon />}
          </button>
        </form>
      </>
    );
  }

  if (!detail) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-2 p-8" aria-label={t("common.loading")}>
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
              onSubmit={(e) => { e.preventDefault(); if (newName.trim()) void (async () => { try { await renameGroup(groupId, newName.trim()); setRenaming(false); await refresh(); } catch (err) { setError(err instanceof Error ? err.message : t("chat.errRename")); } })(); }}
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
                {t("chat.save")}
              </button>
              <button type="button" onClick={() => setRenaming(false)} className="shrink-0 rounded px-1 text-xs text-zinc-400 hover:text-zinc-200">
                {t("chat.cancel")}
              </button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => { setNewName(detail.group.name); setRenaming(true); }}
              title={t("chat.renameTitle")}
              className="min-w-0 flex-1 truncate rounded px-1 text-left font-bold text-zinc-100 hover:bg-zinc-800"
            >
              {detail.group.name}
            </button>
          )}
          {!renaming && detail.group.is_public ? (
            <span title={t("chat.supportBadgeTitle")} className="shrink-0 rounded border border-emerald-700 px-2 py-0.5 text-[11px] font-bold text-emerald-400">
              {t("chat.supportBadge")}
            </span>
          ) : null}
          {!renaming && (
            <div className="flex shrink-0 items-center">
              <button type="button" onClick={() => { setNewName(detail.group.name); setRenaming(true); }} title={t("chat.renameTitle")} className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
                {t("chat.rename")}
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
                      setError(err instanceof Error ? err.message : t("chat.errVisibility"));
                    }
                  })();
                }}
                title={detail.group.is_public ? t("chat.makePrivateTitle") : t("chat.makePublicTitle")}
                className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-emerald-400"
              >
                {detail.group.is_public ? t("chat.makePrivate") : t("chat.makePublic")}
              </button>
              <button type="button" onClick={doDelete} className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400">
                {t("chat.delete")}
              </button>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {detail.members.map((m) => (
            <span key={m.id} className="flex items-center gap-1.5 rounded-full bg-zinc-800 py-1 pl-1 pr-2 text-sm">
              <BotAvatar bot={m} size="sm" />
              <span className="text-zinc-200">{m.name}</span>
              <button type="button" onClick={() => doRemove(m.id)} title={t("chat.unsupportedRemove").replace("{name}", m.name)} className="text-zinc-500 hover:text-red-400">
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
              {t("chat.addMembers")}
            </button>
          )}
          {addOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={t("chat.addMembersLabel")}>
              <div className="absolute inset-0 bg-black/60" onClick={() => { if (!busy) setAddOpen(false); }} />
              <div className="relative flex max-h-[80vh] w-full max-w-md flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-xl">
                <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
                  <h3 className="font-bold text-zinc-100">{t("chat.addMembersTitle").replace("{name}", detail.group.name)}</h3>
                  <button type="button" onClick={() => setAddOpen(false)} disabled={busy} title={t("chat.addMembersClose")} className="rounded px-2 py-1 text-lg leading-none text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40">
                    ×
                  </button>
                </div>
                <div className="border-b border-zinc-800 px-4 py-2">
                  <input
                    value={pickFilter}
                    onChange={(e) => setPickFilter(e.target.value)}
                    placeholder={t("chat.searchAssistant")}
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
                    {picked.length === 0 ? t("chat.pickToAdd") : t("chat.nSelected").replace("{n}", String(picked.length))}
                  </span>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => setAddOpen(false)} disabled={busy} className="rounded-md px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40">
                      {t("chat.cancel")}
                    </button>
                    <button type="button" onClick={doAdd} disabled={picked.length === 0 || busy} className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40">
                      {busy ? t("chat.adding") : `${t("chat.add")}${picked.length > 0 ? ` (${picked.length})` : ""}`}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
          <div className="mt-2 flex items-center gap-1 border-t border-zinc-800 pt-2">
          <button type="button" onClick={() => setTab("chat")} className={`rounded-md px-3 py-1 text-xs font-bold ${tab === "chat" ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-200"}`}>
            {t("chat.tabChat")}
          </button>
          <button type="button" onClick={openBoard} className={`rounded-md px-3 py-1 text-xs font-bold ${tab === "board" ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-200"}`}>
            {detail.group.project_id ? t("chat.tabBoard") : t("chat.tabBoardNew")}
          </button>
          {tab === "board" && detail.group.project_id && (
            <button type="button" onClick={() => setBoardFull((v) => !v)} title={boardFull ? t("chat.shrinkBoardTitle") : t("chat.expandBoardTitle")} className="ml-auto rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
              {boardFull ? t("chat.shrinkBoard") : t("chat.expandBoard")}
            </button>
          )}
        </div>
      </div>

      {tab === "chat" ? (
        <ChatPane minimized={false} />
      ) : !detail.group.project_id ? (
        <div className="rounded-xl border border-dashed border-zinc-700 bg-zinc-900/60 p-8 text-center">
          <div className="text-2xl">▤</div>
          <h3 className="mt-2 font-bold text-zinc-100">{t("chat.noBoardTitle")}</h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-zinc-400">{t("chat.noBoardBody")}</p>
          {teamProjects.length > 0 && (
            <div className="mx-auto mt-3 flex max-w-md gap-2">
              <select
                value=""
                onChange={(e) => attach(e.target.value)}
                disabled={attachBusy}
                className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none disabled:opacity-40"
              >
                <option value="">{t("chat.noBoardPick")}</option>
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
              placeholder={t("chat.noBoardNew")}
              className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
            />
            <button type="submit" disabled={!newProjName.trim() || attachBusy} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40">
              {attachBusy ? "…" : t("chat.noBoardCreate")}
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
