import { describe, it, expect, beforeEach } from "bun:test";
import { openDb } from "../src/db.ts";
import * as d from "../src/domain.ts";
import type { Database } from "bun:sqlite";

let db: Database;
let kopi: string;
let shot: string;
let teh: string;
let table: string;

const stock = (id: string) =>
  (db.query("SELECT stock_qty AS s FROM products WHERE id = $id").get({ $id: id }) as any).s;

beforeEach(() => {
  db = openDb(":memory:");
  kopi = d.upsertProduct(db, { name: "Kopi Susu", category: "Coffee", price_idr: 25000, stock_qty: 5 }).id;
  teh = d.upsertProduct(db, { name: "Teh", category: "Tea", price_idr: 10000 }).id; // unlimited
  shot = d.upsertAddon(db, { product_id: kopi, name: "Extra shot", price_idr: 8000, stock_qty: 3 }).id;
  table = d.upsertTable(db, { name: "A1", capacity: 4 }).id;
});

describe("cart pricing", () => {
  it("computes subtotal from live prices including add-ons", () => {
    const cart = d.createCart(db).cart_id;
    const c = d.addToCart(db, { cart_id: cart, product_id: kopi, qty: 2, addon_id: shot });
    expect(c.subtotal_idr).toBe((25000 + 8000) * 2);
    expect(c.total_idr).toBe(66000);
  });

  it("applies a percent promo with a minimum subtotal", () => {
    d.upsertPromotion(db, { code: "hemat10", name: "Hemat 10%", kind: "percent", value: 10, min_subtotal_idr: 20000 });
    const cart = d.createCart(db).cart_id;
    d.addToCart(db, { cart_id: cart, product_id: kopi, qty: 1 });
    const c = d.applyPromo(db, cart, "HEMAT10");
    expect(c.discount_idr).toBe(2500);
    expect(c.total_idr).toBe(22500);
    expect(c.promo?.code).toBe("HEMAT10");
  });

  it("rejects promo below minimum subtotal with a reason", () => {
    d.upsertPromotion(db, { code: "BIG", name: "Big", kind: "fixed", value: 5000, min_subtotal_idr: 100000 });
    const cart = d.createCart(db).cart_id;
    d.addToCart(db, { cart_id: cart, product_id: teh, qty: 1 });
    expect(() => d.applyPromo(db, cart, "BIG")).toThrow("Minimum subtotal");
  });

  it("rejects expired promo and promo over usage limit", () => {
    d.upsertPromotion(db, { code: "OLD", name: "Old", kind: "fixed", value: 1000, ends_at: "2020-01-01T00:00:00Z" });
    d.upsertPromotion(db, { code: "ONCE", name: "Once", kind: "fixed", value: 1000, max_uses: 1 });
    const cart = d.createCart(db).cart_id;
    d.addToCart(db, { cart_id: cart, product_id: teh, qty: 1 });
    expect(() => d.applyPromo(db, cart, "OLD")).toThrow("expired");

    d.applyPromo(db, cart, "ONCE");
    d.placeOrder(db, { cart_id: cart, fulfillment: "pickup" });
    const cart2 = d.createCart(db).cart_id;
    d.addToCart(db, { cart_id: cart2, product_id: teh, qty: 1 });
    expect(() => d.applyPromo(db, cart2, "ONCE")).toThrow("usage limit");
  });

  it("rejects a percent value above 100", () => {
    expect(() => d.upsertPromotion(db, { name: "x", kind: "percent", value: 150 })).toThrow("1-100");
  });

  it("shows promo_error when promo became invalid, and checkout refuses", () => {
    d.upsertPromotion(db, { code: "MIN", name: "Min", kind: "fixed", value: 1000, min_subtotal_idr: 10000 });
    const cart = d.createCart(db).cart_id;
    d.addToCart(db, { cart_id: cart, product_id: teh, qty: 1 });
    expect(d.applyPromo(db, cart, "MIN").discount_idr).toBe(1000);
    // Admin raises the minimum after the code was applied.
    db.query("UPDATE promotions SET min_subtotal_idr = 50000 WHERE code = 'MIN'").run();
    const c = d.priceCart(db, cart);
    expect(c.discount_idr).toBe(0);
    expect(c.promo_error).toContain("Minimum subtotal");
    expect(() => d.placeOrder(db, { cart_id: cart, fulfillment: "pickup" })).toThrow("Promo cannot be applied");
  });
});

