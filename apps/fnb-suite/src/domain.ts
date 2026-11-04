import type { Database } from "bun:sqlite";

// Domain logic. Functions run over the SQLite handle; the MCP layer validates
// input and forwards here. Expected failures throw DomainError.
// Writes that touch several tables run inside db.transaction() so they are atomic.

export class DomainError extends Error {}

export const TABLE_STATUSES = ["available", "occupied", "reserved", "cleaning"] as const;
export type TableStatus = (typeof TABLE_STATUSES)[number];
export const FULFILLMENTS = ["dine_in", "pickup", "delivery"] as const;
export const PAYMENT_METHODS = ["cash", "qris", "transfer", "card"] as const;
export const ORDER_STATUSES = ["pending_payment", "paid", "preparing", "ready", "completed", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
const now = () => new Date();

type Row = Record<string, any>;
const one = (db: Database, sql: string, params: Row = {}): Row | null =>
  (db.query(sql).get(params) as Row | null) ?? null;
const all = (db: Database, sql: string, params: Row = {}): Row[] => db.query(sql).all(params) as Row[];

// ---------- Catalog ----------

export interface ProductInput {
  id?: string;
  name: string;
  description?: string;
  category?: string;
  price_idr: number;
  stock_qty?: number | null;
  active?: boolean;
}

export function upsertProduct(db: Database, input: ProductInput): { id: string } {
  const id = input.id ?? newId("prd");
  db.query(
    `INSERT INTO products (id, name, description, category, price_idr, stock_qty, active)
     VALUES ($id, $name, $description, $category, $price, $stock, $active)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, description = excluded.description, category = excluded.category,
       price_idr = excluded.price_idr, stock_qty = excluded.stock_qty, active = excluded.active`,
  ).run({
    $id: id,
    $name: input.name,
    $description: input.description ?? "",
    $category: input.category ?? "",
    $price: input.price_idr,
    $stock: input.stock_qty ?? null,
    $active: input.active === false ? 0 : 1,
  });
  return { id };
}

export interface AddonInput {
  id?: string;
  product_id: string;
  name: string;
  price_idr: number;
  stock_qty?: number | null;
}

export function upsertAddon(db: Database, input: AddonInput): { id: string } {
  requireProduct(db, input.product_id);
  const id = input.id ?? newId("add");
  db.query(
    `INSERT INTO addons (id, product_id, name, price_idr, stock_qty)
     VALUES ($id, $pid, $name, $price, $stock)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, price_idr = excluded.price_idr, stock_qty = excluded.stock_qty`,
  ).run({ $id: id, $pid: input.product_id, $name: input.name, $price: input.price_idr, $stock: input.stock_qty ?? null });
  return { id };
}

// Adjust stock by delta (positive = restock, negative = usage/waste).
export function adjustStock(db: Database, productId: string, delta: number) {
  const p = requireProduct(db, productId);
  if (p.stock_qty === null) throw new DomainError("Product has unlimited stock; set stock_qty first.");
  const next = p.stock_qty + delta;
  if (next < 0) throw new DomainError(`Stock would go negative (current ${p.stock_qty}).`);
  db.query("UPDATE products SET stock_qty = $s WHERE id = $id").run({ $s: next, $id: productId });
  return { product_id: productId, stock_qty: next };
}

function requireProduct(db: Database, id: string) {
  const p = one(db, "SELECT * FROM products WHERE id = $id", { $id: id });
  if (!p) throw new DomainError(`Product not found: ${id}`);
  return p as { id: string; name: string; stock_qty: number | null; price_idr: number; active: number };
}

function requireAddon(db: Database, id: string) {
  const a = one(db, "SELECT * FROM addons WHERE id = $id", { $id: id });
  if (!a) throw new DomainError(`Add-on not found: ${id}`);
  return a as { id: string; product_id: string; name: string; stock_qty: number | null; price_idr: number; active: number };
}

// Units still free after items already sitting in open carts (soft reservation).
function freeUnits(db: Database, column: "product_id" | "addon_id", id: string, stock: number | null): number | null {
  if (stock === null) return null;
  const r = one(db, `SELECT COALESCE(SUM(qty),0) AS n FROM cart_items WHERE ${column} = $id`, { $id: id });
  return stock - (r?.n ?? 0);
}

export function listCatalog(db: Database, category?: string) {
  const products = all(
    db,
    `SELECT * FROM products WHERE active = 1 AND ($cat IS NULL OR category = $cat) ORDER BY category, name`,
    { $cat: category ?? null },
  );
  return products.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    category: p.category,
    price_idr: p.price_idr,
    available: freeUnits(db, "product_id", p.id, p.stock_qty),
    addons: all(db, "SELECT * FROM addons WHERE product_id = $pid AND active = 1 ORDER BY name", { $pid: p.id }).map(
      (a) => ({
        id: a.id,
        name: a.name,
        price_idr: a.price_idr,
        available: freeUnits(db, "addon_id", a.id, a.stock_qty),
      }),
    ),
  }));
}

