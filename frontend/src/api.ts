/// Single-endpoint MCP client: every app action is a JSON-RPC `tools/call`
/// against POST /mcp. No other API endpoints exist.

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface ProviderInfo {
  provider: string;
  provider_label: string;
  key_hint: string;
  models: { id: string; label: string; default: boolean }[];
  custom_allowed: boolean;
  default: string;
  example_models?: string;
  default_base?: string;
}

export interface ProviderTest {
  ok: boolean;
  error?: string;
  endpoint?: string;
  model?: string;
  models?: string[];
  notes?: string[];
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

export interface Group {
  id: string;
  team_id: string;
  name: string;
  is_public?: number;
  repo_id?: string;
  project_id?: string;
  created_at: string;
  updated_at: string;
}

export interface PublicGroup {
  id: string;
  team_id: string;
  team_name: string;
  name: string;
  repo_id: string;
  created_at: string;
}

export async function fetchPublicGroups(): Promise<PublicGroup[]> {
  const data = await callTool<{ groups: PublicGroup[] }>("groups_public", {});
  return data.groups;
}

export async function setGroupVisibility(groupId: string, isPublic: boolean): Promise<Group> {
  const data = await callTool<{ group: Group }>("groups_set_visibility", { group_id: groupId, public: isPublic });
  return data.group;
}

export async function fetchSupportGroup(repoId: string): Promise<Group> {
  const data = await callTool<{ group: Group }>("groups_support", { repo_id: repoId });
  return data.group;
}

export interface OAuthClient {
  id: string;
  team_id: string;
  name: string;
  redirect_uris: string;
  created_at: string;
}

export async function createOAuthClient(teamId: string, name: string, redirectUris: string): Promise<{ client: OAuthClient; client_secret: string }> {
  return callTool("oauth_clients_create", { team_id: teamId, name, redirect_uris: redirectUris });
}

export async function fetchOAuthClients(teamId: string): Promise<OAuthClient[]> {
  const data = await callTool<{ clients: OAuthClient[] }>("oauth_clients_list", { team_id: teamId });
  return data.clients;
}

export async function revokeOAuthClient(teamId: string, clientId: string): Promise<void> {
  await callTool("oauth_clients_revoke", { team_id: teamId, client_id: clientId });
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

export interface ChatResult {
  slavebot_id: string;
  reply?: string;
  usage: { prompt_tokens: number; completion_tokens: number; estimated?: boolean };
  cost_usd: number;
}

export interface SendAsResult {
  reply: string;
  from_bot_id: string;
  to_bot_id: string;
  cost_usd: number;
}

export interface ActivityItem {
  slavebot_id: string;
  bot_name: string;
  role: string;
  content: string;
  created_at: string;
}

export interface Meeting {
  id: string;
  user_id: string;
  team_id: string;
  topic: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface MeetingParticipant {
  meeting_id: string;
  slavebot_id: string;
  bot_name: string | null;
  decision: string;
  reason: string;
  created_at: string;
}

export interface MeetingMessage {
  id: number;
  meeting_id: string;
  slavebot_id: string | null;
  bot_name: string | null;
  role: string;
  content: string;
  created_at: string;
}

export interface MeetingDetail {
  meeting: Meeting;
  participants: MeetingParticipant[];
  messages: MeetingMessage[];
}

export interface TranscribeResult {
  transcript: string;
  audio_seconds: number;
  estimated?: boolean;
  cost_usd: number;
}

export interface SpeakResult {
  audio: Blob;
  cost_usd: number;
}

const TOKEN_KEY = "slaver_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

let rpcId = 0;

interface RpcEnvelope {
  result?: { content?: { type: string; text?: string }[]; data?: unknown };
  error?: { code?: number; message?: string } | string;
}

/** Call one MCP tool and return its `data` payload (or {} when data-less). */
async function callTool<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
  const token = getToken();
  const res = await fetch("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const data = (await res.json().catch(() => ({}))) as RpcEnvelope;
  if (!res.ok) {
    throw new Error(typeof data.error === "string" ? data.error : `Request failed (${res.status}).`);
  }
  if (typeof data.error === "string") {
    throw new Error(data.error);
  }
  if (data.error && typeof data.error === "object") {
    throw new Error(data.error.message ?? "MCP call failed.");
  }
  return ((data.result?.data ?? {}) as T);
}

// ---------- auth ----------

export async function register(
  email: string,
  password: string,
  name: string,
): Promise<{ token: string; user: User }> {
  const data = await callTool<{ token: string; user: User }>("auth_register", { email, password, name });
  setToken(data.token);
  return data;
}

export async function login(email: string, password: string): Promise<{ token: string; user: User }> {
  const data = await callTool<{ token: string; user: User }>("auth_login", { email, password });
  setToken(data.token);
  return data;
}

export async function fetchMe(): Promise<User> {
  const data = await callTool<{ user: User }>("auth_me");
  return data.user;
}

// ---------- models / provider ----------

export async function fetchProviderModels(teamId?: string): Promise<ProviderInfo> {
  const args: Record<string, unknown> = {};
  if (teamId) args.team_id = teamId;
  return callTool<ProviderInfo>("models", args);
}

export async function setTeamProvider(teamId: string, p: { preset: string; base_url?: string; api_key?: string }): Promise<TeamDetail["team"]> {
  const data = await callTool<TeamDetail>("teams_set_provider", {
    team_id: teamId,
    preset: p.preset,
    base_url: p.base_url ?? "",
    api_key: p.api_key ?? "",
  });
  return data.team;
}

export async function clearTeamProvider(teamId: string): Promise<void> {
  await callTool("teams_clear_provider", { team_id: teamId });
}

export async function testTeamProvider(teamId: string, model?: string): Promise<ProviderTest> {
  const data = await callTool<ProviderTest>("teams_test_provider", {
    team_id: teamId,
    ...(model?.trim() ? { model: model.trim() } : {}),
  });
  return data;
}

// ---------- teams ----------

export async function fetchTeams(): Promise<Team[]> {
  const data = await callTool<{ teams: Team[] }>("team_list");
  return data.teams;
}

export async function createTeam(name: string): Promise<Team> {
  const data = await callTool<{ team: Team }>("team_create", { name });
  return data.team;
}

export const fetchTeam = fetchTeamDetail;

export async function fetchTeamDetail(teamId: string): Promise<TeamDetail> {
  return callTool<TeamDetail>("teams_get", { team_id: teamId });
}

export async function deleteTeam(teamId: string): Promise<void> {
  await callTool("teams_delete", { team_id: teamId });
}

export async function updateMember(teamId: string, userId: string, patch: { role?: string; bot_ids?: string[] }): Promise<void> {
  const args: Record<string, unknown> = { team_id: teamId, user_id: userId };
  if (patch.role !== undefined) args.role = patch.role;
  if (patch.bot_ids !== undefined) args.bot_ids = patch.bot_ids;
  await callTool("teams_set_member", args);
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
  await callTool("team_invite", { team_id: teamId, email, role });
}

export async function removeMember(teamId: string, userId: string): Promise<void> {
  await callTool("teams_remove_member", { team_id: teamId, user_id: userId });
}

export async function fetchTeamActivity(teamId: string): Promise<ActivityItem[]> {
  const data = await callTool<{ activity: ActivityItem[] }>("teams_activity", { team_id: teamId });
  return data.activity;
}

// ---------- slaveBots ----------

export async function fetchBots(): Promise<SlaveBot[]> {
  const data = await callTool<{ slavebots: SlaveBot[] }>("bots_list");
  return data.slavebots;
}

export async function createBot(model: string, team_id?: string, owner_user_id?: string): Promise<SlaveBot> {
  const args: Record<string, unknown> = {};
  if (model) args.model = model;
  if (team_id) args.team_id = team_id;
  if (owner_user_id) args.owner_user_id = owner_user_id;
  const data = await callTool<{ slavebot: SlaveBot }>("bots_create", args);
  return data.slavebot;
}

export async function fetchBotDetail(botId: string): Promise<BotDetail> {
  return callTool<BotDetail>("bots_get", { slavebot_id: botId });
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
  const data = await callTool<{ slavebot: SlaveBot }>("bots_update", { slavebot_id: botId, ...patch });
  return data.slavebot;
}

export async function transferBot(botId: string, owner_user_id: string): Promise<SlaveBot> {
  const data = await callTool<{ slavebot: SlaveBot }>("bots_transfer", { slavebot_id: botId, owner_user_id });
  return data.slavebot;
}

export async function sendAsBot(fromId: string, to_bot_id: string, message: string): Promise<SendAsResult> {
  return callTool<SendAsResult>("bot_send", { from_bot_id: fromId, to_bot_id, message });
}

export async function appendMemory(slavebotId: string, text: string): Promise<{ memory: string }> {
  const data = await callTool<{ slavebot: SlaveBot }>("bots_append_memory", { slavebot_id: slavebotId, text });
  return { memory: data.slavebot.memory };
}

export async function spawnSubBot(
  managerId: string,
  sub: { name?: string; role?: string; model?: string },
): Promise<SlaveBot> {
  const data = await callTool<{ slavebot: SlaveBot }>("bot_spawn", { manager_id: managerId, ...sub });
  return data.slavebot;
}

export async function fetchChildren(managerId: string): Promise<SlaveBot[]> {
  const data = await callTool<{ children: SlaveBot[] }>("bots_children", { slavebot_id: managerId });
  return data.children;
}

// ---------- avatars (data URLs, no REST) ----------

const avatarCache = new Map<string, string | null>();

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read avatar."));
    reader.readAsDataURL(blob);
  });
}

