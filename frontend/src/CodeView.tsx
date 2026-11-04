import { useCallback, useEffect, useState } from "react";
import {
  createRepo,
  fetchRepoDetail,
  fetchRepoDiff,
  fetchRepos,
  forkRepo,
  publishRepo,
  type Repo,
} from "./api";
import { useLang } from "./i18n";

interface RepoDetail {
  repo: Repo;
  branches: string[];
  log: { sha: string; author: string; email: string; date: string; subject: string }[];
  clone_url: string;
}

export default function CodeView({ teamId, teamRole }: { teamId: string | null; teamRole: string }) {
  const { t } = useLang();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoId, setRepoId] = useState("");
  const [detail, setDetail] = useState<RepoDetail | null>(null);
  const [diff, setDiff] = useState("");
  const [diffTitle, setDiffTitle] = useState("");
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canManage = teamRole === "owner" || teamRole === "admin";

  const refresh = useCallback(async () => {
    if (!teamId) {
      setRepos([]);
      return;
    }
    try {
      const list = await fetchRepos(teamId);
      setRepos(list);
      if (!list.some((r) => r.id === repoId) && list.length > 0) setRepoId(list[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("files.errLoad"));
    }
  }, [teamId, repoId, t]);

  const openRepo = useCallback(async (id: string) => {
    if (!id) {
      setDetail(null);
      return;
    }
    setError("");
    setDiff("");
    try {
      setDetail(await fetchRepoDetail(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("files.errOpen"));
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    void openRepo(repoId);
  }, [repoId, openRepo]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!teamId || !name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await createRepo(teamId, name.trim(), desc.trim());
      setName("");
      setDesc("");
      await refresh();
      setRepoId(res.repo.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("files.errCreate"));
    } finally {
      setBusy(false);
    }
  }

  async function showDiff(commit: string, title: string) {
    if (!detail) return;
    setError("");
    setDiff(t("files.loadingDiff"));
    setDiffTitle(title);
    try {
      setDiff(await fetchRepoDiff(detail.repo.id, commit));
    } catch (err) {
      setDiff("");
      setError(err instanceof Error ? err.message : t("files.errDiff"));
    }
  }

  async function fork() {
    if (!detail || !teamId || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await forkRepo(detail.repo.id, teamId);
      await refresh();
      setRepoId(r.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("files.errFork"));
    } finally {
      setBusy(false);
    }
  }

  async function togglePublish() {
    if (!detail || busy) return;
    setBusy(true);
    setError("");
    try {
      await publishRepo(detail.repo.id, detail.repo.template === 0);
      await openRepo(detail.repo.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("files.errPublish"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl gap-3 px-4 py-4">
      <div className="flex w-64 shrink-0 flex-col gap-2">
        <h2 className="font-bold text-zinc-100">{t("files.title")}</h2>
        <form onSubmit={create} className="flex gap-1">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("files.newPh")}
            disabled={!teamId}
            className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none disabled:opacity-40"
          />
          <button type="submit" disabled={!name.trim() || !teamId || busy} className="shrink-0 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40">
            +
          </button>
        </form>
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder={t("files.descPh")}
          disabled={!teamId}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none disabled:opacity-40"
        />
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto">
          {repos.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setRepoId(r.id)}
              className={`truncate rounded-md px-2 py-2 text-left text-sm hover:bg-zinc-800 ${r.id === repoId ? "bg-zinc-800 font-semibold text-zinc-100" : "text-zinc-300"}`}
            >
              <span className="mr-1 text-zinc-500">⌥</span>{r.name}
              {r.template !== 0 && <span className="ml-1 rounded bg-zinc-700 px-1 text-[10px] text-zinc-300">{t("files.isTemplate")}</span>}
            </button>
          ))}
          {repos.length === 0 && <p className="px-2 text-xs text-zinc-600">{teamId ? t("files.noRepos") : t("files.pickTeam")}</p>}
        </nav>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto">
        {error && <p className="text-sm text-red-400">{error}</p>}
        {!detail ? (
          <p className="py-16 text-center text-sm text-zinc-500">{t("files.empty")}</p>
        ) : (
          <>
            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-bold text-zinc-100">{detail.repo.name}</h3>
                {detail.repo.fork_of && <span className="text-xs text-zinc-500">{t("files.forked")}</span>}
                <div className="ml-auto flex gap-2">
                  {detail.repo.team_id && (
                    <button type="button" onClick={fork} disabled={busy} className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
                      {t("files.fork")}
                    </button>
                  )}
                  {canManage && detail.repo.template === 0 && (
                    <button type="button" onClick={togglePublish} disabled={busy} className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
                      {t("files.publish")}
                    </button>
                  )}
                  {canManage && detail.repo.template !== 0 && (
                    <button type="button" onClick={togglePublish} disabled={busy} className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
                      {t("files.unpublish")}
                    </button>
                  )}
                </div>
              </div>
              {detail.repo.description && <p className="mt-1 text-xs text-zinc-400">{detail.repo.description}</p>}
              <div className="mt-2 rounded bg-zinc-950 px-2 py-1.5 font-mono text-[12px] text-zinc-300">
                git clone https://&lt;token&gt;@<span className="text-zinc-500">host</span>{detail.clone_url}
              </div>
              <p className="mt-1 text-[11px] text-zinc-500">{t("files.cloneHint")}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                <span className="text-[11px] uppercase tracking-wide text-zinc-500">{t("files.versions")}</span>
                {detail.branches.length === 0 && <span className="text-[11px] text-zinc-600">{t("files.noVersions")}</span>}
                {detail.branches.map((b) => (
                  <span key={b} className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300">{b}</span>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
              <h4 className="mb-2 text-xs font-bold uppercase tracking-wide text-zinc-500">{t("files.history")}</h4>
              {detail.log.length === 0 && <p className="text-xs text-zinc-600">{t("files.emptyHistory")}</p>}
              <ul className="flex flex-col gap-1">
                {detail.log.map((c) => (
                  <li key={c.sha}>
                    <button type="button" onClick={() => showDiff(c.sha, c.subject)} className="block w-full truncate rounded px-2 py-1.5 text-left hover:bg-zinc-800">
                      <span className="font-mono text-[11px] text-emerald-400">{c.sha.slice(0, 8)}</span>{" "}
                      <span className="text-[13px] text-zinc-200">{c.subject}</span>{" "}
                      <span className="text-[11px] text-zinc-500">{c.author} · {c.date.slice(0, 16).replace("T", " ")}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            {diff && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                <h4 className="mb-1 truncate text-xs font-bold text-zinc-400">{diffTitle}</h4>
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-zinc-300">{diff}</pre>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
