import { useCallback, useEffect, useRef, useState } from "react";
import {
  harnessListRuns,
  harnessRunDetail,
  harnessStartRun,
  readHarnessEvents,
  type HarnessRun,
  type HarnessStep,
} from "./api";

interface Line {
  key: number;
  kind: "prompt" | "text" | "tool_call" | "tool_result" | "step" | "done" | "error";
  title: string;
  body: string;
}

const DEFAULT_MODEL = "glm-5.3-flash";

export default function HarnessView({ teamId }: { teamId: string | null }) {
  const [model, setModel] = useState(() => localStorage.getItem("harness_model") || DEFAULT_MODEL);
  const [prompt, setPrompt] = useState("");
  const [repoId, setRepoId] = useState("");
  const [issueId, setIssueId] = useState("");
  const [issueTitle, setIssueTitle] = useState("");
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState("");
  const [runs, setRuns] = useState<HarnessRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const keyRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const push = useCallback((kind: Line["kind"], title: string, body: string) => {
    setLines((prev) => [...prev, { key: ++keyRef.current, kind, title, body }]);
  }, []);

  const refreshRuns = useCallback(async () => {
    setLoadingRuns(true);
    try {
      setRuns(await harnessListRuns(teamId ?? undefined));
    } catch {
      /* harness may be unconfigured — shown on start */
    } finally {
      setLoadingRuns(false);
    }
  }, [teamId]);

  useEffect(() => {
    void refreshRuns();
    // Prefill from channel board "Start agent run".
    try {
      const raw = localStorage.getItem("harness_prefill");
      if (raw) {
        const p = JSON.parse(raw) as { prompt?: string; repoId?: string; issueId?: string; title?: string };
        if (p.prompt) setPrompt(p.prompt);
        if (p.repoId) setRepoId(p.repoId);
        if (p.issueId) setIssueId(p.issueId);
        if (p.title) setIssueTitle(p.title);
        localStorage.removeItem("harness_prefill");
      }
    } catch {
      /* ignore */
    }
  }, [refreshRuns]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [lines]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  async function start(e?: React.FormEvent) {
    e?.preventDefault();
    const text = prompt.trim();
    if (!text || running || !teamId) return;
    setError("");
    setLines([]);
    setRunning(true);
    const ac = new AbortController();
    abortRef.current = ac;
    localStorage.setItem("harness_model", model.trim() || DEFAULT_MODEL);
    push("prompt", issueTitle ? `Issue: ${issueTitle}` : "Task", text);
    setPrompt("");
    setIssueTitle("");
    try {
      const res = await harnessStartRun(teamId, model.trim() || DEFAULT_MODEL, text, ac.signal, repoId || undefined, issueId || undefined);
      await readHarnessEvents(
        res,
        (ev) => {
          const d = ev.data as Record<string, unknown>;
          const str = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : "");
          if (ev.type === "run") {
            push("step", "Run started", `${str("model")}`);
          } else if (ev.type === "step") {
            push("step", `Step ${String(d.n ?? "")}`, "");
          } else if (ev.type === "text") {
            push("text", "Agent", str("text"));
          } else if (ev.type === "tool_call") {
            const args = d.args;
            push("tool_call", `$ ${str("name")}`, typeof args === "string" ? args : JSON.stringify(args ?? {}));
          } else if (ev.type === "tool_result") {
            push("tool_result", str("name") || "result", str("output"));
          } else if (ev.type === "done") {
            push("done", "Done", `${String(d.steps ?? 0)} steps · ${String(d.prompt_tokens ?? 0)} in / ${String(d.completion_tokens ?? 0)} out`);
            void refreshRuns();
          } else if (ev.type === "error") {
            push("error", "Error", str("message"));
          }
        },
        ac.signal,
      );
    } catch (err) {
      if (ac.signal.aborted) {
        push("step", "Stopped", "Run stopped by user.");
      } else {
        const msg = err instanceof Error ? err.message : "Run failed.";
        setError(msg);
        push("error", "Error", msg);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  async function openRun(id: string) {
    setError("");
    try {
      const { run, steps } = await harnessRunDetail(id);
      const next: Line[] = [{ key: ++keyRef.current, kind: "prompt", title: `Task · ${run.model} · ${run.status}`, body: run.prompt }];
      for (const s of steps as HarnessStep[]) {
        if (s.kind === "text") next.push({ key: ++keyRef.current, kind: "text", title: "Agent", body: s.output });
        else if (s.kind === "tool") next.push({ key: ++keyRef.current, kind: "tool_result", title: s.name, body: s.output });
        else if (s.kind === "error") next.push({ key: ++keyRef.current, kind: "error", title: "Error", body: s.output });
      }
      setLines(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load run.");
    }
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col px-4 py-4">
      <div className="mb-3 rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-zinc-100">Harness <span className="ml-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-bold uppercase text-zinc-400">beta</span></h2>
          <span className="text-xs text-zinc-500">Codex-like runs in an isolated Linux container</span>
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          The agent reads/writes files and runs shell commands in its own Sandbox. Use a chat/completions Go model
          (e.g. <span className="font-mono text-zinc-300">glm-5.3-flash</span>, <span className="font-mono text-zinc-300">kimi-k2.7-code</span>) — responses-only models like the Spark family can't take tools.
        </p>
        <form onSubmit={start} className="mt-3 flex flex-col gap-2">
          <div className="flex gap-2">
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Model id, e.g. glm-5.3-flash"
              spellCheck={false}
              disabled={running}
              className="w-56 shrink-0 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none disabled:opacity-40"
            />
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void start();
                }
              }}
              placeholder={teamId ? "Describe the coding task, e.g. Scaffold a vite app and make npm run build pass" : "Pick a team first (sidebar)"}
              rows={2}
              disabled={running || !teamId}
              className="max-h-40 flex-1 resize-none rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none disabled:opacity-40"
            />
          </div>
          {(repoId || issueId) && (
            <div className="flex items-center gap-2 text-xs text-zinc-400">
              <span className="rounded bg-zinc-800 px-2 py-0.5">
                Linked {issueTitle ? `issue “${issueTitle.slice(0, 40)}”` : "issue"} {repoId ? `· repo ${repoId.slice(0, 8)}` : "· no repo"}
              </span>
              <button
                type="button"
                onClick={() => { setRepoId(""); setIssueId(""); setIssueTitle(""); }}
                className="text-zinc-500 hover:text-zinc-200"
              >
                unlink
              </button>
            </div>
          )}
          <div className="flex gap-2">
            {!running ? (
              <button type="submit" disabled={!prompt.trim() || !teamId} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40">
                Run in sandbox
              </button>
            ) : (
              <button type="button" onClick={stop} className="rounded-md bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-500">
                Stop
              </button>
            )}
          </div>
        </form>
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-[13px]">
        {lines.length === 0 && (
          <p className="py-8 text-center font-sans text-sm text-zinc-500">
            No output yet. Start a run above, or open a past run below.
          </p>
        )}
        {lines.map((l) => (
          <div key={l.key} className="mb-2">
            {l.kind === "step" && (
              <div className="mt-2 flex items-center gap-2 text-zinc-500">
                <div className="h-px flex-1 bg-zinc-800" />
                <span className="text-[11px] font-bold uppercase">{l.title}</span>
                <div className="h-px flex-1 bg-zinc-800" />
              </div>
            )}
            {l.kind === "prompt" && (
              <div className="rounded bg-zinc-900 p-2">
                <div className="mb-1 font-sans text-[11px] font-bold uppercase text-zinc-500">{l.title}</div>
                <div className="whitespace-pre-wrap break-words font-sans text-zinc-200">{l.body}</div>
              </div>
            )}
            {l.kind === "text" && <div className="whitespace-pre-wrap break-words font-sans text-zinc-200">{l.body}</div>}
            {l.kind === "tool_call" && (
              <div className="rounded bg-emerald-950/50 px-2 py-1 text-emerald-300">
                <span className="font-bold">$ {l.title.replace(/^\$ /, "")}</span>
                <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-[12px] text-emerald-200/80">{l.body}</pre>
              </div>
            )}
            {l.kind === "tool_result" && (
              <details className="rounded bg-zinc-900 px-2 py-1" open={l.body.length < 600}>
                <summary className="cursor-pointer text-zinc-400">{l.title || "result"}</summary>
                <pre className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-[12px] text-zinc-300">{l.body}</pre>
              </details>
            )}
            {l.kind === "done" && <div className="font-sans text-sm font-bold text-emerald-400">✓ {l.body}</div>}
            {l.kind === "error" && <div className="font-sans text-sm text-red-400">✗ {l.body}</div>}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="mt-3">
        <div className="mb-1 text-xs font-bold uppercase tracking-wide text-zinc-500">
          Past runs {loadingRuns ? "…" : `(${runs.length})`}
        </div>
        {runs.length === 0 ? (
          <p className="text-xs text-zinc-600">No runs yet.</p>
        ) : (
          <div className="flex max-h-28 flex-col gap-1 overflow-y-auto">
            {runs.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => openRun(r.id)}
                className="truncate rounded-md px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800"
              >
                <span className={`mr-2 inline-block h-2 w-2 rounded-full ${r.status === "done" ? "bg-emerald-500" : r.status === "error" ? "bg-red-500" : "bg-amber-500"}`} />
                <span className="font-mono text-zinc-400">{r.model}</span> · {r.prompt.slice(0, 60)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
