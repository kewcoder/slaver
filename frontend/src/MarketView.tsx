import { useCallback, useEffect, useRef, useState } from "react";
import {
  activateLicense,
  applySkill,
  checkoutLicense,
  createSkill,
  deleteSkill,
  fetchBots,
  fetchLicenses,
  fetchPaymentStatus,
  fetchProjects,
  fetchSkills,
  fetchTemplates,
  type License,
  type Payment,
  type Project,
  type ProjectStats,
  type Repo,
  type Skill,
  type SlaveBot,
} from "./api";
import { useLang } from "./i18n";

function formatPrice(cents?: number): string {
  if (cents === undefined || cents === null) return "";
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

export default function MarketView({
  teamId,
  onOpenProject,
  onOpenSupport,
}: {
  teamId: string | null;
  onOpenProject: (projectId: string) => void;
  onOpenSupport: (repoId: string) => Promise<void>;
}) {
  const { t } = useLang();
  const [templates, setTemplates] = useState<Repo[]>([]);
  const [licenses, setLicenses] = useState<License[]>([]);
  const [projects, setProjects] = useState<{ project: Project; stats: ProjectStats }[]>([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [supportBusy, setSupportBusy] = useState<string | null>(null);
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
          onOpenProject(res.project.id);
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

  async function openSupport(repoId: string) {
    setError("");
    setSupportBusy(repoId);
    try {
      await onOpenSupport(repoId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("market.noSupport"));
    } finally {
      setSupportBusy(null);
    }
  }

  const refresh = useCallback(async () => {
    setError("");
    try {
      setTemplates(await fetchTemplates());
      if (teamId) {
        setLicenses(await fetchLicenses(teamId));
        setProjects(await fetchProjects(teamId));
      } else {
        setLicenses([]);
        setProjects([]);
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
        if (res.project) onOpenProject(res.project.id);
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

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-4">
      <h2 className="font-bold text-zinc-100">{t("market.title")}</h2>
      <p className="mt-1 text-sm text-zinc-400">
        {t("market.sub")}
      </p>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}

      {pending && (
        <div className="mt-3 rounded-lg border border-amber-700 bg-amber-950/40 p-3 text-sm">
          <div className="font-bold text-amber-200">{t("market.waitTitle")} {pending.sandbox && <span className="rounded bg-zinc-800 px-1 text-[11px] text-zinc-300">{t("market.sandbox")}</span>}</div>
          <div className="mt-1 text-xs text-amber-200/80">
            {pending.repoName ? `“${pending.repoName}” · ` : ""}{t("market.waitBody")}
          </div>
          <div className="mt-2 flex gap-2">
            {pending.checkoutUrl && (
              <a href={pending.checkoutUrl} target="_blank" rel="noreferrer" className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-amber-500">
                {t("market.reopen")}
              </a>
            )}
            <button type="button" onClick={() => { if (pollRef.current !== null) window.clearInterval(pollRef.current); setPending(null); }} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
              {t("market.cancel")}
            </button>
          </div>
        </div>
      )}

      <h3 className="mb-2 mt-5 text-sm font-bold uppercase tracking-wide text-zinc-500">{t("market.templates")}</h3>
      {templates.length === 0 ? (
        <p className="text-sm text-zinc-500">{t("market.noTemplates")}</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {templates.map((tpl) => {
            const owned = licensedRepoIds.has(tpl.id);
            const project = projects.find((p) => p.project.repo_id && licensedRepoIds.has(tpl.id) && p.project.name.startsWith(tpl.name.split(" ")[0]));
            return (
              <div key={tpl.id} className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900 p-4">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold text-zinc-100">{tpl.name}</h4>
                  <span className="text-sm font-bold text-emerald-400">{formatPrice(tpl.price_cents)}</span>
                </div>
                <div className="mt-0.5">
                  {owned ? (
                    <span className="rounded bg-emerald-950 px-2 py-0.5 text-[11px] font-bold text-emerald-300">{t("market.owned")}</span>
                  ) : (
                    <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-bold text-zinc-300">{t("market.buyOnce")}</span>
                  )}
                </div>
                {tpl.description && <p className="mt-1 flex-1 text-sm text-zinc-400">{tpl.description}</p>}
                <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openSupport(tpl.id)}
                      disabled={supportBusy === tpl.id}
                      title={t("market.supportTitle")}
                      className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                    >
                      {supportBusy === tpl.id ? t("market.supportOpening") : t("market.support")}
                    </button>
                  {owned ? (
                    <button
                      type="button"
                      onClick={() => project && onOpenProject(project.project.id)}
                      disabled={!project}
                      title={t("market.openBoardTitle")}
                      className="rounded-md bg-zinc-700 px-4 py-2 text-sm font-bold text-white hover:bg-zinc-600 disabled:opacity-40"
                    >
                      {project ? t("market.openBoard") : t("market.licensed")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => buy(tpl)}
                      disabled={!teamId || busyId === tpl.id}
                      title={!teamId ? t("market.installNeedTeam") : t("market.buyTitle")}
                      className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40"
                    >
                      {busyId === tpl.id ? t("market.processing") : `${t("market.buy")} · ${formatPrice(tpl.price_cents)}`}
                    </button>
                  )}
                  <span className="text-[11px] text-zinc-500">{t("market.includes")}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <h3 className="mb-2 mt-6 text-sm font-bold uppercase tracking-wide text-zinc-500">{t("market.skillsTitle")}</h3>
      <p className="mb-2 text-sm text-zinc-400">{t("market.skillsBody")}</p>
      <SkillsGrid teamId={teamId} />

      <h3 className="mb-2 mt-6 text-sm font-bold uppercase tracking-wide text-zinc-500">{t("market.mine")} {teamId ? "" : t("market.minePick")}</h3>
      {licenses.length === 0 ? (
        <p className="text-sm text-zinc-600">{t("market.mineEmpty")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {licenses.map((l) => (
            <li key={l.id} className="rounded-md bg-zinc-900 px-3 py-2 text-sm">
              <span className="font-mono text-xs text-zinc-400">{l.repo_id.slice(0, 8)}</span>
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300">{l.kind}</span>
              <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${l.status === "active" ? "bg-emerald-950 text-emerald-300" : "bg-zinc-800 text-zinc-400"}`}>
                {l.status}
              </span>
              <span className="text-xs text-zinc-500">{t("market.until")} {l.support_until || "—"} · {l.provider}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SkillsGrid({ teamId }: { teamId: string | null }) {
  const { t } = useLang();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [bots, setBots] = useState<SlaveBot[]>([]);
  const [pickFor, setPickFor] = useState<string | null>(null);
  const [botId, setBotId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [fName, setFName] = useState("");
  const [fCat, setFCat] = useState("");
  const [fDesc, setFDesc] = useState("");
  const [fRole, setFRole] = useState("");
  const [fMem, setFMem] = useState("");

  const refresh = useCallback(async () => {
    try {
      setSkills(await fetchSkills(teamId ?? undefined));
      const all = await fetchBots();
      setBots(all.filter((b) => !b.archived && (!teamId || b.team_id === teamId)));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("market.skillsFail"));
    }
  }, [teamId, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function apply(skillId: string) {
    if (!botId || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const bot = await applySkill(skillId, botId);
      setNotice(t("market.installedOk").replace("{name}", `“${bot.name}”`));
      setPickFor(null);
      setBotId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("market.applyFail"));
    } finally {
      setBusy(false);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!teamId || !fName.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await createSkill(teamId, { name: fName.trim(), category: fCat.trim() || t("market.catDefault"), description: fDesc.trim(), role: fRole.trim(), memory: fMem.trim() });
      setFName("");
      setFDesc("");
      setFRole("");
      setFMem("");
      setFormOpen(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("market.createFail"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, name: string) {
    if (!window.confirm(t("market.deleteSkillConfirm").replace("{name}", name))) return;
    setError("");
    try {
      await deleteSkill(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("market.deleteFail"));
    }
  }

  return (
    <div>
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      {notice && <p className="mb-2 text-sm text-emerald-400">{notice}</p>}
      {skills.length === 0 ? (
        <p className="text-sm text-zinc-600">{t("market.noSkills")}</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {skills.map((s) => (
            <div key={s.id} className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              <div className="flex items-center gap-2">
                <h4 className="font-bold text-zinc-100">{s.name}</h4>
                <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-bold text-zinc-300">{s.category || t("market.catDefault")}</span>
                {s.template !== 0 && <span className="rounded bg-emerald-950 px-2 py-0.5 text-[11px] font-bold text-emerald-300">{t("market.skillBuiltin")}</span>}
              </div>
              {s.description && <p className="mt-1 flex-1 text-sm text-zinc-400">{s.description}</p>}
              {pickFor === s.id ? (
                <div className="mt-3 flex gap-2">
                  <select
                    value={botId}
                    onChange={(e) => setBotId(e.target.value)}
                    className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
                  >
                    <option value="">{t("market.pickBot")}</option>
                    {bots.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                  <button type="button" onClick={() => apply(s.id)} disabled={!botId || busy || bots.length === 0} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40">
                    {busy ? "…" : t("market.installGo")}
                  </button>
                  <button type="button" onClick={() => { setPickFor(null); setBotId(""); }} className="rounded-md px-2 py-2 text-sm text-zinc-400 hover:bg-zinc-800">
                    {t("chat.installCancel")}
                  </button>
                </div>
              ) : (
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => { setPickFor(s.id); setBotId(""); setNotice(""); }}
                    disabled={!teamId || bots.length === 0}
                    title={!teamId ? t("market.installNeedTeam") : bots.length === 0 ? t("market.installNeedBot") : t("market.installTitle")}
                    className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40"
                  >
                    {t("market.install")}
                  </button>
                  {s.template === 0 && (
                    <button type="button" onClick={() => remove(s.id, s.name)} className="ml-auto text-xs text-zinc-500 hover:text-red-400">
                      {t("market.deleteSkill")}
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {teamId && (
        <div className="mt-3">
          {!formOpen ? (
            <button type="button" onClick={() => setFormOpen(true)} className="rounded-md border border-dashed border-zinc-700 px-3 py-2 text-sm text-zinc-400 hover:border-emerald-600 hover:text-zinc-200">
              {t("market.newSkill")}
            </button>
          ) : (
            <form onSubmit={create} className="grid max-w-2xl gap-2 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-xs font-semibold text-zinc-300">
                  {t("market.skillName")}
                  <input value={fName} onChange={(e) => setFName(e.target.value)} placeholder={t("market.skillNamePh")} maxLength={60} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
                </label>
                <label className="text-xs font-semibold text-zinc-300">
                  {t("market.skillCategory")}
                  <input value={fCat} onChange={(e) => setFCat(e.target.value)} placeholder={t("market.catDefault")} maxLength={40} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
                </label>
              </div>
              <label className="text-xs font-semibold text-zinc-300">
                {t("market.skillDesc")}
                <input value={fDesc} onChange={(e) => setFDesc(e.target.value)} placeholder={t("market.skillDescPh")} maxLength={500} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
              </label>
              <label className="text-xs font-semibold text-zinc-300">
                {t("market.skillRole")}
                <textarea value={fRole} onChange={(e) => setFRole(e.target.value)} placeholder={t("market.skillRolePh")} rows={2} className="mt-1 w-full resize-none rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
              </label>
              <label className="text-xs font-semibold text-zinc-300">
                {t("market.skillMemory")}
                <textarea value={fMem} onChange={(e) => setFMem(e.target.value)} placeholder={t("market.skillMemoryPh")} rows={2} className="mt-1 w-full resize-none rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
              </label>
              <div className="flex gap-2">
                <button type="submit" disabled={!fName.trim() || busy} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
                  {busy ? t("market.skillSaving") : t("market.skillSave")}
                </button>
                <button type="button" onClick={() => setFormOpen(false)} className="rounded-md px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-800">
                  {t("chat.installCancel")}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
