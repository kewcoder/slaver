import { useCallback, useEffect, useState } from "react";
import {
  applyUpdate,
  fetchUpdates,
  fetchInstalls,
  fetchProjects,
  setProjectUrls,
  type AppUpdate,
  type Install,
  type Project,
  type ProjectStats,
} from "./api";
import { InstallDialog, InstallStatus, ProviderMark, providerMeta } from "./HostingPanel";
import { useLang } from "./i18n";
import { Icon, SectionHeading, Spinner } from "./ui";

interface AppEntry {
  project: Project;
  stats: ProjectStats;
}

/** Apps (Home): installed apps as cards + fullscreen-capable iframe preview. */
export default function AppsView({
  teamId,
  teamName,
  userName,
  botCount = 0,
  onOpenProject,
  onGoMarket,
  onGoChat,
}: {
  teamId: string | null;
  teamName?: string;
  userName?: string;
  botCount?: number;
  onOpenProject: (projectId: string) => void;
  onGoMarket: () => void;
  onGoChat: () => void;
}) {
  const { t } = useLang();
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [env, setEnv] = useState<"prod" | "dev">("prod");
  const [editing, setEditing] = useState(false);
  const [prodUrl, setProdUrl] = useState("");
  const [devUrl, setDevUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [installs, setInstalls] = useState<Install[]>([]);
  const [installOpen, setInstallOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [updates, setUpdates] = useState<AppUpdate[]>([]);
  const [showChanges, setShowChanges] = useState(false);
  const [updBusy, setUpdBusy] = useState(false);
  const [updResult, setUpdResult] = useState<{ pid: string; status: string } | null>(null);

  const refresh = useCallback(async () => {
    if (!teamId) {
      setApps([]);
      return;
    }
    setError("");
    try {
      const [list, inst, upd] = await Promise.all([fetchProjects(teamId), fetchInstalls(teamId).catch(() => [] as Install[]), fetchUpdates(teamId).catch(() => [] as AppUpdate[])]);
      setApps(list);
      setInstalls(inst);
      setUpdates(upd);
      if (!list.some((a) => a.project.id === selectedId)) {
        const firstLive = list.find((a) => a.project.prod_url || a.project.dev_url) ?? list[0];
        setSelectedId(firstLive?.project.id ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("apps.errLoad"));
    }
  }, [teamId, selectedId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = apps.find((a) => a.project.id === selectedId)?.project ?? null;
  const previewUrl = selected ? (env === "prod" ? selected.prod_url : selected.dev_url) || "" : "";
  const lastInstall = (pid: string) => installs.find((i) => i.project_id === pid) ?? null;
  const selInstall = selected ? lastInstall(selected.id) : null;
  const updateFor = (pid: string) => updates.find((u) => u.project_id === pid) ?? null;
  const selUpdate = selected ? updateFor(selected.id) : null;

  async function syncUpdate() {
    if (!selUpdate || updBusy || !selected) return;
    if (!window.confirm(t("upd.confirm", { name: selected.name }))) return;
    setUpdBusy(true);
    setError("");
    try {
      const r = await applyUpdate(selUpdate.repo_id);
      setUpdResult({ pid: selected.id, status: r.status });
      setShowChanges(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("upd.fail"));
    } finally {
      setUpdBusy(false);
    }
  }

  function startEdit() {
    if (!selected) return;
    setProdUrl(selected.prod_url);
    setDevUrl(selected.dev_url);
    setEditing(true);
  }

  async function saveUrls() {
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    try {
      const norm = (u: string) => {
        const t = u.trim();
        if (!t) return "";
        return /^https?:\/\//i.test(t) ? t : `https://${t}`;
      };
      await setProjectUrls(selected.id, { prod_url: norm(prodUrl), dev_url: norm(devUrl) });
      setEditing(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("apps.errSave"));
    } finally {
      setBusy(false);
    }
  }

  if (!teamId) {
    return <p className="p-6 text-sm text-zinc-500">{t("apps.none")}</p>;
  }

  const totalTasks = apps.reduce((sum, a) => sum + a.stats.total, 0);
  const doneTasks = apps.reduce((sum, a) => sum + a.stats.done, 0);
  const liveApps = apps.filter((a) => a.project.prod_url).length;
  const firstName = (userName || teamName || "").split(" ")[0] || teamName || "";

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[1440px] flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <section className="relative overflow-hidden rounded-2xl border border-[#62d89d]/15 bg-gradient-to-br from-[#18291f] via-[#131d17] to-[#101713] p-6 sm:p-8">
        <div className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full bg-[#62d89d]/[0.07] blur-3xl" />
        <div className="relative flex flex-wrap items-end justify-between gap-5">
          <div className="max-w-2xl">
            <div className="panel-title text-[#62d89d]">{t("apps.eyebrow")}{teamName ? ` · ${teamName}` : ""}</div>
            <h2 className="page-heading mt-3 text-3xl font-bold sm:text-4xl">{t("apps.greeting").replace("{name}", firstName)}</h2>
            <p className="mt-2 text-sm leading-6 text-[#9aaca1]">{t("apps.heroBody")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={onGoMarket} className="btn-primary"><Icon name="market" size={16} />{t("apps.quickMarket")}</button>
            <button type="button" onClick={onGoChat} className="btn-secondary"><Icon name="chat" size={16} />{t("apps.quickChat")}</button>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {([
          [t("apps.statApps"), apps.length, "grid"],
          [t("apps.statLive"), liveApps, "check"],
          [t("apps.statTasks"), `${doneTasks}/${totalTasks}`, "arrow"],
          [t("apps.statAgents"), botCount, "bot"],
        ] as const).map(([label, value, icon]) => (
          <div key={label} className="surface rounded-xl p-4">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-[#82958a]">{label}</span>
              <Icon name={icon} size={15} className="text-[#52675b]" />
            </div>
            <div className="mt-3 text-2xl font-bold tracking-tight text-[#edf4ef]">{value}</div>
          </div>
        ))}
      </section>

      {error && <p className="rounded-xl border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">{error}</p>}

      {apps.length === 0 ? (
        <section className="surface flex flex-1 flex-col items-center justify-center rounded-2xl border-dashed px-6 py-16 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#62d89d]/10 text-[#8ce6b8]"><Icon name="grid" size={25} /></span>
          <h3 className="page-heading mt-5 text-xl font-bold">{t("apps.emptyTitle")}</h3>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#8f9d96]">{t("apps.emptyBody")}</p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <button type="button" onClick={onGoMarket} className="btn-primary">{t("apps.emptyMarket")}<Icon name="arrow" size={15} /></button>
            <button type="button" onClick={onGoChat} className="btn-secondary">{t("apps.emptyChat")}</button>
          </div>
        </section>
      ) : (
        <section className="grid min-h-0 flex-1 gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
          <div className="min-w-0">
            <SectionHeading title={t("apps.library")} description={`${apps.length} ${t("apps.statApps").toLowerCase()}`} />
            <div className="mt-4 flex gap-2 overflow-x-auto pb-1 xl:flex-col xl:overflow-visible">
              {apps.map(({ project: p, stats }) => {
                const live = !!p.prod_url;
                const active = p.id === selectedId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setSelectedId(p.id)}
                    className={`min-w-[260px] rounded-xl border p-4 text-left xl:min-w-0 ${active ? "border-[#62d89d]/35 bg-[#62d89d]/[0.07]" : "border-white/[0.08] bg-[#111815] hover:border-white/[0.15] hover:bg-[#151e1a]"}`}
                  >
                    <div className="flex items-center gap-3">
                      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-black ${active ? "bg-[#62d89d] text-[#0b2117]" : "bg-[#213028] text-[#a2c4b0]"}`}>
                        {p.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-bold text-[#e8efeb]">{p.name}</span>
                        <span className="mt-1 flex items-center gap-1.5 text-[11px] text-[#718078]">
                          <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-[#62d89d]" : "bg-[#52615a]"}`} />
                          {live ? t("apps.live") : t("apps.noUrl")}
                        </span>
                      </span>
                      {active && <Icon name="arrow" size={15} className="text-[#62d89d]" />}
                    </div>
                    {p.description && <p className="mt-3 line-clamp-2 text-xs leading-5 text-[#82958a]">{p.description}</p>}
                    <div className="mt-3 flex items-center gap-2 text-[10px] text-[#718078]">
                      {updateFor(p.id) && <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 font-bold text-amber-200">{t("upd.badge")}</span>}
                      {lastInstall(p.id) && <span className="flex items-center gap-1.5"><ProviderMark id={lastInstall(p.id)!.provider} size="sm" /><InstallStatus status={lastInstall(p.id)!.status} /></span>}
                      {p.dev_url && <span className="soft-badge py-1">{t("apps.dev")}</span>}
                      <span className="ml-auto">{t("apps.doneOf").replace("{done}", String(stats.done)).replace("{total}", String(stats.total))}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="min-w-0">
            <SectionHeading title={t("apps.preview")} description={selected?.name} />
            {selected ? (
              <div className="surface mt-4 overflow-hidden rounded-2xl">
                <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.07] px-4 py-3">
                  <span className="mr-1 truncate text-sm font-bold text-[#e8efeb]">{selected.name}</span>
                  <div className="flex rounded-lg bg-[#0b110e] p-0.5 text-[11px]">
                    {(["prod", "dev"] as const).map((e) => (
                      <button
                        key={e}
                        type="button"
                        onClick={() => setEnv(e)}
                        className={`rounded-md px-2.5 py-1.5 font-bold ${env === e ? "bg-[#223229] text-[#8ce6b8]" : "text-[#718078] hover:text-[#dbe5df]"}`}
                      >
                        {e === "prod" ? t("apps.envProd") : t("apps.envDev")}
                      </button>
                    ))}
                  </div>
                  <div className="ml-auto flex items-center gap-1">
                    {previewUrl && (
                      <a href={previewUrl} target="_blank" rel="noreferrer" className="icon-button" title={t("apps.openFull")}>
                        <Icon name="external" size={16} />
                      </a>
                    )}
                    <button type="button" onClick={() => setInstallOpen(true)} disabled={!selected.repo_id} className="btn-primary px-2.5 py-1.5 text-[11px]">
                      <Icon name="rocket" size={14} />{selInstall?.status === "live" ? t("apps.redeploy") : t("apps.install")}
                    </button>
                    {selected.repo_id && (
                      <button type="button" onClick={() => setSourceOpen((v) => !v)} className="btn-secondary px-2.5 py-1.5 text-[11px]">
                        <Icon name="git" size={14} />{t("apps.source")}
                      </button>
                    )}
                    <button type="button" onClick={() => onOpenProject(selected.id)} className="btn-secondary px-2.5 py-1.5 text-[11px]">
                      <Icon name="grid" size={14} />{t("apps.openBoard")}
                    </button>
                    <button type="button" onClick={() => (editing ? setEditing(false) : startEdit())} className="btn-secondary px-2.5 py-1.5 text-[11px]">
                      {editing ? t("apps.cancel") : t("apps.setUrl")}
                    </button>
                  </div>
                </div>

                {sourceOpen && selected.repo_id && (
                  <div className="border-b border-white/[0.07] bg-[#0b110e] px-4 py-3 text-xs text-[#82958a]">
                    <div className="mb-1.5">{t("apps.sourceHelp")}</div>
                    <code className="block overflow-x-auto whitespace-pre rounded-lg bg-[#070b09] px-3 py-2 font-mono text-[11.5px] text-[#cfdad3]">git clone {window.location.origin}/git/{selected.repo_id} {selected.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}</code>
                  </div>
                )}
                {selUpdate && !editing && (
                  <div className="border-b border-amber-400/20 bg-amber-400/[0.06] px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Icon name="spark" size={15} className="text-amber-300" />
                      <span className="text-xs font-bold text-amber-100">{t("upd.title", { n: selUpdate.behind })}</span>
                      <button type="button" onClick={() => setShowChanges((v) => !v)} className="text-[11px] font-semibold text-amber-200/80 hover:underline">{showChanges ? t("upd.hide") : t("upd.review")}</button>
                      <button type="button" onClick={syncUpdate} disabled={updBusy} className="btn-primary ml-auto px-2.5 py-1.5 text-[11px]">{updBusy ? <Spinner /> : <Icon name="arrow" size={14} />}{t("upd.sync")}</button>
                    </div>
                    <p className="mt-1 text-[11px] leading-5 text-amber-100/70">{t("upd.body")}</p>
                    {showChanges && (
                      <ul className="mt-2 flex flex-col gap-1 rounded-lg bg-black/20 p-2">
                        {selUpdate.changes.map((c) => (
                          <li key={c.sha} className="truncate text-[11px] text-amber-50/90"><span className="font-mono text-amber-300">{c.sha}</span> {c.subject} <span className="text-amber-100/50">· {c.date.slice(0, 10)}</span></li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {updResult && selected && updResult.pid === selected.id && !editing && (
                  <div className={`flex flex-wrap items-center gap-2 border-b px-4 py-3 text-xs ${updResult.status === "conflict" ? "border-red-500/20 bg-red-500/[0.06] text-red-100" : "border-[#62d89d]/20 bg-[#62d89d]/[0.06] text-[#cfeedd]"}`}>
                    <span className="min-w-0 flex-1 leading-5">{updResult.status === "conflict" ? t("upd.conflict") : t("upd.done")}</span>
                    {updResult.status !== "conflict" && selected.repo_id && (
                      <button type="button" onClick={() => setInstallOpen(true)} className="btn-primary px-2.5 py-1.5 text-[11px]"><Icon name="rocket" size={14} />{t("apps.redeploy")}</button>
                    )}
                    <button type="button" onClick={() => setUpdResult(null)} className="icon-button" aria-label={t("common.close")}><Icon name="x" size={14} /></button>
                  </div>
                )}
                {selInstall && !editing && (
                  <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.07] px-4 py-2 text-[11px] text-[#82958a]">
                    <ProviderMark id={selInstall.provider} size="sm" />
                    <span>{t("apps.hostedOn", { name: providerMeta(selInstall.provider).name })}</span>
                    <InstallStatus status={selInstall.status} />
                    {selInstall.url && <a href={selInstall.url} target="_blank" rel="noreferrer" className="truncate font-mono text-[#8ce6b8] hover:underline">{selInstall.url}</a>}
                  </div>
                )}
                {editing ? (
                  <div className="flex flex-col gap-4 p-5">
                    <label className="text-xs font-semibold text-[#b8c4bd]">
                      {t("apps.urlProd")}
                      <input value={prodUrl} onChange={(e) => setProdUrl(e.target.value)} placeholder={t("apps.urlProdPh")} className="field mt-2 font-mono text-xs" />
                    </label>
                    <label className="text-xs font-semibold text-[#b8c4bd]">
                      {t("apps.urlDev")}
                      <input value={devUrl} onChange={(e) => setDevUrl(e.target.value)} placeholder={t("apps.urlDevPh")} className="field mt-2 font-mono text-xs" />
                    </label>
                    <div>
                      <button type="button" onClick={saveUrls} disabled={busy} className="btn-primary">
                        {busy ? t("apps.saving") : t("apps.saveUrls")}
                      </button>
                    </div>
                  </div>
                ) : previewUrl ? (
                  <iframe
                    key={previewUrl}
                    src={previewUrl}
                    title={`${selected.name} preview`}
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                    className="h-[62vh] min-h-[440px] w-full bg-white"
                  />
                ) : (
                  <div className="flex min-h-[360px] flex-col items-center justify-center p-8 text-center">
                    <Icon name="external" size={26} className="text-[#52675b]" />
                    <p className="mt-4 max-w-md text-sm leading-6 text-[#82958a]">{env === "prod" ? t("apps.noPreviewInstall") : t("apps.noPreviewDev")}</p>
                    <div className="mt-5 flex flex-wrap justify-center gap-2">
                      {env === "prod" && selected.repo_id && <button type="button" onClick={() => setInstallOpen(true)} className="btn-primary"><Icon name="rocket" size={15} />{t("apps.install")}</button>}
                      <button type="button" onClick={startEdit} className="btn-secondary">{t("apps.setUrl")}</button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="surface mt-4 rounded-2xl p-10 text-center text-sm text-[#82958a]">{t("apps.noSelection")}</div>
            )}
          </div>
        </section>
      )}
      {installOpen && selected && teamId && (
        <InstallDialog
          teamId={teamId}
          projectId={selected.id}
          projectName={selected.name}
          onClose={() => { setInstallOpen(false); void refresh(); }}
          onLive={() => void refresh()}
        />
      )}
    </div>
  );
}
