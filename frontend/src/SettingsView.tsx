import { useCallback, useEffect, useState } from "react";
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
  { id: "meta", label: "Meta (disarankan)", needs_url: false, placeholder: "", help: "Satu kunci dari dev.meta.ai. Model: muse-spark-1.3, muse-wonder-1.0." },
  { id: "openrouter", label: "OpenRouter (cadangan)", needs_url: false, placeholder: "", help: "Kunci sk-or-v1-… dari openrouter.ai/keys. Daftar model tetap." },
  { id: "opencode", label: "OpenCode (langganan Go / kredit Console)", needs_url: true, placeholder: "https://opencode.ai/inference/go/openai/v1", help: "Pelanggan Go: https://opencode.ai/inference/go/openai/v1. Bayar per pakai: https://opencode.ai/inference/openai/v1 (butuh kredit console). Jangan tambah /chat/completions." },
  { id: "ollama", label: "Ollama (lokal, tanpa kunci)", needs_url: true, placeholder: "http://localhost:11434/v1", help: "Ollama lokal. Tanpa kunci. Model harus diunduh dulu — jalankan `ollama list` lalu pakai id persisnya di pengaturan Asisten." },
  { id: "baseten", label: "Baseten", needs_url: true, placeholder: "https://inference.baseten.co/v1", help: "Alamat + kunci API deployment Baseten milikmu." },
  { id: "modal", label: "Modal", needs_url: true, placeholder: "https://<you>--<app>.modal.run/v1", help: "Alamat fungsi Modal milikmu (akar API) + kunci." },
  { id: "custom", label: "Lainnya (server OpenAI-compatible)", needs_url: true, placeholder: "http://127.0.0.1:1234/v1", help: "Server OpenAI-compatible apa pun (vLLM, LM Studio, …). Alamat harus berakhiran /v1. Kunci boleh kosong hanya untuk localhost." },
];

function isLocalHost(v: string): boolean {
  const s = v.trim().toLowerCase();
  return (
    s.includes("localhost") || s.includes("127.0.0.1") || s.includes("0.0.0.0") || s.includes("192.168.") || s.includes("10.") || s.includes(".local")
  );
}

