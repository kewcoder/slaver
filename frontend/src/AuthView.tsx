import { useState } from "react";
import { useLang } from "./i18n";
import { login, register, type User } from "./api";
import { Brand, Icon, ThemeToggle } from "./ui";

export function AuthView({ onAuth }: { onAuth: (user: User) => void }) {
  const { t, lang, setLang } = useLang();
  // Demo-first: reviewer langsung login tanpa registrasi.
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("resto@slaver.app");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("demo1234");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res =
        mode === "register"
          ? await register(email, password, name)
          : await login(email, password);
      onAuth(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.failed"));
    } finally {
      setBusy(false);
    }
  }

  const inputCls = "field mt-2";

  function fillDemo(demoEmail: string) {
    setMode("login");
    setError("");
    setEmail(demoEmail);
    setPassword("demo1234");
  }

  return (
    <div className="relative min-h-dvh overflow-hidden bg-bg text-fg">
      <div className="auth-grid pointer-events-none absolute inset-0" />
      <div className="pointer-events-none absolute -left-40 top-1/3 h-[30rem] w-[30rem] rounded-full bg-accent/10 blur-3xl" />
      <header className="relative z-10 mx-auto flex w-full max-w-[1440px] items-center justify-between px-5 py-5 sm:px-8 lg:px-12">
        <Brand />
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <div className="flex rounded-lg border border-fg/10 bg-fg/[0.03] p-0.5 text-[11px] font-bold" title={t("settings.langTitle")}>
            {(["en", "id"] as const).map((l) => (
              <button key={l} type="button" onClick={() => setLang(l)} className={`rounded-md px-2.5 py-1.5 uppercase ${lang === l ? "bg-surface-2 text-accent-text" : "text-subtle hover:text-fg"}`}>
                {l}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto grid w-full max-w-[1440px] items-center gap-12 px-5 pb-12 pt-8 sm:px-8 lg:grid-cols-[1.08fr_0.92fr] lg:px-12 lg:pb-16 lg:pt-14">
        <section className="max-w-2xl">
          <div className="soft-badge border-accent/20 bg-accent/[0.06] text-accent-text">
            <Icon name="spark" size={13} /> {t("auth.kicker")}
          </div>
          <h1 className="page-heading mt-6 text-[42px] font-bold leading-[1.08] sm:text-[54px] lg:text-[62px]">
            {t("auth.storyTitle")}
          </h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-muted sm:text-lg sm:leading-8">
            {t("auth.storyBody")}
          </p>

          <div className="mt-10 grid gap-5 sm:grid-cols-3">
            {([
              ["01", "auth.stepDiscover", "auth.stepDiscoverBody"],
              ["02", "auth.stepOwn", "auth.stepOwnBody"],
              ["03", "auth.stepShape", "auth.stepShapeBody"],
            ] as const).map(([num, title, body]) => (
              <div key={num} className="border-t border-fg/10 pt-4">
                <div className="font-mono text-[11px] font-bold text-accent">{num}</div>
                <h3 className="mt-2 text-sm font-bold text-fg">{t(title)}</h3>
                <p className="mt-1.5 text-xs leading-5 text-muted">{t(body)}</p>
              </div>
            ))}
          </div>

          <div className="mt-10 hidden items-center gap-3 text-sm text-subtle lg:flex">
            <span className="h-px w-10 bg-surface-2" />
            <span>{t("auth.hero1t")} <strong className="font-semibold text-fg-2">{t("auth.hero1h")}</strong></span>
          </div>
        </section>

        <section className="w-full max-w-md justify-self-center lg:justify-self-end">
          <div className="surface-raised rounded-2xl p-6 sm:p-8">
            <div className="mb-7">
              <div className="panel-title">{mode === "register" ? t("auth.registerTab") : t("auth.loginTab")}</div>
              <h2 className="page-heading mt-2 text-2xl font-bold">{mode === "register" ? t("auth.registerTitle") : t("auth.loginTitle")}</h2>
              <p className="mt-1.5 text-sm leading-6 text-muted">{t("auth.loginHint")}</p>
            </div>

            <div className="mb-6 flex flex-col gap-2">
              {([
                ["resto@slaver.app", t("auth.demoLabel")],
                ["labs@slaver.app", t("auth.demoSeller")],
              ] as const).map(([demoEmail, label]) => (
                <button key={demoEmail} type="button" onClick={() => fillDemo(demoEmail)} className="group flex w-full items-center gap-3 rounded-xl border border-accent/20 bg-accent/[0.055] p-3 text-left hover:border-accent/40 hover:bg-accent/[0.08]">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent-text"><Icon name={demoEmail.startsWith("labs") ? "upload" : "spark"} size={19} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-bold text-accent-text">{label}</span>
                    <span className="mt-1 block truncate font-mono text-[11px] text-muted">{demoEmail} / demo1234</span>
                  </span>
                  <Icon name="arrow" size={16} className="text-accent" />
                </button>
              ))}
            </div>

            <div className="mb-5 grid grid-cols-2 rounded-lg bg-sidebar p-1">
              {(["login", "register"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`rounded-md px-3 py-2 text-sm font-semibold ${mode === m ? "bg-surface-2 text-fg shadow-sm" : "text-muted hover:text-fg"}`}
                >
                  {m === "register" ? t("auth.registerTab") : t("auth.loginTab")}
                </button>
              ))}
            </div>

            <form onSubmit={submit} className="flex flex-col gap-4">
              {mode === "register" && (
                <label className="text-xs font-semibold text-fg-2">
                  {t("auth.name")}
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("auth.namePh")} autoComplete="name" className={inputCls} />
                </label>
              )}
              <label className="text-xs font-semibold text-fg-2">
                Email
                <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("auth.emailPh")} autoComplete="email" className={inputCls} />
              </label>
              <label className="text-xs font-semibold text-fg-2">
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
          <p className="mt-4 text-center text-[11px] text-subtle">{t("auth.secureNote")}</p>
        </section>
      </main>
    </div>
  );
}
