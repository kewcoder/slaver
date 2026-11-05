import type { Database } from "bun:sqlite";
import { DomainError } from "./domain.ts";
import { chatJson, type AiConfig } from "./ai.ts";

// AI camera: a photo of the dining area is sent to a vision model, which says
// per table whether it looks empty. The result is stored as an observation.
// It never changes table status automatically: staff decide.

const MAX_IMAGE_CHARS = 4_000_000; // ~3 MB of JPEG
export const OBSERVATIONS = ["empty", "occupied", "unknown"] as const;

export function toDataUrl(image: string, mime = "image/jpeg"): string {
  if (image.startsWith("data:image/")) return image;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(image)) throw new DomainError("image must be base64 or a data URL.");
  return `data:${mime};base64,${image}`;
}

export async function checkTables(
  db: Database,
  ai: AiConfig | null,
  input: { image: string; mime?: string; table_ids?: string[] },
) {
  if (!ai) {
    throw new DomainError("AI camera is not configured. Set MODEL_API_KEY (Meta Model API).");
  }
  if (input.image.length > MAX_IMAGE_CHARS) throw new DomainError("Image too large (max about 3 MB).");

  const all = db.query("SELECT id, name, status FROM tables ORDER BY name").all() as any[];
  const tables = input.table_ids?.length ? all.filter((t) => input.table_ids!.includes(t.id)) : all;
  if (input.table_ids?.length && tables.length !== new Set(input.table_ids).size) {
    throw new DomainError("One or more table_ids not found.");
  }
  if (tables.length === 0) throw new DomainError("No tables to check.");

  const url = toDataUrl(input.image, input.mime);
  const list = tables.map((t) => `- table_id "${t.id}" (${t.name})`).join("\n");
  const out: any = await chatJson(ai, ai.visionModel, [
    {
      role: "system",
      content:
        'Kamu memeriksa foto area makan restoran. Untuk setiap meja, jawab JSON {"results":[{"table_id":"...","state":"empty|occupied|unknown"}]}. ' +
        "empty = tidak ada orang duduk atau barang (makanan, minuman, tas) di meja. occupied = ada orang atau barang. " +
        "unknown = meja tidak terlihat jelas. Hanya pakai table_id dari daftar.",
    },
    {
      role: "user",
      content: [
        { type: "text", text: `Meja yang diperiksa:\n${list}` },
        { type: "image_url", image_url: { url } },
      ],
    },
  ]);

  const byId = new Map<string, string>();
  for (const r of Array.isArray(out?.results) ? out.results : []) {
    if (r && typeof r.table_id === "string" && (OBSERVATIONS as readonly string[]).includes(r.state)) {
      byId.set(r.table_id, r.state);
    }
  }
  const now = new Date().toISOString();
  const upd = db.query("UPDATE tables SET observed_status = $s, observed_at = $n WHERE id = $id");
  return db.transaction(() =>
    tables.map((t) => {
      const state = byId.get(t.id) ?? "unknown";
      upd.run({ $s: state, $n: now, $id: t.id });
      return {
        table_id: t.id,
        name: t.name,
        status: t.status,
        observed: state,
        // Hint for staff: the camera sees it empty but the system says occupied.
        hint: state === "empty" && t.status === "occupied" ? "Terlihat kosong, status masih terisi. Cek dan ubah status bila sesuai." : null,
      };
    }),
  )();
}
