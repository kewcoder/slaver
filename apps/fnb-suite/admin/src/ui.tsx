import React, { useState } from "react";

export function Card({ title, children, actions }: { title?: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-head">
          <h3>{title}</h3>
          <div>{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

export function Badge({ text, tone }: { text: string; tone?: "ok" | "warn" | "bad" | "info" }) {
  return <span className={`badge ${tone ?? ""}`}>{text}</span>;
}

// Runs an async action, showing its error inline instead of throwing.
export function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { error, busy, run, clearError: () => setError(null) };
}

export function Msg({ error }: { error: string | null }) {
  return error ? <div className="msg bad">{error}</div> : null;
}

export const STATUS_LABEL: Record<string, string> = {
  pending_payment: "Menunggu bayar",
  paid: "Lunas",
  preparing: "Diproses",
  ready: "Siap",
  completed: "Selesai",
  cancelled: "Batal",
  available: "Kosong",
  occupied: "Terisi",
  reserved: "Dipesan",
  cleaning: "Dibersihkan",
  pending: "Menunggu",
  confirmed: "Dikonfirmasi",
  no_show: "Tidak datang",
};

export const FULFILL_LABEL: Record<string, string> = { dine_in: "Dine-in", pickup: "Ambil", delivery: "Antar" };
