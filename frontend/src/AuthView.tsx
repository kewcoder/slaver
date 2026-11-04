import { useEffect, useState } from "react";
import { useLang } from "./i18n";
import { applyTeamTemplate, fetchTeamTemplates, login, register, type TeamTemplate, type User } from "./api";
import { Brand, Icon } from "./ui";

export function AuthView({ onAuth }: { onAuth: (user: User) => void }) {
  const { t, lang, setLang } = useLang();
  // Demo-first: reviewer langsung login tanpa registrasi.
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("resto@slaver.app");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("demo1234");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pendingUser, setPendingUser] = useState<User | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res =
        mode === "register"
          ? await register(email, password, name)
          : await login(email, password);
      if (mode === "register") {
        setPendingUser(res.user);
      } else {
        onAuth(res.user);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.failed"));
    } finally {
      setBusy(false);
    }
  }

  if (pendingUser) {
    return <OnboardingView user={pendingUser} onDone={() => onAuth(pendingUser)} />;
  }

  const inputCls = "field mt-2";

  function fillDemo() {
    setMode("login");
    setError("");
    setEmail("resto@slaver.app");
    setPassword("demo1234");
  }

  return (
    <div className="relative min-h-dvh overflow-hidden bg-[#090d0c] text-[#f1f5f1]">
      <div className="auth-grid pointer-events-none absolute inset-0" />
      <div className="pointer-events-none absolute -left-40 top-1/3 h-[30rem] w-[30rem] rounded-full bg-[#276b49]/10 blur-3xl" />
      <header className="relative z-10 mx-auto flex w-full max-w-[1440px] items-center justify-between px-5 py-5 sm:px-8 lg:px-12">
        <Brand />
        <div className="flex rounded-lg border border-white/10 bg-white/[0.03] p-0.5 text-[11px] font-bold" title={t("settings.langTitle")}>
          {(["en", "id"] as const).map((l) => (
            <button key={l} type="button" onClick={() => setLang(l)} className={`rounded-md px-2.5 py-1.5 uppercase ${lang === l ? "bg-[#1d2c24] text-[#8ce6b8]" : "text-[#718078] hover:text-white"}`}>
              {l}
            </button>
          ))}
        </div>
      </header>

      <main className="relative z-10 mx-auto grid w-full max-w-[1440px] items-center gap-12 px-5 pb-12 pt-8 sm:px-8 lg:grid-cols-[1.08fr_0.92fr] lg:px-12 lg:pb-16 lg:pt-14">
        <section className="max-w-2xl">
          <div className="soft-badge border-[#62d89d]/20 bg-[#62d89d]/[0.06] text-[#8ce6b8]">
            <Icon name="spark" size={13} /> {t("auth.kicker")}
          </div>
          <h1 className="page-heading mt-6 text-[42px] font-bold leading-[1.08] sm:text-[54px] lg:text-[62px]">
            {t("auth.storyTitle")}
          </h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-[#96a69d] sm:text-lg sm:leading-8">
            {t("auth.storyBody")}
          </p>

          <div className="mt-10 grid gap-5 sm:grid-cols-3">
            {([
              ["01", "auth.stepDiscover", "auth.stepDiscoverBody"],
              ["02", "auth.stepOwn", "auth.stepOwnBody"],
              ["03", "auth.stepShape", "auth.stepShapeBody"],
            ] as const).map(([num, title, body]) => (
              <div key={num} className="border-t border-white/10 pt-4">
                <div className="font-mono text-[11px] font-bold text-[#62d89d]">{num}</div>
                <h3 className="mt-2 text-sm font-bold text-[#e8efeb]">{t(title)}</h3>
                <p className="mt-1.5 text-xs leading-5 text-[#7f9087]">{t(body)}</p>
              </div>
            ))}
          </div>

          <div className="mt-10 hidden items-center gap-3 text-sm text-[#6f8077] lg:flex">
            <span className="h-px w-10 bg-[#31433a]" />
            <span>{t("auth.hero1t")} <strong className="font-semibold text-[#b8c8bf]">{t("auth.hero1h")}</strong></span>
          </div>
        </section>

        <section className="w-full max-w-md justify-self-center lg:justify-self-end">
          <div className="surface-raised rounded-2xl p-6 sm:p-8">
            <div className="mb-7">
              <div className="panel-title">{mode === "register" ? t("auth.registerTab") : t("auth.loginTab")}</div>
              <h2 className="page-heading mt-2 text-2xl font-bold">{mode === "register" ? t("auth.registerTitle") : t("auth.loginTitle")}</h2>
              <p className="mt-1.5 text-sm leading-6 text-[#8f9d96]">{t("auth.loginHint")}</p>
            </div>

            <button type="button" onClick={fillDemo} className="group mb-6 flex w-full items-center gap-3 rounded-xl border border-[#62d89d]/20 bg-[#62d89d]/[0.055] p-3 text-left hover:border-[#62d89d]/40 hover:bg-[#62d89d]/[0.08]">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#62d89d]/10 text-[#8ce6b8]"><Icon name="spark" size={19} /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-bold text-[#a2ecc3]">{t("auth.demoLabel")}</span>
                <span className="mt-1 block truncate font-mono text-[11px] text-[#82958a]">resto@slaver.app / demo1234</span>
              </span>
              <Icon name="arrow" size={16} className="text-[#62d89d]" />
            </button>

            <div className="mb-5 grid grid-cols-2 rounded-lg bg-[#0c1210] p-1">
              {(["login", "register"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`rounded-md px-3 py-2 text-sm font-semibold ${mode === m ? "bg-[#202c26] text-[#f1f5f1] shadow-sm" : "text-[#7f9087] hover:text-[#dbe5df]"}`}
                >
                  {m === "register" ? t("auth.registerTab") : t("auth.loginTab")}
                </button>
              ))}
            </div>

            <form onSubmit={submit} className="flex flex-col gap-4">
              {mode === "register" && (
                <label className="text-xs font-semibold text-[#b8c4bd]">
                  {t("auth.name")}
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("auth.namePh")} autoComplete="name" className={inputCls} />
                </label>
              )}
              <label className="text-xs font-semibold text-[#b8c4bd]">
                Email
                <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("auth.emailPh")} autoComplete="email" className={inputCls} />
              </label>
              <label className="text-xs font-semibold text-[#b8c4bd]">
                {t("auth.password")}
                <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t("auth.passwordPh")} autoComplete={mode === "register" ? "new-password" : "current-password"} className={inputCls} />
              </label>
              {error && <p className="rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-sm text-red-300">{error}</p>}
              <button type="submit" disabled={busy} className="btn-primary mt-1 w-full py-3">
                {busy ? t("auth.creating") : mode === "register" ? t("auth.create") : t("auth.login")}
                {!busy && <Icon name="arrow" size={16} />}
              </button>
            </form>
          </div>
          <p className="mt-4 text-center text-[11px] text-[#617169]">{t("auth.secureNote")}</p>
        </section>
      </main>
    </div>
  );
}