// ---------- Tables & bookings ----------

export function upsertTable(db: Database, input: { id?: string; name: string; capacity: number }) {
  const id = input.id ?? newId("tbl");
  db.query(
    `INSERT INTO tables (id, name, capacity) VALUES ($id, $name, $cap)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, capacity = excluded.capacity`,
  ).run({ $id: id, $name: input.name, $cap: input.capacity });
  return { id };
}

export function setTableStatus(db: Database, tableId: string, status: TableStatus) {
  const r = db.query("UPDATE tables SET status = $s WHERE id = $id").run({ $s: status, $id: tableId });
  if (r.changes === 0) throw new DomainError(`Table not found: ${tableId}`);
  return { table_id: tableId, status };
}

export function listTables(db: Database, partySize?: number) {
  return all(
    db,
    `SELECT id, name, capacity, status, observed_status, observed_at FROM tables WHERE ($ps IS NULL OR capacity >= $ps) ORDER BY capacity, name`,
    { $ps: partySize ?? null },
  );
}

export interface BookingInput {
  table_id: string;
  customer_name: string;
  phone: string;
  starts_at: string;
  party_size: number;
  deposit_idr?: number;
}

export function createBooking(db: Database, input: BookingInput) {
  const table = one(db, "SELECT * FROM tables WHERE id = $id", { $id: input.table_id });
  if (!table) throw new DomainError(`Table not found: ${input.table_id}`);
  if (input.party_size > table.capacity) {
    throw new DomainError(`Party of ${input.party_size} exceeds table capacity ${table.capacity}.`);
  }
  if (Number.isNaN(Date.parse(input.starts_at))) throw new DomainError("starts_at must be ISO 8601.");
  const clash = one(
    db,
    `SELECT id FROM bookings WHERE table_id = $t AND starts_at = $s AND status IN ('pending','confirmed')`,
    { $t: input.table_id, $s: input.starts_at },
  );
  if (clash) throw new DomainError("Table already booked for that time.");
  const id = newId("bk");
  db.query(
    `INSERT INTO bookings (id, table_id, customer_name, phone, starts_at, party_size, deposit_idr)
     VALUES ($id, $t, $n, $p, $s, $ps, $d)`,
  ).run({
    $id: id,
    $t: input.table_id,
    $n: input.customer_name,
    $p: input.phone,
    $s: input.starts_at,
    $ps: input.party_size,
    $d: input.deposit_idr ?? 0,
  });
  return { id, status: "pending" as const };
}

export function listBookings(db: Database, date?: string) {
  return all(
    db,
    `SELECT * FROM bookings WHERE ($d IS NULL OR substr(starts_at,1,10) = $d) ORDER BY starts_at`,
    { $d: date ?? null },
  );
}

