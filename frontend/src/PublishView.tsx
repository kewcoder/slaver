import { useCallback, useEffect, useRef, useState } from "react";
import {
  createRepo,
  deleteRepo,
  fetchRepoDetail,
  fetchRepos,
  getToken,
  importRepo,
  publishRepo,
  updateRepo,
  uploadRepoArchive,
  type Repo,
} from "./api";
import { useLang } from "./i18n";
import { Icon, SectionHeading, Spinner } from "./ui";

type Commit = { sha: string; author: string; email: string; date: string; subject: string };
type SourceTab = "upload" | "import" | "git" | "api";

export const CATEGORIES = ["Restaurant & F&B", "Retail & POS", "Booking", "CRM", "Website", "Internal tool", "AI agent", "Other"];

function CopyBox({ text, label }: { text: string; label?: string }) {
  const { t } = useLang();
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative">
      {label && <div className="mb-1 text-[11px] font-semibold text-[#82958a]">{label}</div>}
      <pre className="overflow-x-auto whitespace-pre rounded-lg bg-[#070b09] py-2.5 pl-3 pr-20 font-mono text-[11.5px] leading-5 text-[#cfdad3]">{text}</pre>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded-md border border-white/[0.08] bg-[#111815] px-2 py-1 text-[11px] font-semibold text-[#b8c4bd] hover:text-white"
        style={label ? { top: "1.6rem" } : undefined}
      >
        <Icon name={copied ? "check" : "copy"} size={12} />
        {copied ? t("pub.copied") : t("pub.copy")}
      </button>
    </div>
  );
}

