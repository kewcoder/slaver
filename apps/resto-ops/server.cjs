// Resto Ops server: kasir/booking via HitPay + state meja & booking + MCP connector.
// Dine-in ONLY (tanpa order online — melindungi tim dapur).
// Env: HITPAY_API_KEY (wajib utk bayar), HITPAY_BASE_URL (default sandbox),
//   PORT, APP_PASSWORD (wajib — kunci buka panel kasir), DATA_FILE (default ./data.json),
//   RESTO_NAME (nama rumah makan, default "Saung Rangon").
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const API_KEY = process.env.HITPAY_API_KEY || "";
const BASE = (process.env.HITPAY_BASE_URL || "https://api.sandbox.hit-pay.com").replace(/\/+$/, "");
const PORT = Number(process.env.PORT || 3000);
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const RESTO = process.env.RESTO_NAME || "Saung Rangon";

// ---- menu tetap (harga + kebutuhan stok) ----
const MENU = [
  { id: "N01", name: "Nasi Timbel Komplit", price: 32000, stock: "ayam" },
  { id: "N02", name: "Nasi Goreng Spesial", price: 28000, stock: "beras" },
  { id: "M03", name: "Mie Goreng Jawa", price: 25000, stock: "mie" },
  { id: "A04", name: "Ayam Bakar Kampung", price: 24000, stock: "ayam" },
  { id: "K05", name: "Karedok + Kerupuk", price: 18000, stock: "lalapan" },
  { id: "S06", name: "Sayur Asem", price: 15000, stock: "lalapan" },
  { id: "E07", name: "Es Teh Manis", price: 6000, stock: "teh" },
  { id: "J08", name: "Es Jeruk", price: 8000, stock: "jeruk" },
];

// ---- 2 area makan (dine-in) ----
const AREAS = [
  { id: "dalam", name: "Dalam (indoor, AC)", tables: ["D1", "D2", "D3", "D4", "D5", "D6"] },
  { id: "saung", name: "Saung / Teras (outdoor)", tables: ["S1", "S2", "S3", "S4", "S5", "S6"] },
];
const ALL_TABLES = AREAS.flatMap((a) => a.tables.map((t) => ({ id: t, area: a.id, area_name: a.name })));
const tableArea = (id) => (ALL_TABLES.find((t) => t.id === id) || {}).area || "";
const tableAreaName = (id) => (ALL_TABLES.find((t) => t.id === id) || {}).area_name || "";

// ---- state (meja + booking) di file agar agen & kasir lihat data yang sama ----
function defaultState() {
  const tables = {};
  for (const t of ALL_TABLES) tables[t.id] = "free";
  return { tables, bookings: [], seq: 0 };
}
function load() {
  try {
    const s = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (s && s.tables && Array.isArray(s.bookings)) return s;
  } catch {}
  return defaultState();
}
function save(s) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify(s));
    fs.renameSync(DATA_FILE + ".tmp", DATA_FILE);
  } catch (e) {
    console.error("save failed:", e.message);
  }
}
let S = load();
const orders = new Map(); // reference -> { status, hitpay_id, amount, at }

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}
async function readJson(req) {
  let raw = "";
  for await (const c of req) raw += c;
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}
function needAppKey(req, res) {
  if (!APP_PASSWORD) return true;
  const a = req.headers.authorization || "";
  const m = a.match(/^Bearer\s+(.+)$/);
  if (m && m[1] === APP_PASSWORD) return true;
  send(res, 401, { error: "APP_PASSWORD salah / wajib diisi (header Authorization: Bearer ...)" });
  return false;
}

