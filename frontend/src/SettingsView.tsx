import { useCallback, useEffect, useState } from "react";
import { useLang } from "./i18n";
import {
  addDomain,
  clearTeamProvider,
  connectFly,
  createOAuthClient,
  createTeam,
  deleteTeam,
  destroyFlyMachine,
  disconnectFly,
  fetchDomains,
  fetchFlyAccounts,
  fetchFlyMachines,
  fetchOAuthClients,
  fetchTeam,
  fetchTeamActivity,
  fetchTeams,
  grantBotAccess,
  inviteMember,
  provisionFly,
  removeDomain,
  removeMember,
  revokeBotAccess,
  revokeOAuthClient,
  setMemberRole,
  setTeamProvider,
  setUserLang,
  testTeamProvider,
  transferBot,
  type ActivityItem,
  type CustomDomain,
  type FlyAccount,
  type FlyMachine,
  type OAuthClient,
  type ProviderInfo,
  type SlaveBot,
  type Team,
  type TeamDetail,
  type User,
} from "./api";

export const TEAM_PROVIDER_PRESETS = [
  { id: "meta", labelKey: "settings.presetMeta", needs_url: false, placeholder: "", helpKey: "settings.presetHelpMeta" },
  { id: "openrouter", labelKey: "settings.presetOpenrouter", needs_url: false, placeholder: "", helpKey: "settings.presetHelpOpenrouter" },
  { id: "opencode", labelKey: "settings.presetOpencode", needs_url: true, placeholder: "https://opencode.ai/inference/go/openai/v1", helpKey: "settings.presetHelpOpencode" },
  { id: "ollama", labelKey: "settings.presetOllama", needs_url: true, placeholder: "http://localhost:11434/v1", helpKey: "settings.presetHelpOllama" },
  { id: "baseten", labelKey: "settings.presetBaseten", needs_url: true, placeholder: "https://inference.baseten.co/v1", helpKey: "settings.presetHelpBaseten" },
  { id: "modal", labelKey: "settings.presetModal", needs_url: true, placeholder: "https://<you>--<app>.modal.run/v1", helpKey: "settings.presetHelpModal" },
  { id: "custom", labelKey: "settings.presetCustom", needs_url: true, placeholder: "http://127.0.0.1:1234/v1", helpKey: "settings.presetHelpCustom" },
] as const;

function isLocalHost(v: string): boolean {
  const s = v.trim().toLowerCase();
  return (
    s.includes("localhost") || s.includes("127.0.0.1") || s.includes("0.0.0.0") || s.includes("192.168.") || s.includes("10.") || s.includes(".local")
  );
}

