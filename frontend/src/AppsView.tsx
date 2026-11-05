import { useCallback, useEffect, useState } from "react";
import {
  applyUpdate,
  deleteProject,
  fetchDesktopMeta,
  fetchUpdates,
  fetchInstalls,
  fetchProjects,
  setProjectUrls,
  type AppUpdate,
  type DesktopMeta,
  type Install,
  type Project,
} from "./api";
import { isDesktop } from "./slaver-local";
import { InstallDialog, providerMeta } from "./HostingPanel";
import CustomizeView from "./CustomizeView";
import LocalRunPanel from "./LocalRunPanel";
import { useLang } from "./i18n";
import { Icon, Spinner, type IconName } from "./ui";

type AppState = "none" | "installing" | "live" | "failed";

/** Apps (Home): the team's apps as a simple list. One main action per app (Install / Open); the rest sits in a "more" menu. */
export default function AppsView({
  teamId,
  teamName,
  onGoMarket,
}: {
  teamId: string | null;
  teamName?: string;
  onGoMarket: () => void;
}) {
  const { t } = useLang();
  const [apps, setApps] = useState<Project[] | null>(null);
  const [installs, setInstalls] = useState<Install[]>([]);
  const [updates, setUpdates] = useState<AppUpdate[]>([]);
  const [error, setError] = useState("");
  const [installFor, setInstallFor] = useState<Project | null>(null);
  const [customizeFor, setCustomizeFor] = useState<Project | null>(null);
  const [localCapable, setLocalCapable] = useState(false);

  useEffect(() => {
    if (isDesktop()) {
      setLocalCapable(true);
      return;
    }
    fetchDesktopMeta()
      .then((m) => setLocalCapable(m.desktop || m.bun.found))
      .catch(() => {});
  }, []);

  const refresh = useCallback(async () => {
    if (!teamId) return setApps([]);
    setError("");
    try {
      const [list, inst, upd] = await Promise.all([
        fetchProjects(teamId),
        fetchInstalls(teamId).catch(() => [] as Install[]),
        fetchUpdates(teamId).catch(() => [] as AppUpdate[]),
      ]);
      setApps(list.map((a) => a.project));
      setInstalls(inst);
      setUpdates(upd);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("apps.errLoad"));
      setApps((a) => a ?? []);
    }
  }, [teamId, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!teamId) return <p className="p-6 text-sm text-muted">{t("apps.none")}</p>;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6 sm:px-6 lg:py-10">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-sm text-muted">{t("apps.subSimple", { team: teamName ?? "" })}</p>
        <button type="button" onClick={onGoMarket} className="btn-secondary">
          <Icon name="market" size={16} />
          {t("apps.findApps")}
        </button>
      </header>

      {error && <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</p>}

      {apps === null ? (
        <div className="flex flex-col gap-3">
          {[0, 1].map((i) => <div key={i} className="loading-skeleton h-20" />)}
        </div>
      ) : apps.length === 0 ? (
        <section className="surface flex flex-col items-center rounded-2xl border-dashed px-6 py-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent-text"><Icon name="grid" size={22} /></span>
          <h3 className="mt-4 text-lg font-bold text-fg">{t("apps.emptyTitle")}</h3>
          <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted">{t("apps.emptyBody")}</p>
          <button type="button" onClick={onGoMarket} className="btn-primary mt-5">
            {t("apps.emptyMarket")}
            <Icon name="arrow" size={15} />
          </button>
        </section>
      ) : (
        <ul className="flex flex-col gap-3">
          {apps.map((p) => (
            <AppRow
              key={p.id}
              project={p}
              install={installs.find((i) => i.project_id === p.id) ?? null}
              update={updates.find((u) => u.project_id === p.id) ?? null}
              canLocal={localCapable}
              onInstall={() => setInstallFor(p)}
              onCustomize={() => setCustomizeFor(p)}
              onChanged={refresh}
            />
          ))}
        </ul>
      )}

      {customizeFor && (
        <CustomizeView
          projectId={customizeFor.id}
          teamId={teamId}
          onClose={() => {
            setCustomizeFor(null);
            void refresh();
          }}
          onRedeploy={() => {
            const p = customizeFor;
            setCustomizeFor(null);
            setInstallFor(p);
          }}
        />
      )}

      {installFor && (
        <InstallDialog
          teamId={teamId}
          projectId={installFor.id}
          projectName={installFor.name}
          onClose={() => {
            setInstallFor(null);
            void refresh();
          }}
          onLive={() => void refresh()}
        />
      )}
    </div>
  );
}

