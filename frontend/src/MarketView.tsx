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
          setError("Pembayaran gagal atau kedaluwarsa. Coba lagi.");
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
      setError("Pembayaran terdeteksi — pilih tim dulu, lalu buka Toko lagi untuk selesaikan aktivasi.");
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
        setError(err instanceof Error ? err.message : "Tidak bisa verifikasi pembayaran.");
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
      setError(err instanceof Error ? err.message : "Belum ada channel bantuan — minta tim pemilik membukanya.");
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
      setError(err instanceof Error ? err.message : "Tidak bisa memuat toko.");
    }
  }, [teamId]);

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
      setError(err instanceof Error ? err.message : "Checkout gagal.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-4">
      <h2 className="font-bold text-zinc-100">Toko</h2>
      <p className="mt-1 text-sm text-zinc-400">
        Beli sekali, milik selamanya. Setiap pembelian dapat salinan khusus, aplikasi siap pakai, dan 12 bulan update + bantuan.
      </p>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}

      {pending && (
        <div className="mt-3 rounded-lg border border-amber-700 bg-amber-950/40 p-3 text-sm">
          <div className="font-bold text-amber-200">Menunggu pembayaran… {pending.sandbox && <span className="rounded bg-zinc-800 px-1 text-[11px] text-zinc-300">MODE UJI COBA</span>}</div>
          <div className="mt-1 text-xs text-amber-200/80">
            {pending.repoName ? `“${pending.repoName}” · ` : ""}Tab pembayaran sudah dibuka — selesaikan di sana, lalu kembali ke sini. Pembayaran terdeteksi otomatis.
          </div>
          <div className="mt-2 flex gap-2">
            {pending.checkoutUrl && (
              <a href={pending.checkoutUrl} target="_blank" rel="noreferrer" className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-amber-500">
                Buka halaman bayar lagi
              </a>
            )}
            <button type="button" onClick={() => { if (pollRef.current !== null) window.clearInterval(pollRef.current); setPending(null); }} className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
              Batal
            </button>
          </div>
        </div>
      )}

      <h3 className="mb-2 mt-5 text-sm font-bold uppercase tracking-wide text-zinc-500">Pilihan aplikasi</h3>
      {templates.length === 0 ? (
        <p className="text-sm text-zinc-500">Belum ada aplikasi — cek lagi nanti.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {templates.map((t) => {
            const owned = licensedRepoIds.has(t.id);
            const project = projects.find((p) => p.project.repo_id && licensedRepoIds.has(t.id) && p.project.name.startsWith(t.name.split(" ")[0]));
            return (
              <div key={t.id} className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900 p-4">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold text-zinc-100">{t.name}</h4>
                  <span className="text-sm font-bold text-emerald-400">{formatPrice(t.price_cents)}</span>
                </div>
                <div className="mt-0.5">
                  {owned ? (
                    <span className="rounded bg-emerald-950 px-2 py-0.5 text-[11px] font-bold text-emerald-300">SUDAH PUNYA</span>
                  ) : (
                    <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-bold text-zinc-300">BELI SEKALI</span>
                  )}
                </div>
                {t.description && <p className="mt-1 flex-1 text-sm text-zinc-400">{t.description}</p>}
                <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openSupport(t.id)}
                      disabled={supportBusy === t.id}
                      title="Tanya di channel bantuan penjual (AI mereka yang menjawab)"
                      className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                    >
                      {supportBusy === t.id ? "Membuka…" : "💬 Bantuan"}
                    </button>
                  {owned ? (
                    <button
                      type="button"
                      onClick={() => project && onOpenProject(project.project.id)}
                      disabled={!project}
                      title="Buka papan tugas aplikasi ini di channel"
                      className="rounded-md bg-zinc-700 px-4 py-2 text-sm font-bold text-white hover:bg-zinc-600 disabled:opacity-40"
                    >
                      {project ? "Lihat tugas ▤" : "Sudah dibeli"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => buy(t)}
                      disabled={!teamId || busyId === t.id}
                      title={!teamId ? "Pilih tim dulu" : "Bayar dengan HitPay — dapat salinan + aplikasi + dukungan 12 bulan"}
                      className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40"
                    >
                      {busyId === t.id ? "Memproses…" : `Beli · ${formatPrice(t.price_cents)}`}
                    </button>
                  )}
                  <span className="text-[11px] text-zinc-500">Termasuk update + bantuan 12 bulan</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <h3 className="mb-2 mt-6 text-sm font-bold uppercase tracking-wide text-zinc-500">Keahlian AI</h3>
      <p className="mb-2 text-sm text-zinc-400">Paket peran + ingatan siap pasang ke asisten. Sekali klik, asisten langsung bisa kerja sesuai keahlian.</p>
      <SkillsGrid teamId={teamId} />

      <h3 className="mb-2 mt-6 text-sm font-bold uppercase tracking-wide text-zinc-500">Aplikasi saya {teamId ? "" : "(pilih tim dulu)"}</h3>
      {licenses.length === 0 ? (
        <p className="text-sm text-zinc-600">Tim ini belum punya aplikasi.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {licenses.map((l) => (
            <li key={l.id} className="rounded-md bg-zinc-900 px-3 py-2 text-sm">
              <span className="font-mono text-xs text-zinc-400">{l.repo_id.slice(0, 8)}</span>
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300">{l.kind}</span>
              <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${l.status === "active" ? "bg-emerald-950 text-emerald-300" : "bg-zinc-800 text-zinc-400"}`}>
                {l.status}
              </span>
              <span className="text-xs text-zinc-500">bantuan s/d {l.support_until || "—"} · {l.provider}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SkillsGrid({ teamId }: { teamId: string | null }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [bots, setBots] = useState<SlaveBot[]>([]);
  const [pickFor, setPickFor] = useState<string | null>(null);
  const [botId, setBotId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [fName, setFName] = useState("");
  const [fCat, setFCat] = useState("Layanan");
  const [fDesc, setFDesc] = useState("");
  const [fRole, setFRole] = useState("");
  const [fMem, setFMem] = useState("");

  const refresh = useCallback(async () => {
    try {
      setSkills(await fetchSkills(teamId ?? undefined));
      const all = await fetchBots();
      setBots(all.filter((b) => !b.archived && (!teamId || b.team_id === teamId)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tidak bisa memuat keahlian.");
    }
  }, [teamId]);

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
      setNotice(`“${bot.name}” sekarang punya keahlian baru. Cek di Chat / pengaturan asisten.`);
      setPickFor(null);
      setBotId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal memasang keahlian.");
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
      await createSkill(teamId, { name: fName.trim(), category: fCat.trim() || "Layanan", description: fDesc.trim(), role: fRole.trim(), memory: fMem.trim() });
      setFName("");
      setFDesc("");
      setFRole("");
      setFMem("");
      setFormOpen(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal membuat keahlian.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, name: string) {
    if (!window.confirm(`Hapus keahlian "${name}"? Asisten yang sudah dipasang tidak berubah.`)) return;
    setError("");
    try {
      await deleteSkill(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menghapus.");
    }
  }

  return (
    <div>
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      {notice && <p className="mb-2 text-sm text-emerald-400">{notice}</p>}
      {skills.length === 0 ? (
        <p className="text-sm text-zinc-600">Belum ada keahlian.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {skills.map((s) => (
            <div key={s.id} className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              <div className="flex items-center gap-2">
                <h4 className="font-bold text-zinc-100">{s.name}</h4>
                <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-bold text-zinc-300">{s.category || "Layanan"}</span>
                {s.template !== 0 && <span className="rounded bg-emerald-950 px-2 py-0.5 text-[11px] font-bold text-emerald-300">BAWAAN</span>}
              </div>
              {s.description && <p className="mt-1 flex-1 text-sm text-zinc-400">{s.description}</p>}
              {pickFor === s.id ? (
                <div className="mt-3 flex gap-2">
                  <select
                    value={botId}
                    onChange={(e) => setBotId(e.target.value)}
                    className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
                  >
                    <option value="">Pilih asisten…</option>
                    {bots.map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                  <button type="button" onClick={() => apply(s.id)} disabled={!botId || busy || bots.length === 0} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40">
                    {busy ? "…" : "Pasang"}
                  </button>
                  <button type="button" onClick={() => { setPickFor(null); setBotId(""); }} className="rounded-md px-2 py-2 text-sm text-zinc-400 hover:bg-zinc-800">
                    Batal
                  </button>
                </div>
              ) : (
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => { setPickFor(s.id); setBotId(""); setNotice(""); }}
                    disabled={!teamId || bots.length === 0}
                    title={!teamId ? "Pilih tim dulu" : bots.length === 0 ? "Buat asisten dulu di Pengaturan" : `Pasang ke asisten (peran jadi peran asisten, ingatan ditambahkan)`}
                    className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-40"
                  >
                    Pasang ke asisten
                  </button>
                  {s.template === 0 && (
                    <button type="button" onClick={() => remove(s.id, s.name)} className="ml-auto text-xs text-zinc-500 hover:text-red-400">
                      Hapus
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
              + Buat keahlian sendiri
            </button>
          ) : (
            <form onSubmit={create} className="grid max-w-2xl gap-2 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-xs font-semibold text-zinc-300">
                  Nama keahlian
                  <input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="cth. CS Ramah" maxLength={60} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
                </label>
                <label className="text-xs font-semibold text-zinc-300">
                  Kategori
                  <input value={fCat} onChange={(e) => setFCat(e.target.value)} placeholder="Layanan" maxLength={40} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
                </label>
              </div>
              <label className="text-xs font-semibold text-zinc-300">
                Deskripsi singkat
                <input value={fDesc} onChange={(e) => setFDesc(e.target.value)} placeholder="Untuk apa keahlian ini" maxLength={500} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
              </label>
              <label className="text-xs font-semibold text-zinc-300">
                Peran (jadi peran asisten)
                <textarea value={fRole} onChange={(e) => setFRole(e.target.value)} placeholder="cth. Kamu CS yang ramah…" rows={2} className="mt-1 w-full resize-none rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
              </label>
              <label className="text-xs font-semibold text-zinc-300">
                Ingatan (ditambahkan ke ingatan asisten)
                <textarea value={fMem} onChange={(e) => setFMem(e.target.value)} placeholder="cth. Sapa dengan nama pelanggan…" rows={2} className="mt-1 w-full resize-none rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none" />
              </label>
              <div className="flex gap-2">
                <button type="submit" disabled={!fName.trim() || busy} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
                  {busy ? "Menyimpan..." : "Simpan keahlian"}
                </button>
                <button type="button" onClick={() => setFormOpen(false)} className="rounded-md px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-800">
                  Batal
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
