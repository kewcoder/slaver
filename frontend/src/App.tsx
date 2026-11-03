import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  addGroupMembers,
  appendMemory,
  connectFly,
  destroyFlyMachine,
  disconnectFly,
  fetchAvatar,
  fetchDomains,
  fetchUnread,
  inboxNow,
  markRead,
  openInboxStream,
  fetchFlyAccounts,
  fetchFlyMachines,
  fetchTeamTemplates,
  applyTeamTemplate,
  createBot,
  createOAuthClient,
  createGroup,
  createMeeting,
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
    type InboxEvent,
    type Meeting,
    type MeetingDetail,
  type ActivityItem,
  type OAuthClient,
  type ProviderInfo,
  type PublicGroup,
  type SlaveBot,
  type Team,
  type TeamDetail,
  type Summaries,
  type TeamTemplate,
  type User,
} from "./api";
import { ArrowUpIcon, BotAvatar, MicIcon, PlusIcon, Spinner, TypingDots, WaveIcon, dayKey, dayLabel, renderMentions } from "./ui";
import { AuthView, OnboardingView } from "./AuthView";
import { BotView } from "./BotView";
import { GroupView } from "./GroupView";
import { MeetingView } from "./MeetingView";
import { SettingsView } from "./SettingsView";
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
import { DmView } from "./DmView";
import CodeView from "./CodeView";
import MarketView from "./MarketView";




interface UiMessage {
  key: number;
  id?: number;
  role: string;
  content: string;
  created_at?: string;
}









