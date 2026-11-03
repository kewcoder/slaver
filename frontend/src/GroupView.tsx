import { useCallback, useEffect, useRef, useState } from "react";
import KanbanBoard from "./KanbanBoard";
import { ArrowUpIcon, BotAvatar, Spinner } from "./ui";
import {
  addGroupMembers,
  appendMemory,
  createProject,
  deleteGroup,
  fetchGroupDetail,
  fetchProjects,
  groupChat,
  removeGroupMember,
  renameGroup,
  setGroupProject,
  setGroupVisibility,
  type GroupDetail,
  type Project,
  type SlaveBot,
} from "./api";

export function GroupView({
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