export async function uploadAvatar(botId: string, file: File): Promise<void> {
  const dataUrl = await blobToDataUrl(file);
  const image_base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
  avatarCache.delete(botId);
  await callTool("bots_set_avatar", { slavebot_id: botId, image_base64, content_type: file.type || "image/png" });
}

/** Data URL for a bot avatar (cached per bot id), or null when none is set. */
export async function fetchAvatar(botId: string): Promise<string | null> {
  const cached = avatarCache.get(botId);
  if (cached !== undefined) return cached;
  try {
    const data = await callTool<{ data_url?: string }>("bots_get_avatar", { slavebot_id: botId });
    const url = data.data_url ?? null;
    avatarCache.set(botId, url);
    return url;
  } catch {
    avatarCache.set(botId, null);
    return null;
  }
}

// ---------- chat (non-streaming; the assistant bubble shows a typing indicator) ----------

export async function sendChat(botId: string, message: string, model?: string): Promise<ChatResult> {
  const args: Record<string, unknown> = { slavebot_id: botId, message };
  if (model) args.model = model;
  return callTool<ChatResult>("chat_send", args);
}

// ---------- groups ----------

export async function fetchGroups(): Promise<Group[]> {
  const data = await callTool<{ groups: Group[] }>("groups_list");
  return data.groups;
}

