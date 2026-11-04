import React, { useEffect, useRef, useState, useCallback } from "react";
import { call, toIso, clock } from "./api";
import { Card, Badge, Msg, useAction } from "./ui";

type Props = { offset: number };

const CAMPAIGN_LABEL: Record<string, string> = {
  draft: "Draf",
  scheduled: "Terjadwal",
  live: "Tayang",
  ended: "Selesai",
};
const CAMPAIGN_TONE: Record<string, "ok" | "warn" | "bad" | "info"> = {
  draft: "info",
  scheduled: "warn",
  live: "ok",
  ended: "bad",
};

// ---------- Iklan ----------

export function Ads({ offset }: Props) {
  const [rows, setRows] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [sel, setSel] = useState<any>(null);
  const [gen, setGen] = useState({ product_id: "", promo_code: "", goal: "", tone: "" });
  const [edit, setEdit] = useState({ title: "", body: "", cta: "" });
  const [sched, setSched] = useState({ starts: "", ends: "" });
  const [note, setNote] = useState<string | null>(null);
  const act = useAction();

  const load = useCallback(async () => {
    await act.run(async () => {
      setRows(await call("ad_list"));
      setProducts(await call("catalog_list"));
    });
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  function select(c: any) {
    setSel(c);
    setEdit({ title: c.title, body: c.body, cta: c.cta });
    setNote(null);
  }

  async function generate() {
    await act.run(async () => {
      const c = await call("ad_generate", {
        product_id: gen.product_id || undefined,
        promo_code: gen.promo_code || undefined,
        goal: gen.goal || undefined,
        tone: gen.tone || undefined,
      });
      select(c); // clears the note, so set the message after it
      setNote(c.fallback_reason ? `AI tidak dipakai (${c.fallback_reason}). Draf dibuat dari template.` : "Draf dibuat. Periksa teks sebelum dijadwalkan.");
      await load();
    });
  }

  async function save() {
    await act.run(async () => {
      const c = await call("ad_update", { id: sel.id, ...edit });
      select(c);
      await load();
    });
  }

  async function schedule() {
    await act.run(async () => {
      const c = await call("ad_schedule", {
        id: sel.id,
        starts_at: toIso(sched.starts, offset),
        ends_at: sched.ends ? toIso(sched.ends, offset) : null,
      });
      select(c);
      setNote("Terjadwal. Tampil di toko pada waktu mulai.");
      await load();
    });
  }

  async function setStatus(status: "draft" | "ended") {
    await act.run(async () => {
      const c = await call("ad_set_status", { id: sel.id, status });
      select(c);
      await load();
    });
  }

  return (
    <>
      <h2>Iklan</h2>
      <p className="muted">
        Teks iklan dibuat di sini untuk ditinjau. Tampilan di toko otomatis sesuai jadwal. Posting ke media sosial dilakukan manual.
      </p>
      <Msg error={act.error} />
      {note && <div className="msg ok">{note}</div>}
      <div className="split">
        <Card title="Kampanye">
          <table>
            <thead><tr><th>Judul</th><th>Status</th><th>Mulai</th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => select(c)}>
                  <td>{c.title}<div className="muted small">{c.generated_by === "ai" ? "AI" : "Template"}</div></td>
                  <td><Badge text={CAMPAIGN_LABEL[c.status]} tone={CAMPAIGN_TONE[c.status]} /></td>
                  <td>{c.starts_at ? clock(c.starts_at, offset) : "-"}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={3} className="muted">Belum ada kampanye.</td></tr>}
            </tbody>
          </table>
        </Card>

        <Card title="Buat draf baru">
          <label>Produk
            <select value={gen.product_id} onChange={(e) => setGen({ ...gen, product_id: e.target.value, promo_code: "" })}>
              <option value="">-- pilih produk --</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label>atau kode promo<input value={gen.promo_code} onChange={(e) => setGen({ ...gen, promo_code: e.target.value, product_id: "" })} /></label>
          <label>Tujuan (opsional)<input value={gen.goal} onChange={(e) => setGen({ ...gen, goal: e.target.value })} placeholder="mis. ajak makan siang" /></label>
          <label>Nada (opsional)<input value={gen.tone} onChange={(e) => setGen({ ...gen, tone: e.target.value })} placeholder="mis. ceria" /></label>
          <button disabled={act.busy || (!gen.product_id && !gen.promo_code)} onClick={generate}>Buat draf</button>
        </Card>
      </div>

      {sel && (
        <div className="split">
          <Card title={`Teks · ${CAMPAIGN_LABEL[sel.status]}`}>
            <label>Judul<input value={edit.title} disabled={sel.status === "live"} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></label>
            <label>Isi<textarea rows={4} value={edit.body} disabled={sel.status === "live"} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></label>
            <label>Ajakan (CTA)<input value={edit.cta} disabled={sel.status === "live"} onChange={(e) => setEdit({ ...edit, cta: e.target.value })} /></label>
            <div className="actions">
              <button disabled={act.busy || sel.status === "live"} onClick={save}>Simpan teks</button>
            </div>
          </Card>

          <Card title="Jadwal">
            {sel.starts_at && (
              <p className="muted">
                Mulai {clock(sel.starts_at, offset)}{sel.ends_at ? `, selesai ${clock(sel.ends_at, offset)}` : ""} (waktu toko)
              </p>
            )}
            <label>Mulai (waktu toko)<input type="datetime-local" value={sched.starts} onChange={(e) => setSched({ ...sched, starts: e.target.value })} /></label>
            <label>Selesai (opsional)<input type="datetime-local" value={sched.ends} onChange={(e) => setSched({ ...sched, ends: e.target.value })} /></label>
            <div className="actions">
              <button disabled={act.busy || !sched.starts || sel.status === "live"} onClick={schedule}>Jadwalkan</button>
              {sel.status !== "draft" && sel.status !== "ended" && (
                <button className="ghost" disabled={act.busy} onClick={() => setStatus("draft")}>Batalkan jadwal</button>
              )}
              {(sel.status === "live" || sel.status === "scheduled") && (
                <button className="danger" disabled={act.busy} onClick={() => setStatus("ended")}>Hentikan sekarang</button>
              )}
            </div>
          </Card>
        </div>
      )}
    </>
  );
}

