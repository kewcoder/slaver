import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../src/server.ts";
import { openDb } from "../src/db.ts";
import * as acc from "../src/accounts.ts";
import * as d from "../src/domain.ts";
import { rmSync } from "node:fs";

const ADMIN = "m".repeat(40);
const DB = `/tmp/fnb-acc-${Date.now()}.db`;
const OWNER_PW = "owner-pass-1";
let srv: ReturnType<typeof startServer>;
let stub: ReturnType<typeof Bun.serve>;
let base: string;
let db: ReturnType<typeof openDb>;
const clients: Client[] = [];
let stubCalls: { kind: "text" | "vision"; body: any }[] = [];

// OpenAI-compatible stub. Text: ad copy. Vision: says "empty" for tables named A*, "occupied" otherwise.
beforeAll(async () => {
  stub = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/chat/completions") return new Response("nf", { status: 404 });
      const body: any = await req.json();
      const text = JSON.stringify(body.messages);
      if (text.includes("image_url")) {
        stubCalls.push({ kind: "vision", body });
        const user = body.messages.find((m: any) => m.role === "user").content[0].text as string;
        const results = [...user.matchAll(/table_id "([^"]+)" \(([^)]+)\)/g)].map((m) => ({
          table_id: m[1],
          state: m[2].startsWith("A") ? "empty" : "occupied",
        }));
        return Response.json({ choices: [{ message: { content: JSON.stringify({ results }) } }] });
      }
      stubCalls.push({ kind: "text", body });
      if (text.includes("FAILME")) return new Response("boom", { status: 500 });
      return Response.json({
        choices: [{ message: { content: JSON.stringify({ title: "Judul AI", body: "Isi iklan AI yang singkat.", cta: "Pesan" }) } }],
      });
    },
  });

  db = openDb(DB);
  acc.ensureTeam(db, "Sample Team");
  await acc.addMember(db, { email: "owner@sample.test", name: "Owner", password: OWNER_PW, role: "owner" });
  await acc.addMember(db, { email: "mgr@sample.test", name: "Manager", password: "manager-pass-1", role: "manager" });
  await acc.addMember(db, { email: "cash@sample.test", name: "Kasir", password: "cashier-pass-1", role: "cashier" });

  srv = startServer({
    dbPath: DB,
    adminToken: ADMIN,
    port: 0,
    campaignTickMs: 3_600_000,
    ai: { baseUrl: `http://127.0.0.1:${stub.port}/v1`, apiKey: "k", textModel: "t", visionModel: "v" },
  });
  base = `http://localhost:${srv.port}`;
});

afterAll(() => {
  for (const c of clients) c.close().catch(() => {});
  srv.stop(true);
  stub.stop(true);
  db.close();
  for (const s of ["", "-wal", "-shm"]) rmSync(DB + s, { force: true });
});