// ---------- Customers ----------

// Canonical form: country code 62 with digits only (Indonesia-first).
// "0812-3456-789", "+62 812 3456 789" and "628123456789" all map to "628123456789".
export function normalizePhone(raw: string): string {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("0")) digits = "62" + digits.slice(1);
  if (!/^\d{8,15}$/.test(digits)) throw new DomainError("Invalid phone number.");
  return digits;
}

export interface CustomerInput {
  id?: string;
  name: string;
  phone: string;
  email?: string;
  address?: string;
}

// Upsert by phone (the natural key for a cafe/resto customer).
export function upsertCustomer(db: Database, input: CustomerInput) {
  const phone = normalizePhone(input.phone);
  const existing = one(db, "SELECT id FROM customers WHERE phone = $p", { $p: phone });
  if (existing) {
    db.query(
      `UPDATE customers SET name = $n, email = COALESCE(NULLIF($e,''), email), address = COALESCE(NULLIF($a,''), address)
       WHERE id = $id`,
    ).run({ $n: input.name, $e: input.email ?? "", $a: input.address ?? "", $id: existing.id });
    return { id: existing.id as string };
  }
  const id = input.id ?? newId("cus");
  db.query(
    `INSERT INTO customers (id, name, phone, email, address) VALUES ($id, $n, $p, $e, $a)`,
  ).run({ $id: id, $n: input.name, $p: phone, $e: input.email ?? "", $a: input.address ?? "" });
  return { id };
}

export function getCustomer(db: Database, ref: { id?: string; phone?: string }) {
  const row = ref.id
    ? one(db, "SELECT * FROM customers WHERE id = $v", { $v: ref.id })
    : ref.phone
      ? one(db, "SELECT * FROM customers WHERE phone = $v", { $v: normalizePhone(ref.phone) })
      : null;
  if (!row) throw new DomainError("Customer not found.");
  return row;
}

export function listCustomers(db: Database, query?: string) {
  const q = query ? `%${query}%` : null;
  return all(
    db,
    `SELECT * FROM customers WHERE ($q IS NULL OR name LIKE $q OR phone LIKE $q) ORDER BY total_spent_idr DESC, name LIMIT 200`,
    { $q: q },
  );
}

// ---------- Promotions ----------

export interface PromotionInput {
  id?: string;
  code?: string | null;
  name: string;
  kind: "percent" | "fixed";
  value: number;
  min_subtotal_idr?: number;
  starts_at?: string | null;
  ends_at?: string | null;
  max_uses?: number | null;
  active?: boolean;
}

export function upsertPromotion(db: Database, input: PromotionInput) {
  if (input.kind === "percent" && (input.value < 1 || input.value > 100)) {
    throw new DomainError("Percent promotion value must be 1-100.");
  }
  const code = input.code ? input.code.trim().toUpperCase() : null;
  const id = input.id ?? newId("promo");
  try {
    db.query(
      `INSERT INTO promotions (id, code, name, kind, value, min_subtotal_idr, starts_at, ends_at, max_uses, active)
       VALUES ($id, $code, $name, $kind, $value, $min, $s, $e, $max, $active)
       ON CONFLICT(id) DO UPDATE SET
         code = excluded.code, name = excluded.name, kind = excluded.kind, value = excluded.value,
         min_subtotal_idr = excluded.min_subtotal_idr, starts_at = excluded.starts_at,
         ends_at = excluded.ends_at, max_uses = excluded.max_uses, active = excluded.active`,
    ).run({
      $id: id,
      $code: code,
      $name: input.name,
      $kind: input.kind,
      $value: input.value,
      $min: input.min_subtotal_idr ?? 0,
      $s: input.starts_at ?? null,
      $e: input.ends_at ?? null,
      $max: input.max_uses ?? null,
      $active: input.active === false ? 0 : 1,
    });
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new DomainError(`Promo code already used: ${code}`);
    throw e;
  }
  return { id, code };
}