describe("checkout and stock", () => {
  it("decrements stock on checkout and restores it on cancel", () => {
    const cart = d.createCart(db).cart_id;
    d.addToCart(db, { cart_id: cart, product_id: kopi, qty: 2, addon_id: shot });
    const order = d.placeOrder(db, { cart_id: cart, fulfillment: "pickup" });
    expect(order.status).toBe("pending_payment");
    expect(stock(kopi)).toBe(3);
    const shotStock = (db.query("SELECT stock_qty AS s FROM addons WHERE id = $id").get({ $id: shot }) as any).s;
    expect(shotStock).toBe(1);
    expect(order.items.length).toBe(1);
    expect(order.items[0].unit_price_idr).toBe(25000);
    expect(order.items[0].addon_price_idr).toBe(8000);

    d.setOrderStatus(db, { order_id: order.id, status: "cancelled" });
    expect(stock(kopi)).toBe(5);
  });

  it("checkout checks real stock, not just the cart reservation", () => {
    const a = d.createCart(db).cart_id;
    const b = d.createCart(db).cart_id;
    d.addToCart(db, { cart_id: a, product_id: kopi, qty: 2 });
    d.addToCart(db, { cart_id: b, product_id: kopi, qty: 3 }); // 5 reserved, 5 in stock
    d.adjustStock(db, kopi, -2); // stock drops to 3 after both carts were filled
    const order = d.placeOrder(db, { cart_id: b, fulfillment: "pickup" }); // needs 3, has 3
    expect(order.total_idr).toBe(75000);
    expect(stock(kopi)).toBe(0);
    expect(() => d.placeOrder(db, { cart_id: a, fulfillment: "pickup" })).toThrow("Not enough stock");
  });

  it("failed checkout does not change stock or empty the cart", () => {
    const cart = d.createCart(db).cart_id;
    d.addToCart(db, { cart_id: cart, product_id: kopi, qty: 2 });
    expect(() => d.placeOrder(db, { cart_id: cart, fulfillment: "dine_in", table_id: "nope" })).toThrow("Table not found");
    expect(stock(kopi)).toBe(5);
    expect(d.priceCart(db, cart).items.length).toBe(1);
  });

  it("dine_in needs a table, delivery needs address, customer and fee from settings", () => {
    const cart = d.createCart(db).cart_id;
    d.addToCart(db, { cart_id: cart, product_id: teh, qty: 1 });
    expect(() => d.placeOrder(db, { cart_id: cart, fulfillment: "dine_in" })).toThrow("table_id");
    expect(() => d.placeOrder(db, { cart_id: cart, fulfillment: "delivery" })).toThrow("address");
    expect(() =>
      d.placeOrder(db, { cart_id: cart, fulfillment: "delivery", address: "Jl. Mawar 1" }),
    ).toThrow("customer details");

    d.setSetting(db, "delivery_fee_idr", "7000");
    const o = d.placeOrder(db, {
      cart_id: cart,
      fulfillment: "delivery",
      address: "Jl. Mawar 1",
      customer: { name: "Budi", phone: "0812-3456-789" },
    });
    expect(o.delivery_fee_idr).toBe(7000);
    expect(o.total_idr).toBe(17000);
    expect(o.customer_id).toBeTruthy();
  });
});

describe("payments and status", () => {
  function placed(qty = 1) {
    const cart = d.createCart(db).cart_id;
    d.addToCart(db, { cart_id: cart, product_id: kopi, qty });
    return d.placeOrder(db, { cart_id: cart, fulfillment: "pickup" });
  }

  it("cash payment computes change and rejects short cash", () => {
    const o = placed(1);
    expect(() => d.payOrder(db, { order_id: o.id, method: "cash", amount_received_idr: 20000 })).toThrow("less than total");
    const paid = d.payOrder(db, { order_id: o.id, method: "cash", amount_received_idr: 50000 });
    expect(paid.status).toBe("paid");
    expect(paid.change_idr).toBe(25000);
    expect(() => d.payOrder(db, { order_id: o.id, method: "qris" })).toThrow("already paid");
  });

  it("qris payment needs no change and updates customer totals", () => {
    const cart = d.createCart(db).cart_id;
    d.addToCart(db, { cart_id: cart, product_id: kopi, qty: 2 });
    const o = d.placeOrder(db, {
      cart_id: cart,
      fulfillment: "pickup",
      customer: { name: "Sari", phone: "+62 812 0000 111" },
    });
    const paid = d.payOrder(db, { order_id: o.id, method: "qris" });
    expect(paid.change_idr).toBe(0);
    const c = d.getCustomer(db, { phone: "628120000111" }) as any;
    expect(c.order_count).toBe(1);
    expect(c.total_spent_idr).toBe(50000);
  });

  it("enforces forward-only status transitions", () => {
    const o = placed(1);
    expect(() => d.setOrderStatus(db, { order_id: o.id, status: "preparing" })).toThrow("Cannot change");
    d.payOrder(db, { order_id: o.id, method: "card" });
    d.setOrderStatus(db, { order_id: o.id, status: "preparing" });
    d.setOrderStatus(db, { order_id: o.id, status: "ready" });
    expect(() => d.setOrderStatus(db, { order_id: o.id, status: "cancelled" })).not.toThrow();
  });

  it("completing a dine_in order sets the table to cleaning", () => {
    const cart = d.createCart(db).cart_id;
    d.addToCart(db, { cart_id: cart, product_id: teh, qty: 1 });
    const o = d.placeOrder(db, { cart_id: cart, fulfillment: "dine_in", table_id: table });
    d.payOrder(db, { order_id: o.id, method: "cash" });
    d.setOrderStatus(db, { order_id: o.id, status: "preparing" });
    d.setOrderStatus(db, { order_id: o.id, status: "ready" });
    d.setOrderStatus(db, { order_id: o.id, status: "completed" });
    const t = db.query("SELECT status FROM tables WHERE id = $id").get({ $id: table }) as any;
    expect(t.status).toBe("cleaning");
  });

  it("cancelling a paid order reverses customer totals", () => {
    const cart = d.createCart(db).cart_id;
    d.addToCart(db, { cart_id: cart, product_id: teh, qty: 1 });
    const o = d.placeOrder(db, { cart_id: cart, fulfillment: "pickup", customer: { name: "Rina", phone: "0811111111" } });
    d.payOrder(db, { order_id: o.id, method: "cash" });
    d.setOrderStatus(db, { order_id: o.id, status: "cancelled" });
    const c = d.getCustomer(db, { phone: "0811111111" }) as any;
    expect(c.order_count).toBe(0);
    expect(c.total_spent_idr).toBe(0);
  });

  it("completed orders cannot be cancelled", () => {
    const o = placed(1);
    d.payOrder(db, { order_id: o.id, method: "cash" });
    d.setOrderStatus(db, { order_id: o.id, status: "preparing" });
    d.setOrderStatus(db, { order_id: o.id, status: "ready" });
    d.setOrderStatus(db, { order_id: o.id, status: "completed" });
    expect(() => d.setOrderStatus(db, { order_id: o.id, status: "cancelled" })).toThrow("Cannot change");
  });
});

