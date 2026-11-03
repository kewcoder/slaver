export interface User {
  id: string;
  email: string;
  name: string;
  credit_usd: number;
}

export async function setTeamProvider(teamId: string, p: { preset: string; base_url?: string; api_key?: string }): Promise<TeamDetail["team"]> {
  const data = await request<{ team: TeamDetail["team"] }>(`/api/teams/${encodeURIComponent(teamId)}/provider`, {
    method: "PUT",
    body: JSON.stringify(p),
  });
  return data.team;
}

export async function clearTeamProvider(teamId: string): Promise<void> {
  await request(`/api/teams/${encodeURIComponent(teamId)}/provider`, { method: "DELETE" });
}

export interface ProviderInfo {
  provider: string;
  provider_label: string;
  key_hint: string;
  models: { id: string; label: string; default: boolean }[];
  custom_allowed: boolean;
  default: string;
}

export async function fetchProviderModels(teamId?: string): Promise<ProviderInfo> {
  const q = teamId ? `?team_id=${encodeURIComponent(teamId)}` : "";
  return request<ProviderInfo>(`/api/models${q}`);
}

export interface Team {
  id: string;
  name: string;
  owner_user_id: string;
  personal: number;
  role: string;
  provider: string;
  provider_base_url: string;
  provider_key_set: boolean;
  created_at: string;
}

export interface TeamMember {
  user_id: string;
  email: string | null;
  name: string | null;
  role: string;
  bot_ids: string[];
}

export interface TeamDetail {
  team: { id: string; name: string; owner_user_id: string; personal: number; provider: string; provider_base_url: string; provider_key_set: boolean; created_at: string };
  my_role: string;
  members: TeamMember[];
  bots: SlaveBot[];
}

export async function fetchTeams(): Promise<Team[]> {
  const data = await request<{ teams: Team[] }>("/api/teams");
  return data.teams;
}