export function listPromotions(db: Database) {
  return all(db, "SELECT * FROM promotions ORDER BY name");
}

export function listActivePromotions(db: Database) {
  return listPromotions(db)
    .filter((p) => p.active && (!p.ends_at || Date.parse(p.ends_at) >= now().getTime()))
    .map((p) => ({ name: p.name, kind: p.kind, value: p.value, min_subtotal_idr: p.min_subtotal_idr }));
}

// Returns the discount (IDR) a promo gives on a subtotal, or throws why it is invalid.
export function checkPromo(db: Database, code: string, subtotal: number) {
  const p = one(db, "SELECT * FROM promotions WHERE code = $c", { $c: code.trim().toUpperCase() });
  if (!p) throw new DomainError(`Promo code not found: ${code}`);
  if (!p.active) throw new DomainError("Promo is not active.");
  const t = now().getTime();
  if (p.starts_at && Date.parse(p.starts_at) > t) throw new DomainError("Promo has not started yet.");
  if (p.ends_at && Date.parse(p.ends_at) < t) throw new DomainError("Promo has expired.");
  if (p.max_uses !== null && p.used_count >= p.max_uses) throw new DomainError("Promo usage limit reached.");
  if (subtotal < p.min_subtotal_idr) {
    throw new DomainError(`Minimum subtotal for ${p.code} is Rp ${p.min_subtotal_idr}.`);
  }
  const discount = p.kind === "percent" ? Math.floor((subtotal * p.value) / 100) : Math.min(p.value, subtotal);
  return { promo: p, discount };
}

// ---------- Cart (public: AI agents, online store) ----------

export function createCart(db: Database, customerId?: string) {
  const id = newId("cart");
  db.query("INSERT INTO carts (id, customer_id) VALUES ($id, $c)").run({ $id: id, $c: customerId ?? null });
  return { cart_id: id };
}

export function addToCart(
  db: Database,
  input: { cart_id: string; product_id: string; qty: number; addon_id?: string },
) {
  assertCart(db, input.cart_id);
  const p = requireProduct(db, input.product_id);
  if (!p.active) throw new DomainError(`Product not available: ${p.name}`);
  const avail = freeUnits(db, "product_id", p.id, p.stock_qty);
  if (avail !== null && avail < input.qty) {
    throw new DomainError(`Not enough stock for ${p.name}: ${Math.max(avail, 0)} left.`);
  }
  if (input.addon_id) {
    const a = requireAddon(db, input.addon_id);
    if (a.product_id !== p.id || !a.active) throw new DomainError("Add-on does not belong to this product.");
    const aAvail = freeUnits(db, "addon_id", a.id, a.stock_qty);
    if (aAvail !== null && aAvail < input.qty) {
      throw new DomainError(`Not enough stock for add-on ${a.name}: ${Math.max(aAvail, 0)} left.`);
    }
  }
  db.query("INSERT INTO cart_items (cart_id, product_id, addon_id, qty) VALUES ($c, $p, $a, $q)").run({
    $c: input.cart_id,
    $p: input.product_id,
    $a: input.addon_id ?? null,
    $q: input.qty,
  });
  return priceCart(db, input.cart_id);
}

export function removeFromCart(db: Database, cartId: string, cartItemId: number) {
  assertCart(db, cartId);
  db.query("DELETE FROM cart_items WHERE id = $i AND cart_id = $c").run({ $i: cartItemId, $c: cartId });
  return priceCart(db, cartId);
}

export function applyPromo(db: Database, cartId: string, code: string | null) {
  const cart = priceCart(db, cartId);
  if (!code) {
    db.query("UPDATE carts SET promo_code = NULL WHERE id = $id").run({ $id: cartId });
    return priceCart(db, cartId);
  }
  checkPromo(db, code, cart.subtotal_idr); // throws with the reason
  db.query("UPDATE carts SET promo_code = $c WHERE id = $id").run({
    $c: code.trim().toUpperCase(),
    $id: cartId,
  });
  return priceCart(db, cartId);
}