function TeamProviderSection({ team, onChanged }: { team: TeamDetail["team"]; onChanged: () => void }) {
  const { t } = useLang();
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
      setError(err instanceof Error ? err.message : t("settings.errProvSave"));
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
      if (!res.ok) setError(res.error || t("settings.errTest"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("settings.errTest");
      setError(msg);
      setTestResult({ ok: false, error: msg });
    } finally {
      setTesting(false);
    }
  }

  async function remove() {
    if (!window.confirm(t("settings.removeKeyConfirm"))) return;
    setBusy(true);
    setError("");
    try {
      await clearTeamProvider(team.id);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.errKeyRemove"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-bold uppercase tracking-wide text-zinc-500">{t("settings.providerTitle")}</h4>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${team.provider_key_set || keyOptional ? "bg-emerald-950 text-emerald-300" : "bg-amber-950 text-amber-300"}`}>
          {team.provider_key_set ? t("settings.providerSaved") : keyOptional ? t("settings.providerLocalOk") : t("settings.providerMissing")}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-zinc-500">{t("settings.providerHint")}</p>
      <form onSubmit={save} className="mt-3 space-y-3">
        <label className="block text-xs font-semibold text-zinc-300">
          {t("settings.preset")}
          <select value={preset} onChange={(e) => { setPreset(e.target.value); setTestResult(null); }} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none">
            {TEAM_PROVIDER_PRESETS.map((x) => (
              <option key={x.id} value={x.id}>{t(x.labelKey)}</option>
            ))}
          </select>
        </label>
        <p className="text-[11px] leading-snug text-zinc-500">{t(meta.helpKey)}</p>
        {needsUrl && (
          <label className="block text-xs font-semibold text-zinc-300">
            {t("settings.baseUrl")} <span className="font-normal text-zinc-500">{t("settings.baseUrlHint")}</span>
            <input value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setTestResult(null); }} placeholder={meta.placeholder || "https://..."} autoComplete="off" spellCheck={false} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 font-mono text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
          </label>
        )}
        <label className="block text-xs font-semibold text-zinc-300">
          {t("settings.apiKey")} {team.provider_key_set ? t("settings.apiKeySaved") : keyOptional ? t("settings.apiKeyLocal") : t("settings.apiKeyRequired")}
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={team.provider_key_set ? t("settings.apiKeyPhSaved") : keyOptional ? t("settings.apiKeyPhLocal") : t("settings.apiKeyPhNew")} autoComplete="off" className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
        </label>
        {needsUrl && baseUrl.trim() && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2">
            <div className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">{t("settings.willPost")}</div>
            <div className="mt-0.5 break-all font-mono text-[12px] text-emerald-300">{normalizedEndpoint() || "—"}</div>
            {baseUrl.trim().endsWith("/chat/completions") && (
              <div className="mt-1 text-[11px] text-amber-300">{t("settings.pasteNote")}</div>
            )}
          </div>
        )}
        <label className="block text-xs font-semibold text-zinc-300">
          {t("settings.testModel")} <span className="font-normal text-zinc-500">{t("settings.testModelHint")}</span>
          <input value={testModel} onChange={(e) => setTestModel(e.target.value)} placeholder={t("settings.testModelPh")} autoComplete="off" spellCheck={false} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 font-mono text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" disabled={busy || testing} className="rounded-md bg-zinc-700 px-3 py-1.5 text-sm font-bold text-white hover:bg-zinc-600 disabled:opacity-50">
            {busy ? t("settings.saving") : t("settings.save")}
          </button>
          <button type="button" onClick={runTest} disabled={testing || busy} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
            {testing ? t("settings.testing") : t("settings.testConn")}
          </button>
          {team.provider_key_set && (
            <button type="button" onClick={remove} disabled={busy || testing} className="rounded px-2 py-1 text-xs text-zinc-500 hover:text-red-400 disabled:opacity-50">
              {t("settings.removeKey")}
            </button>
          )}
        </div>
        {testResult && (
          <div className={`rounded-lg border px-3 py-2 text-[12px] ${testResult.ok ? "border-emerald-800 bg-emerald-950/60 text-emerald-200" : "border-red-800 bg-red-950/50 text-red-200"}`}>
            <div className="font-bold">{testResult.ok ? t("settings.connOk") : t("settings.connFail")}</div>
            {testResult.endpoint && <div className="mt-0.5 break-all font-mono text-[11px] opacity-80">{testResult.endpoint}{testResult.model ? ` · ${testResult.model}` : ""}</div>}
            {testResult.models && testResult.models.length > 0 && (
              <div className="mt-1 opacity-90">{t("settings.serverModels")} <span className="font-mono">{testResult.models.slice(0, 8).join(", ")}</span>{testResult.models.length > 8 ? ` ${t("settings.moreModels", { n: testResult.models.length - 8 })}` : ""}</div>
            )}
            {testResult.notes?.map((n, i) => <div key={i} className="mt-0.5 opacity-80">{n}</div>)}
            {!testResult.ok && testResult.error && <div className="mt-1">{testResult.error}</div>}
          </div>
        )}
        <p className="text-[11px] text-zinc-500">
          {team.provider_key_set ? t("settings.hasKeyLine") : keyOptional ? t("settings.noKeyLine") : t("settings.needKeyLine")}
          {" "}{t("settings.fix404")}
        </p>
        {error && !testResult && <p className="text-xs text-red-400">{error}</p>}
      </form>
    </div>
  );
}
export function TeamsView({
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
      .catch((e: unknown) => setError(e instanceof Error ? e.message : t("settings.errTeamLoad")));
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
      setError(e instanceof Error ? e.message : t("settings.errTeamAction"));
    } finally {
      setBusy(false);
    }
  }

  const { t } = useLang();
  const myRole = detail?.my_role ?? "staff";
  const canManage = myRole === "owner" || myRole === "admin";

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h2 className="text-xl font-bold">{t("settings.teamsTitle")}</h2>
      <p className="mt-1 text-sm text-zinc-400">{t("settings.teamsBody")}</p>
      <form
        onSubmit={(e) => { e.preventDefault(); if (name.trim()) void run(() => createTeam(name.trim())); setName(""); }}
        className="mt-4 flex gap-2"
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("settings.teamNamePh")}
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
        />
        <button type="submit" disabled={busy || !name.trim()} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
          {t("settings.teamCreate")}
        </button>
      </form>
      <div className="mt-3 flex flex-wrap gap-2">
        {teams.map((tm) => (
          <button
            key={tm.id}
            type="button"
            onClick={() => onSelect(tm.id)}
            className={`rounded-md border px-3 py-1.5 text-sm font-semibold ${tm.id === activeId ? "border-emerald-600 bg-zinc-800 text-zinc-100" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}
          >
            {tm.name} <span className="text-xs text-zinc-500">{tm.role}{tm.personal ? ` · ${t("settings.teamPersonal")}` : ""}</span>
          </button>
        ))}
      </div>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      {detail && (
        <div className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold">{detail.team.name}</h3>
            {canManage && !detail.team.personal && (
              <button type="button" disabled={busy} onClick={() => { if (window.confirm(t("settings.teamDeleteConfirm", { name: detail.team.name }))) void run(() => deleteTeam(detail.team.id)); }} className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400 disabled:opacity-50">
                {t("settings.teamDelete")}
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
              {t("settings.providerTitle")}: {detail.team.provider || "meta"}{detail.team.provider_key_set ? ` · ${t("settings.providerSaved")}` : ` · ${t("settings.needKeyLine")}`}
            </p>
          )}
          <h4 className="mt-4 text-sm font-bold uppercase tracking-wide text-zinc-500">{t("settings.members", { n: detail.members.length })}</h4>
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
                      <button type="button" disabled={busy} onClick={() => void run(() => removeMember(detail.team.id, m.user_id))} className="rounded px-1 text-xs text-zinc-500 hover:text-red-400 disabled:opacity-50">{t("settings.remove")}</button>
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
                  placeholder={t("settings.invitePh")}
                  autoComplete="off"
                  className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
                />
              <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none">
                <option value="admin">admin</option>
                <option value="staff">staff</option>
              </select>
                <button type="submit" disabled={busy || !inviteEmail.trim()} className="rounded-md bg-zinc-700 px-3 py-2 text-sm font-bold text-white hover:bg-zinc-600 disabled:opacity-50">
                  {t("settings.invite")}
                </button>
            </form>
          )}
          <h4 className="mt-5 text-sm font-bold uppercase tracking-wide text-zinc-500">{t("settings.botsCount", { n: detail.bots.length })}</h4>
          <ul className="mt-2 space-y-1">
            {detail.bots.map((b) => {
              const owner = detail.members.find((m) => m.user_id === b.owner_user_id);
              return (
              <li key={b.id} className="rounded-md bg-zinc-800/60 px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-semibold">{b.name}</span>
                    <span className="shrink-0 text-xs text-zinc-500">◈ {owner ? (owner.name || owner.email) : t("settings.unassignedBot")}</span>
                </div>
                {canManage && (
                    <label className="mt-1 flex items-center gap-2 text-xs text-zinc-400">
                      {t("settings.partnerIs")}
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
                          title={has ? t("settings.revokeTitle", { bot: b.name, email: m.email || "" }) : t("settings.grantTitle", { bot: b.name, email: m.email || "" })}
                          onClick={() => void run(() => has ? revokeBotAccess(detail.team.id, b.id, m.user_id, m.bot_ids) : grantBotAccess(detail.team.id, b.id, m.user_id, m.bot_ids))}
                          className={`rounded border px-2 py-0.5 text-xs ${has ? "border-emerald-700 text-emerald-400" : "border-zinc-700 text-zinc-500 hover:text-zinc-200"}`}
                        >
                          {m.email}: {has ? t("settings.granted") : t("settings.grant")}
                        </button>
                      );
                    })}
                  </div>
                )}
              </li>
              );
            })}
            {detail.bots.length === 0 && <p className="text-sm text-zinc-600">{t("settings.noBots")}</p>}
          </ul>
          {canManage && (
            <>
                <h4 className="mt-5 text-sm font-bold uppercase tracking-wide text-zinc-500">{t("settings.activity")}</h4>
                {activity.length === 0 ? (
                  <p className="mt-1 text-sm text-zinc-600">{t("settings.noActivity")}</p>
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
export function FlySection({ teamId }: { teamId: string | null }) {
  const { t } = useLang();
  const [accounts, setAccounts] = useState<FlyAccount[]>([]);
  const [machines, setMachines] = useState<FlyMachine[]>([]);
  const [domains, setDomains] = useState<CustomDomain[]>([]);
  const [name, setName] = useState("");
  const [org, setOrg] = useState("");
  const [token, setTokenInput] = useState("");
  const [slug, setSlug] = useState("");
  const [sub, setSub] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!teamId) { setAccounts([]); setMachines([]); setDomains([]); return; }
    try {
      const [a, m, d] = await Promise.all([fetchFlyAccounts(teamId), fetchFlyMachines(teamId), fetchDomains(teamId)]);
      setAccounts(a); setMachines(m); setDomains(d);
    } catch (err) { setError(err instanceof Error ? err.message : t("settings.errFlyLoad")); }
  }, [teamId]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    if (!teamId || !token.trim() || busy) return;
    setBusy(true); setError("");
    try {
      await connectFly(teamId, { name: name.trim() || "fly", org: org.trim(), api_token: token.trim() });
      setName(""); setOrg(""); setTokenInput("");
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : t("settings.errFlyConnect")); }
    finally { setBusy(false); }
  }

  async function provision(accountId: string) {
    if (!teamId || !slug.trim() || busy) return;
    setBusy(true); setError("");
    try { await provisionFly(teamId, { account_id: accountId, name: slug.trim().toLowerCase() }); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : t("settings.errProvision")); }
    finally { setBusy(false); }
  }

  return (
    <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="mb-1 text-sm font-bold uppercase tracking-wide text-zinc-500">{t("settings.flyTitle")}</h3>
      <p className="mb-2 text-xs text-zinc-500">{t("settings.flyBody")}</p>
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      <form onSubmit={connect} className="flex flex-col gap-2">
        <div className="flex flex-col gap-2 sm:flex-row">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("settings.flyAccountPh")} disabled={!teamId} className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none disabled:opacity-40" />
        <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder={t("settings.flyOrgPh")} disabled={!teamId} className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none disabled:opacity-40" />
        </div>
        <input value={token} onChange={(e) => setTokenInput(e.target.value)} placeholder={t("settings.flyTokenPh")} type="password" disabled={!teamId} className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none disabled:opacity-40" />
        <div><button type="submit" disabled={!token.trim() || !teamId || busy} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40">{busy ? t("settings.flyConnecting") : t("settings.flyConnect")}</button></div>
      </form>
      {accounts.map((a) => (
        <div key={a.id} className="mt-3 rounded-md bg-zinc-800/60 p-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-zinc-100">{a.name}</span>
          <span className="font-mono text-zinc-500">{a.org || t("settings.flyOrgDefault")} · token ✓</span>
          <button type="button" onClick={() => teamId && disconnectFly(teamId, a.id).then(refresh)} className="ml-auto text-zinc-500 hover:text-red-400">{t("settings.flyDisconnect")}</button>
          </div>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={t("settings.flySlugPh")} className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
          <button type="button" onClick={() => provision(a.id)} disabled={!slug.trim() || busy} className="rounded-md bg-sky-600 px-3 py-1.5 font-bold text-white hover:bg-sky-500 disabled:opacity-40">{t("settings.flyProvision")}</button>
        </div>
        <p className="mt-1 text-zinc-500">{t("settings.flyMakes")} <span className="font-mono">{slug || "slug"}-prod</span> {t("settings.flyProdNote")} + <span className="font-mono">{slug || "slug"}-dev</span> {t("settings.flyDevNote")}.</p>
        </div>
      ))}
      {machines.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {machines.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-2 rounded-md bg-zinc-800/60 px-3 py-2 font-mono text-xs">
              <span className={m.role === "prod" ? "font-bold text-emerald-400" : "font-bold text-sky-400"}>{m.role}</span>
              <span className="text-zinc-100">{m.app_name}</span>
              <span className="text-zinc-500">{m.machine_id.slice(0, 8)} · {m.image} · {m.cpus}cpu/{m.memory_mb}MB · {m.status}</span>
              <button type="button" onClick={() => teamId && destroyFlyMachine(teamId, m.id, false).then(refresh)} className="ml-auto text-zinc-500 hover:text-red-400">{t("settings.flyDestroy")}</button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 border-t border-zinc-800 pt-3">
        <div className="mb-1 text-xs font-bold uppercase tracking-wide text-zinc-500">{t("settings.domainsTitle", { zone: "{nama}.slaver.app" })}</div>
        <p className="mb-2 text-[11px] text-zinc-500">{t("settings.domainsHint")}</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input value={sub} onChange={(e) => setSub(e.target.value)} placeholder={t("settings.domSubPh")} className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
          <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={t("settings.domTargetPh")} className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
          <button type="button" onClick={async () => { if (!teamId || !sub.trim() || !target.trim()) return; setError(""); try { await addDomain(teamId, { subdomain: sub.trim().toLowerCase(), target: target.trim() }); setSub(""); setTarget(""); await refresh(); } catch (err) { setError(err instanceof Error ? err.message : t("settings.domFail")); } }} className="rounded-md bg-zinc-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-zinc-600">{t("settings.domAdd")}</button>
        </div>
        {domains.map((d) => (
          <div key={d.id} className="mt-1 flex items-center gap-2 font-mono text-xs text-zinc-400">
            <span className="text-zinc-100">{d.hostname}</span><span>→ {d.target}</span><span className="text-zinc-600">[{d.status}]</span>
            <button type="button" onClick={() => teamId && removeDomain(teamId, d.id).then(refresh)} className="ml-auto text-zinc-600 hover:text-red-400">{t("settings.domRemove")}</button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DeveloperSection({ teamId }: { teamId: string | null }) {
  const { t } = useLang();
  const [clients, setClients] = useState<OAuthClient[]>([]);
  const [name, setName] = useState("");
  const [redirects, setRedirects] = useState("");
  const [newSecret, setNewSecret] = useState<{ id: string; secret: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (!teamId) {
      setClients([]);
      return;
    }
    try {
      setClients(await fetchOAuthClients(teamId));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.errOauthLoad"));
    }
  }, [teamId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!teamId || !name.trim() || !redirects.trim() || busy) return;
    setBusy(true);
    setError("");
    setNewSecret(null);
    try {
      const res = await createOAuthClient(teamId, name.trim(), redirects.trim());
      setNewSecret({ id: res.client.id, secret: res.client_secret });
      setName("");
      setRedirects("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.errOauthCreate"));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(clientId: string) {
    if (!teamId || !window.confirm(t("settings.devRevokeConfirm"))) return;
    setError("");
    try {
      await revokeOAuthClient(teamId, clientId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.errOauthRevoke"));
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="mb-1 text-sm font-bold uppercase tracking-wide text-zinc-500">{t("settings.devTitle")}</h3>
      <p className="mb-2 text-xs text-zinc-500">
        {t("settings.devBody")}
      </p>
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      {newSecret && (
        <div className="mb-2 rounded-md border border-amber-700 bg-amber-950/60 p-2 text-xs text-amber-200">
          <div className="font-bold">{t("settings.devSecret")}</div>
          <div className="mt-1 break-all font-mono">client_id: {newSecret.id}</div>
          <div className="break-all font-mono">client_secret: {newSecret.secret}</div>
        </div>
      )}
      <form onSubmit={create} className="flex flex-col gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("settings.devNamePh")}
          disabled={!teamId}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none disabled:opacity-40"
        />
        <input
          value={redirects}
          onChange={(e) => setRedirects(e.target.value)}
          placeholder={t("settings.devRedirectPh")}
          disabled={!teamId}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none disabled:opacity-40"
        />
        <div>
          <button type="submit" disabled={!name.trim() || !redirects.trim() || !teamId || busy} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40">
            {busy ? t("settings.devCreating") : t("settings.devCreate")}
          </button>
        </div>
      </form>
      {clients.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1">
          {clients.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-md bg-zinc-800/60 px-3 py-2 text-xs">
              <span className="font-semibold text-zinc-100">{c.name}</span>
              <span className="font-mono text-zinc-500">{c.id}</span>
              <span className="truncate text-zinc-500">{c.redirect_uris}</span>
              <button type="button" onClick={() => revoke(c.id)} className="ml-auto text-zinc-500 hover:text-red-400">
                {t("settings.devRevoke")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!teamId && <p className="mt-1 text-xs text-zinc-500">{t("settings.devNeedTeam")}</p>}
    </div>
  );
}

export function SettingsView({
  user,
  teams,
  teamId,
  memberNames,
  onPickTeam,
  onTeamsChanged,
  onCreateBot,
  onLogout,
  onUserChanged,
}: {
  user: User;
  teams: Team[];
  teamId: string | null;
  memberNames: Record<string, string>;
  onPickTeam: (id: string) => void;
  onTeamsChanged: () => Promise<void>;
  onCreateBot: (ownerId: string) => Promise<void>;
  onLogout: () => void;
  onUserChanged: (u: User) => void;
}) {
  const { t, lang, setLang } = useLang();
  const [createOwner, setCreateOwner] = useState(user.id);
  const [creating, setCreating] = useState(false);
  const [langBusy, setLangBusy] = useState(false);
  const [section, setSection] = useState<"profile" | "teams" | "fly" | "dev">("profile");

  async function create() {
    if (creating) return;
    setCreating(true);
    try {
      await onCreateBot(createOwner || user.id);
    } finally {
      setCreating(false);
    }
  }

  async function pickLang(l: "en" | "id") {
    if (l === lang || langBusy) return;
    setLangBusy(true);
    try {
      setLang(l);
      const u = await setUserLang(l);
      onUserChanged(u);
    } catch {
      /* keep local choice even if server save fails */
    } finally {
      setLangBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <h2 className="text-xl font-bold text-zinc-100">{t("settings.title")}</h2>

      {/* Mobile: horizontal section tabs */}
      <div className="mt-4 flex gap-1 overflow-x-auto md:hidden">
        {(["profile", "teams", "fly", "dev"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSection(s)}
            className={`shrink-0 rounded-md px-3 py-1.5 text-xs font-bold ${section === s ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-200"}`}
          >
            {s === "profile" ? t("settings.profile") : s === "teams" ? t("settings.teamsTitle") : s === "fly" ? t("settings.flyTitle") : t("settings.devTitle")}
          </button>
        ))}
      </div>

      <div className="mt-4 flex gap-5">
        {/* Sub-sidebar (desktop) */}
        <aside className="hidden w-52 shrink-0 md:block">
          <nav className="sticky top-4 flex flex-col gap-1 rounded-xl border border-zinc-800 bg-zinc-900 p-2">
            {(["profile", "teams", "fly", "dev"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSection(s)}
                className={`rounded-md px-3 py-2 text-left text-sm ${section === s ? "bg-zinc-800 font-semibold text-zinc-100" : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"}`}
              >
                {s === "profile" ? t("settings.profile") : s === "teams" ? t("settings.teamsTitle") : s === "fly" ? t("settings.flyTitle") : t("settings.devTitle")}
              </button>
            ))}
          </nav>
        </aside>

        <div className="min-w-0 flex-1">
      {section === "profile" && (
      <>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-zinc-500">{t("settings.profile")}</h3>
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-zinc-800 text-lg font-bold text-zinc-200">
            {(user.name || user.email || "?").slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold text-zinc-100">{user.name || t("settings.unnamed")}</div>
            <div className="truncate text-xs text-zinc-500">{user.email}</div>
          </div>
          <button type="button" onClick={onLogout} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">
            {t("settings.logout")}
          </button>
        </div>
        <div className="mt-3 flex items-center gap-2 border-t border-zinc-800 pt-3">
          <span className="text-xs font-semibold text-zinc-400">{t("settings.langTitle")}</span>
          {(["en", "id"] as const).map((l) => (
            <button
              key={l}
              type="button"
              disabled={langBusy}
              onClick={() => pickLang(l)}
              className={`rounded-md px-3 py-1.5 text-xs font-bold ${lang === l ? "bg-emerald-600 text-white" : "border border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`}
            >
              {l === "en" ? t("settings.langEn") : t("settings.langId")}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <h3 className="mb-1 text-sm font-bold uppercase tracking-wide text-zinc-500">{t("settings.newBot")}</h3>
        <p className="mb-2 text-xs text-zinc-500">{t("settings.newBotHint")}</p>
        <div className="flex gap-2">
          <select
            value={createOwner}
            onChange={(e) => setCreateOwner(e.target.value)}
            title={t("settings.newBotOwner")}
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
          >
            <option value={user.id}>{memberNames[user.id] ?? t("settings.newBotMe")}</option>
            {Object.entries(memberNames).filter(([id]) => id !== user.id).map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
          <button type="button" onClick={create} disabled={creating || !teamId} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40">
            {creating ? t("settings.creating") : t("settings.create")}
          </button>
        </div>
        {!teamId && <p className="mt-1 text-xs text-amber-300">{t("settings.pickTeam")}</p>}
      </div>
      </>
      )}

      {section === "teams" && (
      <TeamsView
        teams={teams}
        teamId={teamId}
        userId={user.id}
        onChanged={onTeamsChanged}
        onSelect={onPickTeam}
      />
      )}

      {section === "fly" && <FlySection teamId={teamId} />}

      {section === "dev" && <DeveloperSection teamId={teamId} />}
        </div>
      </div>
    </div>
  );
}
