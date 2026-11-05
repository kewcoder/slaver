import { useCallback, useEffect, useRef, useState } from "react";
import { connectHosting, fetchCustomize, promoteCustomize, sendCustomize, type CustomizeStatus } from "./api";
import { useLang } from "./i18n";
import { Icon, Spinner } from "./ui";

/** Lovable-style customize: chat with the Meta model on the left, live staging preview on the right. */
export default function CustomizeView({ projectId, teamId, onClose, onRedeploy }: { projectId: string; teamId: string; onClose: () => void; onRedeploy: () => void }) {
  const { t } = useLang();
  const [st, setSt] = useState<CustomizeStatus | null>(null);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [path, setPath] = useState("/");
  const [frameKey, setFrameKey] = useState(0);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const lastDone = useRef("");

  const refresh = useCallback(async () => {
    try {
      const s = await fetchCustomize(projectId);
      setSt(s);
      const done = s.staging.changes.filter((c) => c.status === "done").map((c) => c.id).join(",");
      if (done !== lastDone.current) {
        if (lastDone.current) setFrameKey((k) => k + 1); // reload preview after a finished change
        lastDone.current = done;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const working = !!st?.staging.changes.some((c) => c.status === "working");
  useEffect(() => {
    if (!working) return;
    const h = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(h);
  }, [working, refresh]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [st?.staging.changes.length, working]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    if (!prompt.trim() || working) return;
    setError("");
    setNotice("");
    try {
      await sendCustomize(projectId, prompt.trim());
      setPrompt("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function promote() {
    if (!window.confirm(t("cz.promoteConfirm"))) return;
    setBusy(true);
    setError("");
    try {
      const r = await promoteCustomize(projectId);
      setNotice(r.merged ? t("cz.promoted") : t("cz.nothing"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    setError("");
    try {
      await connectHosting(teamId, { provider: "sprites", api_token: token.trim() });
      setToken("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const url = st?.staging.url ?? "";
  const changes = st?.staging.changes ?? [];
  const hasDone = changes.some((c) => c.status === "done");
  const examples = [t("cz.ex1"), t("cz.ex2"), t("cz.ex3")];

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4">
        <button type="button" onClick={onClose} className="icon-button" aria-label={t("common.close")}><Icon name="x" size={18} /></button>
        <div className="min-w-0">
          <div className="truncate text-sm font-bold text-fg">{t("cz.title", { name: st?.project.name ?? "" })}</div>
          <div className="truncate text-[11px] text-muted">{t("cz.sub")}</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {hasDone && (
            <button type="button" onClick={promote} disabled={busy || working} className="btn-primary px-3 py-1.5 text-xs">
              {busy ? <Spinner /> : <Icon name="rocket" size={14} />}
              {t("cz.promote")}
            </button>
          )}
        </div>
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[400px_minmax(0,1fr)]">
        {/* Chat */}
        <section className="flex min-h-0 flex-col border-r border-line">
          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            {!st ? (
              <div className="loading-skeleton h-20" />
            ) : !st.sprites_connected ? (
              <form onSubmit={connect} className="surface flex flex-col gap-3 rounded-xl p-4">
                <div className="text-sm font-bold text-fg">{t("cz.connectTitle")}</div>
                <p className="text-xs leading-5 text-muted">{t("cz.connectBody")} <a href="https://sprites.dev/account" target="_blank" rel="noreferrer" className="font-semibold text-accent-text hover:underline">sprites.dev/account ↗</a></p>
                <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="org/id/secret" autoComplete="off" className="field font-mono text-xs" />
                <button type="submit" disabled={busy || !token.trim()} className="btn-primary self-start">{busy ? <Spinner /> : <Icon name="check" size={15} />}{t("host.connect")}</button>
              </form>
            ) : changes.length === 0 ? (
              <div className="py-6 text-center">
                <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent-text"><Icon name="spark" size={22} /></span>
                <h3 className="mt-3 font-bold text-fg">{t("cz.emptyTitle")}</h3>
                <p className="mx-auto mt-1 max-w-xs text-sm text-muted">{t("cz.emptyBody")}</p>
                <div className="mt-4 flex flex-col gap-2">
                  {examples.map((ex) => (
                    <button key={ex} type="button" onClick={() => setPrompt(ex)} className="rounded-lg border border-line px-3 py-2 text-left text-sm text-fg-2 hover:bg-hover">{ex}</button>
                  ))}
                </div>
              </div>
            ) : (
              changes.map((c) => (
                <div key={c.id} className="space-y-2">
                  <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-sm text-accent-fg">{c.prompt}</div>
                  <div className="max-w-[90%] rounded-2xl rounded-bl-md bg-surface-2 px-3.5 py-2.5 text-sm text-fg-2">
                    {c.status === "working" ? (
                      <span className="flex items-center gap-2 text-muted"><Spinner />{c.step || t("cz.working")}</span>
                    ) : c.status === "failed" ? (
                      <span className="text-red-300">{c.error}</span>
                    ) : (
                      <>
                        <div className="text-fg">{c.summary}</div>
                        {c.files.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {c.files.map((f) => <span key={f} className="rounded bg-fg/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-muted">{f}</span>)}
                          </div>
                        )}
                        <div className="mt-1.5 text-[11px] text-subtle">{t("cz.onStaging")} · {c.commit.slice(0, 7)}</div>
                      </>
                    )}
                  </div>
                </div>
              ))
            )}
            {notice && (
              <div className="rounded-xl bg-accent/10 px-3 py-2 text-sm text-accent-text">
                {notice}
                <button type="button" onClick={onRedeploy} className="ml-2 font-semibold underline">{t("cz.redeploy")}</button>
              </div>
            )}
            {error && <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>}
            <div ref={endRef} />
          </div>
          {st?.sprites_connected && (
            <form onSubmit={send} className="border-t border-line p-3">
              <div className="flex items-end gap-2 rounded-xl border border-line bg-surface p-2 focus-within:border-accent/50">
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  rows={2}
                  placeholder={t("cz.placeholder")}
                  className="max-h-40 min-h-[44px] flex-1 resize-none bg-transparent px-1 text-sm text-fg outline-none placeholder:text-subtle"
                />
                <button type="submit" disabled={working || !prompt.trim()} className="btn-primary h-9 w-9 p-0" aria-label={t("cz.send")}>
                  {working ? <Spinner /> : <Icon name="arrow" size={16} />}
                </button>
              </div>
            </form>
          )}
        </section>

        {/* Preview */}
        <section className="flex min-h-[50vh] flex-col">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <div className="flex rounded-lg border border-line p-0.5 text-[11px] font-semibold">
              {[["/", t("cz.store")], ["/admin/", t("cz.admin")]].map(([p, label]) => (
                <button key={p} type="button" onClick={() => setPath(p)} className={`rounded-md px-2.5 py-1 ${path === p ? "bg-surface-2 text-fg" : "text-subtle hover:text-fg"}`}>{label}</button>
              ))}
            </div>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-subtle">{url ? `${url}${path}` : t("cz.noStaging")}</span>
            <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-200">staging</span>
            {url && (
              <>
                <button type="button" onClick={() => setFrameKey((k) => k + 1)} className="icon-button h-8 w-8" title={t("cz.reload")}><Icon name="arrow" size={14} /></button>
                <a href={`${url}${path}`} target="_blank" rel="noreferrer" className="icon-button h-8 w-8" title={t("apps.btnOpen")}><Icon name="external" size={14} /></a>
              </>
            )}
          </div>
          {url ? (
            <iframe key={`${frameKey}-${path}`} src={`${url}${path}`} title="staging preview" className="min-h-0 w-full flex-1 bg-white" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted">{working ? t("cz.booting") : t("cz.noStagingBody")}</div>
          )}
        </section>
      </div>
    </div>
  );
}
