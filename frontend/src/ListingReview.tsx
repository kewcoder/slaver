import { useEffect, useState } from "react";
import type { ListingReview } from "./api";
import { useLang } from "./i18n";
import { Icon, Spinner } from "./ui";

/** Live progress while the Meta model reviews a listing request. */
export function ReviewRunning() {
  const { t } = useLang();
  const steps = [t("rev.stepRead"), t("rev.stepChecks"), t("rev.stepModel")];
  const [i, setI] = useState(0);
  useEffect(() => {
    const h = window.setInterval(() => setI((v) => Math.min(v + 1, steps.length - 1)), 2200);
    return () => window.clearInterval(h);
  }, [steps.length]);
  return (
    <section className="surface rounded-2xl p-5">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent-text"><Spinner /></span>
        <div>
          <h3 className="font-bold text-fg">{t("rev.runningTitle")}</h3>
          <p className="text-xs text-muted">{t("rev.runningSub")}</p>
        </div>
      </div>
      <ol className="mt-4 flex flex-col gap-2">
        {steps.map((s, n) => (
          <li key={s} className={`flex items-center gap-2.5 text-sm ${n < i ? "text-accent-text" : n === i ? "text-fg" : "text-subtle"}`}>
            <span className="flex h-5 w-5 items-center justify-center">
              {n < i ? <Icon name="check" size={15} /> : n === i ? <span className="h-2 w-2 animate-pulse rounded-full bg-accent" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
            </span>
            {s}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Result of a listing review: verdict, score, and the Meta model's feedback. */
export function ReviewResult({ review, onRerun, canRerun }: { review: ListingReview; onRerun: () => void; canRerun: boolean }) {
  const { t } = useLang();
  const ok = review.verdict === "approved";
  const ai = review.ai;
  const must = review.checks.filter((c) => c.level === "must");
  const lists: { key: string; title: string; items: string[]; tone: string; icon: string }[] = ai
    ? [
        { key: "must", title: t("rev.mustFix"), items: ai.must_fix, tone: "text-red-300", icon: "✕" },
        { key: "sug", title: t("rev.suggestions"), items: ai.suggestions, tone: "text-amber-200", icon: "→" },
        { key: "good", title: t("rev.strengths"), items: ai.strengths, tone: "text-accent-text", icon: "✓" },
      ]
    : [];

  return (
    <section className="surface overflow-hidden rounded-2xl">
      <div className={`flex flex-wrap items-center gap-4 border-b border-line p-5 ${ok ? "bg-accent/[0.06]" : "bg-amber-400/[0.06]"}`}>
        <div className={`flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-2xl ${ok ? "bg-accent text-accent-fg" : "bg-amber-400/20 text-amber-200"}`}>
          <span className="text-xl font-black leading-none">{review.score != null ? Math.round(review.score * 10) / 10 : "–"}</span>
          <span className="text-[10px] font-bold opacity-80">/10</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-bold text-fg">{ok ? t("rev.approved") : t("rev.changes")}</h3>
            {!review.current && <span className="rounded-full bg-fg/[0.08] px-2 py-0.5 text-[11px] font-semibold text-muted">{t("rev.outdated")}</span>}
          </div>
          <p className="mt-0.5 text-sm leading-6 text-fg-2">{ai?.summary || (must.length ? t("rev.staticBlock") : review.ai_error)}</p>
          <p className="mt-1 text-[11px] text-subtle">
            {review.model ? t("rev.by", { model: review.model }) : t("rev.noModel")} · {t("rev.version")} {review.commit_sha.slice(0, 8)} · {review.files_reviewed.length} {t("rev.files")}
          </p>
        </div>
        {canRerun && (
          <button type="button" onClick={onRerun} className="btn-secondary px-3 py-2 text-xs">
            <Icon name="spark" size={14} />
            {t("rev.rerun")}
          </button>
        )}
      </div>

      {review.ai_error && !ai && <p className="border-b border-line px-5 py-3 text-xs text-red-300">{review.ai_error}</p>}

      {lists.length > 0 && (
        <div className="grid gap-px bg-line md:grid-cols-3">
          {lists.map((l) => (
            <div key={l.key} className="bg-surface p-5">
              <h4 className={`text-xs font-bold uppercase tracking-wider ${l.tone}`}>
                {l.title} <span className="text-subtle">({l.items.length})</span>
              </h4>
              {l.items.length ? (
                <ul className="mt-3 flex flex-col gap-2.5">
                  {l.items.map((it, n) => (
                    <li key={n} className="flex gap-2 text-sm leading-6 text-fg-2">
                      <span className={`mt-px shrink-0 font-bold ${l.tone}`}>{l.icon}</span>
                      <span>{it}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-sm text-subtle">{t("rev.none")}</p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2 border-t border-line px-5 py-3">
        {review.checks.map((c) => (
          <span
            key={c.name}
            title={c.detail}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${c.level === "must" ? "bg-red-500/15 text-red-300" : c.level === "suggest" ? "bg-amber-400/15 text-amber-200" : "bg-fg/[0.06] text-muted"}`}
          >
            {c.level === "ok" ? "✓" : c.level === "must" ? "✕" : "!"} {c.name}
          </span>
        ))}
      </div>
      {must.length > 0 && (
        <ul className="border-t border-line px-5 py-3 text-xs leading-5 text-red-300">
          {must.map((c) => <li key={c.name}>✕ {c.name}: {c.detail}</li>)}
        </ul>
      )}
    </section>
  );
}
