import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../src/server.ts";
import { rmSync } from "node:fs";

const TOKEN = "t".repeat(40);
const DB = `/tmp/fnb-test-${Date.now()}.db`;
let srv: ReturnType<typeof startServer>;
let base: string;

async function connect(token?: string) {
  const client = new Client({ name: "test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  });
  await client.connect(transport);
  return client;
}

const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r: any = await c.callTool({ name, arguments: args });
  const text = r.content[0].text as string;
  return { isError: !!r.isError, data: r.isError ? text : JSON.parse(text) };
};

beforeAll(() => {
  srv = startServer({ dbPath: DB, adminToken: TOKEN, port: 0 });
  base = `http://localhost:${srv.port}`;
});
afterAll(() => {
  srv.stop(true);
  rmSync(DB, { force: true });
  rmSync(`${DB}-wal`, { force: true });
  rmSync(`${DB}-shm`, { force: true });
});

describe("public MCP tools", () => {
  it("hides admin tools without token", async () => {
    const c = await connect();
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain("catalog_list");
    expect(names).toContain("cart_add_item");
    expect(names).not.toContain("product_upsert");
    expect(names).not.toContain("stock_adjust");
    await c.close();
  });

  it("rejects a wrong token as public", async () => {
    const c = await connect("x".repeat(40));
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("product_upsert");
    await c.close();
  });
});

describe("admin + cart flow", () => {
  let admin: Client;
  let pub: Client;
  let productId: string;
  let addonId: string;
  let tableId: string;

  beforeAll(async () => {
    admin = await connect(TOKEN);
    pub = await connect();
  });
  afterAll(async () => {
    await admin.close();
    await pub.close();
  });

  it("creates product, add-on, table", async () => {
    const p = await call(admin, "product_upsert", {
      name: "Kopi Susu", category: "Coffee", price_idr: 25000, stock_qty: 3,
    });
    productId = p.data.id;
    const a = await call(admin, "addon_upsert", {
      product_id: productId, name: "Extra shot", price_idr: 8000, stock_qty: 2,
    });
    addonId = a.data.id;
    const t = await call(admin, "table_upsert", { name: "A1", capacity: 4 });
    tableId = t.data.id;
    expect(productId).toBeTruthy();
    expect(addonId).toBeTruthy();
    expect(tableId).toBeTruthy();
  });

  it("shows catalog with availability to public", async () => {
    const r = await call(pub, "catalog_list");
    const item = r.data.find((p: any) => p.id === productId);
    expect(item.available).toBe(3);
    expect(item.addons[0].available).toBe(2);
  });

  it("stock adjust blocks negative", async () => {
    const r = await call(admin, "stock_adjust", { product_id: productId, delta: -5 });
    expect(r.isError).toBe(true);
    expect(r.data).toContain("negative");
  });

  it("cart add reserves against stock, cart total is correct", async () => {
    const cart = (await call(pub, "cart_create")).data.cart_id;
    const add = await call(pub, "cart_add_item", {
      cart_id: cart, product_id: productId, qty: 2, addon_id: addonId,
    });
    expect(add.isError).toBe(false);
    expect(add.data.total_idr).toBe((25000 + 8000) * 2);

    // Only 1 left: adding 2 more must fail.
    const cart2 = (await call(pub, "cart_create")).data.cart_id;
    const over = await call(pub, "cart_add_item", { cart_id: cart2, product_id: productId, qty: 2 });
    expect(over.isError).toBe(true);
    expect(over.data).toContain("1 left");

    const cat = await call(pub, "catalog_list");
    expect(cat.data.find((p: any) => p.id === productId).available).toBe(1);
  });

  it("rejects add-on that belongs to another product", async () => {
    const cart = (await call(pub, "cart_create")).data.cart_id;
    const other = (await call(admin, "product_upsert", { name: "Teh", price_idr: 10000 })).data.id;
    const r = await call(pub, "cart_add_item", { cart_id: cart, product_id: other, qty: 1, addon_id: addonId });
    expect(r.isError).toBe(true);
  });

  it("restocks via admin tool", async () => {
    const r = await call(admin, "stock_adjust", { product_id: productId, delta: 10 });
    expect(r.data.stock_qty).toBe(13);
  });

  it("table filtered by party size and status update", async () => {
    const fits = await call(pub, "table_availability", { party_size: 4 });
    expect(fits.data.map((t: any) => t.id)).toContain(tableId);
    const tooBig = await call(pub, "table_availability", { party_size: 6 });
    expect(tooBig.data.map((t: any) => t.id)).not.toContain(tableId);
    const s = await call(admin, "table_set_status", { table_id: tableId, status: "occupied" });
    expect(s.data.status).toBe("occupied");
  });

  it("booking rules: capacity and double-booking", async () => {
    const when = "2026-11-05T19:00:00+07:00";
    const ok1 = await call(admin, "booking_create", {
      table_id: tableId, customer_name: "Budi", phone: "08123456789", starts_at: when, party_size: 2, deposit_idr: 50000,
    });
    expect(ok1.isError).toBe(false);
    const dup = await call(admin, "booking_create", {
      table_id: tableId, customer_name: "Sari", phone: "08129999999", starts_at: when, party_size: 2,
    });
    expect(dup.isError).toBe(true);
    const big = await call(admin, "booking_create", {
      table_id: tableId, customer_name: "Rina", phone: "08121111111", starts_at: "2026-11-06T19:00:00+07:00", party_size: 9,
    });
    expect(big.isError).toBe(true);
    const list = await call(admin, "booking_list", { date: "2026-11-05" });
    expect(list.data.length).toBe(1);
  });

  it("public cannot call admin tools", async () => {
    const r: any = await pub
      .callTool({ name: "stock_adjust", arguments: { product_id: productId, delta: 1 } })
      .catch((e) => ({ isError: true, err: String(e) }));
    expect(r.isError).toBe(true);
    const stock = await call(admin, "catalog_list");
    expect(stock.data.find((p: any) => p.id === productId).available).toBe(11); // 13 restocked minus 2 reserved in cart
  });
});
