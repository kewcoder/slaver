import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { ArrowUpIcon, BotAvatar, Brand, Icon, MicIcon, PlusIcon, Spinner, ThemeToggle, TypingDots, WaveIcon, dayKey, dayLabel, renderMentions, type IconName } from "./ui";
import { AuthView, OnboardingView } from "./AuthView";
import { BotView } from "./BotView";
import { GroupView } from "./GroupView";
import { MeetingView } from "./MeetingView";
import { SettingsView } from "./SettingsView";
import { LangProvider, translate, useLang, type Lang, type StringsKey } from "./i18n";
import {
  playAudioBlob,
  recordConversationTurn,
  speak,
  startRecording,
  stopSpeaking,
  warmUpVoices,
  type Recorder,
} from "./voice";
import { setUserLang, fetchUpdates } from "./api";
import AppsView from "./AppsView";
import { DmView } from "./DmView";
import PublishView from "./PublishView";
import MarketView from "./MarketView";




interface UiMessage {
  key: number;
  id?: number;
  role: string;
  content: string;
  created_at?: string;
}









function AppShell() {
  const { lang, t, setLang: setUILang } = useLang();
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [providerInfo, setProviderInfo] = useState<ProviderInfo | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [view, setView] = useState<"apps" | "chat" | "group" | "meeting" | "bot" | "dm" | "settings" | "publish" | "market">(() => (new URLSearchParams(window.location.search).get("view") === "publish" ? "publish" : "apps"));
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
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [langBusy, setLangBusy] = useState(false);
  const [dmPeer, setDmPeer] = useState<{ id: string; name: string } | null>(null);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [teammates, setTeammates] = useState<{ id: string; name: string }[]>([]);
  const [feed, setFeed] = useState<InboxEvent | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const reconnectRef = useRef<number | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const langRef = useRef<Lang>("en");
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

  // Creator updates for owned apps: a badge only — nothing changes until the team syncs.
  const [updateCount, setUpdateCount] = useState(0);
  useEffect(() => {
    if (!teamId) return setUpdateCount(0);
    let alive = true;
    const check = () => fetchUpdates(teamId).then((u) => alive && setUpdateCount(u.length)).catch(() => {});
    void check();
    const h = window.setInterval(check, 5 * 60 * 1000);
    return () => { alive = false; window.clearInterval(h); };
  }, [teamId, view]);

  function goTo(next: typeof view) {
    setView(next);
    setSideOpen(false);
    setTeamMenuOpen(false);
    setUserMenuOpen(false);
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
      if ((user.lang === "en" || user.lang === "id") && user.lang !== langRef.current) {
        langRef.current = user.lang;
        setUILang(user.lang);
      }
      if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission().catch(() => {});
      }
    } else {
      setSupportGroups([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            ? ev.from_name || t("notif.dmFallback")
            : ev.kind === "group"
              ? `#${(ev as { group_name?: string }).group_name || t("notif.groupFallback")}`
              : ev.kind === "meeting"
                ? `${t("notif.meetingPrefix")}: ${(ev as { topic?: string }).topic || t("notif.meetingPrefix")}`
                : (ev as { bot_name?: string }).bot_name || t("notif.botFallback");
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
  }, [user, lang, t]);

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
      const created = await createGroup(t("chat.newGroupName"), teamId ?? undefined);
      await refreshGroups();
      await openGroup(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("chat.errNewGroup"));
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
      setError(err instanceof Error ? err.message : t("chat.errOpenBoard"));
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
      setError(err instanceof Error ? err.message : t("chat.errOpenBot"));
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
      setError(err instanceof Error ? err.message : t("chat.errNewBot"));
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
        setError(err instanceof Error ? err.message : t("chat.errTranscribe"));
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
      setError(err instanceof Error ? err.message : t("chat.errMic"));
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
      setError(err instanceof Error ? err.message : t("chat.errCommand"));
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
      setError(err instanceof Error ? err.message : t("chat.errSend"));
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
          setError(err instanceof Error ? err.message : t("chat.errMicRecord"));
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
          setError(err instanceof Error ? err.message : t("chat.errConverse"));
          break;
        }
      }
    } finally {
      converseRef.current = false;
      setConversing(false);
      setMicLevel(0);
    }
  }

  async function switchLang(l: Lang) {
    if (l === lang || langBusy) return;
    setLangBusy(true);
    try {
      setUILang(l);
      setUser(await setUserLang(l));
    } catch {
      /* keep local choice even if server save fails */
    } finally {
      setLangBusy(false);
    }
  }

  function logout() {
    setUserMenuOpen(false);
    autoOpenedRef.current = false;
    stopConverse();    if (recorder) {
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

  if (checking) return <div className="flex min-h-screen items-center justify-center text-zinc-400">{t("common.loading")}</div>;
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

  const ownerName = (b: SlaveBot) => (b.owner_user_id && b.owner_user_id !== user.id ? (memberNames[b.owner_user_id] ?? t("common.teammate")) : "");
  function botRow(b: SlaveBot, indented: boolean) {
    const partner = ownerName(b);
    return (
      <button
        key={b.id}
        type="button"
        onClick={() => openBot(b.id)}
        title={(b.role ? `${b.role} — ` : "") + (b.title || b.name) + (partner ? ` ${t("top.partnerTag", { name: partner })}` : "")}
        className={`group flex items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left ${b.id === botId && view === "chat" ? "border-accent/20 bg-accent/[0.08]" : "border-transparent hover:border-fg/[0.06] hover:bg-fg/[0.035]"} ${indented ? "ml-5 border-l border-l-white/10" : ""}`}
      >
        <span className="relative shrink-0">
          <BotAvatar bot={b} size="sm" />
          <span title={t("nav.online")} className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-zinc-950 bg-emerald-500" />
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
          <span title={t("nav.pinTitle")} className="shrink-0 rounded border border-emerald-700 px-1 text-[10px] font-bold text-emerald-400">PIN</span>
        ) : null}
      </button>
    );
  }

  const topBtn = (active: boolean) =>
    `flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-[13px] font-semibold ${active ? "bg-surface-2 text-accent-text " : "text-muted hover:bg-fg/[0.04] hover:text-fg"}`;

  const isConversationView = view === "chat" || view === "group" || view === "meeting" || view === "bot" || view === "dm";
  const activeTeam = teams.find((team) => team.id === teamId);
  const navItems: { id: "apps" | "chat" | "publish" | "market"; icon: IconName; label: string; active: boolean; badge?: number }[] = [
    { id: "apps", icon: "home", label: t("nav.apps"), active: view === "apps", badge: updateCount },
    { id: "market", icon: "market", label: t("nav.market"), active: view === "market" },
    { id: "publish", icon: "upload", label: t("nav.publish"), active: view === "publish" },
  ];

  const pageMeta = (() => {
    if (view === "apps") return { title: t("apps.title"), sub: activeTeam?.name ?? t("shell.workspace") };
    if (view === "settings") return { title: t("settings.title"), sub: activeTeam?.name ?? t("shell.workspace") };
    if (view === "publish") return { title: t("pub.title"), sub: t("shell.publishSub") };
    if (view === "market") return { title: t("market.title"), sub: t("shell.marketSub") };
    if (view === "group") return { title: groups.find((g) => g.id === groupId)?.name ?? t("top.mainTitleGroup"), sub: t("side.groups") };
    if (view === "dm" && dmPeer) return { title: dmPeer.name, sub: t("dm.title") };
    if (view === "meeting") return { title: meetings.find((h) => h.id === meetingId)?.topic ?? t("mtg.newTitle"), sub: t("side.meetings") };
    if (view === "bot" && bot) return { title: bot.name, sub: t("top.botSettings") };
    return { title: bot?.name ?? t("nav.chat"), sub: bot?.role || bot?.title || t("shell.chatSub") };
  })();

  function teamMenuPanel(pos: string) {
    return (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setTeamMenuOpen(false)} />
              <div className={`surface-raised ${pos} z-50 overflow-hidden rounded-xl`}>
                <div className="border-b border-fg/[0.07] px-3 py-2.5 panel-title">{t("nav.teamsTitle")}</div>
                <div className="max-h-64 overflow-y-auto p-1.5">
                  {teams.map((team) => (
                    <button
                      key={team.id}
                      type="button"
                      onClick={() => pickTeam(team.id)}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-fg/[0.05] ${team.id === teamId ? "bg-accent/[0.07]" : ""}`}
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-xs font-black text-accent-text">
                        {team.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-fg">{team.name}</span>
                        <span className="block text-[11px] text-subtle">{team.role}</span>
                      </span>
                      {team.id === teamId && <Icon name="check" size={15} className="text-accent" />}
                    </button>
                  ))}
                  {teams.length === 0 && <p className="px-3 py-2 text-xs text-subtle">{t("nav.noTeam")}</p>}
                </div>
                <div className="border-t border-fg/[0.07] p-1.5">
                  <button
                    type="button"
                    onClick={() => goTo("settings")}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm hover:bg-fg/[0.05] ${view === "settings" ? "bg-accent/[0.08] font-semibold text-accent-text" : "text-fg-2"}`}
                  >
                    <Icon name="settings" size={16} /> {t("nav.settings")}
                  </button>
                </div>
              </div>
            </>
    );
  }

  function mainNav(mobile = false) {
    return navItems.map((item) => (
      <button key={item.id} type="button" onClick={() => goTo(item.id)} className={`relative ${topBtn(item.active)}`} title={item.badge ? t("upd.navBadge", { n: item.badge }) : undefined}>
        <Icon name={item.icon} size={17} />
        <span className={mobile ? "" : "hidden lg:inline"}>{item.label}</span>
        {!!item.badge && <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-black text-[#1a1203]">{item.badge}</span>}
      </button>
    ));
  }


  return (
    <div className="app-backdrop flex h-dvh flex-col text-fg">
      {/* Global navigation */}
      <header className="flex h-16 shrink-0 items-center gap-2 border-b border-fg/[0.07] bg-sidebar/95 px-3 backdrop-blur-xl sm:px-5">
        {isConversationView && <button type="button" onClick={() => setSideOpen((v) => !v)} title={t("nav.conversations")} className="icon-button md:hidden">
          <Icon name="menu" size={20} />
        </button>}
        <div className="mr-2 hidden sm:block"><Brand /></div>
        <div className="sm:hidden"><Brand compact /></div>
        <nav className="flex min-w-0 flex-1 items-center justify-center gap-1 overflow-x-auto">
          {mainNav()}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          {!isConversationView && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setTeamMenuOpen((v) => !v)}
                title={activeTeam?.name ? t("nav.changeTeam", { name: activeTeam.name }) : t("nav.pickTeam")}
                className="flex max-w-[180px] items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-sm font-semibold text-fg-2 hover:bg-hover hover:text-fg"
              >
                <span className="truncate">{activeTeam?.name ?? t("nav.pickTeam")}</span>
                <Icon name="chevron" size={14} className="shrink-0 text-subtle" />
              </button>
              {teamMenuOpen && teamMenuPanel("absolute right-0 top-11 w-64")}
            </div>
          )}
          <ThemeToggle />
          <div className="flex rounded-lg border border-fg/[0.07] bg-fg/[0.025] p-0.5 text-[10px] font-bold" title={t("settings.langTitle")}>
            {(["en", "id"] as const).map((l) => (
              <button
                key={l}
                type="button"
                disabled={langBusy}
                onClick={() => switchLang(l)}
                className={`rounded-md px-2 py-1.5 uppercase ${lang === l ? "bg-surface-2 text-accent-text" : "text-subtle hover:text-fg"} disabled:opacity-40`}
              >
                {l}
              </button>
            ))}
          </div>
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setUserMenuOpen((v) => !v)}
              title={user.email}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-fg/10 bg-surface-2 text-sm font-bold text-accent-text hover:border-accent/35 hover:bg-surface-2"
            >
              {(user.name || user.email || "?").slice(0, 1).toUpperCase()}
            </button>
            {userMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setUserMenuOpen(false)} />
                <div className="surface-raised absolute right-0 top-12 z-50 w-60 overflow-hidden rounded-xl">
                  <div className="border-b border-zinc-800 px-3 py-2">
                    <div className="truncate text-sm font-semibold text-zinc-100">{user.name || user.email}</div>
                    <div className="truncate text-[11px] text-zinc-500">{user.email}</div>
                  </div>
                  <div className="p-1">
                    <button
                      type="button"
                      onClick={logout}
                      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-fg-2 hover:bg-fg/[0.05] hover:text-red-300"
                    >
                      <Icon name="logout" size={16} /> {t("settings.logout")}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
      {/* Sidebar — workspace sections */}
      {sideOpen && (
        <div className="fixed inset-0 z-30 bg-black/60 md:hidden" onClick={() => setSideOpen(false)} />
      )}
      {isConversationView && (
      <aside className={`${sideOpen ? "fixed inset-y-0 left-0 z-40 flex w-[290px]" : "hidden"} shrink-0 flex-col border-r border-fg/[0.07] bg-sidebar md:static md:flex md:w-[264px]`}>
        <div className="relative border-b border-fg/[0.07] p-3">
          <button
            type="button"
            onClick={() => setTeamMenuOpen((v) => !v)}
            title={activeTeam?.name ? t("nav.changeTeam", { name: activeTeam.name }) : t("nav.pickTeam")}
            className="flex w-full items-center gap-3 rounded-xl border border-fg/[0.08] bg-fg/[0.025] p-2.5 text-left hover:border-fg/[0.14] hover:bg-fg/[0.045]"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-sm font-black text-accent-text">
              {(activeTeam?.name || "S").slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-bold text-fg">{activeTeam?.name ?? t("nav.pickTeam")}</span>
              <span className="mt-0.5 block text-[11px] capitalize text-subtle">{activeTeam?.role ?? t("shell.workspace")}</span>
            </span>
            <Icon name="chevron" size={16} className="text-subtle" />
          </button>
          {teamMenuOpen && teamMenuPanel("absolute left-3 right-3 top-[72px]")}
        </div>

        {isConversationView ? (
        <>
        <div className="flex items-center justify-between px-4 pb-1 pt-4">
          <div className="panel-title">{t("side.chat")}</div>
          <button type="button" onClick={() => goTo("settings")} title={t("nav.newBotTitle")} className="icon-button h-7 w-7">
            <Icon name="plus" size={15} />
          </button>
        </div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
          {topBots.flatMap((b) => [botRow(b, false), ...(childMap.get(b.id) ?? []).map((c) => botRow(c, true))])}
          {orphanBots.map((b) => botRow(b, false))}
          {activeBots.length === 0 && <p className="px-2 py-2 text-sm text-zinc-500">{t("side.noBots")}</p>}
          {archivedBots.length > 0 && (
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              className="mt-1 rounded-md px-2 py-1.5 text-left text-xs font-semibold text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
            >
              {showArchived ? `▾ ${t("side.archived")}` : `▸ ${t("side.archived")} (${archivedBots.length})`}
            </button>
          )}
          {showArchived &&
            archivedBots.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => openBot(b.id)}
                title={`${b.title || b.name} (${t("side.archived").toLowerCase()})`}
                className={`flex items-center gap-2.5 rounded-md px-2 py-2 text-left opacity-60 hover:bg-zinc-800 hover:opacity-100 ${b.id === botId ? "bg-zinc-800" : ""}`}
              >
                <BotAvatar bot={b} size="sm" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{b.name}</span>
                  <span className="block truncate text-xs text-zinc-500">{t("side.archived").toLowerCase()}</span>
                </span>
              </button>
            ))}
        </nav>
        <div className="flex items-center justify-between border-t border-zinc-800 px-4 pb-1 pt-3">
          <div className="text-xs font-bold uppercase tracking-wide text-zinc-500">{t("side.teammates")}</div>
        </div>
        <nav className="flex max-h-40 flex-col gap-1 overflow-y-auto p-2 pt-1">
          {teammates.map((tm) => {
            const n = unread[`dm:${teamId ?? ""}:${tm.id}`] || 0;
            return (
              <button
                key={tm.id}
                type="button"
                onClick={() => openDm(tm.id, tm.name)}
                title={t("dm.chatWith", { name: tm.name })}
                className={`flex items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-zinc-800 ${tm.id === dmPeer?.id && view === "dm" ? "bg-zinc-800" : ""}`}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-teal-800 text-sm font-bold text-teal-200">
                  {tm.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{tm.name}</span>
                {n > 0 && (
                  <span className="shrink-0 rounded-full bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold text-white">{n > 99 ? "99+" : n}</span>
                )}
              </button>
            );
          })}
          {teammates.length === 0 && <p className="px-2 pb-1 text-xs text-zinc-600">{t("side.noTeammates")}</p>}
        </nav>
        <div className="flex items-center justify-between border-t border-zinc-800 px-4 pb-1 pt-3">
          <div className="text-xs font-bold uppercase tracking-wide text-zinc-500">{t("side.groups")}</div>
          <button type="button" onClick={newGroup} title={t("chat.menuNewGroup")} className="rounded px-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
            {t("side.new")}
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
          {teamGroups.length === 0 && <p className="px-2 pb-1 text-xs text-zinc-600">{t("side.noGroups")}</p>}
        </nav>
        <div className="flex items-center justify-between border-t border-zinc-800 px-4 pb-1 pt-3">
          <div className="text-xs font-bold uppercase tracking-wide text-zinc-500">{t("side.meetings")}</div>
          <button type="button" onClick={() => openMeeting(null)} title={t("chat.menuNewMeeting")} className="rounded px-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
            {t("side.new")}
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
          {teamMeetings.length === 0 && <p className="px-2 pb-1 text-xs text-zinc-600">{t("side.noMeetings")}</p>}
        </nav>
        <div className="border-t border-zinc-800 px-4 pb-1 pt-3">
          <div className="text-xs font-bold uppercase tracking-wide text-zinc-500">{t("side.support")}</div>
          <div className="text-[11px] text-zinc-600">{t("side.supportHint")}</div>
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
          {supportGroups.length === 0 && <p className="px-2 pb-1 text-xs text-zinc-600">{t("side.noSupport")}</p>}
        </nav>
        </>
        ) : (
          <div className="flex flex-1 flex-col justify-between p-3">
            <div className="rounded-2xl border border-accent/15 bg-gradient-to-b from-accent/[0.07] to-transparent p-4">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/10 text-accent-text"><Icon name="spark" size={18} /></span>
              <h3 className="mt-4 text-sm font-bold leading-5 text-fg">{t("shell.ownershipTitle")}</h3>
              <p className="mt-2 text-xs leading-5 text-muted">{t("shell.ownershipBody")}</p>
              <div className="mt-4 border-t border-accent/10 pt-3 font-mono text-[10px] font-semibold text-accent">{t("shell.flow")}</div>
            </div>
            {view !== "market" && (
              <button type="button" onClick={() => goTo("market")} className="btn-secondary mt-3 w-full text-xs">
                <Icon name="market" size={15} /> {t("shell.browseMarket")}
              </button>
            )}
          </div>
        )}
      </aside>
      )}

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col bg-transparent">
        <header className="flex min-h-[76px] shrink-0 items-center justify-between gap-3 border-b border-fg/[0.07] bg-surface/70 px-4 py-3 backdrop-blur-sm md:px-6">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              {view === "bot" && bot && (
                <button type="button" onClick={() => goTo("chat")} title={t("top.backChat")} className="icon-button -ml-2 h-8 w-8">
                  <Icon name="arrow" size={16} className="rotate-180" />
                </button>
              )}
              <h1 className="page-heading truncate text-lg font-bold text-fg">{pageMeta.title}</h1>
              {view === "chat" && bot && (
                <button type="button" onClick={() => goTo("bot")} title={t("top.botSettings")} className="icon-button h-7 w-7">
                  <Icon name="settings" size={15} />
                </button>
              )}
            </div>
            <p className="mt-0.5 truncate text-xs text-subtle">{pageMeta.sub}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isConversationView && (
              <span className="soft-badge hidden border-accent/15 text-accent-text sm:inline-flex"><span className="h-1.5 w-1.5 rounded-full bg-accent" />{t("nav.online")}</span>
            )}
            {(view === "chat" || view === "bot") && (
              <button
                type="button"
                onClick={() => { if (voiceOn) stopSpeaking(); setVoiceOn((v) => !v); }}
                title={t("top.voiceTitle")}
                className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold ${voiceOn ? "border-accent/25 bg-accent/[0.06] text-accent-text" : "border-fg/10 text-subtle"}`}
              >
                {voiceOn ? t("top.voiceOn") : t("top.voiceOff")}
              </button>
            )}
          </div>
        </header>

        {view === "apps" ? (
          <main className="flex-1 overflow-y-auto">
            <AppsView
              teamId={teamId}
              teamName={activeTeam?.name}
              userName={user.name || user.email}
              botCount={activeBots.length}
              onOpenProject={(pid) => openProjectChannel(pid)}
              onGoMarket={() => goTo("market")}
              onGoChat={() => goTo("chat")}
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
                    onUserChanged={setUser}
            />
          </main>
        ) : view === "publish" ? (
          <main className="flex-1 overflow-y-auto">
            <PublishView teamId={teamId} teamRole={teams.find((t) => t.id === teamId)?.role ?? ""} onGoMarket={() => goTo("market")} />
          </main>
        ) : view === "market" ? (
          <main className="flex-1 overflow-y-auto">
            <MarketView
              teamId={teamId}
              onGoPublish={() => goTo("publish")}
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
              partnerName={bot.owner_user_id === user.id ? t("nav.you") : (memberNames[bot.owner_user_id] ?? t("common.teammate"))}
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
                  <h2 className="text-xl font-bold">{t("chat.hello", { name: user.name || user.email })}</h2>
                  <p className="mt-2 text-zinc-400">{t("chat.emptyBody")}</p>
                    <button type="button" onClick={() => newBot()} className="mt-4 rounded-md bg-emerald-600 px-4 py-2 font-semibold text-white hover:bg-emerald-500">
                    {t("chat.newBot")}
                  </button>
                </div>
              ) : (
                messages.length === 0 && (
                  <div className="mx-auto max-w-xl py-16">
                    <h2 className="text-xl font-bold">{t("chat.ready", { name: bot.name })}</h2>
                    <p className="mt-2 text-zinc-400">{t("chat.readyBody", { name: bot.name })}</p>
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
                        <span className="rounded-full border border-zinc-700 px-3 py-0.5 text-xs font-semibold text-zinc-300">{dayLabel(m.created_at, lang)}</span>
                        <div className="h-px flex-1 bg-zinc-800" />
                      </div>
                    )}
                <div className="group flex gap-3 rounded px-2 py-3 hover:bg-zinc-800/50">
                  <BotAvatar bot={bot ?? { id: "u", name: m.role === "user" ? (user.name || t("common.you")) : t("chat.assistantFallback"), title: "", model: "", memory: "", role: "", parent_id: "", pinned: 0, pinned_by: "", owner_user_id: "", relay: 1, user_id: "u", team_id: "", avatar_key: "", archived: 0, voice: "luna", active_days: "all", active_start: "", active_end: "", created_at: "", updated_at: "" } as SlaveBot} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-bold">{m.role === "user" ? (user.name || t("common.you")) : (bot?.name ?? t("chat.assistantFallback"))}</span>
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
                          title={t("chat.speakTitle")}
                          className="rounded px-1 text-xs text-zinc-500 hover:bg-zinc-700 hover:text-emerald-400"
                        >
                          {speakingKey === m.key ? t("chat.stop") : t("chat.speak")}
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
              <form onSubmit={send} className="mx-auto flex max-w-3xl items-end gap-1 rounded-[28px] border border-zinc-700 bg-surface-2 p-2 pl-2 shadow-lg focus-within:border-zinc-500">
                <div className="relative shrink-0">
                  <button
                    type="button"
                    onClick={() => setPlusOpen((v) => !v)}
                    title={t("chat.moreActions")}
                    className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100"
                  >
                    <PlusIcon />
                  </button>
                  {plusOpen && (
                    <>
                      <div className="fixed inset-0 z-30" onClick={() => setPlusOpen(false)} />
                      <div className="absolute bottom-11 left-0 z-40 w-52 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 py-1 shadow-xl">
                        <button type="button" onClick={() => { setPlusOpen(false); setView("settings"); }} className="block w-full px-4 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800">
                          {t("chat.menuNewBot")}
                        </button>
                        <button type="button" onClick={() => { setPlusOpen(false); newGroup(); }} className="block w-full px-4 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800">
                          {t("chat.menuNewGroup")}
                        </button>
                        <button type="button" onClick={() => { setPlusOpen(false); openMeeting(null); }} className="block w-full px-4 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800">
                          {t("chat.menuNewMeeting")}
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
                  placeholder={bot ? t("chat.inputPlaceholder", { name: bot.name }) : t("chat.pickAssistant")}
                  rows={1}
                  disabled={!bot}
                  className="max-h-40 flex-1 resize-none bg-transparent px-2 py-2 text-[15px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none disabled:opacity-40"
                />
                {conversing && (
                  <span title={t("chat.micLevel")} className="mx-1 flex h-8 w-1.5 shrink-0 self-center overflow-hidden rounded-full bg-zinc-700">
                    <span className="mt-auto w-full bg-emerald-500" style={{ height: `${Math.round(micLevel * 100)}%` }} />
                  </span>
                )}
                <button
                  type="button"
                  onClick={toggleMic}
                  disabled={streaming || transcribing || conversing || !bot}
                  title={recorder ? t("chat.micStop", { n: recSecs.toFixed(0) }) : t("chat.micDictate")}
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full hover:bg-zinc-700 disabled:opacity-40 ${recorder ? "text-red-400" : "text-zinc-300"}`}
                >
                  {recorder ? <span className="flex items-center gap-1 text-xs font-bold tabular-nums"><span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />{recSecs.toFixed(0)}</span> : transcribing ? <Spinner /> : <MicIcon />}
                </button>
                {input.trim() || streaming ? (
                  <button
                    type="submit"
                    disabled={!input.trim() || !bot || streaming}
                    title={t("chat.send")}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-700 disabled:text-zinc-500"
                  >
                    {streaming ? <Spinner /> : <ArrowUpIcon />}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={toggleConverse}
                    disabled={!bot || streaming || transcribing || !!recorder}
                    title={conversing ? t("chat.handsOff") : t("chat.handsOn")}
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

export default function App() {
  const [lang, setLangState] = useState<Lang>(() => (localStorage.getItem("slaver_lang") === "id" ? "id" : "en"));
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem("slaver_lang", l);
    } catch {
      /* ignore */
    }
  }, []);
  const value = useMemo(
    () => ({ lang, setLang, t: (key: StringsKey, vars?: Record<string, string | number>) => translate(lang, key, vars) }),
    [lang, setLang],
  );
  return (
    <LangProvider value={value}>
      <AppShell />
    </LangProvider>
  );
}