export async function createGroup(name: string, team_id?: string): Promise<Group> {
  const args: Record<string, unknown> = { name };
  if (team_id) args.team_id = team_id;
  const data = await callTool<{ group: Group }>("groups_create", args);
  return data.group;
}

export async function fetchGroupDetail(groupId: string): Promise<GroupDetail> {
  return callTool<GroupDetail>("groups_get", { group_id: groupId });
}

export async function deleteGroup(groupId: string): Promise<void> {
  await callTool("groups_delete", { group_id: groupId });
}

export async function addGroupMembers(groupId: string, slavebotIds: string[]): Promise<string[]> {
  const data = await callTool<{ added: string[] }>("groups_add_member", { group_id: groupId, slavebot_ids: slavebotIds });
  return data.added;
}

export async function removeGroupMember(groupId: string, slavebotId: string): Promise<void> {
  await callTool("groups_remove_member", { group_id: groupId, slavebot_id: slavebotId });
}

export async function groupChat(
  groupId: string,
  message: string,
  model?: string,
  saveMemory?: boolean,
): Promise<{ replies: GroupReply[]; total_cost_usd: number; saved_to_memory: string[] }> {
  const args: Record<string, unknown> = { group_id: groupId, message };
  if (model) args.model = model;
  if (saveMemory !== undefined) args.save_memory = saveMemory;
  return callTool("groups_chat", args);
}

export async function renameGroup(groupId: string, name: string): Promise<Group> {
  const data = await callTool<{ group: Group }>("groups_rename", { group_id: groupId, name });
  return data.group;
}

export async function broadcast(
  groupId: string,
  text: string,
  saveToMemory: boolean,
): Promise<{ posted: boolean; saved_to_memory: string[] }> {
  return callTool("groups_broadcast", { group_id: groupId, text, save_to_memory: saveToMemory });
}

// ---------- meetings ----------

export async function fetchMeetings(): Promise<Meeting[]> {
  const data = await callTool<{ meetings: Meeting[] }>("meeting_list");
  return data.meetings;
}

