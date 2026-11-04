import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchGithubLink,
  fetchGithubRepos,
  fetchGithubStatus,
  githubConnectToken,
  githubDisconnect,
  githubLink,
  githubOauthStart,
  githubSync,
  githubUnlink,
  type GithubAccount,
  type GithubLink,
  type GithubRepo,
} from "./api";
import { useLang } from "./i18n";
import { Icon, Spinner } from "./ui";

function ago(iso: string): string {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Publish → Source → GitHub: connect, pick a (private) repo, mirror it into Slaver git. */
export default function GithubSource({
  teamId,
  repoId,
  canManage,
  onLinkChange,
  onSynced,
}: {
  teamId: string;
  repoId: string;
  canManage: boolean;
  onLinkChange: (l: GithubLink | null) => void;
  onSynced: () => void;
}) {
  const { t } = useLang();
  const [oauth, setOauth] = useState(false);
  const [accounts, setAccounts] = useState<GithubAccount[]>([]);
  const [link, setLink] = useState<GithubLink | null>(null);
  const [accountId, setAccountId] = useState("");
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<GithubRepo | null>(null);
  const [branch, setBranch] = useState("");
  const [pat, setPat] = useState("");
  const [showPat, setShowPat] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const [st, l] = await Promise.all([fetchGithubStatus(teamId), fetchGithubLink(repoId)]);
      setOauth(st.oauth);
      setAccounts(st.accounts);
      setAccountId((cur) => (st.accounts.some((a) => a.id === cur) ? cur : st.accounts[0]?.id ?? ""));
      setLink(l);
      onLinkChange(l);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gh.fail"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, repoId, t]);

  useEffect(() => {
    setRepos(null);
    setPick(null);
    setNotice("");
    setError("");
    void load();
  }, [load]);

  useEffect(() => {
    if (!accountId || link || !canManage) return;
    setRepos(null);
    fetchGithubRepos(teamId, accountId).then(setRepos).catch((err) => setError(err instanceof Error ? err.message : t("gh.fail")));
  }, [accountId, link, teamId, canManage, t]);

  const filtered = useMemo(() => (repos ?? []).filter((r) => !q.trim() || r.full_name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 30), [repos, q]);

  async function run(key: string, fn: () => Promise<string | void>) {
    if (busy) return;
    setBusy(key);
    setError("");
    setNotice("");
    try {
      const m = await fn();
      if (m) setNotice(m);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gh.fail"));
    } finally {
      setBusy(null);
    }
  }

  const connectOauth = () => run("oauth", async () => { window.location.href = await githubOauthStart(teamId); });
  const connectPat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pat.trim()) return;
    void run("pat", async () => {
      const a = await githubConnectToken(teamId, pat.trim());
      setPat("");
      setShowPat(false);
      await load();
      setAccountId(a.id);
    });
  };
  const doLink = () => {
    if (!pick || !accountId) return;
    void run("link", async () => {
      const l = await githubLink(repoId, accountId, pick.full_name, branch.trim() || pick.default_branch);
      setLink(l);
      onLinkChange(l);
      onSynced();
      return t("gh.linkedOk", { repo: l.github_repo });
    });
  };
  const doSync = () => run("sync", async () => {
    const sha = await githubSync(repoId);
    await load();
    onSynced();
    return t("gh.syncedOk", { sha: sha.slice(0, 8) });
  });
  const doUnlink = () => {
    if (!window.confirm(t("gh.unlinkConfirm"))) return;
    void run("unlink", async () => {
      await githubUnlink(repoId);
      await load();
    });
  };

  const msgs = (
    <>
      {error && <p className="text-xs text-red-300">{error}</p>}
      {notice && <p className="text-xs text-[#a2ecc3]">{notice}</p>}
    </>
  );

  // Linked: status + sync.
  if (link) {
    return (
      <div className="flex flex-col gap-3">
        <div className="rounded-xl border border-[#62d89d]/20 bg-[#62d89d]/[0.05] p-3">
          <div className="flex items-center gap-2">
            <Icon name="git" size={15} className="text-[#62d89d]" />
            <a href={`https://github.com/${link.github_repo}`} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-mono text-xs font-bold text-[#e8efeb] hover:underline">
              {link.github_repo}
            </a>
            <span className="soft-badge py-0.5 font-mono">{link.github_branch}</span>
          </div>
          <div className="mt-1.5 text-[11px] text-[#82958a]">{t("gh.lastSync", { ago: ago(link.github_synced_at) })} · {t("gh.autoSync")}</div>
          {link.github_error && <div className="mt-1.5 text-[11px] text-red-300">{link.github_error}</div>}
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={doSync} disabled={!!busy} className="btn-primary">{busy === "sync" ? <Spinner /> : <Icon name="arrow" size={15} />}{t("gh.syncNow")}</button>
            <button type="button" onClick={doUnlink} disabled={!!busy} className="btn-secondary">{t("gh.unlink")}</button>
          </div>
        )}
        {msgs}
      </div>
    );
  }

  // Not connected.
  if (accounts.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-xs leading-5 text-[#82958a]">{t("gh.connectHelp")}</p>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            {oauth && <button type="button" onClick={connectOauth} disabled={!!busy} className="btn-primary">{busy === "oauth" ? <Spinner /> : <Icon name="git" size={15} />}{t("gh.connect")}</button>}
            <button type="button" onClick={() => setShowPat((v) => !v)} className={oauth ? "btn-secondary" : "btn-primary"}>
              <Icon name="tag" size={15} />{t("gh.useToken")}
            </button>
          </div>
        )}
        {showPat && (
          <form onSubmit={connectPat} className="flex flex-col gap-2 rounded-xl border border-white/[0.08] bg-[#0d1411] p-3">
            <p className="text-[11px] leading-5 text-[#82958a]">
              {t("gh.patHelp")}{" "}
              <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer" className="font-semibold text-[#8ce6b8] hover:underline">{t("gh.patCreate")} ↗</a>
            </p>
            <div className="flex flex-wrap gap-2">
              <input type="password" value={pat} onChange={(e) => setPat(e.target.value)} autoComplete="off" placeholder="github_pat_…" className="field min-w-[200px] flex-1 font-mono text-xs" />
              <button type="submit" disabled={!pat.trim() || !!busy} className="btn-primary">{busy === "pat" ? <Spinner /> : <Icon name="check" size={15} />}{t("host.connect")}</button>
            </div>
          </form>
        )}
        {msgs}
      </div>
    );
  }

  // Connected: pick a repo.
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-[#82958a]">
        <span>{t("gh.connectedAs")}</span>
        {accounts.length > 1 ? (
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="field w-auto py-1 text-xs">
            {accounts.map((a) => <option key={a.id} value={a.id}>@{a.login}</option>)}
          </select>
        ) : (
          <span className="font-semibold text-[#e8efeb]">@{accounts[0].login}</span>
        )}
        {canManage && (
          <button type="button" onClick={() => { if (window.confirm(t("gh.disconnectConfirm"))) void run("dc", async () => { await githubDisconnect(teamId, accountId); await load(); }); }} className="ml-auto text-[#718078] hover:text-red-300">
            {t("host.disconnect")}
          </button>
        )}
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("gh.searchPh")} className="field text-xs" />
      <div className="max-h-56 overflow-y-auto rounded-lg border border-white/[0.06] bg-[#0b110e]">
        {repos === null ? (
          <div className="flex items-center gap-2 p-3 text-xs text-[#82958a]"><Spinner />{t("common.loading")}</div>
        ) : filtered.length === 0 ? (
          <div className="p-3 text-xs text-[#82958a]">{t("gh.noRepos")}</div>
        ) : (
          filtered.map((r) => (
            <button
              key={r.full_name}
              type="button"
              onClick={() => { setPick(r); setBranch(r.default_branch); }}
              className={`flex w-full items-center gap-2 border-b border-white/[0.04] px-3 py-2 text-left last:border-0 ${pick?.full_name === r.full_name ? "bg-[#62d89d]/[0.08]" : "hover:bg-white/[0.03]"}`}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-[#e8efeb]">{r.full_name}</span>
              {r.private && <span className="rounded-full bg-white/[0.06] px-1.5 text-[10px] font-semibold text-[#b8c4bd]">{t("gh.private")}</span>}
            </button>
          ))
        )}
      </div>
      {pick && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs font-semibold text-[#b8c4bd]">
            {t("gh.branch")}
            <input value={branch} onChange={(e) => setBranch(e.target.value)} className="field mt-1.5 w-40 font-mono text-xs" />
          </label>
          <button type="button" onClick={doLink} disabled={!!busy || !canManage} className="btn-primary">{busy === "link" ? <Spinner /> : <Icon name="git" size={15} />}{t("gh.linkGo")}</button>
        </div>
      )}
      {msgs}
    </div>
  );
}