// Priced view of a cart. Prices are read live from the catalog.
export function priceCart(db: Database, cartId: string) {
  const cart = assertCart(db, cartId);
  const rows = all(
    db,
    `SELECT ci.id, ci.qty, p.id AS product_id, p.name AS product_name, p.price_idr,
            a.id AS addon_id, a.name AS addon_name, a.price_idr AS addon_price_idr
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     LEFT JOIN addons a ON a.id = ci.addon_id
     WHERE ci.cart_id = $c ORDER BY ci.id`,
    { $c: cartId },
  );
  let subtotal = 0;
  const items = rows.map((r) => {
    const line = (r.price_idr + (r.addon_price_idr ?? 0)) * r.qty;
    subtotal += line;
    return {
      cart_item_id: r.id,
      product_id: r.product_id,
      product_name: r.product_name,
      addon_id: r.addon_id,
      addon_name: r.addon_name,
      unit_price_idr: r.price_idr,
      addon_price_idr: r.addon_price_idr ?? 0,
      qty: r.qty,
      line_total_idr: line,
    };
  });
  let discount = 0;
  let promo: { code: string; name: string } | null = null;
  let promo_error: string | null = null;
  if (cart.promo_code) {
    try {
      const c = checkPromo(db, cart.promo_code, subtotal);
      discount = c.discount;
      promo = { code: c.promo.code, name: c.promo.name };
    } catch (e) {
      promo_error = e instanceof Error ? e.message : String(e);
    }
  }
  return {
    cart_id: cartId,
    customer_id: cart.customer_id as string | null,
    items,
    subtotal_idr: subtotal,
    promo,
    promo_error,
    discount_idr: discount,
    total_idr: subtotal - discount,
  };
}

function assertCart(db: Database, id: string) {
  const c = one(db, "SELECT * FROM carts WHERE id = $id", { $id: id });
  if (!c) throw new DomainError(`Cart not found: ${id}`);
  return c;
}

// ---------- Settings (admin-only writes; store reads a subset) ----------

export const PUBLIC_SETTINGS = [
  "shop_name",
  "shop_address",
  "shop_hours",
  "delivery_fee_idr",
  "booking_deposit_idr",
  "utc_offset_hours",
] as const;

// Business-day boundary: timestamps are stored in UTC; reports group by the
// shop-local date using utc_offset_hours (default 7 = WIB).
function localDate(db: Database, col: string): string {
  const h = Math.trunc(getSettingNumber(db, "utc_offset_hours", 7));
  return `date(${col}, '${h >= 0 ? "+" : ""}${h} hours')`;
}

export function setSetting(db: Database, key: string, value: string) {
  if (!/^[a-z_]{2,40}$/.test(key)) throw new DomainError("Invalid setting key.");
  db.query("INSERT INTO settings (key, value) VALUES ($k, $v) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run({
    $k: key,
    $v: value,
  });
  return { key, value };
}

