import { resolve, join, normalize, sep } from "node:path";
import { existsSync } from "node:fs";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { openDb } from "./db.ts";
import { createMcpServer } from "./mcp.ts";
import { resolveAuth } from "./accounts.ts";
import { hasOwner } from "./accounts.ts";
import { aiFromEnv, type AiConfig } from "./ai.ts";
import { getSchemaVersion, SCHEMA_VERSION } from "./db.ts";
import { APP_VERSION } from "./version.ts";
import { tickCampaigns } from "./ads.ts";

// One public port. Routes:
//   /mcp        MCP endpoint (the only API)
//   /healthz    liveness
//   /admin/*    static React admin SPA (adminDir)
//   everything  proxied to the Astro store process (storeUrl), if configured

export interface AppConfig {
  dbPath: string;
  adminToken: string;
  port: number;
  adminDir?: string;
  storeUrl?: string;
  ai?: AiConfig | null;
  campaignTickMs?: number;
  updateCheckUrl?: string;
  updateCheckTtlMs?: number;
}

export function startServer(cfg: AppConfig) {
  const db = openDb(cfg.dbPath);
  const ai = cfg.ai ?? null;
  // Publish scheduled ads and end expired ones.
  const timer = setInterval(() => tickCampaigns(db), cfg.campaignTickMs ?? 30_000);
  (timer as any).unref?.();
  const adminDir = cfg.adminDir ? resolve(cfg.adminDir) : null;

  return Bun.serve({
    port: cfg.port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/healthz") return new Response("ok");

      if (path === "/version") {
        return Response.json({
          app: "fnb-suite",
          version: APP_VERSION,
          schema_version: SCHEMA_VERSION,
          db_schema_version: getSchemaVersion(db),
          needs_setup: !hasOwner(db),
        });
      }

      if (path === "/mcp") {
        // Stateless server: no server-initiated SSE stream. Clients fall back to POST only.
        if (req.method === "GET" || req.method === "DELETE") {
          return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
        }
        const bearer = bearerOf(req);
        const auth = resolveAuth(db, bearer, cfg.adminToken);
        // Stateless: a fresh server + transport per request, no session state.
        const server = createMcpServer(db, {
          role: auth.role,
          userId: auth.userId,
          token: bearer,
          ai,
          update: { url: cfg.updateCheckUrl, ttlMs: cfg.updateCheckTtlMs },
        });
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        await server.connect(transport);
        return transport.handleRequest(req);
      }

      if (path === "/admin" || path.startsWith("/admin/")) {
        if (!adminDir) return new Response("Admin UI not built", { status: 404 });
        return serveStatic(adminDir, path.slice("/admin".length));
      }

      if (cfg.storeUrl) {
        const target = new URL(path + url.search, cfg.storeUrl);
        return fetch(target, {
          method: req.method,
          headers: req.headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
          redirect: "manual",
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
}

// Serves files under root. Missing asset files are 404; other unknown paths
// fall back to index.html so client-side routes work.
async function serveStatic(root: string, subpath: string): Promise<Response> {
  const rel = normalize(decodeURIComponent(subpath)).replace(/^[\\/]+/, "");
  const full = resolve(join(root, rel));
  if (full !== root && !full.startsWith(root + sep)) return new Response("Forbidden", { status: 403 });
  let file = Bun.file(full);
  let hashed = false;
  if (rel === "" || !(await file.exists()) || (await file.stat()).isDirectory()) {
    if (rel !== "" && /\.[a-z0-9]+$/i.test(rel)) return new Response("Not found", { status: 404 });
    file = Bun.file(join(root, "index.html"));
  } else {
    hashed = rel.startsWith("assets/");
  }
  if (!(await file.exists())) return new Response("Admin UI not built", { status: 404 });
  return new Response(file, {
    headers: { "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache" },
  });
}

function bearerOf(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

if (import.meta.main) {
  const adminToken = process.env.ADMIN_TOKEN ?? "";
  if (adminToken.length < 32) {
    console.error("ADMIN_TOKEN must be set and at least 32 characters.");
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 8080);
  const storePort = Number(process.env.STORE_PORT ?? 4321);
  // Use the built store if present; STORE_ENTRY overrides (set to "" to disable).
  const storeEntry = process.env.STORE_ENTRY ?? (existsSync("store/dist/server/entry.mjs") ? "store/dist/server/entry.mjs" : "");

  // Start the Astro SSR store as a child process when built. The child must
  // die with this process, otherwise it keeps the port and blocks the next start.
  let store: ReturnType<typeof Bun.spawn> | null = null;
  if (storeEntry) {
    store = Bun.spawn([process.execPath, storeEntry], {
      env: {
        ...process.env,
        PORT: String(storePort),
        HOST: "127.0.0.1",
        MCP_URL: `http://127.0.0.1:${port}/mcp`,
      },
      stdout: "inherit",
      stderr: "inherit",
    });
    store.exited.then((code) => console.error(`store process exited with code ${code}`));
    const stopStore = () => store?.kill();
    process.on("exit", stopStore);
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, () => {
        stopStore();
        process.exit(0);
      });
    }
  }

  const server = startServer({
    dbPath: process.env.DB_PATH ?? "./data/fnb.db",
    adminToken,
    port,
    adminDir: process.env.ADMIN_DIR ?? "./admin/dist",
    storeUrl: storeEntry ? `http://127.0.0.1:${storePort}` : undefined,
    ai: aiFromEnv(),
    updateCheckUrl: process.env.UPDATE_CHECK_URL ?? "",
  });
  console.log(`fnb-suite on http://localhost:${server.port} (mcp: /mcp, admin: /admin)`);
}