// ---------- Kamera AI ----------

export function Camera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [tables, setTables] = useState<any[]>([]);
  const [results, setResults] = useState<any[] | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const [every, setEvery] = useState(30);
  const [camErr, setCamErr] = useState<string | null>(null);
  const inFlight = useRef(false);
  const act = useAction();

  const loadTables = useCallback(async () => {
    await act.run(async () => setTables(await call("table_availability")));
  }, []);
  useEffect(() => {
    loadTables();
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);

  async function start() {
    setCamErr(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      setStream(s);
      if (videoRef.current) {
        videoRef.current.srcObject = s;
        await videoRef.current.play();
      }
    } catch (e) {
      setCamErr(e instanceof Error ? e.message : "Kamera tidak bisa dibuka. Gunakan upload foto.");
    }
  }

  function stop() {
    stream?.getTracks().forEach((t) => t.stop());
    setStream(null);
    setAuto(false);
  }

  function grab(): string | null {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return null;
    const w = Math.min(1280, v.videoWidth);
    const h = Math.round((v.videoHeight * w) / v.videoWidth);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d")!.drawImage(v, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.7);
  }

  async function check(image?: string | null) {
    const img = image ?? grab();
    if (!img || inFlight.current) return;
    inFlight.current = true;
    await act.run(async () => {
      setResults(await call("table_camera_check", { image: img }));
      setCheckedAt(new Date().toLocaleTimeString("id-ID"));
      await loadTables();
    });
    inFlight.current = false;
  }

  useEffect(() => {
    if (!auto || !stream) return;
    const t = setInterval(() => check(), every * 1000);
    return () => clearInterval(t);
  }, [auto, stream, every]);

  function upload(file: File) {
    const r = new FileReader();
    r.onload = () => check(String(r.result));
    r.readAsDataURL(file);
  }

  return (
    <>
      <h2>Kamera meja (AI)</h2>
      <p className="muted">
        Foto area makan dikirim ke model AI untuk melihat meja mana yang kosong. Hasilnya hanya saran. Status meja tidak berubah otomatis.
      </p>
      <Msg error={act.error ?? camErr} />
      <div className="split">
        <Card title="Kamera">
          <video ref={videoRef} muted playsInline style={{ width: "100%", background: "#000", borderRadius: 8, minHeight: 200 }} />
          <div className="actions">
            {!stream ? (
              <button onClick={start}>Buka kamera</button>
            ) : (
              <>
                <button disabled={act.busy} onClick={() => check()}>Cek sekarang</button>
                <label style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Otomatis tiap
                </label>
                <select value={every} onChange={(e) => setEvery(Number(e.target.value))}>
                  <option value={15}>15 detik</option>
                  <option value={30}>30 detik</option>
                  <option value={60}>1 menit</option>
                </select>
                <button className="ghost" onClick={stop}>Tutup kamera</button>
              </>
            )}
          </div>
          <label>Atau upload foto
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          </label>
        </Card>

        <Card title={checkedAt ? `Hasil terakhir (${checkedAt})` : "Hasil"}>
          {!results && <p className="muted">Belum ada pengecekan.</p>}
          {results && (
            <table>
              <thead><tr><th>Meja</th><th>Status sistem</th><th>Kamera</th></tr></thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.table_id}>
                    <td>{r.name}</td>
                    <td>{r.status}</td>
                    <td>
                      <Badge text={r.observed === "empty" ? "Kosong" : r.observed === "occupied" ? "Terisi" : "Tidak jelas"} tone={r.observed === "empty" ? "ok" : r.observed === "occupied" ? "warn" : "info"} />
                      {r.hint && <div className="muted small">{r.hint}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      <Card title="Observasi terakhir per meja">
        <table>
          <thead><tr><th>Meja</th><th>Status sistem</th><th>Kamera</th><th>Waktu</th></tr></thead>
          <tbody>
            {tables.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>{t.status}</td>
                <td>{t.observed_status ?? <span className="muted">belum dicek</span>}</td>
                <td>{t.observed_at ? clock(t.observed_at) : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

// ---------- Tim ----------

export function Team() {
  const [rows, setRows] = useState<any[]>([]);
  const [form, setForm] = useState({ email: "", name: "", password: "", role: "cashier" });
  const [msg, setMsg] = useState<string | null>(null);
  const act = useAction();
  const load = useCallback(async () => {
    await act.run(async () => setRows(await call("team_member_list")));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="split">
      <Card title="Anggota tim">
        <Msg error={act.error} />
        <table>
          <thead><tr><th>Nama</th><th>Email</th><th>Peran</th><th></th></tr></thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id} style={{ opacity: m.active ? 1 : 0.5 }}>
                <td>{m.name}</td>
                <td>{m.email}</td>
                <td>{m.role}</td>
                <td>
                  {m.role !== "owner" && m.active === 1 && (
                    <button className="ghost small" disabled={act.busy} onClick={async () => {
                      await act.run(async () => {
                        await call("team_member_deactivate", { user_id: m.id });
                        await load();
                      });
                    }}>Nonaktifkan</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Tambah anggota">
        {msg && <div className="msg ok">{msg}</div>}
        <label>Nama<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>Email<input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
        <label>Password awal (min. 8)<input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
        <label>Peran
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="cashier">Kasir</option>
            <option value="manager">Manajer</option>
          </select>
        </label>
        <button
          disabled={act.busy || !form.name || !form.email || form.password.length < 8}
          onClick={async () => {
            setMsg(null);
            await act.run(async () => {
              await call("team_member_add", form);
              setMsg(`Akun ${form.email} dibuat.`);
              setForm({ email: "", name: "", password: "", role: "cashier" });
              await load();
            });
          }}
        >
          Tambah
        </button>
      </Card>
    </div>
  );
}
