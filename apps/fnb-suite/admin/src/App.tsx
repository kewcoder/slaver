import { useEffect, useState } from "react";
import { login, restore, logout, call, type Session, type Role } from "./api";
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
  const [offset, setOffset] = useState(7);
  const [page, setPage] = useState<PageId>("pos");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const act = useAction();

  useEffect(() => {
    restore().then((s) => {
      setSession(s);
      setChecking(false);
    });
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
