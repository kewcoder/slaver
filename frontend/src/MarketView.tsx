import { useCallback, useEffect, useState } from "react";
import {
  buyLicense,
  fetchLicenses,
  fetchProjects,
  fetchTemplates,
  type License,
  type Project,
  type ProjectStats,
  type Repo,
} from "./api";

export default function MarketView({
  teamId,
  onOpenProject,
  onOpenSupport,
}: {
  teamId: string | null;
  onOpenProject: (projectId: string) => void;
  onOpenSupport: (repoId: string) => Promise<void>;
}) {
  const [templates, setTemplates] = useState<Repo[]>([]);
  const [licenses, setLicenses] = useState<License[]>([]);
  const [projects, setProjects] = useState<{ project: Project; stats: ProjectStats }[]>([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [supportBusy, setSupportBusy] = useState<string | null>(null);

  async function openSupport(repoId: string) {
    setError("");
    setSupportBusy(repoId);
    try {
      await onOpenSupport(repoId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No support channel yet — ask the owning team to open one.");
    } finally {
      setSupportBusy(null);
    }
  }

  const refresh = useCallback(async () => {
    setError("");
    try {
      setTemplates(await fetchTemplates());
      if (teamId) {
        setLicenses(await fetchLicenses(teamId));
        setProjects(await fetchProjects(teamId));
      } else {
        setLicenses([]);
        setProjects([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load marketplace.");
    }
  }, [teamId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const licensedRepoIds = new Set(licenses.filter((l) => l.status === "active").map((l) => l.repo_id));

  async function buy(repo: Repo) {
    if (!teamId || busyId) return;
    setBusyId(repo.id);
    setError("");
    try {
      const res = await buyLicense(teamId, repo.id);
      await refresh();
      onOpenProject(res.project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Checkout failed.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-4">
      <h2 className="font-bold text-zinc-100">Marketplace</h2>
      <p className="mt-1 text-sm text-zinc-400">
        Buy once, customize forever. Every purchase includes a private fork, a ready project, and 12 months of updates + support.
      </p>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}

      <h3 className="mb-2 mt-5 text-sm font-bold uppercase tracking-wide text-zinc-500">Templates</h3>
      {templates.length === 0 ? (
        <p className="text-sm text-zinc-500">No templates published yet — check back soon.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {templates.map((t) => {
            const owned = licensedRepoIds.has(t.id);
            const project = projects.find((p) => p.project.repo_id && licensedRepoIds.has(t.id) && p.project.name.startsWith(t.name.split(" ")[0]));
            return (
              <div key={t.id} className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900 p-4">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold text-zinc-100">{t.name}</h4>
                  {owned ? (
                    <span className="rounded bg-emerald-950 px-2 py-0.5 text-[11px] font-bold text-emerald-300">OWNED</span>
                  ) : (
                    <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-bold text-zinc-300">BUY ONCE</span>
                  )}
                </div>
                {t.description && <p className="mt-1 flex-1 text-sm text-zinc-400">{t.description}</p>}
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => openSupport(t.id)}
                    disabled={supportBusy === t.id}
                    title="Ask in the seller's public support channel (their AI bots reply)"
                    className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                  >
                    {supportBusy === t.id ? "Opening…" : "💬 Support"}
                  </button>
                  {owned ? (
                    <button
                      type="button"
                      onClick={() => project && onOpenProject(project.project.id)}
                      disabled={!project}
                      className="rounded-md bg-zinc-700 px-4 py-2 text-sm font-bold text-white hover:bg-zinc-600 disabled:opacity-40"
                    >
                      {project ? "Open project" : "Licensed"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => buy(t)}
                      disabled={!teamId || busyId === t.id}
                      title={!teamId ? "Pick a team first" : "Mock checkout — includes fork + project + 12mo support"}
                      className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40"
                    >
                      {busyId === t.id ? "Processing…" : "Buy & fork"}
                    </button>
                  )}
                  <span className="text-[11px] text-zinc-500">Includes 12 months updates + support</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <h3 className="mb-2 mt-6 text-sm font-bold uppercase tracking-wide text-zinc-500">My licenses {teamId ? "" : "(pick a team)"}</h3>
      {licenses.length === 0 ? (
        <p className="text-sm text-zinc-600">No licenses on this team yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {licenses.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-2 rounded-md bg-zinc-900 px-3 py-2 text-sm">
              <span className="font-mono text-xs text-zinc-400">{l.repo_id.slice(0, 8)}</span>
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300">{l.kind}</span>
              <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${l.status === "active" ? "bg-emerald-950 text-emerald-300" : "bg-zinc-800 text-zinc-400"}`}>
                {l.status}
              </span>
              <span className="text-xs text-zinc-500">support until {l.support_until || "—"} · {l.provider}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
