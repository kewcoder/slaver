/// Single-endpoint MCP client: every app action is a JSON-RPC `tools/call`
/// against POST /mcp. The only other endpoint is the live inbox stream
/// (GET /api/inbox/stream, SSE) for realtime chat + notifications.

export interface User {
  id: string;
  email: string;
  name: string;
  lang?: string;
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
}

export interface TeamDetail {
  team: { id: string; name: string; owner_user_id: string; personal: number; provider: string; provider_base_url: string; provider_key_set: boolean; created_at: string };
  my_role: string;
  members: TeamMember[];
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

export async function setUserLang(lang: string): Promise<User> {
  const data = await callTool<{ user: User }>("user_set_lang", { lang });
  return data.user;
}

// ---------- models / provider ----------

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

export async function inviteMember(teamId: string, email: string, role: string): Promise<void> {
  await callTool("team_invite", { team_id: teamId, email, role });
}

export async function removeMember(teamId: string, userId: string): Promise<void> {
  await callTool("teams_remove_member", { team_id: teamId, user_id: userId });
}



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


export interface Repo {
  id: string;
  team_id: string;
  name: string;
  description: string;
  price_cents?: number;
  template: number;
  fork_of: string;
  category?: string;
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

export async function fetchProjects(teamId: string): Promise<{ project: Project; stats: ProjectStats }[]> {
  const data = await callTool<{ projects: { project: Project; stats: ProjectStats }[] }>("projects_list", { team_id: teamId });
  return data.projects;
}

export async function setProjectUrls(projectId: string, urls: { prod_url?: string; dev_url?: string }): Promise<Project> {
  const data = await callTool<{ project: Project }>("projects_set_urls", { project_id: projectId, ...urls });
  return data.project;
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

export interface ReviewCheck {
  level: "must" | "suggest" | "ok";
  name: string;
  detail: string;
}

export interface ListingReview {
  id: string;
  repo_id: string;
  commit_sha: string;
  verdict: "approved" | "changes";
  score: number | null;
  model: string;
  checks: ReviewCheck[];
  ai: { score: number | null; summary: string; strengths: string[]; must_fix: string[]; suggestions: string[] } | null;
  ai_error: string;
  files_reviewed: string[];
  created_at: string;
  current: boolean;
}

/** Ask the Meta model to review the listing's current code. Slow (up to ~1 min). */
export async function runListingReview(repoId: string, lang: string): Promise<ListingReview> {
  return (await callTool<{ review: ListingReview }>("listing_review_run", { repo_id: repoId, lang })).review;
}

export async function fetchListingReview(repoId: string): Promise<ListingReview | null> {
  return (await callTool<{ review: ListingReview | null }>("listing_review_get", { repo_id: repoId })).review;
}

export async function publishRepo(repoId: string, template: boolean): Promise<void> {
  await callTool("repos_publish", { repo_id: repoId, template });
}

export async function fetchLicenses(teamId: string): Promise<License[]> {
  const data = await callTool<{ licenses: License[] }>("licenses_list", { team_id: teamId });
  return data.licenses;
}

export interface Skill {
  id: string;
  team_id: string;
  name: string;
  category: string;
  description: string;
  role: string;
  memory: string;
  price_cents: number;
  template: number;
  fork_of: string;
  created_at: string;
}

export async function deleteSkill(skillId: string): Promise<void> {
  await callTool("skills_delete", { skill_id: skillId });
}

export async function updateRepo(repoId: string, v: { name?: string; description?: string; price_cents?: number; category?: string }): Promise<Repo> {
  const data = await callTool<{ repo: Repo }>("repos_update", { repo_id: repoId, ...v });
  return data.repo;
}

/** Upload a .zip / .tar.gz as the repo's new HEAD commit (raw body, up to 200 MB). */
export async function uploadRepoArchive(repoId: string, file: Blob, message = ""): Promise<string> {
  const token = getToken();
  const res = await fetch(`/api/repos/${encodeURIComponent(repoId)}/upload?message=${encodeURIComponent(message)}`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: file,
  });
  const data = (await res.json().catch(() => ({}))) as { sha?: string; error?: string };
  if (!res.ok || !data.sha) throw new Error(data.error ?? `Upload failed (${res.status}).`);
  return data.sha;
}

export async function deleteRepo(repoId: string): Promise<void> {
  await callTool("repos_delete", { repo_id: repoId });
}

// ---------- hosting (one-click install) ----------

export type HostingProvider = "fly" | "sprites";

export interface HostingAccount {
  id: string;
  team_id: string;
  provider: HostingProvider;
  name: string;
  account_ref: string;
  created_at: string;
}

export interface Install {
  id: string;
  team_id: string;
  project_id: string;
  provider: HostingProvider;
  account_id: string;
  site_name: string;
  external_id: string;
  url: string;
  status: "queued" | "running" | "live" | "failed";
  log: string;
  commit_sha: string;
  created_at: string;
  updated_at: string;
}

export async function fetchHostingAccounts(teamId: string): Promise<HostingAccount[]> {
  const data = await callTool<{ accounts: HostingAccount[] }>("hosting_accounts", { team_id: teamId });
  return data.accounts;
}

export async function connectHosting(teamId: string, v: { provider: HostingProvider; api_token: string; account_ref?: string; name?: string }): Promise<HostingAccount> {
  const data = await callTool<{ account: HostingAccount }>("hosting_connect", { team_id: teamId, ...v });
  return data.account;
}

export async function disconnectHosting(teamId: string, provider: HostingProvider, accountId: string): Promise<void> {
  await callTool("hosting_disconnect", { team_id: teamId, provider, account_id: accountId });
}

export async function startInstall(projectId: string, provider: HostingProvider, accountId: string, siteName = ""): Promise<Install> {
  const data = await callTool<{ install: Install }>("install_start", { project_id: projectId, provider, account_id: accountId, site_name: siteName });
  return data.install;
}

export async function fetchInstalls(teamId: string, projectId = ""): Promise<Install[]> {
  const data = await callTool<{ installs: Install[] }>("installs_list", { team_id: teamId, project_id: projectId });
  return data.installs;
}

// ---------- GitHub connector (creator) ----------

export interface GithubAccount { id: string; team_id: string; login: string; created_at: string }
export interface GithubRepo { full_name: string; private: boolean; default_branch: string; description: string | null; updated_at: string }
export interface GithubLink { repo_id: string; team_id: string; github_account_id: string; github_repo: string; github_branch: string; github_synced_at: string; github_error: string }

export async function fetchGithubStatus(teamId: string): Promise<{ oauth: boolean; accounts: GithubAccount[] }> {
  return callTool("github_status", { team_id: teamId });
}
export async function githubOauthStart(teamId: string): Promise<string> {
  return (await callTool<{ url: string }>("github_oauth_start", { team_id: teamId })).url;
}
export async function githubConnectToken(teamId: string, token: string): Promise<GithubAccount> {
  return (await callTool<{ account: GithubAccount }>("github_connect", { team_id: teamId, token })).account;
}
export async function githubDisconnect(teamId: string, accountId: string): Promise<void> {
  await callTool("github_disconnect", { team_id: teamId, account_id: accountId });
}
export async function fetchGithubRepos(teamId: string, accountId: string): Promise<GithubRepo[]> {
  return (await callTool<{ repos: GithubRepo[] }>("github_repos", { team_id: teamId, account_id: accountId })).repos;
}
export async function githubLink(repoId: string, accountId: string, fullName: string, branch: string): Promise<GithubLink> {
  return (await callTool<{ link: GithubLink }>("github_link", { repo_id: repoId, account_id: accountId, full_name: fullName, branch })).link;
}
export async function githubUnlink(repoId: string): Promise<void> {
  await callTool("github_unlink", { repo_id: repoId });
}
export async function githubSync(repoId: string): Promise<string> {
  return (await callTool<{ sha: string }>("github_sync", { repo_id: repoId })).sha;
}
export async function fetchGithubLink(repoId: string): Promise<GithubLink | null> {
  return (await callTool<{ link: GithubLink | null }>("github_link_get", { repo_id: repoId })).link;
}

// ---------- updates (buyer, opt-in) ----------

export interface AppUpdate { repo_id: string; project_id: string; app_name: string; behind: number; latest_sha: string; changes: { sha: string; subject: string; date: string }[] }

export async function fetchUpdates(teamId: string): Promise<AppUpdate[]> {
  return (await callTool<{ updates: AppUpdate[] }>("updates_list", { team_id: teamId })).updates;
}
export async function applyUpdate(repoId: string): Promise<{ status: "updated" | "conflict" | "up_to_date"; sha?: string; branch?: string }> {
  return callTool("updates_apply", { repo_id: repoId });
}

// ---------- customize (AI edits on a staging sandbox) ----------

export interface CustomizeChange {
  id: string;
  prompt: string;
  status: "working" | "done" | "failed" | "discarded";
  step: string;
  summary: string;
  files: string[];
  commit: string;
  error: string;
  applied: boolean;
  created_at: string;
}

export interface CustomizeStatus {
  staging: { sprite: string; url: string; changes: CustomizeChange[] };
  sprites_connected: boolean;
  sandbox: "sprites" | "local";
  project: Project;
}

export async function fetchCustomize(projectId: string): Promise<CustomizeStatus> {
  return callTool<CustomizeStatus>("customize_status", { project_id: projectId });
}

export async function sendCustomize(projectId: string, prompt: string, ship?: "none"): Promise<CustomizeChange> {
  return (await callTool<{ change: CustomizeChange }>("customize_send", { project_id: projectId, prompt, ...(ship ? { ship } : {}) })).change;
}

export async function discardCustomize(projectId: string): Promise<{ discarded: number; rebuilding: boolean }> {
  return callTool("customize_discard", { project_id: projectId });
}

export async function promoteCustomize(projectId: string): Promise<{ merged: boolean; commit: string }> {
  return callTool("customize_promote", { project_id: projectId });
}

// ---------- desktop: local runs, tunnels, cloud sync ----------

export interface DesktopMeta {
  desktop: boolean;
  bun: { found: boolean; path?: string };
  git: { found: boolean; path?: string };
  cloudflared: { found: boolean; path?: string };
}

export async function fetchDesktopMeta(): Promise<DesktopMeta> {
  return callTool("desktop_meta", {});
}

export interface LocalRunStatus {
  project_id: string;
  running: boolean;
  url: string | null;
  port: number | null;
}

export async function localrunStart(projectId: string): Promise<LocalRunStatus> {
  return callTool("localrun_start", { project_id: projectId });
}

export async function localrunStop(projectId: string): Promise<LocalRunStatus> {
  return callTool("localrun_stop", { project_id: projectId });
}

export async function localrunStatus(projectId: string): Promise<LocalRunStatus> {
  return callTool("localrun_status", { project_id: projectId });
}

export async function localrunLogs(projectId: string, tail = 80): Promise<{ project_id: string; lines: string[] }> {
  return callTool("localrun_logs", { project_id: projectId, tail });
}

export interface TunnelState {
  running: boolean;
  url: string | null;
  mode: string | null;
  started_at: string | null;
}

export async function tunnelStart(port: number): Promise<TunnelState> {
  return callTool("tunnel_start", { port });
}

export async function tunnelStop(): Promise<TunnelState> {
  return callTool("tunnel_stop", {});
}

export async function tunnelStatus(): Promise<TunnelState> {
  return callTool("tunnel_status", {});
}
