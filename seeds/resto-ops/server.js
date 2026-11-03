// Tiny companion server: keeps the restaurant's HITPAY_API_KEY secret and
// creates HitPay payment requests for the static POS frontend.
// Env: HITPAY_API_KEY (required), HITPAY_BASE_URL (default sandbox), PORT.
const http = require("http");
const { URL } = require("url");

const API_KEY = process.env.HITPAY_API_KEY || "";
const BASE = (process.env.HITPAY_BASE_URL || "https://api.sandbox.hit-pay.com").replace(/\/+$/, "");
const PORT = Number(process.env.PORT || 3000);
const orders = new Map(); // reference -> { status }

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(body);
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

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.end(), void 0;

  try {
    if (req.method === "POST" && u.pathname === "/api/pay") {
      let raw = "";
      for await (const c of req) raw += c;
      const p = JSON.parse(raw || "{}");
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
      // Re-check server-side so the UI never trusts the browser alone.
      try {
        const r = await hitpay("/v1/payment-requests/" + encodeURIComponent(o.hitpay_id || ref), "GET");
        const st = String(r.data.status || r.data?.data?.status || "").toLowerCase();
        if (["completed", "succeeded", "paid"].includes(st)) o.status = "paid";
        else if (["failed", "expired", "canceled", "cancelled"].includes(st)) o.status = st;
      } catch {}
      return send(res, 200, { status: o.status, reference: ref });
    }
    if (req.method === "POST" && u.pathname === "/api/hook") {
      // HitPay webhook -> mark paid only after server-side re-check.
      let raw = "";
      for await (const c of req) raw += c;
      let v = {};
      try { v = JSON.parse(raw); } catch {}
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

server.listen(PORT, () => console.log("resto-ops pay server on :" + PORT));