export async function createTeam(name: string): Promise<Team> {
  const data = await request<{ team: Team }>("/api/teams", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return data.team;
}

export async function fetchTeamDetail(teamId: string): Promise<TeamDetail> {
  return request<TeamDetail>(`/api/teams/${encodeURIComponent(teamId)}`);
}

export const fetchTeam = fetchTeamDetail;

export async function deleteTeam(teamId: string): Promise<void> {
  await request(`/api/teams/${encodeURIComponent(teamId)}`, { method: "DELETE" });
}

export async function setMemberRole(teamId: string, userId: string, role: string): Promise<void> {
  await updateMember(teamId, userId, { role });
}

export async function setGrants(teamId: string, userId: string, bot_ids: string[]): Promise<void> {
  await updateMember(teamId, userId, { bot_ids });
}

export async function grantBotAccess(teamId: string, botId: string, userId: string, current: string[]): Promise<void> {
  await setGrants(teamId, userId, Array.from(new Set([...current, botId])));
}

export async function revokeBotAccess(teamId: string, botId: string, userId: string, current: string[]): Promise<void> {
  await setGrants(teamId, userId, current.filter((b) => b !== botId));
}

export async function inviteMember(teamId: string, email: string, role: string): Promise<void> {
  await request(`/api/teams/${encodeURIComponent(teamId)}/invites`, {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });
}

export async function removeMember(teamId: string, userId: string): Promise<void> {
  await request(`/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
}

export async function updateMember(teamId: string, userId: string, patch: { role?: string; bot_ids?: string[] }): Promise<void> {
  await request(`/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export interface SlaveBot {
  id: string;
  user_id: string;
  team_id: string;
  name: string;
  title: string;
  model: string;
  memory: string;
  role: string;
  parent_id: string;
  pinned: number;
  pinned_by: string;
  owner_user_id: string;
  relay: number;
  avatar_key: string;
  archived: number;
  voice: string;
  active_days: string;
  active_start: string;
  active_end: string;
  created_at: string;
  updated_at: string;
}

export interface BotSchedule {
  id: string;
  user_id: string;
  slavebot_id: string;
  name: string;
  kind: string;
  time_hhmm: string;
  days: string;
  interval_minutes: number;
  prompt: string;
  active: number;
  next_run_at: string;
  last_run_at: string;
  created_at: string;
}

export interface BotDetail {
  slavebot: SlaveBot;
  messages: { role: string; content: string; created_at: string }[];
}

export interface SummaryRow {
  id: number;
  period: string;
  period_key: string;
  content: string;
  created_at: string;
}

export interface Summaries {
  daily: SummaryRow[];
  weekly: SummaryRow[];
  monthly: SummaryRow[];
}

export interface UsageLog {
  id: number;
  slavebot_id: string | null;
  slavebot_name: string | null;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
  estimated: number;
  audio_seconds: number;
  created_at: string;
}

export interface Group {
  id: string;
  team_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface GroupMessage {
  id: number;
  slavebot_id: string | null;
  bot_name: string | null;
  role: string;
  content: string;
  created_at: string;
}

export interface GroupDetail {
  group: Group;
  members: SlaveBot[];
  messages: GroupMessage[];
}

export interface GroupReply {
  slavebot_id?: string;
  name?: string;
  reply?: string;
  error?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; estimated?: boolean };
  cost_usd?: number;
}

export async function fetchGroups(): Promise<Group[]> {
  const data = await request<{ groups: Group[] }>("/api/groups");
  return data.groups;
}

export async function createGroup(name: string, team_id?: string): Promise<Group> {
  const data = await request<{ group: Group }>("/api/groups", {
    method: "POST",
    body: JSON.stringify({ name, team_id }),
  });
  return data.group;
}

export async function fetchGroupDetail(groupId: string): Promise<GroupDetail> {
  return request<GroupDetail>(`/api/groups/${encodeURIComponent(groupId)}`);
}

export async function deleteGroup(groupId: string): Promise<void> {
  await request(`/api/groups/${encodeURIComponent(groupId)}`, { method: "DELETE" });
}

export async function addGroupMember(groupId: string, slavebotId: string): Promise<void> {
  await request(`/api/groups/${encodeURIComponent(groupId)}/members`, {
    method: "POST",
    body: JSON.stringify({ slavebot_id: slavebotId }),
  });
}

export async function removeGroupMember(groupId: string, slavebotId: string): Promise<void> {
  await request(
    `/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(slavebotId)}`,
    { method: "DELETE" },
  );
}

export async function groupChat(
  groupId: string,
  message: string,
  model?: string,
  saveMemory?: boolean,
): Promise<{ replies: GroupReply[]; total_cost_usd: number; credit_usd: number; saved_to_memory: string[] }> {
  return request(`/api/groups/${encodeURIComponent(groupId)}/chat`, {
    method: "POST",
    body: JSON.stringify({ message, model, save_memory: saveMemory }),
  });
}

export async function renameGroup(groupId: string, name: string): Promise<Group> {
  const data = await request<{ group: Group }>(`/api/groups/${encodeURIComponent(groupId)}`, {
    method: "PUT",
    body: JSON.stringify({ name }),
  });
  return data.group;
}

export async function broadcast(
  groupId: string,
  text: string,
  saveToMemory: boolean,
): Promise<{ posted: boolean; saved_to_memory: string[] }> {
  return request(`/api/groups/${encodeURIComponent(groupId)}/broadcast`, {
    method: "POST",
    body: JSON.stringify({ text, save_to_memory: saveToMemory }),
  });
}

export async function appendMemory(slavebotId: string, text: string): Promise<{ memory: string }> {
  return request(`/api/slavebots/${encodeURIComponent(slavebotId)}/memory`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export interface UsageSummary {
  credit_usd: number;
  spent_usd: number;
  logs: UsageLog[];
}

export interface ChatResult {
  slavebot_id: string;
  reply?: string;
  usage: { prompt_tokens: number; completion_tokens: number; estimated?: boolean };
  cost_usd: number;
  credit_usd: number;
}

const TOKEN_KEY = "slaver_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `Request failed (${res.status}).`);
  }
  return data as T;
}



export async function register(
  email: string,
  password: string,
  name: string,
): Promise<{ token: string; user: User }> {
  const data = await request<{ token: string; user: User }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, name }),
  });
  setToken(data.token);
  return data;
}

export async function login(email: string, password: string): Promise<{ token: string; user: User }> {
  const data = await request<{ token: string; user: User }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  setToken(data.token);
  return data;
}

export async function fetchMe(): Promise<User> {
  const data = await request<{ user: User }>("/api/me");
  return data.user;
}

export async function fetchBots(): Promise<SlaveBot[]> {
  const data = await request<{ slavebots: SlaveBot[] }>("/api/slavebots");
  return data.slavebots;
}

export async function createBot(model: string, team_id?: string, owner_user_id?: string): Promise<SlaveBot> {
  const data = await request<{ slavebot: SlaveBot }>("/api/slavebots", {
    method: "POST",
    body: JSON.stringify({ model, team_id, owner_user_id }),
  });
  return data.slavebot;
}

export async function transferBot(botId: string, owner_user_id: string): Promise<SlaveBot> {
  const data = await request<{ slavebot: SlaveBot }>(`/api/slavebots/${encodeURIComponent(botId)}/transfer`, {
    method: "POST",
    body: JSON.stringify({ owner_user_id }),
  });
  return data.slavebot;
}

export interface SendAsResult {
  reply: string;
  from_bot_id: string;
  to_bot_id: string;
  cost_usd: number;
}