export async function createMeeting(topic: string, slavebot_ids?: string[], team_id?: string): Promise<MeetingDetail> {
  const args: Record<string, unknown> = { topic };
  if (slavebot_ids) args.slavebot_ids = slavebot_ids;
  if (team_id) args.team_id = team_id;
  return callTool<MeetingDetail>("meeting_start", args);
}

export async function fetchMeetingDetail(meetingId: string): Promise<MeetingDetail> {
  return callTool<MeetingDetail>("meeting_get", { meeting_id: meetingId });
}

export async function deleteMeeting(meetingId: string): Promise<void> {
  await callTool("meeting_delete", { meeting_id: meetingId });
}

export async function meetingChat(
  meetingId: string,
  message: string,
): Promise<{ replies: GroupReply[]; total_cost_usd: number }> {
  return callTool("meeting_chat", { meeting_id: meetingId, message });
}

// ---------- summaries ----------

export async function fetchSummaries(botId: string): Promise<Summaries> {
  return callTool<Summaries>("summaries_get", { slavebot_id: botId });
}

export async function runSummary(botId: string): Promise<{ summary: SummaryRow | null; note?: string }> {
  return callTool("summaries_run", { slavebot_id: botId });
}

// ---------- schedules ----------

export async function fetchSchedules(botId: string): Promise<BotSchedule[]> {
  const data = await callTool<{ schedules: BotSchedule[] }>("schedule_list", { slavebot_id: botId });
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
  const data = await callTool<{ schedule: BotSchedule }>("schedule_create", { slavebot_id: botId, ...schedule });
  return data.schedule;
}

export async function updateSchedule(scheduleId: string, active: boolean): Promise<BotSchedule> {
  const data = await callTool<{ schedule: BotSchedule }>("schedules_update", { schedule_id: scheduleId, active });
  return data.schedule;
}

export async function deleteSchedule(scheduleId: string): Promise<void> {
  await callTool("schedule_delete", { schedule_id: scheduleId });
}

// ---------- voice (base64 over MCP) ----------

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      resolve(url.includes(",") ? url.slice(url.indexOf(",") + 1) : url);
    };
    reader.onerror = () => reject(new Error("Could not read audio."));
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(b64: string, contentType: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: contentType });
}

export async function transcribeVoice(audio: Blob, teamId?: string): Promise<TranscribeResult> {
  const audio_base64 = await blobToBase64(audio);
  const args: Record<string, unknown> = { audio_base64 };
  if (teamId) args.team_id = teamId;
  return callTool<TranscribeResult>("voice_transcribe", args);
}

