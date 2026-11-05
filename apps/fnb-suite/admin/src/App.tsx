import { useEffect, useState } from "react";
import { login, restore, logout, call, setupStatus, setupOwner, type Session, type Role } from "./api";
import { Dashboard, Pos, Orders, Menu, Tables, Customers, Promotions, Settings } from "./pages";
import { Ads, Camera, Team } from "./pages2";
import { Msg, useAction } from "./ui";

type PageId = "dashboard" | "pos" | "orders" | "menu" | "tables" | "camera" | "ads" | "customers" | "promos" | "settings" | "team";

// Minimum role per page. Mirrors the server-side tool gating.
const PAGES: { id: PageId; label: string; min: Role }[] = [
  { id: "dashboard", label: "Ringkasan", min: "manager" },
  { id: "pos", label: "Kasir", min: "cashier" },
  { id: "orders", label: "Pesanan", min: "cashier" },
  { id: "menu", label: "Menu & stok", min: "manager" },
  { id: "tables", label: "Meja & booking", min: "cashier" },
  { id: "camera", label: "Kamera meja (AI)", min: "cashier" },
  { id: "ads", label: "Iklan", min: "manager" },
  { id: "customers", label: "Pelanggan", min: "cashier" },
  { id: "promos", label: "Promo", min: "manager" },
  { id: "settings", label: "Pengaturan", min: "manager" },
  { id: "team", label: "Tim & akun", min: "owner" },
];
const RANK: Record<Role, number> = { cashier: 1, manager: 2, owner: 3 };
const allowed = (role: Role, min: Role) => RANK[role] >= RANK[min];

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [offset, setOffset] = useState(7);
  const [page, setPage] = useState<PageId>("pos");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const act = useAction();

  useEffect(() => {
    (async () => {
      const [s, st] = await Promise.all([
        restore(),
        setupStatus().catch(() => ({ needs_setup: false })),
      ]);
      setSession(s);
      // First visit: no owner account exists yet and nobody is logged in.
      setNeedsSetup(!s && st.needs_setup === true);
      setChecking(false);
    })();
  }, []);

  useEffect(() => {
    if (!session) return;
    call("shop_info").then((info: any) => {
      if (info.utc_offset_hours !== undefined) setOffset(Number(info.utc_offset_hours));
    });
    const first = PAGES.find((p) => allowed(session.role, p.min));
    if (first) setPage(first.id);
  }, [session]);

  if (checking) return <div className="login"><p className="muted">Memuat…</p></div>;

  if (!session && needsSetup) {
    return <SetupWizard onDone={(s) => { setSession(s); setNeedsSetup(false); }} />;
  }

  if (!session) {
    return (
      <div className="login">
        <form
          className="card"
          onSubmit={async (e) => {
            e.preventDefault();
            await act.run(async () => setSession(await login(email.trim(), password)));
          }}
        >
          <h2>Masuk</h2>
          <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></label>
          <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <Msg error={act.error} />
          <button disabled={act.busy || !email || !password}>Masuk</button>
        </form>
      </div>
    );
  }

  const visible = PAGES.filter((p) => allowed(session.role, p.min));
  return (
    <div className="shell">
      <nav>
        <div className="brand">Admin</div>
        <div className="muted small" style={{ color: "#94a3b8", padding: "0 10px 10px" }}>
          {session.user.name} · {session.role === "owner" ? "Owner" : session.role === "manager" ? "Manajer" : "Kasir"}
        </div>
        {visible.map((p) => (
          <button key={p.id} className={`nav ${page === p.id ? "active" : ""}`} onClick={() => setPage(p.id)}>
            {p.label}
          </button>
        ))}
        <button
          className="ghost nav"
          onClick={async () => {
            await call("auth_logout").catch(() => {});
            logout();
            setSession(null);
          }}
        >
          Keluar
        </button>
      </nav>
      <main>
        {page === "dashboard" && <Dashboard offset={offset} />}
        {page === "pos" && <Pos offset={offset} />}
        {page === "orders" && <Orders offset={offset} />}
        {page === "menu" && <Menu offset={offset} />}
        {page === "tables" && <Tables offset={offset} />}
        {page === "camera" && <Camera />}
        {page === "ads" && <Ads offset={offset} />}
        {page === "customers" && <Customers />}
        {page === "promos" && <Promotions offset={offset} />}
        {page === "settings" && <Settings />}
        {page === "team" && <Team />}
      </main>
    </div>
  );
}

// First-visit onboarding: shown when the deployment has no owner yet.
// Creates the shop, the owner account, and logs the owner in.
function SetupWizard({ onDone }: { onDone: (s: Session) => void }) {
  const [business, setBusiness] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const act = useAction();

  const mismatch = confirm !== "" && password !== confirm;
  const ready =
    business.trim() !== "" &&
    name.trim() !== "" &&
    email.trim() !== "" &&
    password.length >= 8 &&
    password === confirm;

  return (
    <div className="login">
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!ready) return;
          await act.run(async () => onDone(await setupOwner({
            business: business.trim(),
            name: name.trim(),
            email: email.trim(),
            password,
          })));
        }}
      >
        <h2>Siapkan usaha Anda</h2>
        <p className="muted">
          Kunjungan pertama: buat nama usaha dan akun owner. Setelah ini, tambah
          manajer dan kasir di menu Tim &amp; akun.
        </p>
        <label>Nama usaha<input value={business} onChange={(e) => setBusiness(e.target.value)} placeholder="mis. Warung Kopi Sore" autoFocus /></label>
        <label>Nama owner<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama Anda" /></label>
        <label>Email owner<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="pemilik@usaha.id" /></label>
        <label>Password (min. 8 karakter)<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <label>Ulangi password<input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
        {mismatch && <div className="msg bad">Password tidak sama.</div>}
        <Msg error={act.error} />
        <button disabled={act.busy || !ready}>Buat usaha & masuk</button>
      </form>
    </div>
  );
}
