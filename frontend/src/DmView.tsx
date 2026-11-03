import { useCallback, useEffect, useRef, useState } from "react";
import { fetchDmHistory, markRead, sendDm, type DirectMessage, type InboxEvent } from "./api";
import { ArrowUpIcon, Spinner } from "./ui";

/** User-to-user direct messages. Live via inbox SSE (feed prop). */
export function DmView({
  teamId,
  meId,
  peer,
  feed,
  onMarked,
}: {
  teamId: string;
  meId: string;
  peer: { id: string; name: string };
  feed: InboxEvent | null;
  onMarked: () => void;
}) {
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const seenRef = useRef<Set<number>>(new Set());
  const markedRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await fetchDmHistory(teamId, peer.id);
      for (const m of list) seenRef.current.add(m.id);
      setMessages(list);
      const maxId = list.reduce((a, m) => Math.max(a, m.id), 0);
      if (maxId > markedRef.current) {
        markedRef.current = maxId;
        await markRead("dm", teamId, peer.id, maxId).catch(() => {});
        onMarked();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tidak bisa memuat chat.");
    }
  }, [teamId, peer.id, onMarked]);

  useEffect(() => {
    seenRef.current = new Set();
    markedRef.current = 0;
    setMessages([]);
    setError("");
    void refresh();
  }, [refresh]);

  // Live append from inbox stream.
  useEffect(() => {
    if (!feed || feed.kind !== "dm" || feed.team_id !== teamId) return;
    const from = feed.from_user_id || "";
    const to = feed.to_user_id || "";
    const relevant =
      (from === peer.id && to === meId) || (from === meId && to === peer.id);
    if (!relevant || seenRef.current.has(feed.id)) return;
    seenRef.current.add(feed.id);
    setMessages((prev) => {
      if (prev.some((m) => m.id === feed.id)) return prev;
      return [
        ...prev,
        {
          id: feed.id,
          team_id: feed.team_id,
          from_user_id: from,
          from_name: feed.from_name ?? null,
          to_user_id: to,
          content: feed.content,
          created_at: feed.created_at,
        },
      ];
    });
    if (feed.id > markedRef.current) {
      markedRef.current = feed.id;
      void markRead("dm", teamId, peer.id, feed.id).catch(() => {});
      onMarked();
    }
  }, [feed, teamId, peer.id, meId, onMarked]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [messages.length]);

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    setInput("");
    try {
      const sent = await sendDm(teamId, peer.id, text);
      seenRef.current.add(sent.id);
      setMessages((prev) => [...prev, sent]);
      if (sent.id > markedRef.current) {
        markedRef.current = sent.id;
        await markRead("dm", teamId, peer.id, sent.id).catch(() => {});
        onMarked();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal mengirim.");
      setInput(text);
    } finally {
      setBusy(false);
    }
  }

  const initial = (peer.name || "?").slice(0, 1).toUpperCase();

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-4 py-4">
      <div className="mb-3 flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-900 text-sm font-black text-emerald-300">
          {initial}
        </span>
        <div className="min-w-0">
          <div className="truncate font-bold text-zinc-100">{peer.name}</div>
          <div className="text-xs text-zinc-500">Chat langsung · otomatis tersimpan sebagai dibaca</div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {messages.length === 0 && (
          <p className="py-8 text-center text-zinc-500">Belum ada pesan. Sapa {peer.name} duluan 👋</p>
        )}
        {messages.map((m) => {
          const mine = m.from_user_id === meId;
          return (
            <div key={m.id} className={`flex gap-3 rounded px-2 py-2 ${mine ? "flex-row-reverse text-right" : ""}`}>
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${mine ? "bg-emerald-900 text-emerald-300" : "bg-zinc-700 text-white"}`}>
                {(mine ? "Anda" : m.from_name || peer.name || "?").slice(0, 1).toUpperCase()}
              </span>
              <div className={`min-w-0 max-w-[80%] ${mine ? "items-end" : ""}`}>
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-bold">{mine ? "Anda" : m.from_name || peer.name}</span>
                  <span className="text-xs text-zinc-500">{m.created_at ? new Date(m.created_at).toLocaleString() : ""}</span>
                </div>
                <div className="whitespace-pre-wrap break-words text-[15px] text-zinc-200">{m.content}</div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {error && <p className="py-1 text-sm text-red-400">{error}</p>}

      <form onSubmit={send} className="mt-2 flex items-end gap-1 rounded-[28px] border border-zinc-700 bg-[#2b2d31] p-2 pl-4 shadow-lg focus-within:border-zinc-500">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={`Pesan untuk ${peer.name}… (live)`}
          rows={1}
          disabled={busy}
          className="max-h-40 flex-1 resize-none bg-transparent px-2 py-2 text-[15px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none disabled:opacity-40"
        />
        <button type="submit" disabled={!input.trim() || busy} title="Kirim" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-700 disabled:text-zinc-500">
          {busy ? <Spinner /> : <ArrowUpIcon />}
        </button>
      </form>
    </div>
  );
}