/** Server voice (Workers AI Aura). Throws when unconfigured so callers can fall back to browser voice. */
export async function speakVoice(text: string, voice: string): Promise<SpeakResult> {
  const data = await callTool<{ audio_base64: string; content_type?: string; cost_usd: number }>(
    "voice_speak",
    { text: text.slice(0, 2000), voice },
  );
  return {
    audio: base64ToBlob(data.audio_base64, data.content_type || "audio/mpeg"),
    cost_usd: data.cost_usd,
  };
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(n < 0.01 && n > 0 ? 6 : 4)}`;
}

// ---------- platform: projects, kanban, git, marketplace, vps ----------

export interface Project {
  id: string;
  team_id: string;
  repo_id: string;
  name: string;
  description: string;
  status: string;
  prod_url: string;
  dev_url: string;
  created_at: string;
}

export interface ProjectStats {
  total: number;
  done: number;
  in_progress: number;
}

export interface Issue {
  id: string;
  project_id: string;
  title: string;
  body: string;
  state: string;
  assignee_bot_id: string;
  assignee_name: string | null;
  priority: string;
  labels: string;
  created_at: string;
  updated_at: string;
}

export interface Repo {
  id: string;
  team_id: string;
  name: string;
  description: string;
  price_cents?: number;
  template: number;
  fork_of: string;
  created_at: string;
}

export interface Checkout {
  payment_id: string;
  hitpay_request_id: string;
  checkout_url: string;
  redirect_url: string;
  amount_cents: number;
  currency: string;
  sandbox: boolean;
  mock?: boolean;
  license?: License;
  repo?: Repo;
  project?: Project;
}

export async function checkoutLicense(teamId: string, repoId: string): Promise<Checkout & { license?: License; repo?: Repo; project?: Project }> {
  const data = await callTool<{ license?: License; repo?: Repo; project?: Project } & Checkout>("licenses_checkout", { team_id: teamId, repo_id: repoId });
  return data as Checkout & { license?: License; repo?: Repo; project?: Project };
}

export async function activateLicense(paymentId: string): Promise<{ license: License; repo: Repo; project: Project }> {
  const data = await callTool<{ license: License; repo: Repo; project: Project }>("licenses_activate", { payment_id: paymentId });
  return data;
}

export async function fetchPaymentStatus(paymentId: string): Promise<{ payment: Payment; hitpay_status: string }> {
  const data = await callTool<{ payment: Payment; hitpay_status: string }>("payments_status", { payment_id: paymentId });
  return data;
}

export interface Payment {
  id: string;
  team_id: string;
  repo_id: string;
  hitpay_request_id: string;
  amount_cents: number;
  currency: string;
  status: string;
  license_id: string;
  created_at: string;
  paid_at: string;
}

export interface License {
  id: string;
  team_id: string;
  repo_id: string;
  kind: string;
  support_until: string;
  status: string;
  provider: string;
  amount_cents: number;
  created_at: string;
}

export interface VpsTarget {
  id: string;
  team_id: string;
  name: string;
  host: string;
  ssh_user: string;
  created_at: string;
}

export interface Deployment {
  id: string;
  project_id: string;
  vps_target_id: string;
  commit_sha: string;
  status: string;
  log: string;
  created_at: string;
}

export async function createProject(teamId: string, name: string, description?: string): Promise<Project> {
  const data = await callTool<{ project: Project }>("projects_create", { team_id: teamId, name, description: description ?? "" });
  return data.project;
}

export async function fetchProjects(teamId: string): Promise<{ project: Project; stats: ProjectStats }[]> {
  const data = await callTool<{ projects: { project: Project; stats: ProjectStats }[] }>("projects_list", { team_id: teamId });
  return data.projects;
}

export async function setProjectRepo(projectId: string, repoId: string): Promise<Project> {
  const data = await callTool<{ project: Project }>("project_set_repo", { project_id: projectId, repo_id: repoId });
  return data.project;
}

export async function setProjectUrls(projectId: string, urls: { prod_url?: string; dev_url?: string }): Promise<Project> {
  const data = await callTool<{ project: Project }>("projects_set_urls", { project_id: projectId, ...urls });
  return data.project;
}

export async function fetchProject(projectId: string): Promise<Project> {
  const data = await callTool<{ project: Project }>("projects_get", { project_id: projectId });
  return data.project;
}

export async function setGroupProject(groupId: string, projectId: string): Promise<Group> {
  const data = await callTool<{ group: Group }>("groups_set_project", { group_id: groupId, project_id: projectId });
  return data.group;
}

export async function createIssue(projectId: string, title: string, body?: string, assigneeBotId?: string): Promise<Issue> {
  const data = await callTool<{ issue: Issue }>("issues_create", { project_id: projectId, title, body: body ?? "", assignee_bot_id: assigneeBotId ?? "" });
  return data.issue;
}

export async function fetchIssues(projectId: string): Promise<Issue[]> {
  const data = await callTool<{ issues: Issue[] }>("issues_list", { project_id: projectId });
  return data.issues;
}

export async function moveIssue(issueId: string, state: string): Promise<Issue> {
  const data = await callTool<{ issue: Issue }>("issues_move", { issue_id: issueId, state });
  return data.issue;
}

export async function assignIssue(issueId: string, botId: string): Promise<Issue> {
  const data = await callTool<{ issue: Issue }>("issues_assign", { issue_id: issueId, bot_id: botId });
  return data.issue;
}

export async function updateIssue(issueId: string, patch: { title?: string; body?: string; priority?: string; labels?: string }): Promise<Issue> {
  const data = await callTool<{ issue: Issue }>("issues_update", { issue_id: issueId, ...patch });
  return data.issue;
}

export async function createRepo(teamId: string, name: string, description?: string): Promise<{ repo: Repo; clone_url: string }> {
  return callTool("repos_create", { team_id: teamId, name, description: description ?? "" });
}

export async function fetchRepos(teamId: string): Promise<Repo[]> {
  const data = await callTool<{ repos: Repo[] }>("repos_list", { team_id: teamId });
  return data.repos;
}

export async function fetchTemplates(): Promise<Repo[]> {
  const data = await callTool<{ repos: Repo[] }>("repos_templates", {});
  return data.repos;
}

export async function fetchRepoDetail(repoId: string): Promise<{ repo: Repo; branches: string[]; log: { sha: string; author: string; email: string; date: string; subject: string }[]; clone_url: string }> {
  return callTool("repos_get", { repo_id: repoId });
}

export async function fetchRepoDiff(repoId: string, commit?: string): Promise<string> {
  const data = await callTool<{ diff: string }>("repos_diff", { repo_id: repoId, commit: commit ?? "" });
  return data.diff;
}

export async function forkRepo(repoId: string, teamId: string): Promise<Repo> {
  const data = await callTool<{ repo: Repo }>("repos_fork", { repo_id: repoId, team_id: teamId });
  return data.repo;
}

export async function publishRepo(repoId: string, template: boolean): Promise<void> {
  await callTool("repos_publish", { repo_id: repoId, template });
}

export async function buyLicense(teamId: string, repoId: string): Promise<{ license: License; repo: Repo; project: Project }> {
  return callTool("licenses_buy", { team_id: teamId, repo_id: repoId, provider: "mock" });
}

export async function fetchLicenses(teamId: string): Promise<License[]> {
  const data = await callTool<{ licenses: License[] }>("licenses_list", { team_id: teamId });
  return data.licenses;
}

export async function addVps(teamId: string, v: { name: string; host: string; ssh_user: string; ssh_key: string }): Promise<VpsTarget> {
  const data = await callTool<{ vps: VpsTarget }>("vps_add", { team_id: teamId, ...v });
  return data.vps;
}

export async function fetchVpsList(teamId: string): Promise<VpsTarget[]> {
  const data = await callTool<{ vps: VpsTarget[] }>("vps_list", { team_id: teamId });
  return data.vps;
}

export async function startDeploy(projectId: string, vpsId: string): Promise<Deployment> {
  const data = await callTool<{ deployment: Deployment }>("deploy_start", { project_id: projectId, vps_id: vpsId });
  return data.deployment;
}

export interface TeamTemplateAgent { name: string; role: string; memory: string; }
export interface TeamTemplate { key: string; category: string; name: string; description: string; team_name: string; agents: TeamTemplateAgent[]; }

export async function fetchTeamTemplates(): Promise<TeamTemplate[]> {
  const data = await callTool<{ templates: TeamTemplate[] }>("templates_list", {});
  return data.templates;
}

export async function applyTeamTemplate(templateKey: string, teamName?: string): Promise<{ team: Team; bots: SlaveBot[] }> {
  return callTool("templates_apply", { template_key: templateKey, team_name: teamName ?? "" });
}

export async function fetchDeployments(projectId: string): Promise<Deployment[]> {
  const data = await callTool<{ deployments: Deployment[] }>("deployments_list", { project_id: projectId });
  return data.deployments;
}

export interface FlyAccount { id: string; team_id: string; name: string; org: string; has_token: boolean; created_at: string; }
export interface FlyMachine { id: string; team_id: string; role: string; app_name: string; machine_id: string; image: string; cpus: number; memory_mb: number; status: string; live?: unknown; created_at: string; }
export interface CustomDomain { id: string; team_id: string; project_id: string; subdomain: string; hostname: string; target: string; kind: string; status: string; created_at: string; }

export async function fetchFlyAccounts(teamId: string): Promise<FlyAccount[]> {
  const data = await callTool<{ accounts: FlyAccount[] }>("fly_accounts", { team_id: teamId });
  return data.accounts;
}
export async function connectFly(teamId: string, v: { name: string; org: string; api_token: string }): Promise<FlyAccount> {
  const data = await callTool<{ account: FlyAccount }>("fly_connect", { team_id: teamId, ...v });
  return data.account;
}
export async function disconnectFly(teamId: string, accountId: string): Promise<void> {
  await callTool("fly_disconnect", { team_id: teamId, account_id: accountId });
}
export async function provisionFly(teamId: string, v: { account_id: string; name: string; prod_image?: string; dev_image?: string; dev_cpus?: number; dev_memory?: number }): Promise<{ prod: FlyMachine; dev: FlyMachine }> {
  return callTool("fly_provision", { team_id: teamId, ...v });
}
export async function fetchFlyMachines(teamId: string): Promise<FlyMachine[]> {
  const data = await callTool<{ machines: FlyMachine[] }>("fly_machines", { team_id: teamId });
  return data.machines;
}
export async function destroyFlyMachine(teamId: string, machineId: string, deleteApp?: boolean): Promise<void> {
  await callTool("fly_destroy", { team_id: teamId, machine_id: machineId, delete_app: !!deleteApp });
}
export async function fetchDomains(teamId: string): Promise<CustomDomain[]> {
  const data = await callTool<{ domains: CustomDomain[] }>("domains_list", { team_id: teamId });
  return data.domains;
}
export async function addDomain(teamId: string, v: { project_id?: string; subdomain: string; target: string; kind?: string }): Promise<CustomDomain> {
  const data = await callTool<{ domain: CustomDomain }>("domains_add", { team_id: teamId, project_id: v.project_id ?? "", subdomain: v.subdomain, target: v.target, kind: v.kind ?? "CNAME" });
  return data.domain;
}
export async function removeDomain(teamId: string, domainId: string): Promise<void> {
  await callTool("domains_remove", { team_id: teamId, domain_id: domainId });
}

// ---------- harness (Codex-like agent runs in Sandbox containers) ----------

export interface HarnessRun {
  id: string;
  team_id: string;
  model: string;
  prompt: string;
  status: string;
  created_at: string;
}

export interface HarnessStep {
  kind: string;
  name: string;
  output: string;
  created_at: string;
}

let harnessBaseCache: string | null = null;

/** Base URL of the harness server. Empty string = same origin (self-hosted). */
export async function fetchHarnessBase(): Promise<string> {
  if (harnessBaseCache !== null) return harnessBaseCache;
  try {
    const data = await callTool<{ url: string }>("harness_config");
    harnessBaseCache = (data.url || "").trim().replace(/\/+$/, "");
  } catch {
    harnessBaseCache = "";
  }
  return harnessBaseCache;
}

async function harnessFetch(path: string, init?: RequestInit): Promise<Response> {
  const base = await fetchHarnessBase();
  const token = getToken();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    try {
      const v = JSON.parse(text) as { error?: string };
      if (v.error) throw new Error(v.error);
    } catch (e) {
      if (e instanceof Error && (e.message.includes("Harness") || !text)) throw e;
    }
    throw new Error(text.slice(0, 300) || `Harness request failed (${res.status}).`);
  }
  return res;
}

/** Start an agent run. Returns the raw SSE response — read events with readHarnessEvents. */
export async function harnessStartRun(teamId: string, model: string, prompt: string, signal?: AbortSignal, repoId?: string, issueId?: string): Promise<Response> {
  return harnessFetch("/api/runs", {
    method: "POST",
    signal,
    body: JSON.stringify({ team_id: teamId, model, prompt, repo_id: repoId ?? "", issue_id: issueId ?? "" }),
  });
}

export interface HarnessEvent {
  type: string;
  data: Record<string, unknown>;
}

/** Parse an SSE stream into events. Calls onEvent per event; resolves on done/error. */
export async function readHarnessEvents(res: Response, onEvent: (e: HarnessEvent) => void, signal?: AbortSignal): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body.");
  const decoder = new TextDecoder();
  let buf = "";
  let evType = "";
  const flush = (chunk: string) => {
    buf += chunk;
    for (;;) {
      const idx = buf.indexOf("\n\n");
      if (idx < 0) break;
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) evType = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (evType && data) {
        try {
          onEvent({ type: evType, data: JSON.parse(data) as Record<string, unknown> });
        } catch {
          /* ignore malformed */
        }
      }
      evType = "";
    }
  };
  for (;;) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      return;
    }
    const { done, value } = await reader.read();
    if (done) {
      if (buf.trim()) flush("\n\n");
      return;
    }
    flush(decoder.decode(value, { stream: true }));
  }
}

export async function harnessListRuns(teamId?: string): Promise<HarnessRun[]> {
  const res = await harnessFetch(teamId ? `/api/runs?team_id=${encodeURIComponent(teamId)}` : "/api/runs");
  const data = (await res.json()) as { runs?: HarnessRun[] };
  return data.runs || [];
}

export async function harnessRunDetail(runId: string): Promise<{ run: HarnessRun; steps: HarnessStep[] }> {
  const res = await harnessFetch(`/api/runs/${encodeURIComponent(runId)}`);
  return (await res.json()) as { run: HarnessRun; steps: HarnessStep[] };
}
