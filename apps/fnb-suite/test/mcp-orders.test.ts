import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../src/server.ts";
import { rmSync } from "node:fs";

const TOKEN = "k".repeat(40);
const DB = `/tmp/fnb-orders-${Date.now()}.db`;
let srv: ReturnType<typeof startServer>;
let base: string;
const clients: Client[] = [];

async function connect(token?: string) {
  const c = new Client({ name: "t", version: "0.0.0" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
    }),
  );
  clients.push(c);
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r: any = await c.callTool({ name, arguments: args });
  const text = r.content[0].text as string;
  return { isError: !!r.isError, data: r.isError ? text : JSON.parse(text) };
}

beforeAll(() => {
  srv = startServer({ dbPath: DB, adminToken: TOKEN, port: 0 });
  base = `http://localhost:${srv.port}`;
});
afterAll(() => {
  for (const c of clients) c.close().catch(() => {});
  srv.stop(true);
  for (const s of ["", "-wal", "-shm"]) rmSync(DB + s, { force: true });
});

describe("MCP order flow", () => {
  it("admin sets up menu, promo, delivery fee; public checks out; admin pays and fulfils", async () => {
    const admin = await connect(TOKEN);
    const pub = await connect();

    const p = await call(admin, "product_upsert", { name: "Nasi Goreng", category: "Main", price_idr: 30000, stock_qty: 2 });
    await call(admin, "setting_set", { key: "delivery_fee_idr", value: "5000" });
    await call(admin, "setting_set", { key: "shop_name", value: "Warung Uji" });
    await call(admin, "promotion_upsert", { code: "uji10", name: "Diskon 10", kind: "percent", value: 10 });

    // Public cannot see admin-only tools or private settings.
    const pubNames = (await pub.listTools()).tools.map((t) => t.name);
    expect(pubNames).toContain("order_place");
    expect(pubNames).not.toContain("order_pay");
    expect(pubNames).not.toContain("customer_list");
    const info = await call(pub, "shop_info");
    expect(info.data.shop_name).toBe("Warung Uji");

    // Public: cart with promo, delivery checkout.
    const cart = (await call(pub, "cart_create")).data.cart_id;
    await call(pub, "cart_add_item", { cart_id: cart, product_id: p.data.id, qty: 2 });
    const promo = await call(pub, "cart_apply_promo", { cart_id: cart, code: "UJI10" });
    expect(promo.data.discount_idr).toBe(6000);
    const order = await call(pub, "order_place", {
      cart_id: cart,
      fulfillment: "delivery",
      address: "Jl. Uji 1",
      customer: { name: "Andi", phone: "0813-1234-5678" },
    });
    expect(order.isError).toBe(false);
    expect(order.data.total_idr).toBe(60000 - 6000 + 5000);
    expect(order.data.status).toBe("pending_payment");

    // Stock exhausted by that order (2 units sold, 0 left).
    const cart2 = (await call(pub, "cart_create")).data.cart_id;
    const out = await call(pub, "cart_add_item", { cart_id: cart2, product_id: p.data.id, qty: 1 });
    expect(out.isError).toBe(true);

    // Public cannot pay; admin can.
    const denied: any = await pub
      .callTool({ name: "order_pay", arguments: { order_id: order.data.id, method: "qris" } })
      .catch(() => ({ isError: true }));
    expect(denied.isError).toBe(true);

    const paid = await call(admin, "order_pay", { order_id: order.data.id, method: "qris" });
    expect(paid.data.status).toBe("paid");
    await call(admin, "order_set_status", { order_id: order.data.id, status: "preparing" });
    await call(admin, "order_set_status", { order_id: order.data.id, status: "ready" });
    await call(admin, "order_set_status", { order_id: order.data.id, status: "completed" });

    const status = await call(pub, "order_status", { order_id: order.data.id });
    expect(status.data.status).toBe("completed");
    expect(status.data.items[0].name).toBe("Nasi Goreng");

    const cust = await call(admin, "customer_get", { phone: "081312345678" });
    expect(cust.data.order_count).toBe(1);
    const sales = await call(admin, "sales_summary", { date: new Date().toISOString().slice(0, 10) });
    expect(sales.data.revenue_idr).toBe(59000);
  });
});

describe("public booking request", () => {
  it("creates pending booking, rejects past times and over-capacity", async () => {
    const admin = await connect(TOKEN);
    const pub = await connect();
    const t = await call(admin, "table_upsert", { name: "Meja VIP", capacity: 2 });
    await call(admin, "setting_set", { key: "booking_deposit_idr", value: "50000" });
    const future = new Date(Date.now() + 86400000).toISOString();
    const ok = await call(pub, "booking_request", {
      table_id: t.data.id, customer_name: "Lia", phone: "0857000111", starts_at: future, party_size: 2,
    });
    expect(ok.isError).toBe(false);
    const list = await call(admin, "booking_list", { date: future.slice(0, 10) });
    expect(list.data[0].deposit_idr).toBe(50000);
    expect(list.data[0].status).toBe("pending");

    const past = await call(pub, "booking_request", {
      table_id: t.data.id, customer_name: "Lia", phone: "0857000111",
      starts_at: "2020-01-01T10:00:00+07:00", party_size: 2,
    });
    expect(past.isError).toBe(true);
    const big = await call(pub, "booking_request", {
      table_id: t.data.id, customer_name: "Lia", phone: "0857000111",
      starts_at: new Date(Date.now() + 2 * 86400000).toISOString(), party_size: 5,
    });
    expect(big.isError).toBe(true);
  });
});