export async function sendAsBot(fromId: string, to_bot_id: string, message: string): Promise<SendAsResult> {
  return request<SendAsResult>(`/api/slavebots/${encodeURIComponent(fromId)}/send`, {
    method: "POST",
    body: JSON.stringify({ to_bot_id, message }),
  });
}

export interface ActivityItem {
  slavebot_id: string;
  bot_name: string;
  role: string;
  content: string;
  created_at: string;
}

export async function fetchTeamActivity(teamId: string): Promise<ActivityItem[]> {
  const data = await request<{ activity: ActivityItem[] }>(`/api/teams/${encodeURIComponent(teamId)}/activity`);
  return data.activity;
}

export async function fetchBotDetail(botId: string): Promise<BotDetail> {
  return request<BotDetail>(`/api/slavebots/${encodeURIComponent(botId)}`);
}

export async function updateBot(
  botId: string,
  patch: {
    name?: string;
    memory?: string;
    role?: string;
    pinned?: boolean;
    model?: string;
    voice?: string;
    archived?: boolean;
    active_days?: string;
    active_start?: string;
    active_end?: string;
    relay?: boolean;
  },
): Promise<SlaveBot> {
  const data = await request<{ slavebot: SlaveBot }>(
    `/api/slavebots/${encodeURIComponent(botId)}`,
    { method: "PUT", body: JSON.stringify(patch) },
  );
  return data.slavebot;
}

export async function fetchUsage(): Promise<UsageSummary> {
  return request<UsageSummary>("/api/usage");
}

export async function spawnSubBot(
  managerId: string,
  sub: { name?: string; role?: string; model?: string },
): Promise<SlaveBot> {
  const data = await request<{ slavebot: SlaveBot }>(
    `/api/slavebots/${encodeURIComponent(managerId)}/spawn`,
    { method: "POST", body: JSON.stringify(sub) },
  );
  return data.slavebot;
}

export async function fetchChildren(managerId: string): Promise<SlaveBot[]> {
  const data = await request<{ slavebots: SlaveBot[] }>(
    `/api/slavebots/${encodeURIComponent(managerId)}/children`,
  );
  return data.slavebots;
}

export interface Huddle {
  id: string;
  user_id: string;
  team_id: string;
  topic: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface HuddleParticipant {
  huddle_id: string;
  slavebot_id: string;
  bot_name: string | null;
  decision: string;
  reason: string;
  created_at: string;
}

export interface HuddleMessage {
  id: number;
  huddle_id: string;
  slavebot_id: string | null;
  bot_name: string | null;
  role: string;
  content: string;
  created_at: string;
}

export interface HuddleDetail {
  huddle: Huddle;
  participants: HuddleParticipant[];
  messages: HuddleMessage[];
}

export async function fetchHuddles(): Promise<Huddle[]> {
  const data = await request<{ huddles: Huddle[] }>("/api/huddles");
  return data.huddles;
}

export async function createHuddle(topic: string, slavebot_ids?: string[], team_id?: string): Promise<HuddleDetail> {
  return request<HuddleDetail>("/api/huddles", {
    method: "POST",
    body: JSON.stringify({ topic, slavebot_ids, team_id }),
  });
}

export async function fetchHuddleDetail(huddleId: string): Promise<HuddleDetail> {
  return request<HuddleDetail>(`/api/huddles/${encodeURIComponent(huddleId)}`);
}

export async function deleteHuddle(huddleId: string): Promise<void> {
  await request(`/api/huddles/${encodeURIComponent(huddleId)}`, { method: "DELETE" });
}

export async function huddleChat(
  huddleId: string,
  message: string,
  model?: string,
): Promise<{ replies: GroupReply[]; total_cost_usd: number; credit_usd: number }> {
  return request(`/api/huddles/${encodeURIComponent(huddleId)}/chat`, {
    method: "POST",
    body: JSON.stringify({ message, model }),
  });
}

export async function fetchSummaries(botId: string): Promise<Summaries> {
  return request<Summaries>(`/api/summaries?slavebot_id=${encodeURIComponent(botId)}`);
}

export async function runSummary(botId: string): Promise<{ summary: SummaryRow | null; note?: string }> {
  return request("/api/summaries/run", {
    method: "POST",
    body: JSON.stringify({ slavebot_id: botId }),
  });
}

export async function uploadAvatar(botId: string, file: File): Promise<void> {
  const token = getToken();
  const form = new FormData();
  form.append("avatar", file);
  const res = await fetch(`/api/slavebots/${encodeURIComponent(botId)}/avatar`, {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `Avatar upload failed (${res.status}).`);
  }
}

export function avatarUrl(botId: string): string {
  return `/api/slavebots/${encodeURIComponent(botId)}/avatar`;
}

export interface StreamHandlers {
  onToken: (delta: string) => void;
  onUsage?: (usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  }) => void;
  signal: AbortSignal;
}

