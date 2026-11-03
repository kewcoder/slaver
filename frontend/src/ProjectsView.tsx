import { useCallback, useEffect, useState } from "react";
import {
  assignIssue,
  createIssue,
  createProject,
  fetchIssues,
  fetchProjects,
  moveIssue,
  setProjectRepo,
  fetchRepos,
  type Issue,
  type Project,
  type ProjectStats,
  type Repo,
  type SlaveBot,
} from "./api";

const COLUMNS = [
  { id: "backlog", label: "Backlog" },
  { id: "todo", label: "Todo" },
  { id: "in_progress", label: "In Progress" },
  { id: "in_review", label: "In Review" },
  { id: "done", label: "Done" },
] as const;

const PRIORITY_COLORS: Record<string, string> = {
  low: "bg-zinc-700 text-zinc-300",
  medium: "bg-blue-950 text-blue-300",
  high: "bg-amber-950 text-amber-300",
  urgent: "bg-red-950 text-red-300",
};

export default function ProjectsView({
  teamId,
  bots,
  onStartRun,
}: {
  teamId: string | null;
  bots: SlaveBot[];
  onStartRun: (opts: { prompt: string; repoId: string; issueId: string; title: string }) => void;
}) {
  const [projects, setProjects] = useState<{ project: Project; stats: ProjectStats }[]>([]);
  const [projectId, setProjectId] = useState("");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [newProject, setNewProject] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");
  const [newAssignee, setNewAssignee] = useState("");
  const [selected, setSelected] = useState<Issue | null>(null);
  const [error, setError] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const active = projects.find((p) => p.project.id === (projectId || projects[0]?.project.id));

  const refreshProjects = useCallback(async () => {
    if (!teamId) {
      setProjects([]);
      return;
    }
    try {
      const list = await fetchProjects(teamId);
      setProjects(list);
      const pending = localStorage.getItem("projects_open");
      if (pending && list.some((p) => p.project.id === pending)) {
        setProjectId(pending);
        localStorage.removeItem("projects_open");
      } else if (!list.some((p) => p.project.id === projectId) && list.length > 0) {
        setProjectId(list[0].project.id);
      }
      setRepos(await fetchRepos(teamId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load projects.");
    }
  }, [teamId, projectId]);

  const refreshIssues = useCallback(async () => {
    const pid = projectId || projects[0]?.project.id;
    if (!pid) {
      setIssues([]);
      return;
    }
    try {
      setIssues(await fetchIssues(pid));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load issues.");
    }
  }, [projectId, projects]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);
  useEffect(() => {
    void refreshIssues();
  }, [refreshIssues]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!teamId || !newProject.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const p = await createProject(teamId, newProject.trim());
      setNewProject("");
      await refreshProjects();
      setProjectId(p.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create project.");
    } finally {
      setBusy(false);
    }
  }

  async function addIssue(e: React.FormEvent) {
    e.preventDefault();
    const pid = projectId || projects[0]?.project.id;
    if (!pid || !newTitle.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await createIssue(pid, newTitle.trim(), newBody.trim(), newAssignee);
      setNewTitle("");
      setNewBody("");
      setNewAssignee("");
      await refreshIssues();
      await refreshProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create issue.");
    } finally {
      setBusy(false);
    }
  }

  async function move(id: string, state: string) {
    setError("");
    try {
      const updated = await moveIssue(id, state);
      setIssues((prev) => prev.map((i) => (i.id === id ? updated : i)));
      if (selected?.id === id) setSelected(updated);
      await refreshProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not move issue.");
    }
  }

  async function assign(id: string, botId: string) {
    setError("");
    try {
      const updated = await assignIssue(id, botId);
      setIssues((prev) => prev.map((i) => (i.id === id ? updated : i)));
      if (selected?.id === id) setSelected(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not assign.");
    }
  }

  async function attachRepo(repoId: string) {
    const pid = projectId || projects[0]?.project.id;
    if (!pid || !repoId) return;
    setError("");
    try {
      await setProjectRepo(pid, repoId);
      await refreshProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not attach repo.");
    }
  }

  function onDropColumn(state: string, e: React.DragEvent) {
    e.preventDefault();
    if (dragId) {
      void move(dragId, state);
      setDragId(null);
    }
  }

  const pct = active && active.stats.total > 0 ? Math.round((active.stats.done / active.stats.total) * 100) : 0;

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-3 px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-bold text-zinc-100">Projects</h2>
        <select
          value={projectId || projects[0]?.project.id || ""}
          onChange={(e) => { setProjectId(e.target.value); setSelected(null); }}
          disabled={!teamId || projects.length === 0}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none disabled:opacity-40"
        >
          {projects.map((p) => (
            <option key={p.project.id} value={p.project.id}>{p.project.name}</option>
          ))}
          {projects.length === 0 && <option value="">No project yet</option>}
        </select>
        <form onSubmit={create} className="flex gap-1">
          <input
            value={newProject}
            onChange={(e) => setNewProject(e.target.value)}
            placeholder="New project name"
            disabled={!teamId}
            className="w-40 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none disabled:opacity-40"
          />
          <button type="submit" disabled={!newProject.trim() || !teamId || busy} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40">
            +
          </button>
        </form>
        {active && (
          <div className="ml-auto flex items-center gap-2 text-xs text-zinc-400">
            <span>{active.stats.done}/{active.stats.total} done</span>
            <span className="h-2 w-28 overflow-hidden rounded-full bg-zinc-800">
              <span className="block h-full bg-emerald-500" style={{ width: `${pct}%` }} />
            </span>
            <span>{pct}%</span>
          </div>
        )}
      </div>

      {active && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1 text-zinc-400">
            Repo:
            <select
              value={active.project.repo_id || ""}
              onChange={(e) => attachRepo(e.target.value)}
              className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-100 focus:border-emerald-500 focus:outline-none"
            >
              <option value="">(none)</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </label>
          {active.project.description && <span className="truncate text-zinc-500">{active.project.description}</span>}
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      {!teamId ? (
        <p className="py-8 text-center text-sm text-zinc-500">Pick a team in the sidebar to see its projects.</p>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-x-auto md:grid-cols-5 md:overflow-visible">
          {COLUMNS.map((col) => (
            <div
              key={col.id}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => onDropColumn(col.id, e)}
              className="flex min-h-40 flex-col rounded-lg border border-zinc-800 bg-zinc-950 p-2"
            >
              <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-[11px] font-bold uppercase tracking-wide text-zinc-500">{col.label}</span>
                <span className="rounded bg-zinc-800 px-1.5 text-[11px] text-zinc-400">
                  {issues.filter((i) => i.state === col.id).length}
                </span>
              </div>
              <div className="flex flex-1 flex-col gap-2 overflow-y-auto">
                {issues.filter((i) => i.state === col.id).map((issue) => (
                  <button
                    key={issue.id}
                    type="button"
                    draggable
                    onDragStart={() => setDragId(issue.id)}
                    onDragEnd={() => setDragId(null)}
                    onClick={() => setSelected(issue)}
                    className={`rounded-md border bg-zinc-900 p-2 text-left hover:border-zinc-600 ${selected?.id === issue.id ? "border-emerald-600" : "border-zinc-800"}`}
                  >
                    <div className="truncate text-[13px] font-semibold text-zinc-100">{issue.title}</div>
                    <div className="mt-1 flex items-center gap-1">
                      <span className={`rounded px-1 text-[10px] font-bold uppercase ${PRIORITY_COLORS[issue.priority] ?? PRIORITY_COLORS.medium}`}>
                        {issue.priority}
                      </span>
                      {issue.assignee_name ? (
                        <span className="truncate text-[11px] text-emerald-300">◈ {issue.assignee_name}</span>
                      ) : (
                        <span className="text-[11px] text-zinc-600">unassigned</span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <form onSubmit={addIssue} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
          <h3 className="mb-2 text-sm font-bold text-zinc-200">New issue</h3>
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Title, e.g. Add QRIS checkout"
            disabled={!active}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none disabled:opacity-40"
          />
          <textarea
            value={newBody}
            onChange={(e) => setNewBody(e.target.value)}
            placeholder="Acceptance criteria (optional)"
            rows={2}
            disabled={!active}
            className="mt-2 w-full resize-none rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none disabled:opacity-40"
          />
          <div className="mt-2 flex gap-2">
            <select
              value={newAssignee}
              onChange={(e) => setNewAssignee(e.target.value)}
              disabled={!active}
              className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none disabled:opacity-40"
            >
              <option value="">Unassigned</option>
              {bots.filter((b) => !b.archived).map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
            <button type="submit" disabled={!newTitle.trim() || !active || busy} className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40">
              Add
            </button>
          </div>
        </form>

        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
          <h3 className="mb-2 text-sm font-bold text-zinc-200">Issue detail</h3>
          {!selected ? (
            <p className="text-xs text-zinc-500">Click a card to inspect, assign, move, or start an agent run.</p>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="font-semibold text-zinc-100">{selected.title}</div>
              {selected.body && <p className="whitespace-pre-wrap text-xs text-zinc-400">{selected.body}</p>}
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                Assignee
                <select
                  value={selected.assignee_bot_id || ""}
                  onChange={(e) => assign(selected.id, e.target.value)}
                  className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-100 focus:border-emerald-500 focus:outline-none"
                >
                  <option value="">Unassigned</option>
                  {bots.filter((b) => !b.archived).map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </label>
              <div className="flex flex-wrap gap-1">
                {COLUMNS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    disabled={selected.state === c.id}
                    onClick={() => move(selected.id, c.id)}
                    className={`rounded px-2 py-1 text-[11px] font-bold ${selected.state === c.id ? "bg-zinc-700 text-zinc-300" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"} disabled:opacity-60`}
                  >
                    → {c.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => onStartRun({
                  prompt: `Issue: ${selected.title}\n${selected.body}\n\nAcceptance criteria: complete the task, run checks, commit on the issue branch.`,
                  repoId: active?.project.repo_id || "",
                  issueId: selected.id,
                  title: selected.title,
                })}
                className="mt-1 rounded-md bg-emerald-600 px-3 py-2 text-sm font-bold text-white hover:bg-emerald-500"
              >
                ▶ Start agent run {selected.assignee_name ? `as ${selected.assignee_name}` : ""}
              </button>
              <p className="text-[11px] text-zinc-500">Run opens in Harness with the repo checked out on a branch. Done → In Review automatically.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