function AppRow({
  project: p,
  install,
  update,
  canLocal,
  onInstall,
  onCustomize,
  onChanged,
}: {
  project: Project;
  install: Install | null;
  update: AppUpdate | null;
  canLocal: boolean;
  onInstall: () => void;
  onCustomize: () => void;
  onChanged: () => Promise<void>;
}) {
  const { t } = useLang();
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<"none" | "url" | "preview" | "run">("none");
  const [prodUrl, setProdUrl] = useState(p.prod_url);
  const [devUrl, setDevUrl] = useState(p.dev_url);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const liveUrl = (install?.status === "live" && install.url) || p.prod_url || "";
  const state: AppState =
    install && (install.status === "queued" || install.status === "running")
      ? "installing"
      : liveUrl
        ? "live"
        : install?.status === "failed"
          ? "failed"
          : "none";
  const canInstall = !!p.repo_id;

  async function saveUrls() {
    if (busy) return;
    setBusy(true);
    setNote(null);
    const norm = (u: string) => {
      const v = u.trim();
      return !v ? "" : /^https?:\/\//i.test(v) ? v : `https://${v}`;
    };
    try {
      await setProjectUrls(p.id, { prod_url: norm(prodUrl), dev_url: norm(devUrl) });
      setPanel("none");
      await onChanged();
    } catch (err) {
      setNote({ kind: "err", text: err instanceof Error ? err.message : t("apps.errSave") });
    } finally {
      setBusy(false);
    }
  }

  async function syncUpdate() {
    if (!update || busy || !window.confirm(t("upd.confirm", { name: p.name }))) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await applyUpdate(update.repo_id);
      setNote(r.status === "conflict" ? { kind: "err", text: t("upd.conflict") } : { kind: "ok", text: t("upd.done") });
      await onChanged();
    } catch (err) {
      setNote({ kind: "err", text: err instanceof Error ? err.message : t("upd.fail") });
    } finally {
      setBusy(false);
    }
  }

  async function copyClone() {
    const cmd = `git clone ${window.location.origin}/git/${p.repo_id} ${p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    try {
      await navigator.clipboard.writeText(cmd);
      setNote({ kind: "ok", text: `${t("apps.copied")}: ${cmd}` });
    } catch {
      setNote({ kind: "ok", text: cmd });
    }
  }

  async function removeApp() {
    if (busy || !window.confirm(t("apps.removeConfirm", { name: p.name }))) return;
    setBusy(true);
    setNote(null);
    try {
      await deleteProject(p.id);
      await onChanged();
    } catch (err) {
      setNote({ kind: "err", text: err instanceof Error ? err.message : t("apps.errRemove") });
    } finally {
      setBusy(false);
    }
  }

  const menuItems: { label: string; icon: IconName; run: () => void; show: boolean }[] = [
    { label: t("run.menu"), icon: "play", run: () => setPanel("run"), show: canInstall && canLocal },
    { label: t("apps.mReinstall"), icon: "rocket", run: onInstall, show: canInstall && state !== "none" },
    { label: panel === "preview" ? t("apps.mHidePreview") : t("apps.mPreview"), icon: "external", run: () => setPanel(panel === "preview" ? "none" : "preview"), show: !!liveUrl },
    {
      label: t("apps.mSetUrl"),
      icon: "globe",
      run: () => {
        setProdUrl(p.prod_url);
        setDevUrl(p.dev_url);
        setPanel("url");
      },
      show: true,
    },
    { label: t("apps.mSource"), icon: "git", run: copyClone, show: canInstall },
    { label: t("apps.mRemove"), icon: "x", run: removeApp, show: true },
  ];

  return (
    <li className="surface rounded-xl">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-base font-bold text-fg-2">
          {p.name.slice(0, 1).toUpperCase()}
        </span>

        <div className="min-w-0 flex-1 basis-56">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-semibold text-fg">{p.name}</span>
            <StatusPill state={state} />
            {update && (
              <button type="button" onClick={syncUpdate} disabled={busy} className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[11px] font-semibold text-amber-200 hover:bg-amber-400/20" title={t("upd.body")}>
                {t("apps.updAvail")}
              </button>
            )}
          </div>
          {liveUrl ? (
            <a href={liveUrl} target="_blank" rel="noreferrer" className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted hover:text-accent-text">
              <span className="truncate">{liveUrl.replace(/^https?:\/\//, "")}</span>
              {install?.status === "live" && <span className="hidden shrink-0 text-subtle sm:inline">· {providerMeta(install.provider).name}</span>}
            </a>
          ) : (
            <p className="mt-0.5 truncate text-xs text-muted">{p.description || (canInstall ? "" : t("apps.noRepo"))}</p>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {canInstall && (
            <button type="button" onClick={onCustomize} className="btn-secondary px-3.5 py-2">
              <Icon name="spark" size={15} />
              {t("cz.open")}
            </button>
          )}
          {state === "live" ? (
            <a href={liveUrl} target="_blank" rel="noreferrer" className="btn-primary px-3.5 py-2">
              <Icon name="external" size={15} />
              {t("apps.btnOpen")}
            </a>
          ) : canInstall ? (
            <button type="button" onClick={onInstall} className={`${state === "installing" ? "btn-secondary" : "btn-primary"} px-3.5 py-2`}>
              {state === "installing" ? <Spinner /> : <Icon name="rocket" size={15} />}
              {state === "installing" ? t("apps.btnProgress") : state === "failed" ? t("apps.btnRetry") : t("apps.btnInstall")}
            </button>
          ) : (
            <button type="button" onClick={() => setPanel("url")} className="btn-secondary px-3.5 py-2">
              {t("apps.mSetUrl")}
            </button>
          )}

          <div className="relative">
            <button type="button" onClick={() => setMenuOpen((v) => !v)} className="icon-button" aria-label={t("apps.menu")} title={t("apps.menu")} aria-expanded={menuOpen}>
              <Icon name="more" size={18} />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
                <div className="surface-raised absolute right-0 top-11 z-40 w-64 rounded-xl p-1">
                  {menuItems
                    .filter((m) => m.show)
                    .map((m) => (
                      <button
                        key={m.label}
                        type="button"
                        onClick={() => {
                          setMenuOpen(false);
                          m.run();
                        }}
                        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-fg-2 hover:bg-hover hover:text-fg"
                      >
                        <Icon name={m.icon} size={15} className="text-subtle" />
                        {m.label}
                      </button>
                    ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {note && (
        <div className={`mx-4 mb-4 flex items-start gap-2 rounded-lg px-3 py-2 text-xs leading-5 ${note.kind === "err" ? "bg-red-500/10 text-red-300" : "bg-accent/10 text-accent-text"}`}>
          <span className="min-w-0 flex-1 break-all">{note.text}</span>
          {note.text === t("upd.done") && canInstall && (
            <button type="button" onClick={onInstall} className="shrink-0 font-semibold underline">{t("apps.redeploy")}</button>
          )}
          <button type="button" onClick={() => setNote(null)} aria-label={t("common.close")} className="shrink-0 opacity-70 hover:opacity-100">
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      {panel === "url" && (
        <div className="flex flex-col gap-3 border-t border-line p-4">
          <label className="text-xs font-semibold text-fg-2">
            {t("apps.urlProd")}
            <input value={prodUrl} onChange={(e) => setProdUrl(e.target.value)} placeholder={t("apps.urlProdPh")} className="field mt-1.5 font-mono text-xs" />
          </label>
          <label className="text-xs font-semibold text-fg-2">
            {t("apps.urlDev")}
            <input value={devUrl} onChange={(e) => setDevUrl(e.target.value)} placeholder={t("apps.urlDevPh")} className="field mt-1.5 font-mono text-xs" />
          </label>
          <div className="flex gap-2">
            <button type="button" onClick={saveUrls} disabled={busy} className="btn-primary px-3.5 py-2">{busy ? t("apps.saving") : t("apps.saveUrls")}</button>
            <button type="button" onClick={() => setPanel("none")} className="btn-secondary px-3.5 py-2">{t("apps.cancel")}</button>
          </div>
        </div>
      )}

      {panel === "run" && canLocal && <LocalRunPanel projectId={p.id} projectName={p.name} repoId={p.repo_id} />}

      {panel === "preview" && liveUrl && (
        <div className="border-t border-line">
          <iframe
            key={liveUrl}
            src={liveUrl}
            title={`${p.name} preview`}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            className="h-[60vh] min-h-[420px] w-full rounded-b-xl bg-white"
          />
        </div>
      )}
    </li>
  );
}

function StatusPill({ state }: { state: AppState }) {
  const { t } = useLang();
  const cls = {
    none: "bg-fg/[0.06] text-muted",
    installing: "bg-amber-400/15 text-amber-200",
    live: "bg-accent/15 text-accent-text",
    failed: "bg-red-500/15 text-red-300",
  }[state];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full bg-current ${state === "installing" ? "animate-pulse" : ""}`} />
      {t(`apps.st.${state}`)}
    </span>
  );
}
