import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { startServer } from "../src/server.ts";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const TMP = `/tmp/fnb-routes-${Date.now()}`;
const DIST = `${TMP}/dist`;
const DB = `${TMP}/fnb.db`;
let app: ReturnType<typeof startServer>;
let store: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  mkdirSync(`${DIST}/assets`, { recursive: true });
  writeFileSync(`${DIST}/index.html`, "<html>admin-spa</html>");
  writeFileSync(`${DIST}/assets/app-abc.js`, "console.log(1)");
  store = Bun.serve({
    port: 0,
    fetch: (req) => new Response(`store:${new URL(req.url).pathname}:${req.method}`, { status: 201 }),
  });
  app = startServer({
    dbPath: DB,
    adminToken: "a".repeat(40),
    port: 0,
    adminDir: DIST,
    storeUrl: `http://127.0.0.1:${store.port}`,
  });
  base = `http://localhost:${app.port}`;
});
afterAll(() => {
  app.stop(true);
  store.stop(true);
  rmSync(TMP, { recursive: true, force: true });
});

describe("routing", () => {
  it("serves admin SPA entry and falls back for client routes", async () => {
    const r = await fetch(`${base}/admin/orders/123`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("admin-spa");
    expect((await fetch(`${base}/admin`)).status).toBe(200);
  });

  it("hashed assets are cached immutable; missing assets are 404", async () => {
    const ok = await fetch(`${base}/admin/assets/app-abc.js`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toContain("immutable");
    expect((await fetch(`${base}/admin/assets/missing.js`)).status).toBe(404);
  });

  it("blocks path traversal", async () => {
    const r = await fetch(`${base}/admin/%2e%2e/%2e%2e/etc/passwd`);
    expect(r.status).not.toBe(200);
    expect(await r.text()).not.toContain("root:");
  });

  it("proxies everything else to the store, preserving method and path", async () => {
    const r = await fetch(`${base}/menu/kopi?x=1`, { method: "POST", body: "a=1" });
    expect(r.status).toBe(201);
    expect(await r.text()).toBe("store:/menu/kopi:POST");
  });

  it("keeps /mcp and /healthz local", async () => {
    expect(await (await fetch(`${base}/healthz`)).text()).toBe("ok");
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("catalog_list");
  });
});
