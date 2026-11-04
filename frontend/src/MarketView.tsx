import { useCallback, useEffect, useRef, useState } from "react";
import {
  activateLicense,
  checkoutLicense,
  fetchLicenses,
  fetchPaymentStatus,
  fetchProjects,
  fetchRepos,
  fetchTemplates,
  type License,
  type Payment,
  type Project,
  type Repo,
} from "./api";
import { useLang } from "./i18n";
import { InstallDialog } from "./HostingPanel";
import { Icon, Spinner } from "./ui";

function formatPrice(cents?: number): string {
  if (cents === undefined || cents === null) return "";
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

export default function MarketView({
  teamId,
  onGoPublish,
}: {
  teamId: string | null;
  onGoPublish: () => void;
}) {
  const { t } = useLang();
  const [templates, setTemplates] = useState<Repo[]>([]);
  const [section, setSection] = useState<"templates" | "licenses">("templates");
  const [teamRepos, setTeamRepos] = useState<Repo[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [installFor, setInstallFor] = useState<Project | null>(null);
  const [licenses, setLicenses] = useState<License[]>([]);
  const [projects, setProjects] = useState<{ project: Project }[]>([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, setPending] = useState<{ payment: Payment; checkoutUrl: string; sandbox: boolean; repoName: string } | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, []);

  async function pollPayment(paymentId: string, repoName: string, checkoutUrl: string, sandbox: boolean) {
    if (pollRef.current !== null) window.clearInterval(pollRef.current);
    const check = async () => {
      try {
        const { payment, hitpay_status } = await fetchPaymentStatus(paymentId);
        if (hitpay_status === "paid" || payment.status === "paid") {
          if (pollRef.current !== null) window.clearInterval(pollRef.current);
          const res = await activateLicense(paymentId);
          setPending(null);
          await refresh();
          setInstallFor(res.project);
          return;
        }
        if (hitpay_status === "failed" || payment.status === "failed") {
          if (pollRef.current !== null) window.clearInterval(pollRef.current);
          setPending(null);
          setError(t("market.payFailed"));
          return;
        }
        setPending({ payment, checkoutUrl, sandbox, repoName });
      } catch (err) {
        // Keep polling on transient errors; surface only auth/config errors.
        if (err instanceof Error && /not found|team/i.test(err.message)) {
          if (pollRef.current !== null) window.clearInterval(pollRef.current);
          setPending(null);
          setError(err.message);
        }
      }
    };
    await check();
    pollRef.current = window.setInterval(check, 5000);
  }

  // Handle return from HitPay: /market?payment=<id>
  useEffect(() => {
    const pid = new URLSearchParams(window.location.search).get("payment");
    if (!pid) return;
    window.history.replaceState({}, "", window.location.pathname);
    if (!teamId) {
      setError(t("market.payReturn"));
      return;
    }
    (async () => {
      setBusyId("return");
      setError("");
      try {
        const { payment } = await fetchPaymentStatus(pid);
        setPending({ payment, checkoutUrl: "", sandbox: false, repoName: "" });
        await pollPayment(pid, "", "", false);
      } catch (err) {
        setError(err instanceof Error ? err.message : t("market.payVerifyFail"));
      } finally {
        setBusyId(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);



  const refresh = useCallback(async () => {
    setError("");
    try {
      setTemplates(await fetchTemplates());
      if (teamId) {
        const [lic, proj, repos] = await Promise.all([fetchLicenses(teamId), fetchProjects(teamId), fetchRepos(teamId)]);
        setLicenses(lic);
        setProjects(proj);
        setTeamRepos(repos);
      } else {
        setLicenses([]);
        setProjects([]);
        setTeamRepos([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("market.loadFail"));
    }
  }, [teamId, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const licensedRepoIds = new Set(licenses.filter((l) => l.status === "active").map((l) => l.repo_id));

  async function buy(repo: Repo) {
    if (!teamId || busyId) return;
    setBusyId(repo.id);
    setError("");
    try {
      const res = await checkoutLicense(teamId, repo.id);
      if (res.mock || res.license) {
        // Instant (mock / no-key) checkout: already provisioned.
        await refresh();
        if (res.project) setInstallFor(res.project);
        return;
      }
      window.open(res.checkout_url, "_blank", "noopener");
      setPending({ payment: { id: res.payment_id, team_id: teamId, repo_id: repo.id, hitpay_request_id: res.hitpay_request_id, amount_cents: res.amount_cents, currency: res.currency, status: "pending", license_id: "", created_at: "", paid_at: "" }, checkoutUrl: res.checkout_url, sandbox: res.sandbox, repoName: repo.name });
      await pollPayment(res.payment_id, repo.name, res.checkout_url, res.sandbox);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("market.checkoutFail"));
    } finally {
      setBusyId(null);
    }
  }

  const forkToProject = new Map<string, { project: Project }>();
  for (const p of projects) if (p.project.repo_id) forkToProject.set(p.project.repo_id, p);
  const projectForTemplate = (tplId: string) => {
    const fork = teamRepos.find((r) => r.fork_of === tplId);
    return fork ? forkToProject.get(fork.id)?.project ?? null : null;
  };
  const categories = Array.from(new Set(templates.map((x) => x.category || "").filter(Boolean))).sort();
  const q = query.trim().toLowerCase();
  const shown = templates.filter(
    (x) => (!category || x.category === category) && (!q || x.name.toLowerCase().includes(q) || x.description.toLowerCase().includes(q)),
  );
  const owned = templates.filter((x) => licensedRepoIds.has(x.id));

  function appCard(tpl: Repo) {
    const isOwned = licensedRepoIds.has(tpl.id);
    const project = projectForTemplate(tpl.id);
    const mine = tpl.team_id === teamId;
    return (
      <article key={tpl.id} className="surface flex flex-col rounded-2xl p-5 transition hover:border-fg/[0.14]">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-base font-black text-accent-text">{tpl.name.slice(0, 1).toUpperCase()}</span>
          <div className="min-w-0 flex-1">
            <h4 className="truncate text-[15px] font-bold text-fg">{tpl.name}</h4>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
              {tpl.category && <span className="soft-badge py-0.5">{tpl.category}</span>}
              {isOwned && <span className="rounded-full bg-accent/15 px-2 py-0.5 font-bold text-accent-text">{t("market.owned")}</span>}
              {mine && !isOwned && <span className="rounded-full bg-fg/[0.06] px-2 py-0.5 font-bold text-fg-2">{t("market.yours")}</span>}
            </div>
          </div>
          <span className="text-right">
            <span className="block text-lg font-bold text-fg">{(tpl.price_cents ?? 0) === 0 ? t("market.free") : formatPrice(tpl.price_cents)}</span>
            <span className="block text-[10px] text-subtle">{t("market.oneTime")}</span>
          </span>
        </div>
        {tpl.description && <p className="mt-3 line-clamp-3 flex-1 text-sm leading-6 text-muted">{tpl.description}</p>}
        <ul className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-subtle">
          <li className="flex items-center gap-1"><Icon name="check" size={12} className="text-accent" />{t("market.featSource")}</li>
          <li className="flex items-center gap-1"><Icon name="check" size={12} className="text-accent" />{t("market.featHost")}</li>
          <li className="flex items-center gap-1"><Icon name="check" size={12} className="text-accent" />{t("market.featSupport")}</li>
        </ul>
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-fg/[0.06] pt-4">
          {isOwned ? (
            <>
              <button type="button" onClick={() => project && setInstallFor(project)} disabled={!project} className="btn-primary">
                <Icon name="rocket" size={15} />{t("market.installHost")}
              </button>
              {project?.prod_url && (
                <a href={project.prod_url} target="_blank" rel="noreferrer" className="btn-secondary"><Icon name="external" size={14} />{t("market.openApp")}</a>
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={() => buy(tpl)}
              disabled={!teamId || busyId === tpl.id}
              title={!teamId ? t("market.installNeedTeam") : t("market.buyTitle")}
              className="btn-primary"
            >
              {busyId === tpl.id ? <Spinner /> : <Icon name="market" size={15} />}
              {(tpl.price_cents ?? 0) === 0 ? t("market.getFree") : `${t("market.buy")} · ${formatPrice(tpl.price_cents)}`}
            </button>
          )}
        </div>
      </article>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">
      <section className="relative overflow-hidden rounded-2xl border border-accent/15 bg-gradient-to-br from-surface to-bg p-6 sm:p-8">
        <div className="pointer-events-none absolute -right-10 -top-20 h-64 w-64 rounded-full bg-accent/[0.06] blur-3xl" />
        <div className="relative grid items-center gap-6 lg:grid-cols-[1fr_auto]">
          <div className="max-w-2xl">
            <div className="soft-badge border-accent/20 text-accent-text"><Icon name="spark" size={13} />{t("shell.flow")}</div>
            <h2 className="page-heading mt-4 text-3xl font-bold sm:text-4xl">{t("market.heroTitle")}</h2>
            <p className="mt-3 max-w-xl text-sm leading-6 text-muted sm:text-base sm:leading-7">{t("market.heroBody")}</p>
          </div>
          <div className="flex flex-col gap-2 rounded-xl border border-accent/15 bg-inset/50 p-4 lg:min-w-[260px]">
            <div className="panel-title text-accent">{t("market.sellTitle")}</div>
            <p className="text-xs leading-5 text-muted">{t("market.sellBody")}</p>
            <button type="button" onClick={onGoPublish} className="btn-secondary mt-1 self-start"><Icon name="upload" size={15} />{t("market.sellCta")}</button>
          </div>
        </div>
      </section>
      {error && <p className="mt-4 rounded-xl border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">{error}</p>}

      {pending && (
        <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-4 text-sm">
          <div className="flex items-center gap-2 font-bold text-amber-200"><Spinner />{t("market.waitTitle")} {pending.sandbox && <span className="rounded bg-black/30 px-1.5 text-[11px] text-amber-100">{t("market.sandbox")}</span>}</div>
          <div className="mt-1 text-xs text-amber-100/80">
            {pending.repoName ? `“${pending.repoName}” · ` : ""}{t("market.waitBody")}
          </div>
          <div className="mt-3 flex gap-2">
            {pending.checkoutUrl && (
              <a href={pending.checkoutUrl} target="_blank" rel="noreferrer" className="btn-primary px-3 py-1.5 text-xs">{t("market.reopen")}</a>
            )}
            <button type="button" onClick={() => { if (pollRef.current !== null) window.clearInterval(pollRef.current); setPending(null); }} className="btn-secondary px-3 py-1.5 text-xs">
              {t("market.cancel")}
            </button>
          </div>
        </div>
      )}

      <nav className="mt-6 flex gap-1 overflow-x-auto rounded-xl border border-fg/[0.07] bg-surface p-1">
        {([
          ["templates", t("market.templates"), "grid", templates.length],
          ["licenses", t("market.mine"), "check", owned.length],
        ] as const).map(([id, label, icon, count]) => (
          <button key={id} type="button" onClick={() => setSection(id)} className={`flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 py-2.5 text-xs font-bold ${section === id ? "bg-surface-2 text-accent-text" : "text-subtle hover:text-fg"}`}>
            <Icon name={icon} size={15} />{label}
            {count !== null && count > 0 && <span className="rounded-full bg-black/30 px-1.5 text-[10px]">{count}</span>}
          </button>
        ))}
      </nav>

      {section === "templates" && (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <label className="relative min-w-[220px] flex-1 sm:max-w-sm">
              <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("market.searchPh")} className="field pl-9" />
            </label>
            {categories.length > 0 && (
              <div className="flex gap-1 overflow-x-auto">
                {["", ...categories].map((c) => (
                  <button key={c || "all"} type="button" onClick={() => setCategory(c)} className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-semibold ${category === c ? "border-accent/40 bg-accent/10 text-accent-text" : "border-fg/[0.08] text-muted hover:text-fg"}`}>
                    {c || t("market.allCats")}
                  </button>
                ))}
              </div>
            )}
          </div>
          {shown.length === 0 ? (
            <p className="surface mt-5 rounded-2xl p-10 text-center text-sm text-muted">{templates.length === 0 ? t("market.noTemplates") : t("market.noMatch")}</p>
          ) : (
            <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{shown.map(appCard)}</div>
          )}
        </>
      )}

      {section === "licenses" && (
        <div className="mt-5">
          {!teamId ? (
            <p className="text-sm text-muted">{t("market.minePick")}</p>
          ) : owned.length === 0 ? (
            <div className="surface rounded-2xl p-10 text-center">
              <p className="text-sm text-muted">{t("market.mineEmpty")}</p>
              <button type="button" onClick={() => setSection("templates")} className="btn-primary mt-4">{t("apps.emptyMarket")}<Icon name="arrow" size={15} /></button>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{owned.map(appCard)}</div>
          )}
          {licenses.length > 0 && (
            <p className="mt-4 text-[11px] text-subtle">
              {licenses.filter((l) => l.status === "active").map((l) => `${templates.find((x) => x.id === l.repo_id)?.name ?? l.repo_id.slice(0, 8)} · ${t("market.until")} ${l.support_until || "—"}`).join("  ·  ")}
            </p>
          )}
        </div>
      )}

      {installFor && teamId && (
        <InstallDialog
          teamId={teamId}
          projectId={installFor.id}
          projectName={installFor.name}
          onClose={() => setInstallFor(null)}
          onLive={() => void refresh()}
        />
      )}
    </div>
  );
}