function hitpay(path, method, payload) {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : null;
    const u = new URL(BASE + path);
    const req = (u.protocol === "https:" ? require("https") : require("http")).request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: {
          "Content-Type": "application/json",
          "X-BUSINESS-API-KEY": API_KEY,
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
        },
      },
      (resp) => {
        let buf = "";
        resp.on("data", (c) => (buf += c));
        resp.on("end", () => {
          try {
            resolve({ status: resp.statusCode, data: JSON.parse(buf || "{}") });
          } catch (e) {
            reject(new Error("bad upstream json"));
          }
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------- MCP connector (standar Slaver: semua app wajib expose /mcp) ----------
const MCP_TOOLS = [
  { name: "tables_list", description: "Daftar meja per area + status (free/busy/booked). Dine-in only.", inputSchema: { type: "object", properties: {} } },
  { name: "menu_list", description: "Daftar menu + harga.", inputSchema: { type: "object", properties: {} } },
  { name: "booking_list", description: "Daftar booking (terbaru dulu). Argumen opsional date YYYY-MM-DD.", inputSchema: { type: "object", properties: { date: { type: "string" } } } },
  { name: "table_book", description: "Booking meja untuk tamu (tanpa antre saat datang). Pilih area bila tamu minta; kosongkan agar sistem pilihkan meja kosong. DP Rp 50.000 via HitPay bila tersedia.", inputSchema: { type: "object", required: ["name", "date", "time"], properties: { name: { type: "string" }, phone: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, time: { type: "string", description: "HH:MM" }, party: { type: "integer" }, area: { type: "string", description: "dalam | saung | (kosong = otomatis)" }, table: { type: "string", description: "ID meja spesifik, opsional" } } } },
  { name: "table_release", description: "Bebaskan meja (tamu pulang / booking selesai).", inputSchema: { type: "object", required: ["table"], properties: { table: { type: "string" } } } },
];
function pickFreeTable(area) {
  const cands = ALL_TABLES.filter((t) => (!area || t.area === area) && S.tables[t.id] === "free");
  // Utamakan area yang diminta, lalu area mana pun yang kosong.
  const pool = cands.length ? cands : ALL_TABLES.filter((t) => S.tables[t.id] === "free");
  return pool.length ? pool[0].id : "";
}
function mcpCall(name, args) {
  args = args || {};
  if (name === "tables_list") {
    return {
      restaurant: RESTO,
      areas: AREAS.map((a) => ({
        id: a.id,
        name: a.name,
        tables: a.tables.map((t) => ({ id: t, status: S.tables[t.id] || "free" })),
        free: a.tables.filter((t) => (S.tables[t.id] || "free") === "free").length,
      })),
    };
  }
  if (name === "menu_list") return { restaurant: RESTO, menu: MENU };
  if (name === "booking_list") {
    let list = S.bookings.slice().reverse();
    if (args.date) list = list.filter((b) => b.date === args.date);
    return { bookings: list.slice(0, 50) };
  }
  if (name === "table_book") {
    const nm = String(args.name || "").trim();
    const date = String(args.date || "").trim();
    const time = String(args.time || "").trim();
    if (!nm || !date || !time) throw new Error("name, date (YYYY-MM-DD), dan time (HH:MM) wajib diisi.");
    let table = String(args.table || "").trim().toUpperCase();
    if (table && !(S.tables[table] === "free")) throw new Error("Meja " + table + " sedang tidak kosong (" + (S.tables[table] || "?") + ").");
    if (!table) {
      const area = String(args.area || "").trim().toLowerCase();
      if (area && area !== "dalam" && area !== "saung") throw new Error("area harus 'dalam' atau 'saung'.");
      table = pickFreeTable(area);
      if (!table) throw new Error("Penuh: tidak ada meja kosong. Tawarkan jam lain.");
    }
    S.seq += 1;
    const b = {
      id: "B" + Date.now().toString(36).toUpperCase(),
      name: nm, phone: String(args.phone || ""), date, time,
      party: Number(args.party) || 0, table, area: tableArea(table),
      dp: 50000, status: "DP pending", ref: "booking-" + Date.now(), at: new Date().toISOString(),
    };
    S.bookings.push(b);
    S.tables[table] = "booked";
    save(S);
    return { booked: true, booking: b, note: "Sampaikan ke tamu: datang langsung ke meja " + table + " (" + tableAreaName(table) + ") — tanpa antre. DP Rp 50.000 via link kasir." };
  }
  if (name === "table_release") {
    const table = String(args.table || "").trim().toUpperCase();
    if (!S.tables.hasOwnProperty(table)) throw new Error("Meja tidak dikenal: " + table);
    S.tables[table] = "free";
    save(S);
    return { released: true, table };
  }
  throw new Error("tool tidak dikenal: " + name + " (tersedia: " + MCP_TOOLS.map((t) => t.name).join(", ") + ")");
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.end(), void 0;

  try {
    // ---- Login dengan Slaver (opsional; lihat OAUTH.md) ----
    if (req.method === "GET" && u.pathname === "/api/oauth/config") {
      const cid = process.env.OAUTH_CLIENT_ID || "";
      if (!cid) return send(res, 200, { enabled: false });
      return send(res, 200, { enabled: true, client_id: cid, slaver_url: (process.env.SLAVER_URL || "https://www.slaver.app").replace(/\/+$/, "") });
    }
    if (req.method === "POST" && u.pathname === "/api/oauth/exchange") {
      const cid = process.env.OAUTH_CLIENT_ID || "";
      const sec = process.env.OAUTH_CLIENT_SECRET || "";
      if (!cid || !sec) return send(res, 400, { error: "Login Slaver belum dikonfigurasi (lihat OAUTH.md)" });
      const p = await readJson(req);
      if (!p.code) return send(res, 400, { error: "code wajib" });
      const base = (process.env.SLAVER_URL || "https://www.slaver.app").replace(/\/+$/, "");
      const tok = await new Promise((resolve, reject) => {
        const body = new URLSearchParams({ grant_type: "authorization_code", code: String(p.code), redirect_uri: String(p.redirect_uri || "") }).toString();
        const uu = new URL(base + "/oauth/token");
        const rq = (uu.protocol === "https:" ? require("https") : require("http")).request(
          { hostname: uu.hostname, port: uu.port || (uu.protocol === "https:" ? 443 : 80), path: uu.pathname, method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body), Authorization: "Basic " + Buffer.from(cid + ":" + sec).toString("base64") } },
          (rp) => { let b = ""; rp.on("data", (c) => (b += c)); rp.on("end", () => { try { resolve({ status: rp.statusCode, data: JSON.parse(b || "{}") }); } catch (e) { reject(new Error("bad token json")); } }); }
        );
        rq.on("error", reject);
        rq.write(body);
        rq.end();
      });
      if (tok.status < 200 || tok.status >= 300 || !tok.data.access_token) {
        return send(res, 502, { error: "Gagal tukar code (" + tok.status + ")" });
      }
      const me = await new Promise((resolve, reject) => {
        const uu = new URL(base + "/oauth/userinfo");
        const rq = (uu.protocol === "https:" ? require("https") : require("http")).request(
          { hostname: uu.hostname, port: uu.port || (uu.protocol === "https:" ? 443 : 80), path: uu.pathname, method: "GET",
            headers: { Authorization: "Bearer " + tok.data.access_token } },
          (rp) => { let b = ""; rp.on("data", (c) => (b += c)); rp.on("end", () => { try { resolve({ status: rp.statusCode, data: JSON.parse(b || "{}") }); } catch (e) { reject(new Error("bad userinfo json")); } }); }
        );
        rq.on("error", reject);
        rq.end();
      });
      if (me.status < 200 || me.status >= 300) return send(res, 502, { error: "Gagal ambil profil (" + me.status + ")" });
      const uinfo = me.data.user || me.data;
      return send(res, 200, { ok: true, user: { name: uinfo.name || "", email: uinfo.email || "", team: uinfo.team_name || uinfo.team || "", role: uinfo.role || "" } });
    }
    // ---- MCP connector: tools/list + tools/call (JSON-RPC) ----
    if (u.pathname === "/mcp") {
      if (req.method !== "POST") return send(res, 405, { error: "POST only" });
      const p = await readJson(req);
      const id = p.id === undefined ? 1 : p.id;
      if (p.method !== "tools/call" && p.method !== "tools/list") {
        return send(res, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: "method harus tools/list atau tools/call" } });
      }
      if (p.method === "tools/list") {
        return send(res, 200, { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } });
      }
      const name = (p.params && p.params.name) || "";
      const args = (p.params && p.params.arguments) || {};
      try {
        const result = mcpCall(name, args);
        return send(res, 200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], data: result } });
      } catch (e) {
        return send(res, 200, { jsonrpc: "2.0", id, error: { code: -32602, message: String((e && e.message) || e) } });
      }
    }

    // ---- state meja & booking (dipakai UI kasir + agen) ----
    if (req.method === "GET" && u.pathname === "/api/state") {
      if (!needAppKey(req, res)) return;
      return send(res, 200, { restaurant: RESTO, areas: AREAS, tables: S.tables, bookings: S.bookings.slice().reverse().slice(0, 100), menu: MENU });
    }
    if (req.method === "POST" && u.pathname === "/api/table") {
      if (!needAppKey(req, res)) return;
      const p = await readJson(req);
      const t = String(p.table || "").toUpperCase();
      const st = String(p.status || "");
      if (!S.tables.hasOwnProperty(t) || !["free", "busy", "booked"].includes(st)) {
        return send(res, 400, { error: "table/status tidak valid" });
      }
      S.tables[t] = st;
      save(S);
      return send(res, 200, { ok: true, tables: S.tables });
    }
    if (req.method === "POST" && u.pathname === "/api/booking-note") {
      // Kasir menandai hasil pembayaran booking manual (tanpa webhook).
      if (!needAppKey(req, res)) return;
      const p = await readJson(req);
      const b = S.bookings.find((x) => x.ref === p.ref);
      if (!b) return send(res, 404, { error: "booking tidak ditemukan" });
      b.status = String(p.status || b.status).slice(0, 40);
      if (b.status === "DP lunas" || b.status === "Selesai") S.tables[b.table] = b.status === "Selesai" ? "free" : "booked";
      save(S);
      return send(res, 200, { ok: true, booking: b });
    }

    // ---- HitPay (kasir dine-in + DP booking) ----
    if (req.method === "POST" && u.pathname === "/api/pay") {
      if (!needAppKey(req, res)) return;
      const p = await readJson(req);
      if (!API_KEY) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: "HITPAY_API_KEY belum diisi di pay-server (lihat README)" }));
      }
      const amount = Number(p.amount);
      if (!amount || amount < 0.3) throw new Error("nominal tidak valid");
      const reference = p.reference || ("ref-" + Date.now());
      const r = await hitpay("/v1/payment-requests", "POST", {
        amount,
        currency: p.currency || "IDR",
        name: (p.name || "Customer").slice(0, 120),
        phone: p.phone || undefined,
        reference_number: reference,
        purpose: (p.purpose || "Resto payment").slice(0, 255),
        redirect_url: p.redirect_url || undefined,
      });
      if (r.status < 200 || r.status >= 300 || !r.data.url) {
        throw new Error("HitPay menolak request (" + r.status + ")");
      }
      orders.set(reference, { status: "pending", hitpay_id: r.data.id, amount, at: Date.now() });
      return send(res, 200, { checkout_url: r.data.url, reference, hitpay_id: r.data.id, status: "pending" });
    }
    if (req.method === "GET" && u.pathname === "/api/status") {
      const ref = u.searchParams.get("reference") || "";
      const o = orders.get(ref);
      if (!o) return send(res, 404, { error: "unknown reference" });
      try {
        const r = await hitpay("/v1/payment-requests/" + encodeURIComponent(o.hitpay_id || ref), "GET");
        const st = String(r.data.status || (r.data && r.data.data && r.data.data.status) || "").toLowerCase();
        if (["completed", "succeeded", "paid"].includes(st)) o.status = "paid";
        else if (["failed", "expired", "canceled", "cancelled"].includes(st)) o.status = st;
      } catch {}
      return send(res, 200, { status: o.status, reference: ref });
    }
    if (req.method === "POST" && u.pathname === "/api/hook") {
      let v = {};
      try { v = await readJson(req); } catch {}
      const rid = v.id || v.payment_request_id || (v.payment_request && v.payment_request.id) || v.reference_number || "";
      for (const [ref, o] of orders) {
        if (o.hitpay_id === rid || ref === v.reference_number) {
          try {
            const r = await hitpay("/v1/payment-requests/" + encodeURIComponent(o.hitpay_id || rid), "GET");
            const st = String(r.data.status || "").toLowerCase();
            if (["completed", "succeeded", "paid"].includes(st)) o.status = "paid";
          } catch {}
        }
      }
      return send(res, 200, { ok: true });
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  } catch (e) {
    send(res, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, () => console.log("resto-ops server on :" + PORT + " (MCP di /mcp)"));
