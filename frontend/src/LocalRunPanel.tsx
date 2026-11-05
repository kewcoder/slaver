import { useCallback, useEffect, useState } from "react";
import {
  fetchDesktopMeta,
  getToken,
  localrunLogs,
  localrunStart,
  localrunStatus,
  localrunStop,
  tunnelStart,
  tunnelStatus,
  tunnelStop,
  type LocalRunStatus,
  type TunnelState,
} from "./api";
import {
  isDesktop,
  localAppLogs,
  localAppStatus,
  localDeps,
  localRunApp,
  localStopApp,
  localTunnelStart,
  localTunnelStatus,
  localTunnelStop,
} from "./slaver-local";
import { useLang } from "./i18n";
import { Icon, Spinner } from "./ui";

/**
 * Run an owned app on this machine + publish it via Cloudflare tunnel.
 * On desktop (window.SlaverLocal) the repo is cloned from this same server
 * and executed locally; otherwise the /mcp tools run it on the server host.
 */
export default function LocalRunPanel({ projectId, repoId }: { projectId: string; projectName: string; repoId: string }) {
  const { t, lang } = useLang();
  const desktop = isDesktop();
  const key = `run-${projectId}`;
  const [run, setRun] = useState<LocalRunStatus | null>(null);
  const [tun, setTun] = useState<TunnelState | null>(null);
  const [bunOk, setBunOk] = useState<boolean | null>(null);
  const [cfOk, setCfOk] = useState<boolean | null>(null);
  const [logs, setLogs] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      if (desktop) {
        const [r, tu, d] = await Promise.all([
          localAppStatus(key).catch(() => null),
          localTunnelStatus().catch(() => null),
          localDeps().catch(() => null),
        ]);
        if (r) setRun({ project_id: projectId, running: r.running, url: r.url, port: r.port });
        if (tu) setTun(tu);
        if (d) {
          setBunOk(d.bun.found);
          setCfOk(d.cloudflared.found);
        }
      } else {
        const [r, tu, meta] = await Promise.all([
          localrunStatus(projectId).catch(() => null),
          tunnelStatus().catch(() => null),
          fetchDesktopMeta().catch(() => null),
        ]);
        if (r) setRun(r);
        if (tu) setTun(tu);
        if (meta) {
          setBunOk(meta.bun.found);
          setCfOk(meta.cloudflared.found);
        }
      }
    } catch {
      /* polling must never crash the panel */
    }
  }, [projectId, key, desktop]);

  useEffect(() => {
    void refresh();
    const h = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(h);
  }, [refresh]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (desktop) {
      const jwt = getToken();
      if (!jwt) throw new Error("Login first.");
      await localRunApp({ key, cloneUrl: `${window.location.origin}/git/${repoId}`, jwt, branch: "" });
    } else {
      await localrunStart(projectId);
    }
  }

  async function stop() {
    if (desktop) await localStopApp(key);
    else await localrunStop(projectId);
  }

  async function showLogs() {
    if (logs) return setLogs(null);
    try {
      setLogs(desktop ? await localAppLogs(key) : (await localrunLogs(projectId)).lines);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function publish() {
    if (!port) throw new Error(t("run.stopped"));
    if (desktop) {
      const r = await localTunnelStart(port);
      setTun({ running: r.running, url: r.url, mode: r.mode, started_at: r.started_at });
    } else {
      setTun(await tunnelStart(port));
    }
  }

  async function unpublish() {
    if (desktop) setTun(await localTunnelStop());
    else setTun(await tunnelStop());
  }

  const running = !!run?.running;
  const port = run?.port ?? null;

  return (
    <div className="flex flex-col gap-4 border-t border-line p-4">
      <div>
        <div className="text-xs font-bold text-fg-2">{t("run.title")}</div>
        <p className="mt-1 text-xs leading-5 text-muted">{t("run.body")}</p>
        {bunOk === false && (
          <p className="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {t("run.needBun")} <span className="font-mono">curl -fsSL https://bun.sh/install | bash</span>
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${running ? "bg-accent/15 text-accent-text" : "bg-fg/[0.06] text-muted"}`}>
            <span className={`h-1.5 w-1.5 rounded-full bg-current ${busy ? "animate-pulse" : ""}`} />
            {running ? `${t("run.running")} · :${port}` : busy ? t("run.building") : t("run.stopped")}
          </span>
          {!running ? (
            <button type="button" disabled={busy || bunOk === false} onClick={() => void act(start)} className="btn-primary px-3.5 py-2">
              {busy ? <Spinner /> : <Icon name="play" size={15} />}{t("run.start")}
            </button>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={() => void act(stop)} className="btn-secondary px-3.5 py-2">
              <Icon name="stop" size={15} />{t("run.stop")}
              </button>
              {run?.url && <a href={run.url} target="_blank" rel="noreferrer" className="btn-primary px-3.5 py-2"><Icon name="external" size={15} />{t("run.open")}</a>}
            </>
          )}
          {running && (
            <button type="button" onClick={() => void showLogs()} className="btn-secondary px-3.5 py-2">
              <Icon name="terminal" size={15} />{logs ? t("run.hideLogs") : t("run.logs")}
            </button>
          )}
        </div>
        {logs && (
          <pre className="mt-2 max-h-52 overflow-auto rounded-lg bg-black/40 p-3 font-mono text-[11px] leading-5 text-fg-2">{logs.slice(-120).join("\n") || "—"}</pre>
        )}
      </div>

      <div>
        <div className="text-xs font-bold text-fg-2">{t("tun.title")}</div>
        <p className="mt-1 text-xs leading-5 text-muted">{t("tun.body")}</p>
        {cfOk === false ? (
          <p className="mt-2 rounded-lg bg-fg/[0.06] px-3 py-2 font-mono text-[11px] text-muted">
            {t("tun.noCf")} <span className="text-fg">brew install cloudflared</span>
          </p>
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {tun?.running && tun.url ? (
              <>
                <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-semibold text-accent-text">{t("tun.live")}</span>
                <span className="font-mono text-xs text-accent-text">{tun.url.replace(/^https?:\/\//, "")}</span>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(tun.url!);
                      setError(t("tun.copied"));
                    } catch { /* clipboard unavailable */ }
                  }}
                  className="btn-secondary px-2.5 py-1 text-xs"
                >
                  <Icon name="copy" size={13} />
                </button>
                <button type="button" disabled={busy} onClick={() => void act(unpublish)} className="btn-secondary px-3 py-1.5 text-xs">{t("tun.off")}</button>
              </>
            ) : (
              <button type="button" disabled={busy || !port} onClick={() => void act(publish)} className="btn-primary px-3.5 py-2" title={!port ? t("run.stopped") : undefined}>
                <Icon name="link" size={15} />{t("tun.make")}
              </button>
            )}
          </div>
        )}
        {tun?.running && <p className="mt-1 text-[11px] text-subtle">{t("tun.changes")}</p>}
        <details className="mt-2 rounded-lg border border-line p-3 text-xs leading-6 text-muted">
          <summary className="cursor-pointer font-semibold text-fg-2">{t("tun.named")}</summary>
          {lang === "id" ? (
            <ol className="mt-2 list-decimal pl-5">
              <li>Daftar/login di dash.cloudflare.com dan tambahkan domainmu.</li>
              <li>Di komputer ini: <code>cloudflared tunnel login</code> lalu <code>cloudflared tunnel create nama-toko</code>.</li>
              <li><code>cloudflared tunnel route dns nama-toko kasir.namadomain.id</code></li>
              <li>
                Isi <code>~/.cloudflared/config.yml</code> dengan hostname → <code>http://127.0.0.1:{port ?? 8080}</code>,
                lalu <code>cloudflared tunnel run nama-toko</code>.
              </li>
            </ol>
          ) : (
            <ol className="mt-2 list-decimal pl-5">
              <li>Sign up / log in at dash.cloudflare.com and add your domain.</li>
              <li>On this machine: <code>cloudflared tunnel login</code>, then <code>cloudflared tunnel create shop-name</code>.</li>
              <li><code>cloudflared tunnel route dns shop-name pos.yourdomain.com</code></li>
              <li>
                Point the hostname at <code>http://127.0.0.1:{port ?? 8080}</code> in <code>~/.cloudflared/config.yml</code>,
                then <code>cloudflared tunnel run shop-name</code>.
              </li>
            </ol>
          )}
        </details>
      </div>

      {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}
    </div>
  );
}
