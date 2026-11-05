import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../src/server.ts";
import { openDb, getSchemaVersion, migrate, SCHEMA_VERSION } from "../src/db.ts";
import { compareVersions, clearUpdateCache } from "../src/update.ts";
import { APP_VERSION } from "../src/version.ts";
import { rmSync } from "node:fs";

const ADMIN = "u".repeat(40);
const DB = `/tmp/fnb-update-${Date.now()}.db`;
let srv: ReturnType<typeof startServer>;
let base: string;
let stub: ReturnType<typeof Bun.serve>;
const clients: Client[] = [];

beforeAll(() => {
  clearUpdateCache();
  // Fake "latest release" feed.
  stub = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/newer") return Response.json({ version: "9.9.9", notes: "Versi baru.", url: "https://example.com/rilis" });
      if (url.pathname === "/same") return Response.json({ version: APP_VERSION });
      return new Response("nf", { status: 404 });
    },
  });
  srv = startServer({
    dbPath: DB,
    adminToken: ADMIN,
    port: 0,
    campaignTickMs: 3_600_000,
    updateCheckUrl: `http://127.0.0.1:${stub.port}/newer`,
  });
  base = `http://localhost:${srv.port}`;
});
afterAll(() => {
  for (const c of clients) c.close().catch(() => {});
  srv.stop(true);
  stub.stop(true);
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

describe("version compare", () => {
  it("orders dot-separated versions numerically", () => {
    expect(compareVersions("0.5.0", "0.4.0")).toBeGreaterThan(0);
    expect(compareVersions("0.4.0", "0.4.0")).toBe(0);
    expect(compareVersions("0.4.10", "0.4.9")).toBeGreaterThan(0);
    expect(compareVersions("0.3.9", "0.4.0")).toBeLessThan(0);
    expect(compareVersions("v1.0.0", "0.9.9")).toBeGreaterThan(0);
  });
});

describe("GET /version", () => {
  it("reports app, schema, and setup state", async () => {
    const r = await fetch(`${base}/version`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.app).toBe("fnb-suite");
    expect(j.version).toBe(APP_VERSION);
    expect(j.schema_version).toBe(SCHEMA_VERSION);
    expect(j.db_schema_version).toBe(SCHEMA_VERSION);
    expect(j.needs_setup).toBe(true);
  });
});

describe("schema migrations", () => {
  it("stamps fresh databases with the current version", () => {
    expect(getSchemaVersion(openDb(DB))).toBe(SCHEMA_VERSION);
  });

  it("upgrades legacy databases (user_version 0) without losing data", () => {
    const legacy = `${DB}-legacy`;
    const db = openDb(legacy);
    db.query("INSERT INTO products (id, name, price_idr) VALUES ('prd_x', 'Legacy', 1000)").run();
    db.exec("PRAGMA user_version = 0"); // simulate a DB from before versioning
    db.close();

    const db2 = openDb(legacy);
    try {
      expect(getSchemaVersion(db2)).toBe(SCHEMA_VERSION);
      const row = db2.query("SELECT name FROM products WHERE id = 'prd_x'").get() as any;
      expect(row?.name).toBe("Legacy");
    } finally {
      db2.close();
      for (const s of ["", "-wal", "-shm"]) rmSync(legacy + s, { force: true });
    }
  });

  it("migrate() reports the version jump", () => {
    const p = `${DB}-mig`;
    const db = openDb(p);
    db.exec("PRAGMA user_version = 0");
    expect(migrate(db)).toEqual({ from: 0, to: SCHEMA_VERSION });
    db.close();
    for (const s of ["", "-wal", "-shm"]) rmSync(p + s, { force: true });
  });
});

describe("update_status", () => {
  it("is visible to manager/owner and reports a newer release", async () => {
    const c = await connect(ADMIN);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain("update_status");
    const r = await call(c, "update_status");
    expect(r.isError).toBe(false);
    expect(r.data.configured).toBe(true);
    expect(r.data.current).toBe(APP_VERSION);
    expect(r.data.latest).toBe("9.9.9");
    expect(r.data.update_available).toBe(true);
    expect(r.data.notes).toBe("Versi baru.");
  });

  it("is hidden from public and cashier roles", async () => {
    const pub = await connect();
    expect((await pub.listTools()).tools.map((t) => t.name)).not.toContain("update_status");

    // owner -> add a cashier -> cashier must not see the tool
    const owner = await connect(ADMIN);
    const setup = await call(owner, "setup_create_owner", {
      business: "Update Shop",
      name: "Owner",
      email: "owner@upd.test",
      password: "owner-pass-1",
    });
    expect(setup.isError).toBe(false);
    await call(owner, "team_member_add", {
      email: "kasir@upd.test",
      name: "Kasir",
      password: "kasir-pass-1",
      role: "cashier",
    });
    const anon = await connect();
    const login = await call(anon, "auth_login", { email: "kasir@upd.test", password: "kasir-pass-1" });
    const cashier = await connect(login.data.token);
    expect((await cashier.listTools()).tools.map((t) => t.name)).not.toContain("update_status");
  });

  it("reports no update when running the latest", async () => {
    clearUpdateCache();
    const db2 = `${DB}-cfg`;
    const srv2 = startServer({
      dbPath: db2,
      adminToken: ADMIN,
      port: 0,
      campaignTickMs: 3_600_000,
      updateCheckUrl: `http://127.0.0.1:${stub.port}/same`,
    });
    try {
      const c = new Client({ name: "t", version: "0" });
      await c.connect(
        new StreamableHTTPClientTransport(new URL(`http://localhost:${srv2.port}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${ADMIN}` } },
        }),
      );
      clients.push(c);
      const r: any = await c.callTool({ name: "update_status", arguments: {} });
      const data = JSON.parse(r.content[0].text);
      expect(data.update_available).toBe(false);
    } finally {
      srv2.stop(true);
      for (const s of ["", "-wal", "-shm"]) rmSync(db2 + s, { force: true });
    }
  });

  it("reports unconfigured when no check URL is set", async () => {
    const db3 = `${DB}-nocfg`;
    const srv3 = startServer({ dbPath: db3, adminToken: ADMIN, port: 0, campaignTickMs: 3_600_000 });
    try {
      const c = new Client({ name: "t", version: "0" });
      await c.connect(
        new StreamableHTTPClientTransport(new URL(`http://localhost:${srv3.port}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${ADMIN}` } },
        }),
      );
      clients.push(c);
      const r: any = await c.callTool({ name: "update_status", arguments: {} });
      const data = JSON.parse(r.content[0].text);
      expect(data.configured).toBe(false);
      expect(data.update_available).toBe(false);
    } finally {
      srv3.stop(true);
      for (const s of ["", "-wal", "-shm"]) rmSync(db3 + s, { force: true });
    }
  });
});