/** POST /api/chat with stream:true. Resolves with the bot id (X-Chat-Id). */
export async function streamChat(
  botId: string,
  message: string,
  model: string,
  handlers: StreamHandlers,
): Promise<string> {
  const token = getToken();
  const res = await fetch("/api/chat", {
    method: "POST",
    signal: handlers.signal,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ slavebot_id: botId, message, model, stream: true }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Chat failed (${res.status}).`);
  }
  if (!res.body) throw new Error("This browser does not support streaming responses.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const text = line.replace(/^data:\s?/, "");
        if (text === "" || text === "[DONE]") continue;
        try {
          const evt = JSON.parse(text) as {
            choices?: { delta?: { content?: string } }[];
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              total_tokens?: number;
            };
          };
          const delta = evt.choices?.[0]?.delta?.content ?? "";
          if (delta) handlers.onToken(delta);
          if (evt.usage) handlers.onUsage?.(evt.usage);
        } catch {
          // Ignore non-JSON frames (e.g. keep-alive comments).
        }
      }
    }
  }
  return res.headers.get("X-Chat-Id") ?? "";
}

/** Non-streaming chat: single call, reply + cost inline. */
export async function plainChat(
  botId: string,
  message: string,
  model: string,
): Promise<ChatResult> {
  return request<ChatResult>("/api/chat", {
    method: "POST",
    body: JSON.stringify({ slavebot_id: botId, message, model, stream: false }),
  });
}

/** Called after an SSE stream ends: persists the reply, logs usage, deducts credit. */
export async function finishChat(
  botId: string,
  content: string,
  usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null,
): Promise<ChatResult> {
  return request<ChatResult>("/api/chat/finish", {
    method: "POST",
    body: JSON.stringify({ slavebot_id: botId, content, usage }),
  });
}

export interface TranscribeResult {
  transcript: string;
  audio_seconds: number;
  estimated?: boolean;
  cost_usd: number;
  credit_usd: number;
}

export async function fetchSchedules(botId: string): Promise<BotSchedule[]> {
  const data = await request<{ schedules: BotSchedule[] }>(
    `/api/slavebots/${encodeURIComponent(botId)}/schedules`,
  );
  return data.schedules;
}

export async function createSchedule(
  botId: string,
  schedule: {
    name?: string;
    kind: string;
    time_hhmm?: string;
    days?: string;
    interval_minutes?: number;
    prompt: string;
  },
): Promise<BotSchedule> {
  const data = await request<{ schedule: BotSchedule }>(
    `/api/slavebots/${encodeURIComponent(botId)}/schedules`,
    { method: "POST", body: JSON.stringify(schedule) },
  );
  return data.schedule;
}

export async function updateSchedule(scheduleId: string, active: boolean): Promise<BotSchedule> {
  const data = await request<{ schedule: BotSchedule }>(
    `/api/schedules/${encodeURIComponent(scheduleId)}`,
    { method: "PUT", body: JSON.stringify({ active }) },
  );
  return data.schedule;
}

export async function deleteSchedule(scheduleId: string): Promise<void> {
  await request(`/api/schedules/${encodeURIComponent(scheduleId)}`, { method: "DELETE" });
}

export interface SpeakResult {
  audio: Blob;
  cost_usd: number;
  credit_usd: number;
}

/** POST /api/voice/speak — server voice (Workers AI Aura). Falls back to browser voice on 501. */
export async function speakVoice(text: string, voice: string): Promise<SpeakResult> {
  const token = getToken();
  const res = await fetch("/api/voice/speak", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ text: text.slice(0, 2000), voice }),
  });
  if (res.status === 501) {
    throw new Error("SERVER_VOICE_UNCONFIGURED");
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Voice failed (${res.status}).`);
  }
  const audio = await res.blob();
  return {
    audio,
    cost_usd: Number(res.headers.get("X-TTS-Cost-Usd") ?? 0),
    credit_usd: Number(res.headers.get("X-TTS-Credit-Usd") ?? 0),
  };
}

/** POST /api/voice/transcribe — multipart upload of a WAV clip. */
export async function transcribeVoice(audio: Blob, teamId?: string): Promise<TranscribeResult> {
  const token = getToken();
  const form = new FormData();
  form.append("audio", audio, "audio.wav");
  if (teamId) form.append("team_id", teamId);
  const res = await fetch("/api/voice/transcribe", {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as TranscribeResult & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `Transcription failed (${res.status}).`);
  }
  return data;
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(n < 0.01 && n > 0 ? 6 : 4)}`;
}