export function OnboardingView({ user, onDone }: { user: User; onDone: () => void }) {
  const { t } = useLang();
  const [templates, setTemplates] = useState<TeamTemplate[]>([]);
  const [teamName, setTeamName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    fetchTeamTemplates().then((list) => {
      setTemplates(list);
      if (list.length > 0) setSelected(list[0].key);
    }).catch((err) => setError(err instanceof Error ? err.message : t("auth.failed")));
  }, []);

  async function pick(key: string, fallbackName: string) {
    setBusy(true);
    setError("");
    try {
      await applyTeamTemplate(key, teamName.trim() || fallbackName);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative min-h-dvh overflow-hidden bg-[#090d0c] px-5 py-6 text-[#f1f5f1] sm:px-8">
      <div className="auth-grid pointer-events-none absolute inset-0" />
      <div className="relative mx-auto w-full max-w-5xl">
        <div className="flex items-center justify-between">
          <Brand />
          <span className="soft-badge"><Icon name="spark" size={13} /> {t("auth.onboardKicker")}</span>
        </div>

        <div className="mt-12 max-w-2xl">
          <div className="panel-title">{t("auth.teamName")}</div>
          <h1 className="page-heading mt-3 text-3xl font-bold sm:text-4xl">{t("auth.onboardHi").replace("{name}", user.name || user.email)}</h1>
          <p className="mt-3 text-sm leading-6 text-[#8f9d96] sm:text-base">{t("auth.onboardSub")}</p>
        </div>

        <div className="surface mt-8 rounded-2xl p-5 sm:p-6">
          <label className="block text-xs font-semibold text-[#b8c4bd]">
            {t("auth.teamName")}
            <input value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder={t("auth.teamNamePh")} className="field mt-2 max-w-lg" />
          </label>
        </div>

        {error && <p className="mt-4 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-sm text-red-300">{error}</p>}

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          {templates.map((tpl) => {
            const active = selected === tpl.key;
            return (
              <button
                key={tpl.key}
                type="button"
                onClick={() => setSelected(tpl.key)}
                className={`flex flex-col rounded-2xl border p-5 text-left ${active ? "border-[#62d89d]/60 bg-[#62d89d]/[0.06] shadow-[0_0_0_3px_rgba(98,216,157,0.05)]" : "border-white/10 bg-[#111815] hover:border-white/20 hover:bg-[#151e1a]"}`}
              >
                <div className="flex w-full items-start justify-between gap-3">
                  <span className="soft-badge border-[#62d89d]/20 text-[#8ce6b8]">{tpl.category}</span>
                  <span className={`flex h-5 w-5 items-center justify-center rounded-full border ${active ? "border-[#62d89d] bg-[#62d89d] text-[#0b2117]" : "border-white/20 text-transparent"}`}><Icon name="check" size={13} /></span>
                </div>
                <div className="mt-4 text-lg font-bold">{tpl.name}</div>
                <p className="mt-2 flex-1 text-sm leading-6 text-[#8f9d96]">{tpl.description}</p>
                {tpl.agents.length > 0 && (
                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {tpl.agents.map((a) => (
                      <span key={a.name} className="rounded-full bg-white/[0.045] px-2.5 py-1 text-[11px] text-[#a8b6ae]">{a.name}</span>
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-5">
          <button type="button" onClick={onDone} disabled={busy} className="text-sm text-[#718078] hover:text-[#dbe5df]">
            {t("auth.skip")}
          </button>
          <button
            type="button"
            disabled={busy || !selected}
            onClick={() => {
              const tpl = templates.find((x) => x.key === selected);
              if (tpl) void pick(tpl.key, tpl.team_name);
            }}
            className="btn-primary"
          >
            {busy ? t("auth.applying") : t("auth.useTemplate").replace("{name}", templates.find((x) => x.key === selected)?.team_name ?? "")}
            {!busy && <Icon name="arrow" size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}

