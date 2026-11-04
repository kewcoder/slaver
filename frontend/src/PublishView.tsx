import { useCallback, useEffect, useRef, useState } from "react";
import {
  createRepo,
  deleteRepo,
  fetchRepoDetail,
  fetchListingReview,
  fetchRepos,
  getToken,
  runListingReview,
  type ListingReview,
  publishRepo,
  updateRepo,
  uploadRepoArchive,
  type GithubLink,
  type Repo,
} from "./api";
import GithubSource from "./GithubSource";
import { ReviewResult, ReviewRunning } from "./ListingReview";
import { useLang } from "./i18n";
import { Icon, SectionHeading, Spinner } from "./ui";

type Commit = { sha: string; author: string; email: string; date: string; subject: string };
type SourceTab = "github" | "upload" | "git" | "api";

export const CATEGORIES = ["Restaurant & F&B", "Retail & POS", "Booking", "CRM", "Website", "Internal tool", "AI agent", "Other"];

function CopyBox({ text, label }: { text: string; label?: string }) {
  const { t } = useLang();
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative">
      {label && <div className="mb-1 text-[11px] font-semibold text-muted">{label}</div>}
      <pre className="overflow-x-auto whitespace-pre rounded-lg bg-inset py-2.5 pl-3 pr-20 font-mono text-[11.5px] leading-5 text-fg-2">{text}</pre>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="absolute right-1.5 top-1.5 flex items-center gap-1 rounded-md border border-fg/[0.08] bg-surface px-2 py-1 text-[11px] font-semibold text-fg-2 hover:text-fg"
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
  const { t, lang } = useLang();
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
  const [tab, setTab] = useState<SourceTab>("github");
  const [ghLink, setGhLink] = useState<GithubLink | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [message, setMessage] = useState("");
  const [showToken, setShowToken] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [review, setReview] = useState<ListingReview | null>(null);
  const [reviewing, setReviewing] = useState(false);

  const listings = repos.filter((r) => !r.fork_of);
  const repo = listings.find((r) => r.id === repoId) ?? null;
  const hasCode = log.length > 0;
  const live = !!repo && repo.template !== 0;
  const approved = !!review && review.current && review.verdict === "approved";

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

  // Return from GitHub OAuth: /?view=publish&github=connected|error&msg=…
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const gh = p.get("github");
    if (p.has("view") || gh) window.history.replaceState({}, "", window.location.pathname);
    if (gh === "connected") setNotice(t("gh.connectedOk"));
    if (gh === "error") setError(p.get("msg") || t("gh.fail"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const prevRepo = useRef("");
  useEffect(() => {
    if (prevRepo.current) {
      setNotice("");
      setError("");
    }
    prevRepo.current = repoId;
    setFile(null);
    void loadLog(repoId);
  }, [repoId, loadLog]);

  useEffect(() => {
    if (!repoId) return setReview(null);
    let stale = false;
    fetchListingReview(repoId)
      .then((r) => !stale && setReview(r))
      .catch(() => !stale && setReview(null));
    return () => {
      stale = true;
    };
  }, [repoId, log.length]);

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

  const togglePublish = () => {
    if (!repo) return;
    void run("publish", async () => {
      await publishRepo(repo.id, !live);
      await refresh();
      return live ? t("pub.unpublishedOk") : t("pub.publishedOk");
    });
  };

  // "Ajukan listing": the Meta model reviews the current version; approved listings go live right away.
  const requestListing = () => {
    if (!repo || reviewing || busy) return;
    setReviewing(true);
    setError("");
    setNotice("");
    runListingReview(repo.id, lang)
      .then(async (r) => {
        setReview(r);
        if (r.verdict === "approved") {
          await publishRepo(repo.id, true);
          await refresh();
          setNotice(t("rev.publishedOk"));
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("pub.fail")))
      .finally(() => setReviewing(false));
  };

  const remove = () => {
    if (!repo || !window.confirm(t("pub.deleteConfirm", { name: repo.name }))) return;
    void run("delete", async () => {
      await deleteRepo(repo.id);
      await refresh();
    });
  };

  if (!teamId) return <p className="p-6 text-sm text-muted">{t("files.pickTeam")}</p>;

  const origin = window.location.origin;
  const token = getToken() ?? "<token>";
  const shownToken = showToken ? token : "<your-token>";
  const steps = [
    { done: !!repo && !!repo.description.trim(), label: t("pub.stepDetails") },
    { done: hasCode, label: t("pub.stepSource") },
    { done: approved || live, label: t("rev.stepReview") },
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
          <label className="min-w-[240px] flex-1 text-xs font-semibold text-fg-2">
            {t("pub.newName")}
            <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("pub.newNamePh")} maxLength={80} className="field mt-1.5" />
          </label>
          <button type="submit" disabled={!newName.trim() || !!busy} className="btn-primary">{busy === "create" ? <Spinner /> : null}{t("pub.create")}</button>
          <button type="button" onClick={() => setCreating(false)} className="btn-secondary">{t("common.cancel")}</button>
        </form>
      )}

      {listings.length === 0 && !creating ? (
        <section className="surface flex flex-col items-center rounded-2xl border-dashed px-6 py-16 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent-text"><Icon name="upload" size={25} /></span>
          <h3 className="page-heading mt-5 text-xl font-bold">{t("pub.emptyTitle")}</h3>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">{t("pub.emptyBody")}</p>
          <ol className="mx-auto mt-6 grid max-w-2xl gap-3 text-left sm:grid-cols-3">
            {[t("pub.how1"), t("pub.how2"), t("pub.how3")].map((s, i) => (
              <li key={i} className="rounded-xl border border-fg/[0.07] bg-surface p-3 text-xs leading-5 text-fg-2">
                <span className="mb-1 block text-lg font-black text-accent">{i + 1}</span>
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
                  className={`flex min-w-[220px] items-center gap-3 rounded-xl border p-3 text-left lg:min-w-0 ${active ? "border-accent/35 bg-accent/[0.07]" : "border-fg/[0.08] bg-surface hover:border-fg/[0.15]"}`}
                >
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-black ${active ? "bg-accent text-accent-fg" : "bg-surface-2 text-accent-text"}`}>{r.name.slice(0, 1).toUpperCase()}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-fg">{r.name}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-subtle">
                      <span className={`h-1.5 w-1.5 rounded-full ${r.template ? "bg-accent" : "bg-subtle"}`} />
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
                  <span key={i} className={`flex items-center gap-2 text-xs font-semibold ${s.done ? "text-accent-text" : "text-subtle"}`}>
                    <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-black ${s.done ? "bg-accent text-accent-fg" : "border border-fg/15"}`}>{s.done ? <Icon name="check" size={12} /> : i + 1}</span>
                    {s.label}
                  </span>
                ))}
                <span className="ml-auto flex items-center gap-2">
                  {live && (
                    <button type="button" onClick={onGoMarket} className="btn-secondary px-2.5 py-1.5 text-[11px]"><Icon name="market" size={14} />{t("pub.viewInMarket")}</button>
                  )}
                  {canManage && live && (
                    <button type="button" onClick={togglePublish} disabled={!!busy} className="btn-secondary px-3 py-1.5 text-xs">
                      {busy === "publish" ? <Spinner /> : <Icon name="x" size={14} />}
                      {t("pub.unpublish")}
                    </button>
                  )}
                  {canManage && !live && (
                    <button type="button" onClick={requestListing} disabled={reviewing || !!busy || !hasCode} title={!hasCode ? t("pub.needCode") : ""} className="btn-primary px-3 py-1.5 text-xs">
                      {reviewing ? <Spinner /> : <Icon name="spark" size={14} />}
                      {t("rev.request")}
                    </button>
                  )}
                </span>
              </div>

              {error && <p className="rounded-xl border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">{error}</p>}
              {notice && <p className="rounded-xl border border-accent/25 bg-accent/[0.07] px-4 py-3 text-sm text-accent-text">{notice}</p>}

              {reviewing ? (
                <ReviewRunning />
              ) : review ? (
                <ReviewResult review={review} canRerun={canManage && !live && hasCode} onRerun={requestListing} />
              ) : (
                !live && hasCode && canManage && (
                  <section className="surface flex flex-wrap items-center gap-4 rounded-2xl p-5">
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent-text"><Icon name="spark" size={20} /></span>
                    <div className="min-w-0 flex-1">
                      <h3 className="font-bold text-fg">{t("rev.ctaTitle")}</h3>
                      <p className="text-sm text-muted">{t("rev.ctaBody")}</p>
                    </div>
                    <button type="button" onClick={requestListing} className="btn-primary"><Icon name="spark" size={15} />{t("rev.request")}</button>
                  </section>
                )
              )}

              <div className="grid gap-4 xl:grid-cols-2">
                {/* Details */}
                <form onSubmit={saveDetails} className="surface flex flex-col gap-3 rounded-2xl p-5">
                  <div className="flex items-center gap-2">
                    <Icon name="tag" size={16} className="text-accent" />
                    <h3 className="text-sm font-bold text-fg">{t("pub.details")}</h3>
                  </div>
                  <label className="text-xs font-semibold text-fg-2">
                    {t("pub.name")}
                    <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} disabled={!canManage} className="field mt-1.5" />
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="text-xs font-semibold text-fg-2">
                      {t("pub.category")}
                      <input list="pub-cats" value={cat} onChange={(e) => setCat(e.target.value)} maxLength={40} disabled={!canManage} placeholder={CATEGORIES[0]} className="field mt-1.5" />
                      <datalist id="pub-cats">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
                    </label>
                    <label className="text-xs font-semibold text-fg-2">
                      {t("pub.price")}
                      <div className="relative mt-1.5">
                        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-subtle">$</span>
                        <input type="number" min="0" step="1" value={price} onChange={(e) => setPrice(e.target.value)} disabled={!canManage} className="field pl-7" />
                      </div>
                    </label>
                  </div>
                  <label className="text-xs font-semibold text-fg-2">
                    {t("pub.desc")}
                    <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={5} maxLength={2000} disabled={!canManage} placeholder={t("pub.descPh")} className="field mt-1.5 resize-y leading-6" />
                  </label>
                  <p className="text-[11px] leading-5 text-subtle">{t("pub.priceHelp")}</p>
                  {canManage && (
                    <div className="flex items-center gap-2">
                      <button type="submit" disabled={!!busy || !name.trim()} className="btn-primary">{busy === "save" ? <Spinner /> : <Icon name="check" size={15} />}{t("pub.save")}</button>
                      {!live && (
                        <button type="button" onClick={remove} disabled={!!busy} className="ml-auto text-xs font-semibold text-subtle hover:text-red-300">{t("pub.delete")}</button>
                      )}
                    </div>
                  )}
                </form>

                {/* Source */}
                <div className="surface flex flex-col gap-4 rounded-2xl p-5">
                  <div className="flex items-center gap-2">
                    <Icon name="git" size={16} className="text-accent" />
                    <h3 className="text-sm font-bold text-fg">{t("pub.source")}</h3>
                    <span className="ml-auto text-[11px] text-subtle">{hasCode ? t("pub.versions", { n: log.length }) : t("pub.noCode")}</span>
                  </div>
                  {hasCode && (
                    <div className="rounded-lg border border-fg/[0.06] bg-inset px-3 py-2 text-xs">
                      <span className="font-mono text-accent">{log[0].sha.slice(0, 8)}</span> <span className="text-fg-2">{log[0].subject}</span>
                      <span className="block text-[11px] text-subtle">{log[0].author} · {log[0].date.slice(0, 16).replace("T", " ")}</span>
                    </div>
                  )}
                  <div className="flex gap-1 rounded-lg bg-inset p-0.5 text-[11px]">
                    {([
                      ["github", "GitHub", "git"],
                      ["upload", t("pub.tabUpload"), "upload"],
                      ["git", t("pub.tabGit"), "arrow"],
                      ["api", t("pub.tabApi"), "code"],
                    ] as const).map(([id, label, icon]) => (
                      <button key={id} type="button" onClick={() => setTab(id)} className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 font-bold ${tab === id ? "bg-surface-2 text-accent-text" : "text-subtle hover:text-fg"}`}>
                        <Icon name={icon} size={13} />
                        <span className="hidden sm:inline">{label}</span>
                      </button>
                    ))}
                  </div>

                  <div className={tab === "github" ? "" : "hidden"}>
                    <GithubSource teamId={teamId} repoId={repo.id} canManage={canManage} onLinkChange={setGhLink} onSynced={() => void loadLog(repo.id)} />
                  </div>
                  {tab !== "github" && ghLink && (
                    <p className="rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-xs leading-5 text-amber-100">{t("gh.lockedNote", { repo: ghLink.github_repo })}</p>
                  )}

                  {tab === "upload" && !ghLink && (
                    <div className="flex flex-col gap-3">
                      <button
                        type="button"
                        disabled={!canManage}
                        onClick={() => fileInput.current?.click()}
                        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                        onDragLeave={() => setDrag(false)}
                        onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) setFile(f); }}
                        className={`flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-8 text-center ${drag ? "border-accent bg-accent/[0.06]" : "border-fg/15 hover:border-accent/50"} disabled:opacity-50`}
                      >
                        <Icon name="upload" size={22} className="text-accent" />
                        <span className="text-sm font-semibold text-fg">{file ? file.name : t("pub.dropTitle")}</span>
                        <span className="text-[11px] text-subtle">{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : t("pub.dropSub")}</span>
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

                  {tab === "git" && !ghLink && (
                    <div className="flex flex-col gap-3">
                      <p className="text-xs leading-5 text-muted">{t("pub.gitHelp")}</p>
                      <CopyBox text={`git remote add slaver ${origin}/git/${repo.id}\ngit push slaver HEAD:main`} />
                      <div className="flex items-center gap-2 text-[11px] text-muted">
                        <span>{t("pub.gitAuth")}</span>
                        <button type="button" onClick={() => setShowToken((v) => !v)} className="font-semibold text-accent-text hover:underline">{showToken ? t("pub.hideToken") : t("pub.showToken")}</button>
                      </div>
                      {showToken && <CopyBox text={token} />}
                    </div>
                  )}

                  {tab === "api" && (
                    <div className="flex flex-col gap-3">
                      <p className="text-xs leading-5 text-muted">{t("pub.apiHelp")}</p>
                      <CopyBox label={t("pub.apiUpload")} text={`curl -X POST "${origin}/api/repos/${repo.id}/upload?message=v1" \\\n  -H "Authorization: Bearer ${shownToken}" \\\n  --data-binary @app.zip`} />
                      <CopyBox label={t("pub.apiPublish")} text={`curl -X POST ${origin}/mcp -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer ${shownToken}" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"repos_publish","arguments":{"repo_id":"${repo.id}","template":true}}}'`} />
                    </div>
                  )}

                  <details className="rounded-lg border border-fg/[0.06] bg-inset px-3 py-2 text-[11px] leading-5 text-muted">
                    <summary className="cursor-pointer font-semibold text-fg-2">{t("pub.compatTitle")}</summary>
                    <ul className="mt-2 list-disc space-y-1 pl-4">
                      <li>{t("pub.compatStatic")}</li>
                      <li>{t("pub.compatVercel")}</li>
                      <li>{t("pub.compatFly")}</li>
                      <li>{t("pub.compatManifest")} <code className="rounded bg-black/40 px-1 font-mono text-fg-2">{`{ "static_dir": "dist", "port": 8080 }`}</code></li>
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