/** Creator studio: list your app on the marketplace from a zip, GitHub, git push or the API. */
export default function PublishView({ teamId, teamRole, onGoMarket }: { teamId: string | null; teamRole: string; onGoMarket: () => void }) {
  const { t } = useLang();
  const canManage = teamRole === "owner" || teamRole === "admin";
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoId, setRepoId] = useState("");
  const [log, setLog] = useState<Commit[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  // listing form
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [cat, setCat] = useState("");
  const [price, setPrice] = useState("49");
  // source
  const [tab, setTab] = useState<SourceTab>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [message, setMessage] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [showToken, setShowToken] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const listings = repos.filter((r) => !r.fork_of);
  const repo = listings.find((r) => r.id === repoId) ?? null;
  const hasCode = log.length > 0;
  const live = !!repo && repo.template !== 0;

  const refresh = useCallback(async () => {
    if (!teamId) return setRepos([]);
    try {
      const list = await fetchRepos(teamId);
      setRepos(list);
      const own = list.filter((r) => !r.fork_of);
      setRepoId((cur) => (own.some((r) => r.id === cur) ? cur : own[0]?.id ?? ""));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("files.errLoad"));
    }
  }, [teamId, t]);

  const loadLog = useCallback(async (id: string) => {
    if (!id) return setLog([]);
    try {
      setLog((await fetchRepoDetail(id)).log);
    } catch {
      setLog([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setNotice("");
    setError("");
    setFile(null);
    void loadLog(repoId);
  }, [repoId, loadLog]);

  useEffect(() => {
    if (!repo) return;
    setName(repo.name);
    setDesc(repo.description);
    setCat(repo.category ?? "");
    setPrice(String(((repo.price_cents ?? 0) / 100).toFixed((repo.price_cents ?? 0) % 100 === 0 ? 0 : 2)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.id]);

  async function run(key: string, fn: () => Promise<string | void>) {
    if (busy) return;
    setBusy(key);
    setError("");
    setNotice("");
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pub.fail"));
    } finally {
      setBusy(null);
    }
  }

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    if (!teamId || !newName.trim()) return;
    void run("create", async () => {
      const r = await createRepo(teamId, newName.trim(), "");
      setNewName("");
      setCreating(false);
      await refresh();
      setRepoId(r.repo.id);
      setTab("upload");
    });
  };

  const saveDetails = (e: React.FormEvent) => {
    e.preventDefault();
    if (!repo) return;
    void run("save", async () => {
      const cents = Math.max(0, Math.round(parseFloat(price || "0") * 100) || 0);
      await updateRepo(repo.id, { name: name.trim(), description: desc.trim(), category: cat.trim(), price_cents: cents });
      await refresh();
      return t("pub.saved");
    });
  };

  const upload = () => {
    if (!repo || !file) return;
    void run("upload", async () => {
      const sha = await uploadRepoArchive(repo.id, file, message.trim());
      setFile(null);
      setMessage("");
      await loadLog(repo.id);
      return t("pub.uploaded", { sha: sha.slice(0, 8) });
    });
  };

  const doImport = (e: React.FormEvent) => {
    e.preventDefault();
    if (!repo || !gitUrl.trim()) return;
    if (hasCode && !window.confirm(t("pub.importConfirm"))) return;
    void run("import", async () => {
      const sha = await importRepo(repo.id, gitUrl.trim());
      await loadLog(repo.id);
      return t("pub.imported", { sha: sha.slice(0, 8) });
    });
  };

  const togglePublish = () => {
    if (!repo) return;
    void run("publish", async () => {
      await publishRepo(repo.id, !live);
      await refresh();
      return live ? t("pub.unpublishedOk") : t("pub.publishedOk");
    });
  };

  const remove = () => {
    if (!repo || !window.confirm(t("pub.deleteConfirm", { name: repo.name }))) return;
    void run("delete", async () => {
      await deleteRepo(repo.id);
      await refresh();
    });
  };

  if (!teamId) return <p className="p-6 text-sm text-[#82958a]">{t("files.pickTeam")}</p>;

  const origin = window.location.origin;
  const token = getToken() ?? "<token>";
  const shownToken = showToken ? token : "<your-token>";
  const steps = [
    { done: !!repo && !!repo.description.trim(), label: t("pub.stepDetails") },
    { done: hasCode, label: t("pub.stepSource") },
    { done: live, label: t("pub.stepPublish") },
  ];

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <SectionHeading
        eyebrow={t("pub.eyebrow")}
        title={t("pub.title")}
        description={t("pub.sub")}
        action={
          canManage && (
            <button type="button" onClick={() => setCreating(true)} className="btn-primary">
              <Icon name="plus" size={16} />
              {t("pub.new")}
            </button>
          )
        }
      />

      {!canManage && <p className="rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-4 py-3 text-sm text-amber-100">{t("pub.needAdmin")}</p>}

      {creating && (
        <form onSubmit={create} className="surface flex flex-wrap items-end gap-3 rounded-xl p-4">
          <label className="min-w-[240px] flex-1 text-xs font-semibold text-[#b8c4bd]">
            {t("pub.newName")}
            <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("pub.newNamePh")} maxLength={80} className="field mt-1.5" />
          </label>
          <button type="submit" disabled={!newName.trim() || !!busy} className="btn-primary">{busy === "create" ? <Spinner /> : null}{t("pub.create")}</button>
          <button type="button" onClick={() => setCreating(false)} className="btn-secondary">{t("common.cancel")}</button>
        </form>
      )}

      {listings.length === 0 && !creating ? (
        <section className="surface flex flex-col items-center rounded-2xl border-dashed px-6 py-16 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#62d89d]/10 text-[#8ce6b8]"><Icon name="upload" size={25} /></span>
          <h3 className="page-heading mt-5 text-xl font-bold">{t("pub.emptyTitle")}</h3>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#8f9d96]">{t("pub.emptyBody")}</p>
          <ol className="mx-auto mt-6 grid max-w-2xl gap-3 text-left sm:grid-cols-3">
            {[t("pub.how1"), t("pub.how2"), t("pub.how3")].map((s, i) => (
              <li key={i} className="rounded-xl border border-white/[0.07] bg-[#0f1613] p-3 text-xs leading-5 text-[#a9b8af]">
                <span className="mb-1 block text-lg font-black text-[#62d89d]">{i + 1}</span>
                {s}
              </li>
            ))}
          </ol>
          {canManage && (
            <button type="button" onClick={() => setCreating(true)} className="btn-primary mt-6"><Icon name="plus" size={16} />{t("pub.new")}</button>
          )}
        </section>
      ) : (
        <section className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
          {/* Listing picker */}
          <nav className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
            {listings.map((r) => {
              const active = r.id === repoId;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setRepoId(r.id)}
                  className={`flex min-w-[220px] items-center gap-3 rounded-xl border p-3 text-left lg:min-w-0 ${active ? "border-[#62d89d]/35 bg-[#62d89d]/[0.07]" : "border-white/[0.08] bg-[#111815] hover:border-white/[0.15]"}`}
                >
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-black ${active ? "bg-[#62d89d] text-[#0b2117]" : "bg-[#213028] text-[#a2c4b0]"}`}>{r.name.slice(0, 1).toUpperCase()}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-[#e8efeb]">{r.name}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[#718078]">
                      <span className={`h-1.5 w-1.5 rounded-full ${r.template ? "bg-[#62d89d]" : "bg-[#52615a]"}`} />
                      {r.template ? t("pub.statusLive") : t("pub.statusDraft")} · ${((r.price_cents ?? 0) / 100).toFixed(0)}
                    </span>
                  </span>
                </button>
              );
            })}
          </nav>

          {repo && (
            <div className="flex min-w-0 flex-col gap-4">
              {/* Progress */}
              <div className="surface flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl px-4 py-3">
                {steps.map((s, i) => (
                  <span key={i} className={`flex items-center gap-2 text-xs font-semibold ${s.done ? "text-[#a2ecc3]" : "text-[#718078]"}`}>
                    <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-black ${s.done ? "bg-[#62d89d] text-[#0b2117]" : "border border-white/15"}`}>{s.done ? <Icon name="check" size={12} /> : i + 1}</span>
                    {s.label}
                  </span>
                ))}
                <span className="ml-auto flex items-center gap-2">
                  {live && (
                    <button type="button" onClick={onGoMarket} className="btn-secondary px-2.5 py-1.5 text-[11px]"><Icon name="market" size={14} />{t("pub.viewInMarket")}</button>
                  )}
                  {canManage && (
                    <button type="button" onClick={togglePublish} disabled={!!busy || (!live && !hasCode)} title={!hasCode ? t("pub.needCode") : ""} className={live ? "btn-secondary px-3 py-1.5 text-xs" : "btn-primary px-3 py-1.5 text-xs"}>
                      {busy === "publish" ? <Spinner /> : <Icon name={live ? "x" : "globe"} size={14} />}
                      {live ? t("pub.unpublish") : t("pub.publish")}
                    </button>
                  )}
                </span>
              </div>

              {error && <p className="rounded-xl border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">{error}</p>}
              {notice && <p className="rounded-xl border border-[#62d89d]/25 bg-[#62d89d]/[0.07] px-4 py-3 text-sm text-[#a2ecc3]">{notice}</p>}

              <div className="grid gap-4 xl:grid-cols-2">
                {/* Details */}
                <form onSubmit={saveDetails} className="surface flex flex-col gap-3 rounded-2xl p-5">
                  <div className="flex items-center gap-2">
                    <Icon name="tag" size={16} className="text-[#62d89d]" />
                    <h3 className="text-sm font-bold text-[#edf4ef]">{t("pub.details")}</h3>
                  </div>
                  <label className="text-xs font-semibold text-[#b8c4bd]">
                    {t("pub.name")}
                    <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} disabled={!canManage} className="field mt-1.5" />
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="text-xs font-semibold text-[#b8c4bd]">
                      {t("pub.category")}
                      <input list="pub-cats" value={cat} onChange={(e) => setCat(e.target.value)} maxLength={40} disabled={!canManage} placeholder={CATEGORIES[0]} className="field mt-1.5" />
                      <datalist id="pub-cats">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
                    </label>
                    <label className="text-xs font-semibold text-[#b8c4bd]">
                      {t("pub.price")}
                      <div className="relative mt-1.5">
                        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-[#718078]">$</span>
                        <input type="number" min="0" step="1" value={price} onChange={(e) => setPrice(e.target.value)} disabled={!canManage} className="field pl-7" />
                      </div>
                    </label>
                  </div>
                  <label className="text-xs font-semibold text-[#b8c4bd]">
                    {t("pub.desc")}
                    <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={5} maxLength={2000} disabled={!canManage} placeholder={t("pub.descPh")} className="field mt-1.5 resize-y leading-6" />
                  </label>
                  <p className="text-[11px] leading-5 text-[#5f7268]">{t("pub.priceHelp")}</p>
                  {canManage && (
                    <div className="flex items-center gap-2">
                      <button type="submit" disabled={!!busy || !name.trim()} className="btn-primary">{busy === "save" ? <Spinner /> : <Icon name="check" size={15} />}{t("pub.save")}</button>
                      {!live && (
                        <button type="button" onClick={remove} disabled={!!busy} className="ml-auto text-xs font-semibold text-[#718078] hover:text-red-300">{t("pub.delete")}</button>
                      )}
                    </div>
                  )}
                </form>

                {/* Source */}
                <div className="surface flex flex-col gap-4 rounded-2xl p-5">
                  <div className="flex items-center gap-2">
                    <Icon name="git" size={16} className="text-[#62d89d]" />
                    <h3 className="text-sm font-bold text-[#edf4ef]">{t("pub.source")}</h3>
                    <span className="ml-auto text-[11px] text-[#718078]">{hasCode ? t("pub.versions", { n: log.length }) : t("pub.noCode")}</span>
                  </div>
                  {hasCode && (
                    <div className="rounded-lg border border-white/[0.06] bg-[#0b110e] px-3 py-2 text-xs">
                      <span className="font-mono text-[#62d89d]">{log[0].sha.slice(0, 8)}</span> <span className="text-[#cfdad3]">{log[0].subject}</span>
                      <span className="block text-[11px] text-[#5f7268]">{log[0].author} · {log[0].date.slice(0, 16).replace("T", " ")}</span>
                    </div>
                  )}
                  <div className="flex gap-1 rounded-lg bg-[#0b110e] p-0.5 text-[11px]">
                    {([
                      ["upload", t("pub.tabUpload"), "upload"],
                      ["import", t("pub.tabImport"), "globe"],
                      ["git", t("pub.tabGit"), "git"],
                      ["api", t("pub.tabApi"), "code"],
                    ] as const).map(([id, label, icon]) => (
                      <button key={id} type="button" onClick={() => setTab(id)} className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 font-bold ${tab === id ? "bg-[#223229] text-[#8ce6b8]" : "text-[#718078] hover:text-[#dbe5df]"}`}>
                        <Icon name={icon} size={13} />
                        <span className="hidden sm:inline">{label}</span>
                      </button>
                    ))}
                  </div>

                  {tab === "upload" && (
                    <div className="flex flex-col gap-3">
                      <button
                        type="button"
                        disabled={!canManage}
                        onClick={() => fileInput.current?.click()}
                        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                        onDragLeave={() => setDrag(false)}
                        onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) setFile(f); }}
                        className={`flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-8 text-center ${drag ? "border-[#62d89d] bg-[#62d89d]/[0.06]" : "border-white/15 hover:border-[#62d89d]/50"} disabled:opacity-50`}
                      >
                        <Icon name="upload" size={22} className="text-[#62d89d]" />
                        <span className="text-sm font-semibold text-[#e8efeb]">{file ? file.name : t("pub.dropTitle")}</span>
                        <span className="text-[11px] text-[#718078]">{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : t("pub.dropSub")}</span>
                      </button>
                      <input ref={fileInput} type="file" accept=".zip,.tar,.gz,.tgz,application/zip,application/gzip,application/x-tar" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                      {file && (
                        <div className="flex flex-wrap gap-2">
                          <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder={t("pub.messagePh")} className="field min-w-[180px] flex-1 text-xs" />
                          <button type="button" onClick={upload} disabled={!!busy} className="btn-primary">{busy === "upload" ? <Spinner /> : <Icon name="upload" size={15} />}{t("pub.uploadGo")}</button>
                        </div>
                      )}
                    </div>
                  )}

                  {tab === "import" && (
                    <form onSubmit={doImport} className="flex flex-col gap-2">
                      <p className="text-xs leading-5 text-[#82958a]">{t("pub.importHelp")}</p>
                      <div className="flex flex-wrap gap-2">
                        <input value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} disabled={!canManage} placeholder="https://github.com/you/your-app" className="field min-w-[200px] flex-1 font-mono text-xs" />
                        <button type="submit" disabled={!!busy || !gitUrl.trim() || !canManage} className="btn-primary">{busy === "import" ? <Spinner /> : <Icon name="arrow" size={15} />}{t("pub.importGo")}</button>
                      </div>
                    </form>
                  )}

                  {tab === "git" && (
                    <div className="flex flex-col gap-3">
                      <p className="text-xs leading-5 text-[#82958a]">{t("pub.gitHelp")}</p>
                      <CopyBox text={`git remote add slaver ${origin}/git/${repo.id}\ngit push slaver HEAD:main`} />
                      <div className="flex items-center gap-2 text-[11px] text-[#82958a]">
                        <span>{t("pub.gitAuth")}</span>
                        <button type="button" onClick={() => setShowToken((v) => !v)} className="font-semibold text-[#8ce6b8] hover:underline">{showToken ? t("pub.hideToken") : t("pub.showToken")}</button>
                      </div>
                      {showToken && <CopyBox text={token} />}
                    </div>
                  )}

                  {tab === "api" && (
                    <div className="flex flex-col gap-3">
                      <p className="text-xs leading-5 text-[#82958a]">{t("pub.apiHelp")}</p>
                      <CopyBox label={t("pub.apiUpload")} text={`curl -X POST "${origin}/api/repos/${repo.id}/upload?message=v1" \\\n  -H "Authorization: Bearer ${shownToken}" \\\n  --data-binary @app.zip`} />
                      <CopyBox label={t("pub.apiPublish")} text={`curl -X POST ${origin}/mcp -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer ${shownToken}" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"repos_publish","arguments":{"repo_id":"${repo.id}","template":true}}}'`} />
                    </div>
                  )}

                  <details className="rounded-lg border border-white/[0.06] bg-[#0b110e] px-3 py-2 text-[11px] leading-5 text-[#82958a]">
                    <summary className="cursor-pointer font-semibold text-[#b8c4bd]">{t("pub.compatTitle")}</summary>
                    <ul className="mt-2 list-disc space-y-1 pl-4">
                      <li>{t("pub.compatStatic")}</li>
                      <li>{t("pub.compatVercel")}</li>
                      <li>{t("pub.compatFly")}</li>
                      <li>{t("pub.compatManifest")} <code className="rounded bg-black/40 px-1 font-mono text-[#cfdad3]">{`{ "static_dir": "dist", "port": 8080 }`}</code></li>
                    </ul>
                  </details>
                </div>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
