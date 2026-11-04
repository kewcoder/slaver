import { useCallback, useEffect, useState } from "react";
import {
  fetchProjects,
  setProjectUrls,
  type Project,
  type ProjectStats,
} from "./api";
import { useLang } from "./i18n";

interface AppEntry {
  project: Project;
  stats: ProjectStats;
}

/** Apps (Home): installed apps as cards + fullscreen-capable iframe preview. */
export default function AppsView({
  teamId,
  onOpenProject,
  onGoMarket,
  onGoChat,
}: {
  teamId: string | null;
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

  const refresh = useCallback(async () => {
    if (!teamId) {
      setApps([]);
      return;
    }
    setError("");
    try {
      const list = await fetchProjects(teamId);
      setApps(list);
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

  return (
    <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col gap-4 p-4">
      <div>
        <h2 className="text-xl font-bold text-zinc-100">{t("apps.title")}</h2>
        <p className="mt-1 text-sm text-zinc-400">{t("apps.sub")}</p>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}

      {apps.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-700 bg-zinc-900/60 p-10 text-center">
          <div className="text-3xl">◈</div>
          <h3 className="mt-2 font-bold text-zinc-100">{t("apps.emptyTitle")}</h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-zinc-400">{t("apps.emptyBody")}</p>
          <div className="mt-4 flex justify-center gap-2">
            <button type="button" onClick={onGoMarket} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500">{t("apps.emptyMarket")}</button>
            <button type="button" onClick={onGoChat} className="rounded-md border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-200 hover:bg-zinc-800">{t("apps.emptyChat")}</button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {apps.map(({ project: p, stats }) => {
            const live = !!p.prod_url;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelectedId(p.id)}
                className={`rounded-xl border p-4 text-left transition ${p.id === selectedId ? "border-emerald-600 bg-zinc-900" : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-600"}`}
              >
                <div className="flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full ${live ? "bg-emerald-400" : "bg-zinc-600"}`} title={live ? t("apps.live") : t("apps.noProdTitle")} />
                  <span className="truncate font-bold text-zinc-100">{p.name}</span>
                </div>
                {p.description && <p className="mt-1 line-clamp-2 text-xs text-zinc-400">{p.description}</p>}
                <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-500">
                  {live ? <span className="rounded bg-emerald-950 px-2 py-0.5 text-[11px] font-bold text-emerald-300">{t("apps.live")}</span> : <span className="rounded bg-zinc-800 px-1.5 py-0.5">{t("apps.noUrl")}</span>}
                  {p.dev_url && <span className="rounded bg-zinc-800 px-1.5 py-0.5">{t("apps.dev")}</span>}
                  <span className="ml-auto">{t("apps.doneOf").replace("{done}", String(stats.done)).replace("{total}", String(stats.total))}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {selected && (
        <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
            <span className="font-bold text-zinc-100">{selected.name}</span>
            <div className="ml-2 flex rounded-md bg-zinc-800 p-0.5 text-xs">
              {(["prod", "dev"] as const).map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setEnv(e)}
                  className={`rounded px-2.5 py-1 font-bold uppercase ${env === e ? "bg-zinc-950 text-emerald-300" : "text-zinc-500 hover:text-zinc-200"}`}
                >
                  {e === "prod" ? t("apps.envProd") : t("apps.envDev")}
                </button>
              ))}
            </div>
            {previewUrl && (
              <a href={previewUrl} target="_blank" rel="noreferrer" className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs font-semibold text-zinc-200 hover:bg-zinc-800">
                {t("apps.openFull")}
              </a>
            )}
            <div className="ml-auto flex items-center gap-2">
              <button type="button" onClick={() => onOpenProject(selected.id)} className="rounded-md px-2.5 py-1 text-xs font-semibold text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
                {t("apps.openBoard")}
              </button>
              <button type="button" onClick={() => (editing ? setEditing(false) : startEdit())} className="rounded-md px-2.5 py-1 text-xs font-semibold text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
                {editing ? t("apps.cancel") : t("apps.setUrl")}
              </button>
            </div>
          </div>

          {editing ? (
            <div className="flex flex-col gap-2 p-4">
              <label className="text-xs font-semibold text-zinc-300">
                {t("apps.urlProd")}
                <input value={prodUrl} onChange={(e) => setProdUrl(e.target.value)} placeholder={t("apps.urlProdPh")} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
              </label>
              <label className="text-xs font-semibold text-zinc-300">
                {t("apps.urlDev")}
                <input value={devUrl} onChange={(e) => setDevUrl(e.target.value)} placeholder={t("apps.urlDevPh")} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
              </label>
              <div>
                <button type="button" onClick={saveUrls} disabled={busy} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
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
              className="h-[60vh] min-h-[420px] w-full bg-white"
            />
          ) : (
            <div className="p-8 text-center text-sm text-zinc-500">
              {env === "prod" ? t("apps.noPreviewProd") : t("apps.noPreviewDev")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
