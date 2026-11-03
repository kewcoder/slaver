import { useEffect, useState } from "react";
import { applyTeamTemplate, fetchTeamTemplates, login, register, type TeamTemplate, type User } from "./api";

export function AuthView({ onAuth }: { onAuth: (user: User) => void }) {
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
      setError(err instanceof Error ? err.message : "Failed. Try again.");
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
          Don&apos;t just connect software. <span className="text-emerald-400">Own it.</span>
        </h1>
        <ul className="mt-8 flex flex-col gap-4 text-[15px] text-zinc-300">
          <li className="flex gap-3"><span className="text-emerald-400">◈</span><span><b>Marketplace</b> — beli aplikasi sekali, jadi milikmu selamanya.</span></li>
          <li className="flex gap-3"><span className="text-emerald-400">▤</span><span><b>AI team</b> — agen yang customize, review, dan deploy untukmu.</span></li>
          <li className="flex gap-3"><span className="text-emerald-400">⌁</span><span><b>Server sendiri</b> — jalan di servermu, bukan sewa SaaS.</span></li>
        </ul>
      </div>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900 p-8">
          <div className="text-2xl font-bold text-zinc-100 lg:hidden">Slaver<span className="text-emerald-400">.</span></div>
          <p className="mb-5 mt-1 text-sm text-zinc-400">Masuk untuk mengelola usaha dan asisten AI-mu.</p>
          <button type="button" onClick={fillDemo} className="mb-4 w-full rounded-md border border-dashed border-zinc-700 px-3 py-2 text-left text-xs text-zinc-400 hover:border-emerald-600 hover:text-zinc-200">
            <span className="font-bold text-emerald-400">Coba demo rumah makan →</span><br />
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
                {m === "register" ? "Daftar" : "Masuk"}
              </button>
            ))}
          </div>
          <form onSubmit={submit} className="flex flex-col gap-3">
            {mode === "register" && (
              <label className="text-sm font-semibold text-zinc-300">
                Nama
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama kamu" autoComplete="name" className={inputCls} />
              </label>
            )}
            <label className="text-sm font-semibold text-zinc-300">
              Email
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="kamu@usaha.com" autoComplete="email" className={inputCls} />
            </label>
            <label className="text-sm font-semibold text-zinc-300">
              Kata sandi
              <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Minimal 8 karakter" autoComplete={mode === "register" ? "new-password" : "current-password"} className={inputCls} />
            </label>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button type="submit" disabled={busy} className="rounded-md bg-emerald-600 px-3 py-2.5 font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
              {busy ? "Tunggu..." : mode === "register" ? "Buat akun" : "Masuk"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

export function OnboardingView({ user, onDone }: { user: User; onDone: () => void }) {
  const [templates, setTemplates] = useState<TeamTemplate[]>([]);
  const [teamName, setTeamName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchTeamTemplates().then(setTemplates).catch((err) => setError(err instanceof Error ? err.message : "Could not load templates."));
  }, []);

  async function pick(key: string, fallbackName: string) {
    setBusy(true);
    setError("");
    try {
      await applyTeamTemplate(key, teamName.trim() || fallbackName);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create team.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-6">
      <div className="w-full max-w-2xl">
        <div className="text-3xl font-black tracking-tight text-zinc-100">Slaver<span className="text-emerald-400">.</span></div>
        <h1 className="mt-2 text-2xl font-bold text-zinc-100">Halo, {user.name || user.email} — mau mulai usaha apa?</h1>
        <p className="mt-1 text-sm text-zinc-400">Pilih template tim: dapat team + agen AI yang profilnya sudah diset sesuai kategori bisnis. Bisa diganti nanti.</p>
        <label className="mt-4 block text-sm font-semibold text-zinc-300">
          Nama tim / usahamu
          <input value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="cth. Saung Rangon" className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
        </label>
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {templates.map((t) => (
            <div key={t.key} className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              <div className="text-xs font-bold uppercase tracking-wide text-emerald-400">{t.category}</div>
              <div className="mt-1 font-bold text-zinc-100">{t.name}</div>
              <p className="mt-1 flex-1 text-xs text-zinc-400">{t.description}</p>
              {t.agents.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {t.agents.map((a) => (
                    <span key={a.name} className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">{a.name}</span>
                  ))}
                </div>
              )}
              <button type="button" onClick={() => pick(t.key, t.team_name)} disabled={busy} className="mt-3 rounded-md bg-emerald-600 px-3 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
                {busy ? "Menyiapkan..." : `Pakai: ${t.team_name}`}
              </button>
            </div>
          ))}
        </div>
        <button type="button" onClick={onDone} disabled={busy} className="mt-4 text-sm text-zinc-500 hover:text-zinc-200">
          Lewati — masuk tanpa template
        </button>
      </div>
    </div>
  );
}

