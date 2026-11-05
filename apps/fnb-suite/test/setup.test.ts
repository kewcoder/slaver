import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../src/server.ts";
import { rmSync } from "node:fs";

const ADMIN = "s".repeat(40);
const DB = `/tmp/fnb-setup-${Date.now()}.db`;
let srv: ReturnType<typeof startServer>;
let base: string;
const clients: Client[] = [];

beforeAll(() => {
  srv = startServer({ dbPath: DB, adminToken: ADMIN, port: 0, campaignTickMs: 3_600_000 });
  base = `http://localhost:${srv.port}`;
});
afterAll(() => {
  for (const c of clients) c.close().catch(() => {});
  srv.stop(true);
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

describe("first-visit setup", () => {
  it("reports needs_setup on a fresh database", async () => {
    const c = await connect();
    const r = await call(c, "setup_status");
    expect(r.isError).toBe(false);
    expect(r.data.needs_setup).toBe(true);
    expect((await c.listTools()).tools.map((t) => t.name)).toContain("setup_create_owner");
  });

  it("creates the shop and owner, and returns a working owner session", async () => {
    const c = await connect();
    const r = await call(c, "setup_create_owner", {
      business: "Warung Uji",
      name: "Owner Uji",
      email: "owner@uji.test",
      password: "owner-pass-1",
    });
    expect(r.isError).toBe(false);
    expect(r.data.business).toBe("Warung Uji");
    expect(typeof r.data.token).toBe("string");

    // shop name was saved
    const shop = await call(c, "shop_info");
    expect(shop.data.shop_name).toBe("Warung Uji");

    // the returned token logs in as owner
    const oc = await connect(r.data.token);
    const me = await call(oc, "auth_me");
    expect(me.data.role).toBe("owner");

    // password login works too
    const lc = await connect();
    const login = await call(lc, "auth_login", { email: "owner@uji.test", password: "owner-pass-1" });
    expect(login.isError).toBe(false);
    expect(login.data.user.role).toBe("owner");

    // setup is now done
    expect((await call(c, "setup_status")).data.needs_setup).toBe(false);
  });

  it("refuses a second setup and validates input", async () => {
    const c = await connect();
    const twice = await call(c, "setup_create_owner", {
      business: "Lain",
      name: "Lain",
      email: "lain@uji.test",
      password: "lain-pass-1",
    });
    expect(twice.isError).toBe(true);
    expect(twice.data).toContain("already set up");
  });

  it("rejects weak input on a fresh database", async () => {
    // separate fresh server/db for validation checks
    const db2 = `${DB}-v2`;
    const srv2 = startServer({ dbPath: db2, adminToken: ADMIN, port: 0, campaignTickMs: 3_600_000 });
    try {
      const c = new Client({ name: "t", version: "0" });
      await c.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${srv2.port}/mcp`)));
      clients.push(c);
      const bad = await call(c, "setup_create_owner", {
        business: "Warung",
        name: "Owner",
        email: "owner@uji.test",
        password: "short",
      });
      expect(bad.isError).toBe(true);
    } finally {
      srv2.stop(true);
      for (const s of ["", "-wal", "-shm"]) rmSync(db2 + s, { force: true });
    }
  });
});