async function connect(token?: string) {
  const c = new Client({ name: "t", version: "0" });
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
async function toolNames(c: Client) {
  return (await c.listTools()).tools.map((t) => t.name);
}
async function login(email: string, password: string) {
  const c = await connect();
  const r = await call(c, "auth_login", { email, password });
  await c.close();
  return r;
}

describe("accounts and roles", () => {
  it("rejects wrong password and unknown email with the same message", async () => {
    const a = await login("owner@sample.test", "nope-nope-nope");
    const b = await login("nobody@sample.test", "nope-nope-nope");
    expect(a.isError).toBe(true);
    expect(b.isError).toBe(true);
    expect(a.data).toBe(b.data);
  });

  it("stores passwords hashed, never plain", () => {
    const row = db.query("SELECT password_hash FROM users WHERE email = 'owner@sample.test'").get() as any;
    expect(row.password_hash).not.toContain(OWNER_PW);
    expect(row.password_hash.startsWith("$argon2")).toBe(true);
  });

  it("owner login gives owner tools; cashier sees only cashier tools", async () => {
    const owner = (await login("owner@sample.test", OWNER_PW)).data;
    const oc = await connect(owner.token);
    const oNames = await toolNames(oc);
    expect(oNames).toContain("team_member_add");
    expect(oNames).toContain("product_upsert");

    const cashier = (await login("cash@sample.test", "cashier-pass-1")).data;
    const cc = await connect(cashier.token);
    const cNames = await toolNames(cc);
    expect(cNames).toContain("order_pay");
    expect(cNames).toContain("table_camera_check");
    expect(cNames).not.toContain("product_upsert");
    expect(cNames).not.toContain("sales_summary");
    expect(cNames).not.toContain("team_member_add");

    const me = await call(cc, "auth_me");
    expect(me.data.role).toBe("cashier");
    expect(me.data.user.email).toBe("cash@sample.test");
  });

  it("manager can manage catalog and ads but not team", async () => {
    const mgr = (await login("mgr@sample.test", "manager-pass-1")).data;
    const mc = await connect(mgr.token);
    const names = await toolNames(mc);
    expect(names).toContain("product_upsert");
    expect(names).toContain("ad_generate");
    expect(names).not.toContain("team_member_add");
  });

  it("an unknown or wrong token is public", async () => {
    const c = await connect("x".repeat(40));
    expect(await toolNames(c)).not.toContain("order_pay");
  });

  it("owner adds a cashier via MCP; logout ends the session; deactivate blocks login", async () => {
    const owner = (await login("owner@sample.test", OWNER_PW)).data;
    const oc = await connect(owner.token);
    const add = await call(oc, "team_member_add", { email: "kasir2@sample.test", name: "Kasir 2", password: "kasir2-pass", role: "cashier" });
    expect(add.isError).toBe(false);
    const dup = await call(oc, "team_member_add", { email: "KASIR2@sample.test", name: "x", password: "kasir2-pass", role: "cashier" });
    expect(dup.isError).toBe(true);

    const k2 = (await login("kasir2@sample.test", "kasir2-pass")).data;
    const k2c = await connect(k2.token);
    expect((await call(k2c, "auth_me")).isError).toBe(false);
    expect((await call(k2c, "auth_logout")).data.ok).toBe(true);
    const after = await connect(k2.token);
    expect(await toolNames(after)).not.toContain("order_pay");

    const members = await call(oc, "team_member_list");
    const id = members.data.find((m: any) => m.email === "kasir2@sample.test").id;
    await call(oc, "team_member_deactivate", { user_id: id });
    expect((await login("kasir2@sample.test", "kasir2-pass")).isError).toBe(true);
  });

  it("rejects a short password", async () => {
    const owner = (await login("owner@sample.test", OWNER_PW)).data;
    const oc = await connect(owner.token);
    const r = await call(oc, "team_member_add", { email: "short@sample.test", name: "S", password: "short", role: "cashier" });
    expect(r.isError).toBe(true);
  });
});

describe("ad campaigns", () => {
  let productId: string;
  beforeAll(() => {
    productId = d.upsertProduct(db, { name: "Ayam Krispi", category: "Makanan", price_idr: 35000, description: "Renyah" }).id;
  });

  it("creates an AI draft from a product when the provider answers", async () => {
    const mgr = (await login("mgr@sample.test", "manager-pass-1")).data;
    const mc = await connect(mgr.token);
    const t = await call(mc, "ad_generate", { product_id: productId });
    expect(t.isError).toBe(false);
    expect(t.data.generated_by).toBe("ai");
    expect(t.data.title).toBe("Judul AI");
    expect(t.data.status).toBe("draft");
  });

  it("falls back to template when AI fails, and says why", async () => {
    const mgr = (await login("mgr@sample.test", "manager-pass-1")).data;
    const mc = await connect(mgr.token);
    const pid = d.upsertProduct(db, { name: "FAILME Burger", price_idr: 20000 }).id;
    const r = await call(mc, "ad_generate", { product_id: pid });
    expect(r.data.generated_by).toBe("template");
    expect(r.data.fallback_reason).toContain("500");
    expect(r.data.body).toContain("FAILME Burger");
  });

  it("promo-based draft and validation of product/promo input", async () => {
    const mgr = (await login("mgr@sample.test", "manager-pass-1")).data;
    const mc = await connect(mgr.token);
    d.upsertPromotion(db, { code: "MERDEKA", name: "Merdeka Hemat", kind: "percent", value: 17 });
    const r = await call(mc, "ad_generate", { promo_code: "merdeka" });
    expect(r.isError).toBe(false);
    expect(r.data.promo_code).toBe("MERDEKA");
    expect((await call(mc, "ad_generate", {})).isError).toBe(true);
    expect((await call(mc, "ad_generate", { product_id: "nope" })).isError).toBe(true);
  });

  it("schedule validates range; past start goes live; past end becomes ended; live banner visible on store", async () => {
    const mgr = (await login("mgr@sample.test", "manager-pass-1")).data;
    const mc = await connect(mgr.token);
    const draft = (await call(mc, "ad_generate", { product_id: productId })).data;

    const bad = await call(mc, "ad_schedule", { id: draft.id, starts_at: "2030-01-02T10:00:00Z", ends_at: "2030-01-01T10:00:00Z" });
    expect(bad.isError).toBe(true);

    const past = new Date(Date.now() - 3600_000).toISOString();
    const ahead = new Date(Date.now() + 86400_000).toISOString();
    const s = await call(mc, "ad_schedule", { id: draft.id, starts_at: past, ends_at: ahead });
    expect(s.data.status).toBe("scheduled");

    const pub = await connect();
    const banners = await call(pub, "ad_banners");
    expect(banners.data.map((b: any) => b.id)).toContain(draft.id);
    const row = db.query("SELECT status FROM campaigns WHERE id = $id").get({ $id: draft.id }) as any;
    expect(row.status).toBe("live");

    const expired = (await call(mc, "ad_generate", { product_id: productId })).data;
    await call(mc, "ad_schedule", { id: expired.id, starts_at: new Date(Date.now() - 2 * 86400_000).toISOString(), ends_at: new Date(Date.now() - 86400_000).toISOString() });
    const banners2 = await call(pub, "ad_banners");
    expect(banners2.data.map((b: any) => b.id)).not.toContain(expired.id);
    expect((db.query("SELECT status FROM campaigns WHERE id = $id").get({ $id: expired.id }) as any).status).toBe("ended");
  });

  it("cannot edit text of a live campaign; draft edits validate length", async () => {
    const mgr = (await login("mgr@sample.test", "manager-pass-1")).data;
    const mc = await connect(mgr.token);
    const live = (await call(mc, "ad_list", { status: "live" })).data[0];
    expect((await call(mc, "ad_update", { id: live.id, title: "baru" })).isError).toBe(true);
    const draft = (await call(mc, "ad_generate", { product_id: productId })).data;
    expect((await call(mc, "ad_update", { id: draft.id, title: "Judul baru" })).data.title).toBe("Judul baru");
    expect((await call(mc, "ad_update", { id: draft.id, title: "x".repeat(81) })).isError).toBe(true);
  });
});

describe("AI camera", () => {
  const img = Buffer.from("fake-jpeg-bytes").toString("base64");
  let cashier: Client;

  beforeAll(async () => {
    cashier = await connect((await login("cash@sample.test", "cashier-pass-1")).data.token);
    d.upsertTable(db, { id: "tbl_A1", name: "A1", capacity: 4 });
    d.upsertTable(db, { id: "tbl_B1", name: "B1", capacity: 4 });
    d.setTableStatus(db, "tbl_A1", "occupied");
  });

  it("checks all tables, stores observations, and hints when status disagrees", async () => {
    stubCalls = [];
    const r = await call(cashier, "table_camera_check", { image: img });
    expect(r.isError).toBe(false);
    const a1 = r.data.find((x: any) => x.table_id === "tbl_A1");
    const b1 = r.data.find((x: any) => x.table_id === "tbl_B1");
    expect(a1.observed).toBe("empty");
    expect(a1.hint).toContain("Terlihat kosong");
    expect(b1.observed).toBe("occupied");
    expect(b1.hint).toBeNull();

    // Observation is advisory: table status unchanged.
    const row = db.query("SELECT status, observed_status FROM tables WHERE id = 'tbl_A1'").get() as any;
    expect(row.status).toBe("occupied");
    expect(row.observed_status).toBe("empty");

    // The image really went to the provider as a data URL.
    const sent = stubCalls.find((c) => c.kind === "vision")!.body;
    expect(JSON.stringify(sent)).toContain("data:image/jpeg;base64,");
  });

  it("limits to requested tables and rejects unknown ids", async () => {
    const r = await call(cashier, "table_camera_check", { image: img, table_ids: ["tbl_B1"] });
    expect(r.data.length).toBe(1);
    expect(r.data[0].table_id).toBe("tbl_B1");
    expect((await call(cashier, "table_camera_check", { image: img, table_ids: ["nope"] })).isError).toBe(true);
  });

  it("rejects oversized and non-base64 input", async () => {
    expect((await call(cashier, "table_camera_check", { image: "A".repeat(4_000_001) })).isError).toBe(true);
    expect((await call(cashier, "table_camera_check", { image: "not base64!!" })).isError).toBe(true);
  });

  it("reports clearly when AI is not configured", async () => {
    const noAi = startServer({ dbPath: DB, adminToken: ADMIN, port: 0, ai: null, campaignTickMs: 3_600_000 });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${noAi.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${ADMIN}` } } }));
    const r = await call(c, "table_camera_check", { image: img });
    expect(r.isError).toBe(true);
    expect(r.data).toContain("not configured");
    await c.close();
    noAi.stop(true);
  });

  it("cashier cannot read team or ad management tools, public cannot check camera", async () => {
    const pub = await connect();
    expect(await toolNames(pub)).not.toContain("table_camera_check");
    expect(await toolNames(cashier)).not.toContain("ad_generate");
  });
});