export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [providerInfo, setProviderInfo] = useState<ProviderInfo | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [view, setView] = useState<"apps" | "chat" | "group" | "meeting" | "bot" | "dm" | "settings" | "code" | "market">("apps");
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
  const [dmPeer, setDmPeer] = useState<{ id: string; name: string } | null>(null);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [teammates, setTeammates] = useState<{ id: string; name: string }[]>([]);
  const [feed, setFeed] = useState<InboxEvent | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const reconnectRef = useRef<number | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const convRef = useRef({ view: "apps" as string, dmPeerId: "", groupId: "", meetingId: "", botId: "", teamId: "" });

  const refreshUnread = useCallback(async () => {
    try {
      const list = await fetchUnread();
      const map: Record<string, number> = {};
      for (const u of list) map[`${u.kind}:${u.team_id}:${u.ref_id}`] = u.unread;
      setUnread(map);
    } catch {
      /* keep old badges on transient failure */
    }
  }, []);

  function pickTeam(id: string | null) {
    setTeamId(id);
    setBotId(null);
    setBot(null);
    setGroupId(null);
    setMeetingId(null);
    setDmPeer(null);
    setMessages([]);
    setTeamMenuOpen(false);
  }
  const [plusOpen, setPlusOpen] = useState(false);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const keyRef = useRef(0);
  const pendingEcho = useRef<string[]>([]);
  const lastFeed = useRef<InboxEvent | null>(null);
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

  // Teammates for user-to-user DMs (excluding self).
  useEffect(() => {
    if (!user || !teamId) {
      setTeammates([]);
      return;
    }
    fetchTeam(teamId)
      .then((d) =>
        setTeammates(
          d.members
            .filter((m) => m.user_id !== user.id)
            .map((m) => ({ id: m.user_id, name: m.name || m.email || m.user_id })),
        ),
      )
      .catch(() => {});
  }, [user, teamId]);

  // Keep a ref mirror so the inbox handler never goes stale.
  useEffect(() => {
    convRef.current = {
      view,
      dmPeerId: dmPeer?.id ?? "",
      groupId: groupId ?? "",
      meetingId: meetingId ?? "",
      botId: botId ?? "",
      teamId: teamId ?? "",
    };
  });

  // Live inbox: one SSE stream for DMs, groups, meetings and bot replies.
  useEffect(() => {
    if (!user) return;
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
    void refreshUnread();
    let stopped = false;
    let es: EventSource | null = null;
    const myName = (user.name || user.email.split("@")[0] || "").toLowerCase();
    const myFirst = myName.split(/\s+/)[0];
    const mentionsMe = (text: string) => {
      const t = text.toLowerCase();
      return (myName && t.includes("@" + myName)) || (myFirst && t.includes("@" + myFirst));
    };
    const notify = (title: string, body: string) => {
      try {
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification(title, { body: body.slice(0, 140) });
        }
      } catch {
        /* notifications optional */
      }
    };
    let debounce: number | null = null;
    const pokeUnread = () => {
      if (debounce !== null) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => void refreshUnread(), 1500);
    };
    const connect = () => {
      if (stopped) return;
      if (es) {
        try {
          es.close();
        } catch {
          /* ignore */
        }
      }
      const since = inboxNow() || new Date().toISOString();
      es = openInboxStream(since, (ev) => {
        if (stopped) return;
        const key = `${ev.kind}:${ev.id}`;
        if (seenRef.current.has(key)) return;
        seenRef.current.add(key);
        if (seenRef.current.size > 3000) {
          seenRef.current = new Set(Array.from(seenRef.current).slice(-2000));
        }
        const c = convRef.current;
        const isOpenDm =
          c.view === "dm" && ev.kind === "dm" && ev.team_id === c.teamId && (ev.from_user_id === c.dmPeerId || ev.to_user_id === c.dmPeerId);
        const isOpenGroup = c.view === "group" && ev.kind === "group" && ev.group_id === c.groupId;
        const isOpenMeeting = c.view === "meeting" && ev.kind === "meeting" && ev.meeting_id === c.meetingId;
        const isOpenBot = (c.view === "chat" || c.view === "bot") && ev.kind === "bot" && ev.bot_id === c.botId;
        const isSelf = "from_user_id" in ev && ev.from_user_id === user.id;
        if (isOpenDm || isOpenGroup || isOpenMeeting) {
          setFeed(ev);
          return;
        }
        if (isOpenBot && !isSelf) {
          setMessages((prev) => {
            if (ev.id != null && prev.some((m) => m.id === ev.id)) return prev;
            if (ev.content && prev.length > 0) {
              const lastMsg = prev[prev.length - 1];
              if (lastMsg.role === "assistant" && lastMsg.content === ev.content) return prev;
            }
            return [...prev, { key: ++keyRef.current, id: ev.id, role: "assistant", content: ev.content, created_at: ev.created_at }];
          });
          void markRead("bot", ev.team_id, ev.bot_id || "", ev.id).catch(() => {});
          void refreshUnread();
          return;
        }
        if (isSelf) return;
        pokeUnread();
        const title =
          ev.kind === "dm"
            ? (ev.from_name as string) || "Pesan baru"
            : ev.kind === "group"
              ? `#${(ev as { group_name?: string }).group_name || "Grup"}`
              : ev.kind === "meeting"
                ? `Rapat: ${(ev as { topic?: string }).topic || "Rapat"}`
                : (ev as { bot_name?: string }).bot_name || "Asisten";
        if (ev.kind === "dm" || mentionsMe(ev.content)) {
          notify(title, ev.content);
        }
      }, () => {
        if (stopped) return;
        reconnectRef.current = window.setTimeout(connect, 5000);
      });
      esRef.current = es;
    };
    connect();
    return () => {
      stopped = true;
      if (reconnectRef.current !== null) window.clearTimeout(reconnectRef.current);
      if (es) {
        try {
          es.close();
        } catch {
          /* ignore */
        }
      }
      esRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Live bot replies landing in the open bot chat (deduped against echoes).
  useEffect(() => {
    if (!feed || feed.kind !== "bot" || feed === lastFeed.current) return;
    lastFeed.current = feed;
    if (!bot || feed.bot_id !== bot.id || view === "dm") return;
    const idx = pendingEcho.current.indexOf(feed.content);
    if (idx >= 0) {
      pendingEcho.current.splice(idx, 1);
    } else {
      setMessages((prev) => {
        if (prev.some((m) => m.id === feed.id)) return prev;
        return [...prev, { key: ++keyRef.current, id: feed.id, role: "assistant", content: feed.content, created_at: feed.created_at }];
      });
    }
    void markRead("bot", feed.team_id, feed.bot_id || "", feed.id).catch(() => {});
    void refreshUnread();
  }, [feed, bot, view, refreshUnread]);

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
    setDmPeer(null);
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
    setDmPeer(null);
    setBotId(null);
    setBot(null);
    setMessages([]);
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

  async function openDm(peerId: string, peerName: string) {
    setSideOpen(false);
    setError("");
    stopConverse();
    setBotId(null);
    setBot(null);
    setGroupId(null);
    setMeetingId(null);
    setMessages([]);
    setDmPeer({ id: peerId, name: peerName });
    setView("dm");
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
    setDmPeer(null);
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
        detail.messages.map((m) => ({ key: ++keyRef.current, id: m.id, role: m.role, content: m.content, created_at: m.created_at })),
      );
      const maxId = detail.messages.reduce((a, m) => Math.max(a, m.id), 0);
      if (maxId > 0) {
        await markRead("bot", detail.slavebot.team_id, detail.slavebot.id, maxId).catch(() => {});
        void refreshUnread();
      }
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
      if (reply) pendingEcho.current.push(reply);
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
      if (content) pendingEcho.current.push(content);
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
        {(() => {
          const n = unread[`bot:${b.team_id}:${b.id}`] || 0;
          return n > 0 ? (
            <span className="shrink-0 rounded-full bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold text-white">{n > 99 ? "99+" : n}</span>
          ) : null;
        })()}
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
          <button type="button" onClick={() => setView("chat")} className={topBtn(view === "chat" || view === "group" || view === "bot" || view === "meeting" || view === "dm")}><span aria-hidden="true">💬</span> Chat</button>
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
          <div className="text-xs font-bold uppercase tracking-wide text-zinc-500">Rekan tim</div>
        </div>
        <nav className="flex max-h-40 flex-col gap-1 overflow-y-auto p-2 pt-1">
          {teammates.map((t) => {
            const n = unread[`dm:${teamId ?? ""}:${t.id}`] || 0;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => openDm(t.id, t.name)}
                title={`Chat dengan ${t.name}`}
                className={`flex items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-zinc-800 ${t.id === dmPeer?.id && view === "dm" ? "bg-zinc-800" : ""}`}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-teal-800 text-sm font-bold text-teal-200">
                  {t.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{t.name}</span>
                {n > 0 && (
                  <span className="shrink-0 rounded-full bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold text-white">{n > 99 ? "99+" : n}</span>
                )}
              </button>
            );
          })}
          {teammates.length === 0 && <p className="px-2 pb-1 text-xs text-zinc-600">Belum ada rekan tim.</p>}
        </nav>
        <div className="flex items-center justify-between border-t border-zinc-800 px-4 pb-1 pt-3">
          <div className="text-xs font-bold uppercase tracking-wide text-zinc-500">Grup</div>
          <button type="button" onClick={newGroup} title="Buat grup baru" className="rounded px-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
            + Baru
          </button>
        </div>
        <nav className="flex max-h-40 flex-col gap-1 overflow-y-auto p-2 pt-1">
          {teamGroups.map((g) => {
            const n = unread[`group:${g.team_id}:${g.id}`] || 0;
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => openGroup(g.id)}
                title={g.name}
                className={`flex items-center gap-1 truncate rounded-md px-2 py-2 text-left text-sm hover:bg-zinc-800 ${g.id === groupId ? "bg-zinc-800 font-semibold" : "text-zinc-300"}`}
              >
                <span className="text-zinc-500">##</span><span className="min-w-0 flex-1 truncate">{g.name}</span>
                {n > 0 && <span className="shrink-0 rounded-full bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold text-white">{n > 99 ? "99+" : n}</span>}
              </button>
            );
          })}
          {teamGroups.length === 0 && <p className="px-2 pb-1 text-xs text-zinc-600">Belum ada grup.</p>}
        </nav>
        <div className="flex items-center justify-between border-t border-zinc-800 px-4 pb-1 pt-3">
          <div className="text-xs font-bold uppercase tracking-wide text-zinc-500">Rapat</div>
          <button type="button" onClick={() => openMeeting(null)} title="Mulai rapat baru" className="rounded px-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
            + Baru
          </button>
        </div>
        <nav className="flex max-h-40 flex-col gap-1 overflow-y-auto p-2 pt-1">
          {teamMeetings.map((h) => {
            const n = unread[`meeting:${h.team_id}:${h.id}`] || 0;
            return (
              <button
                key={h.id}
                type="button"
                onClick={() => openMeeting(h.id)}
                title={h.topic}
                className={`flex items-center gap-1 truncate rounded-md px-2 py-2 text-left text-sm hover:bg-zinc-800 ${h.id === meetingId ? "bg-zinc-800 font-semibold" : "text-zinc-300"}`}
              >
                <span className="text-zinc-500">◉</span><span className="min-w-0 flex-1 truncate">{h.topic.length > 40 ? `${h.topic.slice(0, 40)}…` : h.topic}</span>
                {n > 0 && <span className="shrink-0 rounded-full bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold text-white">{n > 99 ? "99+" : n}</span>}
              </button>
            );
          })}
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
            ) : view === "dm" && dmPeer ? (
              <span className="truncate px-1 font-semibold"><span className="mr-1 text-teal-300">✉</span>{dmPeer.name}</span>
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
              meId={user.id}
              feed={feed}
              onMarked={refreshUnread}
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
        ) : view === "dm" && dmPeer ? (
          <main className="flex-1 overflow-y-auto">
            <DmView
              teamId={teamId ?? ""}
              meId={user.id}
              peer={dmPeer}
              feed={feed}
              onMarked={refreshUnread}
            />
          </main>
        ) : view === "meeting" ? (
          <main className="flex-1 overflow-y-auto">
            <MeetingView
              meetingId={meetingId}
              bots={bots}
              teamId={teamId}
              feed={feed}
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
              onMarked={refreshUnread}
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
