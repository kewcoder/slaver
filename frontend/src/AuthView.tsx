import { useEffect, useState } from "react";
import { useLang } from "./i18n";
import { applyTeamTemplate, fetchTeamTemplates, login, register, type TeamTemplate, type User } from "./api";

export function AuthView({ onAuth }: { onAuth: (user: User) => void }) {
  const { t } = useLang();
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

  const inputCls =
    "mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none";

  function fillDemo() {
    setMode("login");
    setError("");
    setEmail("resto@slaver.app");
    setPassword("demo1234");
  }

  return (
    <div className="flex min-h-screen bg-zinc-950">
      <div className="hidden flex-1 flex-col justify-center bg-gradient-to-br from-zinc-950 via-zinc-900 to-emerald-950 p-12 lg:flex">
        <div className="text-3xl font-black tracking-tight text-zinc-100">
          Slaver<span className="text-emerald-400">.</span>
        </div>
        <h1 className="mt-6 max-w-md text-4xl font-bold leading-tight text-zinc-100">
          {t("auth.hero1t")} <span className="text-emerald-400">{t("auth.hero1h")}</span>
        </h1>
        <ul className="mt-8 flex flex-col gap-4 text-[15px] text-zinc-300">
          <li className="flex gap-3"><span className="text-emerald-400">◈</span><span><b>{t("auth.featMarket")}</b> {t("auth.featMarketD")}</span></li>
          <li className="flex gap-3"><span className="text-emerald-400">▤</span><span><b>{t("auth.featTeam")}</b> {t("auth.featTeamD")}</span></li>
          <li className="flex gap-3"><span className="text-emerald-400">⌁</span><span><b>{t("auth.featServer")}</b> {t("auth.featServerD")}</span></li>
        </ul>
      </div>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900 p-8">
          <div className="text-2xl font-bold text-zinc-100 lg:hidden">Slaver<span className="text-emerald-400">.</span></div>
          <p className="mb-5 mt-1 text-sm text-zinc-400">{t("auth.loginHint")}</p>
          <button type="button" onClick={fillDemo} className="mb-4 w-full rounded-md border border-dashed border-zinc-700 px-3 py-2 text-left text-xs text-zinc-400 hover:border-emerald-600 hover:text-zinc-200">
            <span className="font-bold text-emerald-400">{t("auth.demoTitle")}</span><br />
            <span className="font-mono">resto@slaver.app / demo1234</span>
          </button>
          <div className="mb-4 flex gap-2">
            {(["login", "register"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${
                  mode === m ? "bg-zinc-100 text-zinc-900" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {m === "register" ? t("auth.registerTab") : t("auth.loginTab")}
              </button>
            ))}
          </div>
          <form onSubmit={submit} className="flex flex-col gap-3">
            {mode === "register" && (
              <label className="text-sm font-semibold text-zinc-300">
                {t("auth.name")}
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("auth.namePh")} autoComplete="name" className={inputCls} />
              </label>
            )}
            <label className="text-sm font-semibold text-zinc-300">
              Email
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("auth.emailPh")} autoComplete="email" className={inputCls} />
            </label>
            <label className="text-sm font-semibold text-zinc-300">
              {t("auth.password")}
              <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t("auth.passwordPh")} autoComplete={mode === "register" ? "new-password" : "current-password"} className={inputCls} />
            </label>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button type="submit" disabled={busy} className="rounded-md bg-emerald-600 px-3 py-2.5 font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
              {busy ? t("auth.creating") : mode === "register" ? t("auth.create") : t("auth.login")}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

export function OnboardingView({ user, onDone }: { user: User; onDone: () => void }) {
  const { t } = useLang();
  const [templates, setTemplates] = useState<TeamTemplate[]>([]);
  const [teamName, setTeamName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchTeamTemplates().then(setTemplates).catch((err) => setError(err instanceof Error ? err.message : t("auth.failed")));
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
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-6">
      <div className="w-full max-w-2xl">
        <div className="text-3xl font-black tracking-tight text-zinc-100">Slaver<span className="text-emerald-400">.</span></div>
        <h1 className="mt-2 text-2xl font-bold text-zinc-100">{t("auth.onboardHi").replace("{name}", user.name || user.email)}</h1>
        <p className="mt-1 text-sm text-zinc-400">{t("auth.onboardSub")}</p>
        <label className="mt-4 block text-sm font-semibold text-zinc-300">
          {t("auth.teamName")}
          <input value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder={t("auth.teamNamePh")} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
        </label>
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {templates.map((tpl) => (
            <div key={tpl.key} className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              <div className="text-xs font-bold uppercase tracking-wide text-emerald-400">{tpl.category}</div>
              <div className="mt-1 font-bold text-zinc-100">{tpl.name}</div>
              <p className="mt-1 flex-1 text-xs text-zinc-400">{tpl.description}</p>
              {tpl.agents.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {tpl.agents.map((a) => (
                    <span key={a.name} className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">{a.name}</span>
                  ))}
                </div>
              )}
              <button type="button" onClick={() => pick(tpl.key, tpl.team_name)} disabled={busy} className="mt-3 rounded-md bg-emerald-600 px-3 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
                {busy ? t("auth.applying") : t("auth.useTemplate").replace("{name}", tpl.team_name)}
              </button>
            </div>
          ))}
        </div>
        <button type="button" onClick={onDone} disabled={busy} className="mt-4 text-sm text-zinc-500 hover:text-zinc-200">
          {t("auth.skip")}
        </button>
      </div>
    </div>
  );
}