describe("customers, settings, reports", () => {
  it("upserts customer by normalized phone", () => {
    const a = d.upsertCustomer(db, { name: "Budi", phone: "0812 3456 789" }).id;
    const b = d.upsertCustomer(db, { name: "Budi S", phone: "0812-3456-789", address: "Jl. A" }).id;
    expect(a).toBe(b);
    const row = d.getCustomer(db, { id: a }) as any;
    expect(row.name).toBe("Budi S");
    expect(row.address).toBe("Jl. A");
  });

  it("rejects invalid phone numbers", () => {
    expect(() => d.upsertCustomer(db, { name: "x", phone: "abc" })).toThrow("Invalid phone");
  });

  it("public shop info exposes only whitelisted settings", () => {
    d.setSetting(db, "shop_name", "Kopi Senja");
    d.setSetting(db, "delivery_fee_idr", "5000");
    d.setSetting(db, "secret_key", "nope");
    const info = d.publicShopInfo(db);
    expect(info.shop_name).toBe("Kopi Senja");
    expect(info.secret_key).toBeUndefined();
  });

  it("daily sales summary counts paid, excludes cancelled", () => {
    const today = new Date().toISOString().slice(0, 10);
    const c1 = d.createCart(db).cart_id;
    d.addToCart(db, { cart_id: c1, product_id: kopi, qty: 1 });
    const o1 = d.placeOrder(db, { cart_id: c1, fulfillment: "pickup" });
    d.payOrder(db, { order_id: o1.id, method: "cash", amount_received_idr: 25000 });

    const c2 = d.createCart(db).cart_id;
    d.addToCart(db, { cart_id: c2, product_id: teh, qty: 2 });
    const o2 = d.placeOrder(db, { cart_id: c2, fulfillment: "pickup" });
    d.payOrder(db, { order_id: o2.id, method: "qris" });
    d.setOrderStatus(db, { order_id: o2.id, status: "cancelled" });

    const s = d.salesSummary(db, today);
    expect(s.orders).toBe(1);
    expect(s.revenue_idr).toBe(25000);
    expect(s.top_products[0].product_name).toBe("Kopi Susu");
  });
});

describe("business day in shop timezone", () => {
  it("groups a payment at 01:30 WIB under the WIB date, not the UTC date", () => {
    const cart = d.createCart(db).cart_id;
    d.addToCart(db, { cart_id: cart, product_id: teh, qty: 1 });
    const o = d.placeOrder(db, { cart_id: cart, fulfillment: "pickup" });
    d.payOrder(db, { order_id: o.id, method: "cash" });
    // 2026-11-04 18:30 UTC == 2026-11-05 01:30 WIB
    db.query("UPDATE payments SET paid_at = '2026-11-04 18:30:00' WHERE order_id = $o").run({ $o: o.id });
    expect(d.salesSummary(db, "2026-11-05").orders).toBe(1);
    expect(d.salesSummary(db, "2026-11-04").orders).toBe(0);
    d.setSetting(db, "utc_offset_hours", "0");
    expect(d.salesSummary(db, "2026-11-04").orders).toBe(1);
  });
});