function TeamProviderSection({ team, onChanged }: { team: TeamDetail["team"]; onChanged: () => void }) {
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
      setError(err instanceof Error ? err.message : "Could not save provider.");
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
      if (!res.ok) setError(res.error || "Connection test failed.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Connection test failed.";
      setError(msg);
      setTestResult({ ok: false, error: msg });
    } finally {
      setTesting(false);
    }
  }

  async function remove() {
    if (!window.confirm("Hapus kunci AI tim ini? Asisten tidak bisa menjawab sampai ada kunci baru.")) return;
    setBusy(true);
    setError("");
    try {
      await clearTeamProvider(team.id);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove key.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-bold uppercase tracking-wide text-zinc-500">Kunci AI</h4>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${team.provider_key_set || keyOptional ? "bg-emerald-950 text-emerald-300" : "bg-amber-950 text-amber-300"}`}>
          {team.provider_key_set ? "sudah ada" : keyOptional ? "tanpa kunci OK" : "belum ada"}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-zinc-500">Agar asisten bisa menjawab, tim ini butuh kunci dari penyedia AI (mis. Meta, OpenRouter). Satu kunci untuk satu tim.</p>
      <form onSubmit={save} className="mt-3 space-y-3">
        <label className="block text-xs font-semibold text-zinc-300">
          Penyedia
          <select value={preset} onChange={(e) => { setPreset(e.target.value); setTestResult(null); }} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none">
            {TEAM_PROVIDER_PRESETS.map((x) => (
              <option key={x.id} value={x.id}>{x.label}</option>
            ))}
          </select>
        </label>
        <p className="text-[11px] leading-snug text-zinc-500">{meta.help}</p>
        {needsUrl && (
          <label className="block text-xs font-semibold text-zinc-300">
            Alamat server <span className="font-normal text-zinc-500">(berakhiran /v1)</span>
            <input value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setTestResult(null); }} placeholder={meta.placeholder || "https://..."} autoComplete="off" spellCheck={false} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 font-mono text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
          </label>
        )}
        <label className="block text-xs font-semibold text-zinc-300">
          Kunci {team.provider_key_set ? "(sudah tersimpan — isi baru untuk ganti)" : keyOptional ? "(boleh kosong untuk server lokal)" : "(wajib diisi)"}
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={team.provider_key_set ? "••••••••" : keyOptional ? "kosongkan untuk lokal" : "tempel kunci..."} autoComplete="off" className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
        </label>
        {needsUrl && baseUrl.trim() && (
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2">
            <div className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">Akan menghubungi</div>
            <div className="mt-0.5 break-all font-mono text-[12px] text-emerald-300">{normalizedEndpoint() || "—"}</div>
            {baseUrl.trim().endsWith("/chat/completions") && (
              <div className="mt-1 text-[11px] text-amber-300">Alamat kepanjangan — akhiran /chat/completions kami buang otomatis.</div>
            )}
          </div>
        )}
        <label className="block text-xs font-semibold text-zinc-300">
          Model untuk tes <span className="font-normal text-zinc-500">(nama persis dari server)</span>
          <input value={testModel} onChange={(e) => setTestModel(e.target.value)} placeholder="cth. qwen3:8b — kosongkan untuk pakai yang pertama" autoComplete="off" spellCheck={false} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 font-mono text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" disabled={busy || testing} className="rounded-md bg-zinc-700 px-3 py-1.5 text-sm font-bold text-white hover:bg-zinc-600 disabled:opacity-50">
            {busy ? "Menyimpan..." : "Simpan"}
          </button>
          <button type="button" onClick={runTest} disabled={testing || busy} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
            {testing ? "Mengetes..." : "Simpan + tes koneksi"}
          </button>
          {team.provider_key_set && (
            <button type="button" onClick={remove} disabled={busy || testing} className="rounded px-2 py-1 text-xs text-zinc-500 hover:text-red-400 disabled:opacity-50">
              Hapus kunci
            </button>
          )}
        </div>
        {testResult && (
          <div className={`rounded-lg border px-3 py-2 text-[12px] ${testResult.ok ? "border-emerald-800 bg-emerald-950/60 text-emerald-200" : "border-red-800 bg-red-950/50 text-red-200"}`}>
            <div className="font-bold">{testResult.ok ? "Koneksi OK" : "Koneksi gagal"}</div>
            {testResult.endpoint && <div className="mt-0.5 break-all font-mono text-[11px] opacity-80">{testResult.endpoint}{testResult.model ? ` · ${testResult.model}` : ""}</div>}
            {testResult.models && testResult.models.length > 0 && (
              <div className="mt-1 opacity-90">Model di server: <span className="font-mono">{testResult.models.slice(0, 8).join(", ")}</span>{testResult.models.length > 8 ? ` +${testResult.models.length - 8} lagi` : ""}</div>
            )}
            {testResult.notes?.map((n, i) => <div key={i} className="mt-0.5 opacity-80">{n}</div>)}
            {!testResult.ok && testResult.error && <div className="mt-1">{testResult.error}</div>}
          </div>
        )}
        <p className="text-[11px] text-zinc-500">
          {team.provider_key_set ? "Kunci aktif — tagihan AI dibayar langsung oleh kunci ini." : keyOptional ? "Belum ada kunci — boleh kosong hanya untuk server lokal." : "Belum ada kunci — asisten tidak bisa menjawab sampai pemilik/admin menambahkan."}
          {" "}Error 404? Nama model harus persis sama dengan di server, dan alamat harus akar /v1.
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
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load team."));
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
      setError(e instanceof Error ? e.message : "Team action failed.");
    } finally {
      setBusy(false);
    }
  }

  const myRole = detail?.my_role ?? "staff";
  const canManage = myRole === "owner" || myRole === "admin";

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h2 className="text-xl font-bold">Tim</h2>
      <p className="mt-1 text-sm text-zinc-400">Satu tim punya asisten AI, grup, dan rapatnya sendiri. Pemilik dan admin mengatur semuanya; anggota biasa hanya melihat asisten yang dibagikan ke mereka.</p>
      <form
        onSubmit={(e) => { e.preventDefault(); if (name.trim()) void run(() => createTeam(name.trim())); setName(""); }}
        className="mt-4 flex gap-2"
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nama tim baru, cth. Warung Bu Tini"
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
        />
        <button type="submit" disabled={busy || !name.trim()} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
          Buat
        </button>
      </form>
      <div className="mt-3 flex flex-wrap gap-2">
        {teams.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id)}
            className={`rounded-md border px-3 py-1.5 text-sm font-semibold ${t.id === activeId ? "border-emerald-600 bg-zinc-800 text-zinc-100" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}
          >
            {t.name} <span className="text-xs text-zinc-500">{t.role}{t.personal ? " · pribadi" : ""}</span>
          </button>
        ))}
      </div>
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      {detail && (
        <div className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold">{detail.team.name}</h3>
            {canManage && !detail.team.personal && (
              <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Hapus tim ${detail.team.name}? Asistennya diarsipkan; grup dan rapat dihapus.`)) void run(() => deleteTeam(detail.team.id)); }} className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400 disabled:opacity-50">
                Hapus tim
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
              Kunci AI: {detail.team.provider || "meta"}{detail.team.provider_key_set ? " · sudah ada" : " · belum ada — minta pemilik/admin menambahkan"}.
            </p>
          )}
          <h4 className="mt-4 text-sm font-bold uppercase tracking-wide text-zinc-500">Anggota ({detail.members.length})</h4>
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
                  <button type="button" disabled={busy} onClick={() => void run(() => removeMember(detail.team.id, m.user_id))} className="rounded px-1 text-xs text-zinc-500 hover:text-red-400 disabled:opacity-50">Keluarkan</button>
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
                placeholder="teammate@example.com"
                autoComplete="off"
                className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none"
              />
              <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none">
                <option value="admin">admin</option>
                <option value="staff">staff</option>
              </select>
              <button type="submit" disabled={busy || !inviteEmail.trim()} className="rounded-md bg-zinc-700 px-3 py-2 text-sm font-bold text-white hover:bg-zinc-600 disabled:opacity-50">
                Undang
              </button>
            </form>
          )}
          <h4 className="mt-5 text-sm font-bold uppercase tracking-wide text-zinc-500">Asisten AI ({detail.bots.length})</h4>
          <ul className="mt-2 space-y-1">
            {detail.bots.map((b) => {
              const owner = detail.members.find((m) => m.user_id === b.owner_user_id);
              return (
              <li key={b.id} className="rounded-md bg-zinc-800/60 px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-semibold">{b.name}</span>
                  <span className="shrink-0 text-xs text-zinc-500">◈ {owner ? (owner.name || owner.email) : "unassigned"}</span>
                </div>
                {canManage && (
                  <label className="mt-1 flex items-center gap-2 text-xs text-zinc-400">
                    Partner (penanggung jawab)
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
                          title={has ? `Cabut akses ${b.name} dari ${m.email}` : `Beri akses ${b.name} ke ${m.email}`}
                          onClick={() => void run(() => has ? revokeBotAccess(detail.team.id, b.id, m.user_id, m.bot_ids) : grantBotAccess(detail.team.id, b.id, m.user_id, m.bot_ids))}
                          className={`rounded border px-2 py-0.5 text-xs ${has ? "border-emerald-700 text-emerald-400" : "border-zinc-700 text-zinc-500 hover:text-zinc-200"}`}
                        >
                          {m.email}: {has ? "boleh" : "beri akses"}
                        </button>
                      );
                    })}
                  </div>
                )}
              </li>
              );
            })}
            {detail.bots.length === 0 && <p className="text-sm text-zinc-600">Belum ada asisten di tim ini.</p>}
          </ul>
          {canManage && (
            <>
              <h4 className="mt-5 text-sm font-bold uppercase tracking-wide text-zinc-500">Obrolan terakhir (semua asisten)</h4>
              {activity.length === 0 ? (
                <p className="mt-1 text-sm text-zinc-600">Belum ada obrolan asisten.</p>
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
    } catch (err) { setError(err instanceof Error ? err.message : "Could not load Fly state."); }
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
    } catch (err) { setError(err instanceof Error ? err.message : "Fly connect failed."); }
    finally { setBusy(false); }
  }

  async function provision(accountId: string) {
    if (!teamId || !slug.trim() || busy) return;
    setBusy(true); setError("");
    try { await provisionFly(teamId, { account_id: accountId, name: slug.trim().toLowerCase() }); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : "Provision failed."); }
    finally { setBusy(false); }
  }

  return (
    <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="mb-1 text-sm font-bold uppercase tracking-wide text-zinc-500">Server (Fly.io)</h3>
      <p className="mb-2 text-xs text-zinc-500">Sambungkan akun Fly.io milik usaha. Slaver menyiapkan 2 mesin terpisah: <b>prod</b> (stabil, untuk aplikasi yang dilihat pelanggan) + <b>dev</b> (untuk coba-coba). Token tersimpan aman di server.</p>
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      <form onSubmit={connect} className="flex flex-col gap-2">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama akun, cth. warung" disabled={!teamId} className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none disabled:opacity-40" />
          <input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Kode organisasi (opsional)" disabled={!teamId} className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none disabled:opacity-40" />
        </div>
        <input value={token} onChange={(e) => setTokenInput(e.target.value)} placeholder="Token Fly (fo1_...)" type="password" disabled={!teamId} className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none disabled:opacity-40" />
        <div><button type="submit" disabled={!token.trim() || !teamId || busy} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40">{busy ? "Menyimpan..." : "Sambungkan"}</button></div>
      </form>
      {accounts.map((a) => (
        <div key={a.id} className="mt-3 rounded-md bg-zinc-800/60 p-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-zinc-100">{a.name}</span>
            <span className="font-mono text-zinc-500">{a.org || "default org"} · token ✓</span>
            <button type="button" onClick={() => teamId && disconnectFly(teamId, a.id).then(refresh)} className="ml-auto text-zinc-500 hover:text-red-400">Putuskan</button>
          </div>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="nama pendek, cth. warung" className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
            <button type="button" onClick={() => provision(a.id)} disabled={!slug.trim() || busy} className="rounded-md bg-sky-600 px-3 py-1.5 font-bold text-white hover:bg-sky-500 disabled:opacity-40">Buatkan 2 mesin</button>
          </div>
          <p className="mt-1 text-zinc-500">Membuat <span className="font-mono">{slug || "slug"}-prod</span> (asli) + <span className="font-mono">{slug || "slug"}-dev</span> (uji coba).</p>
        </div>
      ))}
      {machines.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {machines.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-2 rounded-md bg-zinc-800/60 px-3 py-2 font-mono text-xs">
              <span className={m.role === "prod" ? "font-bold text-emerald-400" : "font-bold text-sky-400"}>{m.role}</span>
              <span className="text-zinc-100">{m.app_name}</span>
              <span className="text-zinc-500">{m.machine_id.slice(0, 8)} · {m.image} · {m.cpus}cpu/{m.memory_mb}MB · {m.status}</span>
              <button type="button" onClick={() => teamId && destroyFlyMachine(teamId, m.id, false).then(refresh)} className="ml-auto text-zinc-500 hover:text-red-400">Hapus</button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 border-t border-zinc-800 pt-3">
        <div className="mb-1 text-xs font-bold uppercase tracking-wide text-zinc-500">Alamat web — {`{nama}.slaver.app`}</div>
        <p className="mb-2 text-[11px] text-zinc-500">Catat di sini, lalu buat sendiri DNS-nya (A/AAAA ke IP Fly, atau CNAME ke nama app Fly) — tanpa integrasi DNS otomatis.</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input value={sub} onChange={(e) => setSub(e.target.value)} placeholder="nama depan, cth. kasirku" className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
          <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="tujuan: xxx.fly.dev atau IP" className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
          <button type="button" onClick={async () => { if (!teamId || !sub.trim() || !target.trim()) return; setError(""); try { await addDomain(teamId, { subdomain: sub.trim().toLowerCase(), target: target.trim() }); setSub(""); setTarget(""); await refresh(); } catch (err) { setError(err instanceof Error ? err.message : "Gagal pasang alamat."); } }} className="rounded-md bg-zinc-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-zinc-600">Pasang alamat</button>
        </div>
        {domains.map((d) => (
          <div key={d.id} className="mt-1 flex items-center gap-2 font-mono text-xs text-zinc-400">
            <span className="text-zinc-100">{d.hostname}</span><span>→ {d.target}</span><span className="text-zinc-600">[{d.status}]</span>
            <button type="button" onClick={() => teamId && removeDomain(teamId, d.id).then(refresh)} className="ml-auto text-zinc-600 hover:text-red-400">lepas</button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DeveloperSection({ teamId }: { teamId: string | null }) {
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
      setError(err instanceof Error ? err.message : "Could not load OAuth clients.");
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
      setError(err instanceof Error ? err.message : "Could not create client.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(clientId: string) {
    if (!teamId || !window.confirm("Cabut akses ini? Pelanggan yang sedang masuk langsung keluar.")) return;
    setError("");
    try {
      await revokeOAuthClient(teamId, clientId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke client.");
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="mb-1 text-sm font-bold uppercase tracking-wide text-zinc-500">Login dengan Slaver</h3>
      <p className="mb-2 text-xs text-zinc-500">
        Pelanggan bisa masuk ke aplikasimu dengan akun Slaver-nya. Aplikasi menerima nama, email, tim, dan peran mereka.
      </p>
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      {newSecret && (
        <div className="mb-2 rounded-md border border-amber-700 bg-amber-950/60 p-2 text-xs text-amber-200">
          <div className="font-bold">Salin kunci rahasia sekarang — hanya tampil sekali.</div>
          <div className="mt-1 break-all font-mono">client_id: {newSecret.id}</div>
          <div className="break-all font-mono">client_secret: {newSecret.secret}</div>
        </div>
      )}
      <form onSubmit={create} className="flex flex-col gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nama aplikasi, cth. Kasir Warung Saya"
          disabled={!teamId}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none disabled:opacity-40"
        />
        <input
          value={redirects}
          onChange={(e) => setRedirects(e.target.value)}
          placeholder="Alamat kembali, pisah koma — https://aplikasi.com/oauth/callback"
          disabled={!teamId}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none disabled:opacity-40"
        />
        <div>
          <button type="submit" disabled={!name.trim() || !redirects.trim() || !teamId || busy} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40">
            {busy ? "Membuat..." : "Buat akses login"}
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
                Cabut
              </button>
            </li>
          ))}
        </ul>
      )}
      {!teamId && <p className="mt-1 text-xs text-zinc-500">Pilih tim dulu (khusus pemilik/admin).</p>}
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
}: {
  user: User;
  teams: Team[];
  teamId: string | null;
  memberNames: Record<string, string>;
  onPickTeam: (id: string) => void;
  onTeamsChanged: () => Promise<void>;
  onCreateBot: (ownerId: string) => Promise<void>;
  onLogout: () => void;
}) {
  const [createOwner, setCreateOwner] = useState(user.id);
  const [creating, setCreating] = useState(false);

  async function create() {
    if (creating) return;
    setCreating(true);
    try {
      await onCreateBot(createOwner || user.id);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <h2 className="text-xl font-bold text-zinc-100">Pengaturan</h2>

      <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-zinc-500">Profil</h3>
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-zinc-800 text-lg font-bold text-zinc-200">
            {(user.name || user.email || "?").slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold text-zinc-100">{user.name || "Unnamed"}</div>
            <div className="truncate text-xs text-zinc-500">{user.email}</div>
          </div>
          <button type="button" onClick={onLogout} className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">
            Keluar
          </button>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <h3 className="mb-1 text-sm font-bold uppercase tracking-wide text-zinc-500">Asisten AI baru</h3>
        <p className="mb-2 text-xs text-zinc-500">Asisten tinggal di tim yang dipilih dan muncul di Chat.</p>
        <div className="flex gap-2">
          <select
            value={createOwner}
            onChange={(e) => setCreateOwner(e.target.value)}
            title="Partner (penanggung jawab)"
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
          >
            <option value={user.id}>{memberNames[user.id] ?? "Saya"}</option>
            {Object.entries(memberNames).filter(([id]) => id !== user.id).map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
          <button type="button" onClick={create} disabled={creating || !teamId} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40">
            {creating ? "Membuat..." : "Buat"}
          </button>
        </div>
        {!teamId && <p className="mt-1 text-xs text-amber-300">Pilih tim dulu.</p>}
      </div>

      <div className="mt-4">
        <TeamsView
          teams={teams}
          teamId={teamId}
          userId={user.id}
          onChanged={onTeamsChanged}
          onSelect={onPickTeam}
        />
      </div>

      <FlySection teamId={teamId} />

      <DeveloperSection teamId={teamId} />
    </div>
  );
}
