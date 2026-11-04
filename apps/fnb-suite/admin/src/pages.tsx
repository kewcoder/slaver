import React, { useEffect, useState, useCallback } from "react";
import { call, rupiah, shopToday, toIso, clock } from "./api";
import { Card, Stat, Badge, Msg, useAction, STATUS_LABEL, FULFILL_LABEL } from "./ui";

type Props = { offset: number; onChanged?: () => void };

// ---------- Dashboard ----------

export function Dashboard({ offset }: Props) {
  const [sales, setSales] = useState<any>(null);
  const [pending, setPending] = useState<any[]>([]);
  const [tables, setTables] = useState<any[]>([]);
  const act = useAction();
  const load = useCallback(async () => {
    await act.run(async () => {
      const today = shopToday(offset);
      setSales(await call("sales_summary", { date: today }));
      setPending(await call("order_list", { status: "pending_payment" }));
      setTables(await call("table_availability"));
    });
  }, [offset]);
  useEffect(() => {
    load();
  }, [load]);

  const free = tables.filter((t) => t.status === "available").length;
  return (
    <>
      <h2>Ringkasan hari ini</h2>
      <Msg error={act.error} />
      <div className="grid4">
        <Stat label="Omzet" value={rupiah(sales?.revenue_idr)} />
        <Stat label="Pesanan lunas" value={sales?.orders ?? "-"} />
        <Stat label="Menunggu bayar" value={pending.length} />
        <Stat label="Meja kosong" value={`${free} / ${tables.length}`} />
      </div>
      <div className="grid2">
        <Card title="Pembayaran per metode">
          {(sales?.by_method ?? []).length === 0 && <p className="muted">Belum ada pembayaran.</p>}
          <ul className="plain">
            {(sales?.by_method ?? []).map((m: any) => (
              <li key={m.method}>
                {m.method.toUpperCase()} · {m.payments}x · {rupiah(m.amount_idr)}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Produk terlaris">
          {(sales?.top_products ?? []).length === 0 && <p className="muted">Belum ada penjualan.</p>}
          <ul className="plain">
            {(sales?.top_products ?? []).map((p: any) => (
              <li key={p.product_name}>
                {p.product_name} · {p.qty}x · {rupiah(p.revenue_idr)}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

// ---------- Kasir (POS) ----------

export function Pos({ offset, onChanged }: Props) {
  const [menu, setMenu] = useState<any[]>([]);
  const [tables, setTables] = useState<any[]>([]);
  const [lines, setLines] = useState<{ product: any; qty: number; addon?: any }[]>([]);
  const [fulfillment, setFulfillment] = useState<"dine_in" | "pickup" | "delivery">("dine_in");
  const [tableId, setTableId] = useState("");
  const [cust, setCust] = useState({ name: "", phone: "", address: "" });
  const [method, setMethod] = useState<"cash" | "qris" | "transfer" | "card">("cash");
  const [received, setReceived] = useState("");
  const [receipt, setReceipt] = useState<any>(null);
  const act = useAction();

  useEffect(() => {
    act.run(async () => {
      setMenu(await call("catalog_list"));
      setTables(await call("table_availability"));
    });
  }, []);

  const subtotal = lines.reduce((s, l) => s + (l.product.price_idr + (l.addon?.price_idr ?? 0)) * l.qty, 0);
  const total = subtotal;

  function add(product: any, addon?: any) {
    setLines((prev) => {
      const same = prev.find((l) => l.product.id === product.id && l.addon?.id === addon?.id);
      if (same) return prev.map((l) => (l === same ? { ...l, qty: l.qty + 1 } : l));
      return [...prev, { product, qty: 1, addon }];
    });
  }

  async function charge() {
    await act.run(async () => {
      const cart = (await call("cart_create")).cart_id;
      for (const l of lines) {
        await call("cart_add_item", {
          cart_id: cart,
          product_id: l.product.id,
          qty: l.qty,
          addon_id: l.addon?.id,
        });
      }
      const customer = cust.name && cust.phone ? { name: cust.name, phone: cust.phone, address: cust.address || undefined } : undefined;
      const order = await call("order_place", {
        cart_id: cart,
        fulfillment,
        table_id: fulfillment === "dine_in" ? tableId : undefined,
        address: fulfillment === "delivery" ? cust.address : undefined,
        customer,
      });
      const paid = await call("order_pay", {
        order_id: order.id,
        method,
        amount_received_idr: method === "cash" ? Number(received || order.total_idr) : undefined,
      });
      setReceipt(paid);
      setLines([]);
      setReceived("");
      setCust({ name: "", phone: "", address: "" });
      onChanged?.();
    });
  }

  if (receipt) {
    return (
      <Card title="Struk">
        <div className="receipt">
          <div>Pesanan {receipt.id}</div>
          {receipt.items.map((i: any) => (
            <div key={i.id} className="row">
              <span>
                {i.qty}x {i.product_name}
                {i.addon_name ? ` + ${i.addon_name}` : ""}
              </span>
              <span>{rupiah(i.line_total_idr)}</span>
            </div>
          ))}
          <div className="row strong">
            <span>Total</span>
            <span>{rupiah(receipt.total_idr)}</span>
          </div>
          <div className="row">
            <span>Bayar ({receipt.payments[0]?.method})</span>
            <span>{rupiah(receipt.payments[0]?.amount_idr)}</span>
          </div>
          <div className="row">
            <span>Kembali</span>
            <span>{rupiah(receipt.change_idr)}</span>
          </div>
        </div>
        <button onClick={() => setReceipt(null)}>Transaksi baru</button>
      </Card>
    );
  }

  return (
    <div className="pos">
      <Card title="Menu">
        <Msg error={act.error} />
        <div className="menu-grid">
          {menu.map((p) => (
            <div key={p.id} className="menu-item">
              <div>
                <strong>{p.name}</strong>
                <div className="muted">{rupiah(p.price_idr)}</div>
                <div className="muted small">
                  {p.available === null ? "Stok tak terbatas" : `Sisa ${p.available}`}
                </div>
              </div>
              <button disabled={p.available === 0} onClick={() => add(p)}>
                Tambah
              </button>
              {p.addons.map((a: any) => (
                <button key={a.id} className="ghost small" disabled={p.available === 0} onClick={() => add(p, a)}>
                  + {a.name} ({rupiah(a.price_idr)})
                </button>
              ))}
            </div>
          ))}
        </div>
      </Card>

      <Card title="Keranjang">
        {lines.length === 0 && <p className="muted">Belum ada item.</p>}
        {lines.map((l, i) => (
          <div key={i} className="row">
            <span>
              {l.product.name}
              {l.addon ? ` + ${l.addon.name}` : ""}
            </span>
            <span className="qty">
              <button className="ghost small" onClick={() => setLines(lines.map((x, j) => (j === i ? { ...x, qty: x.qty - 1 } : x)).filter((x) => x.qty > 0))}>−</button>
              {l.qty}
              <button className="ghost small" onClick={() => setLines(lines.map((x, j) => (j === i ? { ...x, qty: x.qty + 1 } : x)))}>+</button>
            </span>
            <span>{rupiah((l.product.price_idr + (l.addon?.price_idr ?? 0)) * l.qty)}</span>
          </div>
        ))}
        <div className="row strong">
          <span>Total</span>
          <span>{rupiah(total)}</span>
        </div>

        <label>
          Jenis
          <select value={fulfillment} onChange={(e) => setFulfillment(e.target.value as any)}>
            <option value="dine_in">Dine-in (meja)</option>
            <option value="pickup">Ambil di tempat</option>
            <option value="delivery">Antar</option>
          </select>
        </label>
        {fulfillment === "dine_in" && (
          <label>
            Meja
            <select value={tableId} onChange={(e) => setTableId(e.target.value)}>
              <option value="">Pilih meja</option>
              {tables.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.capacity} org) · {STATUS_LABEL[t.status]}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Nama pelanggan (opsional)
          <input value={cust.name} onChange={(e) => setCust({ ...cust, name: e.target.value })} />
        </label>
        <label>
          No. HP (opsional)
          <input value={cust.phone} onChange={(e) => setCust({ ...cust, phone: e.target.value })} />
        </label>
        {fulfillment === "delivery" && (
          <label>
            Alamat antar
            <input value={cust.address} onChange={(e) => setCust({ ...cust, address: e.target.value })} />
          </label>
        )}
        <label>
          Metode bayar
          <select value={method} onChange={(e) => setMethod(e.target.value as any)}>
            <option value="cash">Tunai</option>
            <option value="qris">QRIS</option>
            <option value="transfer">Transfer</option>
            <option value="card">Kartu</option>
          </select>
        </label>
        {method === "cash" && (
          <label>
            Uang diterima
            <input type="number" value={received} placeholder={String(total)} onChange={(e) => setReceived(e.target.value)} />
          </label>
        )}
        <button
          disabled={act.busy || lines.length === 0 || (fulfillment === "dine_in" && !tableId)}
          onClick={charge}
        >
          Bayar {rupiah(total)}
        </button>
      </Card>
    </div>
  );
}

// ---------- Pesanan ----------

const NEXT_STATUS: Record<string, string[]> = {
  paid: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["completed", "cancelled"],
  pending_payment: ["cancelled"],
};

export function Orders({ offset, onChanged }: Props) {
  const [list, setList] = useState<any[]>([]);
  const [filter, setFilter] = useState<string>("");
  const [open, setOpen] = useState<any>(null);
  const [method, setMethod] = useState<"cash" | "qris" | "transfer" | "card">("qris");
  const act = useAction();

  const load = useCallback(async () => {
    await act.run(async () => {
      setList(await call("order_list", { ...(filter ? { status: filter } : {}), date: shopToday(offset) }));
    });
  }, [filter, offset]);
  useEffect(() => {
    load();
  }, [load]);

  async function openOrder(id: string) {
    await act.run(async () => setOpen(await call("order_get", { order_id: id })));
  }
  async function pay() {
    await act.run(async () => {
      setOpen(await call("order_pay", { order_id: open.id, method }));
      onChanged?.();
      load();
    });
  }
  async function move(status: string) {
    await act.run(async () => {
      setOpen(await call("order_set_status", { order_id: open.id, status }));
      onChanged?.();
      load();
    });
  }

  return (
    <div className="split">
      <Card
        title="Pesanan hari ini"
        actions={
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">Semua status</option>
            {Object.keys(NEXT_STATUS).concat(["completed", "cancelled"]).filter((v, i, a) => a.indexOf(v) === i).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        }
      >
        <Msg error={act.error} />
        <table>
          <thead>
            <tr>
              <th>Jam</th>
              <th>Jenis</th>
              <th>Total</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {list.map((o) => (
              <tr key={o.id} className="clickable" onClick={() => openOrder(o.id)}>
                <td>{clock(o.created_at, offset)}</td>
                <td>{FULFILL_LABEL[o.fulfillment]}</td>
                <td>{rupiah(o.total_idr)}</td>
                <td>
                  <Badge text={STATUS_LABEL[o.status]} tone={o.status === "cancelled" ? "bad" : o.status === "pending_payment" ? "warn" : "ok"} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title={open ? `Detail ${open.id}` : "Detail"}>
        {!open && <p className="muted">Pilih pesanan.</p>}
        {open && (
          <>
            <div>
              {FULFILL_LABEL[open.fulfillment]}
              {open.table_id ? ` · meja ${open.table_id}` : ""} · <Badge text={STATUS_LABEL[open.status]} />
            </div>
            {open.items.map((i: any) => (
              <div key={i.id} className="row">
                <span>
                  {i.qty}x {i.product_name}
                  {i.addon_name ? ` + ${i.addon_name}` : ""}
                </span>
                <span>{rupiah(i.line_total_idr)}</span>
              </div>
            ))}
            {open.discount_idr > 0 && <div className="row"><span>Diskon {open.promo_code}</span><span>-{rupiah(open.discount_idr)}</span></div>}
            {open.delivery_fee_idr > 0 && <div className="row"><span>Ongkir</span><span>{rupiah(open.delivery_fee_idr)}</span></div>}
            <div className="row strong">
              <span>Total</span>
              <span>{rupiah(open.total_idr)}</span>
            </div>
            {open.address && <div className="muted">Alamat: {open.address}</div>}
            {open.note && <div className="muted">Catatan: {open.note}</div>}

            {open.status === "pending_payment" && (
              <div className="actions">
                <select value={method} onChange={(e) => setMethod(e.target.value as any)}>
                  <option value="qris">QRIS</option>
                  <option value="transfer">Transfer</option>
                  <option value="card">Kartu</option>
                  <option value="cash">Tunai</option>
                </select>
                <button disabled={act.busy} onClick={pay}>Tandai lunas</button>
              </div>
            )}
            <div className="actions">
              {(NEXT_STATUS[open.status] ?? []).map((s) => (
                <button key={s} className={s === "cancelled" ? "danger" : ""} disabled={act.busy} onClick={() => move(s)}>
                  {STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

// ---------- Menu ----------

export function Menu({ onChanged }: Props) {
  const [items, setItems] = useState<any[]>([]);
  const [form, setForm] = useState<any>({ name: "", category: "", price_idr: "", stock_qty: "", description: "" });
  const [addonFor, setAddonFor] = useState<string | null>(null);
  const [addon, setAddon] = useState<any>({ name: "", price_idr: "", stock_qty: "" });
  const act = useAction();

  const load = useCallback(async () => {
    await act.run(async () => setItems(await call("catalog_list")));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    await act.run(async () => {
      await call("product_upsert", {
        id: form.id,
        name: form.name,
        category: form.category,
        description: form.description,
        price_idr: Number(form.price_idr),
        stock_qty: form.stock_qty === "" ? null : Number(form.stock_qty),
      });
      setForm({ name: "", category: "", price_idr: "", stock_qty: "", description: "" });
      await load();
      onChanged?.();
    });
  }
  async function edit(p: any) {
    setForm({ id: p.id, name: p.name, category: p.category, price_idr: p.price_idr, stock_qty: p.available ?? "", description: p.description });
  }
  async function restock(id: string, delta: number) {
    await act.run(async () => {
      await call("stock_adjust", { product_id: id, delta });
      await load();
    });
  }
  async function saveAddon(productId: string) {
    await act.run(async () => {
      await call("addon_upsert", {
        product_id: productId,
        name: addon.name,
        price_idr: Number(addon.price_idr),
        stock_qty: addon.stock_qty === "" ? null : Number(addon.stock_qty),
      });
      setAddon({ name: "", price_idr: "", stock_qty: "" });
      await load();
    });
  }

  return (
    <div className="split">
      <Card title="Produk & stok">
        <Msg error={act.error} />
        <table>
          <thead>
            <tr>
              <th>Nama</th>
              <th>Kategori</th>
              <th>Harga</th>
              <th>Stok</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <React.Fragment key={p.id}>
                <tr>
                  <td>{p.name}</td>
                  <td>{p.category}</td>
                  <td>{rupiah(p.price_idr)}</td>
                  <td>
                    {p.available === null ? (
                      <Badge text="Tak terbatas" />
                    ) : (
                      <>
                        {p.available}{" "}
                        <button className="ghost small" onClick={() => restock(p.id, 1)}>+1</button>
                        <button className="ghost small" onClick={() => restock(p.id, 10)}>+10</button>
                        <button className="ghost small" onClick={() => restock(p.id, -1)}>−1</button>
                      </>
                    )}
                  </td>
                  <td>
                    <button className="ghost small" onClick={() => edit(p)}>Ubah</button>
                    <button className="ghost small" onClick={() => setAddonFor(addonFor === p.id ? null : p.id)}>Add-on</button>
                  </td>
                </tr>
                {addonFor === p.id && (
                  <tr>
                    <td colSpan={5}>
                      {p.addons.map((a: any) => (
                        <div key={a.id} className="muted">
                          + {a.name} · {rupiah(a.price_idr)} · {a.available === null ? "tak terbatas" : `sisa ${a.available}`}
                        </div>
                      ))}
                      <div className="inline">
                        <input placeholder="Nama add-on" value={addon.name} onChange={(e) => setAddon({ ...addon, name: e.target.value })} />
                        <input placeholder="Harga" type="number" value={addon.price_idr} onChange={(e) => setAddon({ ...addon, price_idr: e.target.value })} />
                        <input placeholder="Stok (kosong = tak terbatas)" type="number" value={addon.stock_qty} onChange={(e) => setAddon({ ...addon, stock_qty: e.target.value })} />
                        <button onClick={() => saveAddon(p.id)} disabled={act.busy || !addon.name}>Simpan add-on</button>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title={form.id ? "Ubah produk" : "Produk baru"}>
        <label>Nama<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>Kategori<input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></label>
        <label>Harga (IDR)<input type="number" value={form.price_idr} onChange={(e) => setForm({ ...form, price_idr: e.target.value })} /></label>
        <label>Stok (kosong = tak terbatas)<input type="number" value={form.stock_qty} onChange={(e) => setForm({ ...form, stock_qty: e.target.value })} /></label>
        <label>Deskripsi<input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <div className="actions">
          <button disabled={act.busy || !form.name || !form.price_idr} onClick={save}>{form.id ? "Simpan" : "Tambah produk"}</button>
          {form.id && <button className="ghost" onClick={() => setForm({ name: "", category: "", price_idr: "", stock_qty: "", description: "" })}>Batal</button>}
        </div>
      </Card>
    </div>
  );
}

// ---------- Meja & booking ----------

export function Tables({ offset }: Props) {
  const [tables, setTables] = useState<any[]>([]);
  const [bookings, setBookings] = useState<any[]>([]);
  const [tForm, setTForm] = useState({ name: "", capacity: "" });
  const [bForm, setBForm] = useState({ table_id: "", customer_name: "", phone: "", starts_at: "", party_size: "2", deposit_idr: "" });
  const act = useAction();

  const load = useCallback(async () => {
    await act.run(async () => {
      setTables(await call("table_availability"));
      setBookings(await call("booking_list", { date: shopToday(offset) }));
    });
  }, [offset]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <Msg error={act.error} />
      <div className="split">
        <Card title="Meja">
          <table>
            <thead>
              <tr><th>Meja</th><th>Kapasitas</th><th>Status</th></tr>
            </thead>
            <tbody>
              {tables.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{t.capacity}</td>
                  <td>
                    <select
                      value={t.status}
                      onChange={async (e) => {
                        await act.run(async () => {
                          await call("table_set_status", { table_id: t.id, status: e.target.value });
                          await load();
                        });
                      }}
                    >
                      {Object.keys(STATUS_LABEL).filter((s) => ["available", "occupied", "reserved", "cleaning"].includes(s)).map((s) => (
                        <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>Meja baru</h4>
          <div className="inline">
            <input placeholder="Nama (mis. A1)" value={tForm.name} onChange={(e) => setTForm({ ...tForm, name: e.target.value })} />
            <input placeholder="Kapasitas" type="number" value={tForm.capacity} onChange={(e) => setTForm({ ...tForm, capacity: e.target.value })} />
            <button
              disabled={act.busy || !tForm.name || !tForm.capacity}
              onClick={async () => {
                await act.run(async () => {
                  await call("table_upsert", { name: tForm.name, capacity: Number(tForm.capacity) });
                  setTForm({ name: "", capacity: "" });
                  await load();
                });
              }}
            >
              Tambah
            </button>
          </div>
        </Card>

        <Card title={`Booking hari ini (${bookings.length})`}>
          <ul className="plain">
            {bookings.map((b) => (
              <li key={b.id}>
                {clock(b.starts_at, offset)} · {b.customer_name} ({b.party_size} org) · {b.phone} · <Badge text={STATUS_LABEL[b.status]} tone={b.status === "pending" ? "warn" : "ok"} />
                {b.deposit_idr > 0 && <span className="muted"> · DP {rupiah(b.deposit_idr)}</span>}
              </li>
            ))}
          </ul>
          <h4>Booking baru</h4>
          <div className="grid2">
            <label>Meja
              <select value={bForm.table_id} onChange={(e) => setBForm({ ...bForm, table_id: e.target.value })}>
                <option value="">Pilih</option>
                {tables.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.capacity})</option>)}
              </select>
            </label>
            <label>Jumlah orang<input type="number" value={bForm.party_size} onChange={(e) => setBForm({ ...bForm, party_size: e.target.value })} /></label>
            <label>Nama<input value={bForm.customer_name} onChange={(e) => setBForm({ ...bForm, customer_name: e.target.value })} /></label>
            <label>No. HP<input value={bForm.phone} onChange={(e) => setBForm({ ...bForm, phone: e.target.value })} /></label>
            <label>Waktu<input type="datetime-local" value={bForm.starts_at} onChange={(e) => setBForm({ ...bForm, starts_at: e.target.value })} /></label>
            <label>DP (IDR)<input type="number" value={bForm.deposit_idr} onChange={(e) => setBForm({ ...bForm, deposit_idr: e.target.value })} /></label>
          </div>
          <button
            disabled={act.busy || !bForm.table_id || !bForm.starts_at || !bForm.customer_name || !bForm.phone}
            onClick={async () => {
              await act.run(async () => {
                await call("booking_create", {
                  table_id: bForm.table_id,
                  customer_name: bForm.customer_name,
                  phone: bForm.phone,
                  starts_at: toIso(bForm.starts_at, offset),
                  party_size: Number(bForm.party_size),
                  deposit_idr: bForm.deposit_idr ? Number(bForm.deposit_idr) : undefined,
                });
                await load();
              });
            }}
          >
            Simpan booking
          </button>
        </Card>
      </div>
    </>
  );
}

// ---------- Pelanggan ----------

export function Customers() {
  const [rows, setRows] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [form, setForm] = useState({ name: "", phone: "", email: "", address: "" });
  const act = useAction();
  const load = useCallback(async () => {
    await act.run(async () => setRows(await call("customer_list", q ? { query: q } : {})));
  }, [q]);
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div className="split">
      <Card title="Pelanggan" actions={<input placeholder="Cari nama / HP" value={q} onChange={(e) => setQ(e.target.value)} />}>
        <Msg error={act.error} />
        <table>
          <thead><tr><th>Nama</th><th>HP</th><th>Pesanan</th><th>Total belanja</th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => setForm({ name: c.name, phone: c.phone, email: c.email, address: c.address })}>
                <td>{c.name}</td><td>{c.phone}</td><td>{c.order_count}</td><td>{rupiah(c.total_spent_idr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Simpan pelanggan">
        <label>Nama<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>No. HP<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
        <label>Email<input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
        <label>Alamat<input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></label>
        <button
          disabled={act.busy || !form.name || !form.phone}
          onClick={async () => {
            await act.run(async () => {
              await call("customer_upsert", { ...form, email: form.email || undefined, address: form.address || undefined });
              await load();
            });
          }}
        >
          Simpan
        </button>
      </Card>
    </div>
  );
}

// ---------- Promo ----------

export function Promotions({ offset }: Props) {
  const [rows, setRows] = useState<any[]>([]);
  const [form, setForm] = useState({ code: "", name: "", kind: "percent", value: "", min_subtotal_idr: "", ends_at: "" });
  const act = useAction();
  const load = useCallback(async () => {
    await act.run(async () => setRows(await call("promotion_list")));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="split">
      <Card title="Promo">
        <Msg error={act.error} />
        <table>
          <thead><tr><th>Nama</th><th>Kode</th><th>Diskon</th><th>Min. belanja</th><th>Dipakai</th><th>Aktif</th></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{p.code ?? <span className="muted">otomatis</span>}</td>
                <td>{p.kind === "percent" ? `${p.value}%` : rupiah(p.value)}</td>
                <td>{rupiah(p.min_subtotal_idr)}</td>
                <td>{p.used_count}{p.max_uses ? ` / ${p.max_uses}` : ""}</td>
                <td>
                  <button
                    className="ghost small"
                    onClick={async () => {
                      await act.run(async () => {
                        await call("promotion_upsert", { id: p.id, code: p.code, name: p.name, kind: p.kind, value: p.value, min_subtotal_idr: p.min_subtotal_idr, active: !p.active });
                        await load();
                      });
                    }}
                  >
                    {p.active ? "Nonaktifkan" : "Aktifkan"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Promo baru">
        <label>Nama<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>Kode (kosong = otomatis)<input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></label>
        <label>Jenis
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="percent">Persen (%)</option>
            <option value="fixed">Potongan tetap (IDR)</option>
          </select>
        </label>
        <label>Nilai<input type="number" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} /></label>
        <label>Min. belanja (IDR)<input type="number" value={form.min_subtotal_idr} onChange={(e) => setForm({ ...form, min_subtotal_idr: e.target.value })} /></label>
        <label>Berakhir<input type="datetime-local" value={form.ends_at} onChange={(e) => setForm({ ...form, ends_at: e.target.value })} /></label>
        <button
          disabled={act.busy || !form.name || !form.value}
          onClick={async () => {
            await act.run(async () => {
              await call("promotion_upsert", {
                code: form.code || null,
                name: form.name,
                kind: form.kind,
                value: Number(form.value),
                min_subtotal_idr: form.min_subtotal_idr ? Number(form.min_subtotal_idr) : 0,
                ends_at: form.ends_at ? toIso(form.ends_at, offset) : null,
              });
              setForm({ code: "", name: "", kind: "percent", value: "", min_subtotal_idr: "", ends_at: "" });
              await load();
            });
          }}
        >
          Simpan promo
        </button>
      </Card>
    </div>
  );
}

// ---------- Pengaturan ----------

const SETTINGS: { key: string; label: string; type?: string }[] = [
  { key: "shop_name", label: "Nama toko" },
  { key: "shop_address", label: "Alamat" },
  { key: "shop_hours", label: "Jam buka" },
  { key: "delivery_fee_idr", label: "Ongkir (IDR)", type: "number" },
  { key: "booking_deposit_idr", label: "DP booking (IDR)", type: "number" },
  { key: "utc_offset_hours", label: "Zona waktu (selisih UTC, jam)", type: "number" },
];

export function Settings() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const act = useAction();
  useEffect(() => {
    act.run(async () => setValues(await call("shop_info")));
  }, []);

  return (
    <Card title="Pengaturan toko">
      <Msg error={act.error} />
      {saved && <div className="msg ok">{saved}</div>}
      {SETTINGS.map((s) => (
        <label key={s.key}>
          {s.label}
          <input type={s.type ?? "text"} value={values[s.key] ?? ""} onChange={(e) => setValues({ ...values, [s.key]: e.target.value })} />
        </label>
      ))}
      <button
        disabled={act.busy}
        onClick={async () => {
          await act.run(async () => {
            for (const s of SETTINGS) {
              if (values[s.key] !== undefined && values[s.key] !== "") await call("setting_set", { key: s.key, value: values[s.key] });
            }
            setSaved("Tersimpan.");
          });
        }}
      >
        Simpan pengaturan
      </button>
    </Card>
  );
}