export function getSettingNumber(db: Database, key: string, fallback: number): number {
  const r = one(db, "SELECT value FROM settings WHERE key = $k", { $k: key });
  const n = r ? Number(r.value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function publicShopInfo(db: Database) {
  const out: Record<string, string> = {};
  for (const k of PUBLIC_SETTINGS) {
    const r = one(db, "SELECT value FROM settings WHERE key = $k", { $k: k });
    if (r) out[k] = r.value;
  }
  return out;
}

// ---------- Orders ----------

export interface PlaceOrderInput {
  cart_id: string;
  fulfillment: (typeof FULFILLMENTS)[number];
  table_id?: string;
  pickup_at?: string;
  address?: string;
  note?: string;
  customer?: { name: string; phone: string; email?: string; address?: string };
}

// Checkout: all-or-nothing. Stock is checked against real stock (not the soft
// cart reservation), decremented, and the cart is emptied in one transaction.
export function placeOrder(db: Database, input: PlaceOrderInput) {
  return db.transaction(() => {
    const cart = priceCart(db, input.cart_id);
    if (cart.items.length === 0) throw new DomainError("Cart is empty.");
    if (cart.promo_error) throw new DomainError(`Promo cannot be applied: ${cart.promo_error}`);

    // Customer: explicit details (upsert by phone) or the one already on the cart.
    let customerId: string | null = cart.customer_id;
    let deliveryAddress = input.address ?? "";
    if (input.customer) {
      customerId = upsertCustomer(db, input.customer).id;
      if (!deliveryAddress) deliveryAddress = input.customer.address ?? "";
    }

    if (input.fulfillment === "dine_in") {
      if (!input.table_id) throw new DomainError("dine_in needs table_id.");
      const t = one(db, "SELECT id FROM tables WHERE id = $id", { $id: input.table_id });
      if (!t) throw new DomainError(`Table not found: ${input.table_id}`);
    }
    if (input.fulfillment === "delivery") {
      if (!deliveryAddress) throw new DomainError("delivery needs an address.");
      if (!customerId) throw new DomainError("delivery needs customer details (name and phone).");
    }
    if (input.pickup_at && Number.isNaN(Date.parse(input.pickup_at))) {
      throw new DomainError("pickup_at must be ISO 8601.");
    }

    // Real stock check, aggregated per product and per add-on.
    const need = new Map<string, { kind: "product" | "addon"; name: string; qty: number; stock: number | null }>();
    for (const it of cart.items) {
      const pk = `p:${it.product_id}`;
      const pv = need.get(pk) ?? { kind: "product" as const, name: it.product_name, qty: 0, stock: null };
      pv.qty += it.qty;
      need.set(pk, pv);
      if (it.addon_id) {
        const ak = `a:${it.addon_id}`;
        const av = need.get(ak) ?? { kind: "addon" as const, name: it.addon_name ?? "", qty: 0, stock: null };
        av.qty += it.qty;
        need.set(ak, av);
      }
    }
    for (const [key, v] of need) {
      const id = key.slice(2);
      const stock =
        v.kind === "product"
          ? (one(db, "SELECT stock_qty AS s FROM products WHERE id = $id", { $id: id }) as any)?.s ?? null
          : (one(db, "SELECT stock_qty AS s FROM addons WHERE id = $id", { $id: id }) as any)?.s ?? null;
      if (stock !== null && stock < v.qty) {
        throw new DomainError(`Not enough stock for ${v.name}: ${Math.max(stock, 0)} left.`);
      }
      v.stock = stock;
    }

    const fee = input.fulfillment === "delivery" ? getSettingNumber(db, "delivery_fee_idr", 0) : 0;
    const total = cart.subtotal_idr - cart.discount_idr + fee;
    const orderId = newId("ord");

    db.query(
      `INSERT INTO orders (id, customer_id, fulfillment, table_id, pickup_at, address, note,
         subtotal_idr, discount_idr, delivery_fee_idr, total_idr, promo_code)
       VALUES ($id, $cust, $ful, $tbl, $pick, $addr, $note, $sub, $disc, $fee, $total, $promo)`,
    ).run({
      $id: orderId,
      $cust: customerId,
      $ful: input.fulfillment,
      $tbl: input.fulfillment === "dine_in" ? input.table_id! : null,
      $pick: input.pickup_at ?? null,
      $addr: deliveryAddress,
      $note: input.note ?? "",
      $sub: cart.subtotal_idr,
      $disc: cart.discount_idr,
      $fee: fee,
      $total: total,
      $promo: cart.promo?.code ?? null,
    });

    for (const it of cart.items) {
      db.query(
        `INSERT INTO order_items (order_id, product_id, addon_id, product_name, addon_name,
           unit_price_idr, addon_price_idr, qty, line_total_idr)
         VALUES ($o, $p, $a, $pn, $an, $up, $ap, $q, $lt)`,
      ).run({
        $o: orderId,
        $p: it.product_id,
        $a: it.addon_id,
        $pn: it.product_name,
        $an: it.addon_name,
        $up: it.unit_price_idr,
        $ap: it.addon_price_idr,
        $q: it.qty,
        $lt: it.line_total_idr,
      });
    }
    for (const [key, v] of need) {
      if (v.stock === null) continue;
      const id = key.slice(2);
      const table = v.kind === "product" ? "products" : "addons";
      db.query(`UPDATE ${table} SET stock_qty = stock_qty - $q WHERE id = $id`).run({ $q: v.qty, $id: id });
    }
    if (cart.promo?.code) {
      db.query("UPDATE promotions SET used_count = used_count + 1 WHERE code = $c").run({ $c: cart.promo.code });
    }
    db.query("DELETE FROM cart_items WHERE cart_id = $c").run({ $c: input.cart_id });
    db.query("UPDATE carts SET promo_code = NULL WHERE id = $c").run({ $c: input.cart_id });

    return getOrder(db, orderId);
  })();
}

export function getOrder(db: Database, orderId: string): Row {
  const o = one(db, "SELECT * FROM orders WHERE id = $id", { $id: orderId });
  if (!o) throw new DomainError(`Order not found: ${orderId}`);
  return {
    ...o,
    items: all(db, "SELECT * FROM order_items WHERE order_id = $id ORDER BY id", { $id: orderId }),
    payments: all(db, "SELECT * FROM payments WHERE order_id = $id ORDER BY id", { $id: orderId }),
  };
}

export function listOrders(db: Database, opts: { status?: OrderStatus; date?: string }) {
  return all(
    db,
    `SELECT id, seq, fulfillment, table_id, status, total_idr, created_at FROM orders
     WHERE ($s IS NULL OR status = $s) AND ($d IS NULL OR ${localDate(db, "created_at")} = $d)
     ORDER BY seq DESC LIMIT 200`,
    { $s: opts.status ?? null, $d: opts.date ?? null },
  );
}

export function payOrder(
  db: Database,
  input: { order_id: string; method: (typeof PAYMENT_METHODS)[number]; amount_received_idr?: number },
): Row {
  return db.transaction(() => {
    const o = one(db, "SELECT * FROM orders WHERE id = $id", { $id: input.order_id });
    if (!o) throw new DomainError(`Order not found: ${input.order_id}`);
    if (o.status !== "pending_payment") throw new DomainError(`Order is already ${o.status}.`);
    let change = 0;
    if (input.method === "cash") {
      const received = input.amount_received_idr ?? o.total_idr;
      if (received < o.total_idr) throw new DomainError(`Cash received is less than total ${o.total_idr}.`);
      change = received - o.total_idr;
    }
    db.query(
      "INSERT INTO payments (order_id, method, amount_idr, change_idr) VALUES ($o, $m, $a, $c)",
    ).run({ $o: o.id, $m: input.method, $a: o.total_idr, $c: change });
    db.query("UPDATE orders SET status = 'paid', updated_at = datetime('now') WHERE id = $id").run({ $id: o.id });
    if (o.customer_id) {
      db.query(
        "UPDATE customers SET order_count = order_count + 1, total_spent_idr = total_spent_idr + $t WHERE id = $c",
      ).run({ $t: o.total_idr, $c: o.customer_id });
    }
    return { ...getOrder(db, o.id), change_idr: change };
  })();
}

const NEXT: Partial<Record<OrderStatus, OrderStatus[]>> = {
  paid: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["completed", "cancelled"],
  pending_payment: ["cancelled"],
};

// Moves an order forward. Cancelling restores stock and promo usage, and
// reverses the customer totals if the order had been paid. Refund money is
// not handled here: record it outside the app.
export function setOrderStatus(db: Database, input: { order_id: string; status: OrderStatus }) {
  return db.transaction(() => {
    const o = one(db, "SELECT * FROM orders WHERE id = $id", { $id: input.order_id });
    if (!o) throw new DomainError(`Order not found: ${input.order_id}`);
    const allowed = NEXT[o.status as OrderStatus] ?? [];
    if (!allowed.includes(input.status)) {
      throw new DomainError(`Cannot change order from ${o.status} to ${input.status}.`);
    }
    if (input.status === "cancelled") {
      const items = all(db, "SELECT * FROM order_items WHERE order_id = $id", { $id: o.id });
      for (const it of items) {
        if (productHasStock(db, it.product_id)) {
          db.query("UPDATE products SET stock_qty = stock_qty + $q WHERE id = $id").run({ $q: it.qty, $id: it.product_id });
        }
        if (it.addon_id && addonHasStock(db, it.addon_id)) {
          db.query("UPDATE addons SET stock_qty = stock_qty + $q WHERE id = $id").run({ $q: it.qty, $id: it.addon_id });
        }
      }
      if (o.promo_code) {
        db.query("UPDATE promotions SET used_count = MAX(used_count - 1, 0) WHERE code = $c").run({ $c: o.promo_code });
      }
      if (o.status !== "pending_payment" && o.customer_id) {
        db.query(
          `UPDATE customers SET order_count = MAX(order_count - 1, 0),
             total_spent_idr = MAX(total_spent_idr - $t, 0) WHERE id = $c`,
        ).run({ $t: o.total_idr, $c: o.customer_id });
      }
    }
    if (input.status === "completed" && o.fulfillment === "dine_in" && o.table_id) {
      db.query("UPDATE tables SET status = 'cleaning' WHERE id = $id").run({ $id: o.table_id });
    }
    db.query("UPDATE orders SET status = $s, updated_at = datetime('now') WHERE id = $id").run({
      $s: input.status,
      $id: o.id,
    });
    return getOrder(db, o.id);
  })();
}

function productHasStock(db: Database, id: string) {
  return (one(db, "SELECT stock_qty AS s FROM products WHERE id = $id", { $id: id }) as any)?.s != null;
}
function addonHasStock(db: Database, id: string) {
  return (one(db, "SELECT stock_qty AS s FROM addons WHERE id = $id", { $id: id }) as any)?.s != null;
}

// ---------- Reports ----------

// Revenue is counted by payment time, excluding cancelled orders.
export function salesSummary(db: Database, date: string) {
  const totals = one(
    db,
    `SELECT COUNT(DISTINCT p.order_id) AS orders, COALESCE(SUM(p.amount_idr),0) AS revenue_idr
     FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE ${localDate(db, "p.paid_at")} = $d AND o.status <> 'cancelled'`,
    { $d: date },
  ) as any;
  const byMethod = all(
    db,
    `SELECT p.method, COUNT(*) AS payments, SUM(p.amount_idr) AS amount_idr
     FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE ${localDate(db, "p.paid_at")} = $d AND o.status <> 'cancelled' GROUP BY p.method`,
    { $d: date },
  );
  const topProducts = all(
    db,
    `SELECT oi.product_name, SUM(oi.qty) AS qty, SUM(oi.line_total_idr) AS revenue_idr
     FROM order_items oi JOIN payments p ON p.order_id = oi.order_id JOIN orders o ON o.id = oi.order_id
     WHERE ${localDate(db, "p.paid_at")} = $d AND o.status <> 'cancelled'
     GROUP BY oi.product_name ORDER BY qty DESC LIMIT 10`,
    { $d: date },
  );
  return { date, orders: totals.orders, revenue_idr: totals.revenue_idr, by_method: byMethod, top_products: topProducts };
}

export { newId };
