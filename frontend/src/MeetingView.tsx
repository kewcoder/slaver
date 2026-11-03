import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpIcon, BotAvatar, Spinner } from "./ui";
import {
  createMeeting,
  deleteMeeting,
  fetchMeetingDetail,
  formatUsd,
  meetingChat,
  type MeetingDetail,
  type SlaveBot,
} from "./api";

export function MeetingView({
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
