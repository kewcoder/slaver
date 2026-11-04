import type { Database } from "bun:sqlite";
import { DomainError } from "./domain.ts";
import { chatJson, type AiConfig } from "./ai.ts";

// Ad campaigns: generate copy (AI or template), review as draft, schedule, and
// show live ones on the store. Publishing to social channels is manual: the copy
// is produced here, posted by a person.

export const CAMPAIGN_STATUSES = ["draft", "scheduled", "live", "ended"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

const newId = () => `cmp_${crypto.randomUUID().slice(0, 8)}`;
const one = (db: Database, sql: string, p: Record<string, unknown> = {}) => (db.query(sql).get(p as any) as any) ?? null;

interface Facts {
  product_id?: string;
  promo_code?: string;
  goal?: string;
  tone?: string;
}

interface Draft {
  title: string;
  body: string;
  cta: string;
}

function templateDraft(f: { name: string; price?: number; description?: string; promo?: { name: string; kind: string; value: number } }, goal?: string): Draft {
  if (f.promo) {
    const off = f.promo.kind === "percent" ? `diskon ${f.promo.value}%` : `potongan Rp ${f.promo.value.toLocaleString("id-ID")}`;
    return {
      title: `${f.promo.name}`,
      body: `${f.promo.name}: ${off}. ${goal ?? "Datang dan nikmati promonya sekarang."}`,
      cta: "Pesan sekarang",
    };
  }
  const price = f.price !== undefined ? ` mulai Rp ${f.price.toLocaleString("id-ID")}` : "";
  return {
    title: `Coba ${f.name}`,
    body: `${f.name}${price}. ${f.description ? f.description + ". " : ""}${goal ?? "Siap dinikmati hari ini."}`,
    cta: "Lihat menu",
  };
}

function validDraft(d: any): d is Draft {
  return (
    d &&
    typeof d.title === "string" && d.title.trim().length > 0 && d.title.length <= 80 &&
    typeof d.body === "string" && d.body.trim().length > 0 && d.body.length <= 400 &&
    typeof d.cta === "string" && d.cta.length <= 40
  );
}

export async function generateCampaign(db: Database, ai: AiConfig | null, facts: Facts) {
  let f: { name: string; price?: number; description?: string; promo?: { name: string; kind: string; value: number } };
  let promoLabel: string | null = null;
  if (facts.product_id) {
    const p = one(db, "SELECT id, name, price_idr, description FROM products WHERE id = $id", { $id: facts.product_id });
    if (!p) throw new DomainError("Product not found.");
    f = { name: p.name, price: p.price_idr, description: p.description };
  } else if (facts.promo_code) {
    const p = one(db, "SELECT * FROM promotions WHERE code = $c", { $c: facts.promo_code.trim().toUpperCase() });
    if (!p) throw new DomainError("Promo code not found.");
    promoLabel = p.code;
    f = { name: p.name, promo: { name: p.name, kind: p.kind, value: p.value } };
  } else {
    throw new DomainError("Pass product_id or promo_code.");
  }

  let draft: Draft = templateDraft(f, facts.goal);
  let generatedBy: "ai" | "template" = "template";
  let fallbackReason: string | null = null;

  if (ai) {
    try {
      const facts_ = JSON.stringify({ ...f, goal: facts.goal ?? null });
      const out: any = await chatJson(ai, ai.textModel, [
        {
          role: "system",
          content:
            "Kamu menulis iklan singkat untuk usaha F&B Indonesia. Jawab JSON {title, body, cta}. " +
            "Hanya gunakan fakta yang diberikan: jangan menambah harga, klaim kesehatan, atau janji yang tidak ada. " +
            "title maks 80 karakter, body maks 300 karakter, cta maks 30 karakter.",
        },
        {
          role: "user",
          content: `Fakta: ${facts_}\nNada: ${facts.tone ?? "ramah dan santai"}\nTujuan: ${facts.goal ?? "ajak pelanggan datang"}`,
        },
      ]);
      if (validDraft(out)) {
        draft = out;
        generatedBy = "ai";
      } else {
        fallbackReason = "AI output failed validation";
      }
    } catch (e) {
      fallbackReason = e instanceof Error ? e.message : String(e);
    }
  }

  const id = newId();
  db.query(
    `INSERT INTO campaigns (id, title, body, cta, product_id, promo_code, generated_by)
     VALUES ($id, $t, $b, $c, $p, $pc, $g)`,
  ).run({
    $id: id,
    $t: draft.title.trim(),
    $b: draft.body.trim(),
    $c: draft.cta.trim(),
    $p: facts.product_id ?? null,
    $pc: promoLabel,
    $g: generatedBy,
  });
  return { ...getCampaign(db, id), fallback_reason: fallbackReason };
}

export function getCampaign(db: Database, id: string) {
  const c = one(db, "SELECT * FROM campaigns WHERE id = $id", { $id: id });
  if (!c) throw new DomainError("Campaign not found.");
  return c;
}

export function updateCampaignText(db: Database, input: { id: string; title?: string; body?: string; cta?: string }) {
  const c = getCampaign(db, input.id);
  if (c.status === "live") throw new DomainError("Stop the campaign before editing its text.");
  const title = (input.title ?? c.title).trim();
  const body = (input.body ?? c.body).trim();
  const cta = (input.cta ?? c.cta).trim();
  if (!title || title.length > 80 || !body || body.length > 400 || cta.length > 40) {
    throw new DomainError("Text length out of range (title 80, body 400, cta 40).");
  }
  db.query("UPDATE campaigns SET title = $t, body = $b, cta = $c WHERE id = $id").run({ $t: title, $b: body, $c: cta, $id: input.id });
  return getCampaign(db, input.id);
}

export function scheduleCampaign(db: Database, input: { id: string; starts_at: string; ends_at?: string | null }) {
  const c = getCampaign(db, input.id);
  if (c.status === "live") throw new DomainError("Campaign is already live.");
  const s = Date.parse(input.starts_at);
  if (Number.isNaN(s)) throw new DomainError("starts_at must be ISO 8601.");
  let e: number | null = null;
  if (input.ends_at) {
    e = Date.parse(input.ends_at);
    if (Number.isNaN(e) || e <= s) throw new DomainError("ends_at must be after starts_at.");
  }
  db.query("UPDATE campaigns SET status = 'scheduled', starts_at = $s, ends_at = $e WHERE id = $id").run({
    $s: new Date(s).toISOString(),
    $e: e === null ? null : new Date(e).toISOString(),
    $id: input.id,
  });
  return getCampaign(db, input.id);
}

// Manual status control: back to draft (unschedule) or end now.
export function setCampaignStatus(db: Database, input: { id: string; status: "draft" | "ended" }) {
  getCampaign(db, input.id);
  db.query("UPDATE campaigns SET status = $s WHERE id = $id").run({ $s: input.status, $id: input.id });
  return getCampaign(db, input.id);
}

// Moves campaigns between states based on time. Called by the server on a timer.
export function tickCampaigns(db: Database, now = new Date()): { started: number; ended: number } {
  const iso = now.toISOString();
  const started = db
    .query(
      `UPDATE campaigns SET status = 'live' WHERE status = 'scheduled' AND starts_at <= $now
         AND (ends_at IS NULL OR ends_at > $now)`,
    )
    .run({ $now: iso }).changes;
  const ended = db
    .query(`UPDATE campaigns SET status = 'ended' WHERE status IN ('scheduled','live') AND ends_at IS NOT NULL AND ends_at <= $now`)
    .run({ $now: iso }).changes;
  return { started, ended };
}

export function listCampaigns(db: Database, status?: CampaignStatus) {
  return db
    .query(`SELECT * FROM campaigns WHERE ($s IS NULL OR status = $s) ORDER BY created_at DESC LIMIT 200`)
    .all({ $s: status ?? null });
}

// Public: what the store shows right now.
export function liveBanners(db: Database) {
  tickCampaigns(db);
  return db
    .query(`SELECT id, title, body, cta FROM campaigns WHERE status = 'live' ORDER BY starts_at DESC LIMIT 5`)
    .all();
}

