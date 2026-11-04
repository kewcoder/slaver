// Creates a sample business: one owner account, one team, and a small menu.
// Idempotent: does nothing if the sample owner already exists.
//   bun scripts/seed-sample.ts --db ./data/fnb.db
// Optional: SAMPLE_PASSWORD=... to choose the password (otherwise one is generated and printed once).
// All names and prices are placeholders for demos, not real McDonald's data.
import { openDb } from "../src/db.ts";
import * as d from "../src/domain.ts";
import * as acc from "../src/accounts.ts";

const args = process.argv.slice(2);
const dbPath = args[args.indexOf("--db") + 1];
if (!dbPath || args.indexOf("--db") < 0) {
  console.error("Usage: bun scripts/seed-sample.ts --db <path>");
  process.exit(1);
}

const OWNER_EMAIL = "owner@mcd-sample.local";
const db = openDb(dbPath);

if (db.query("SELECT id FROM users WHERE email = $e").get({ $e: OWNER_EMAIL })) {
  console.log(`Sample already seeded (${OWNER_EMAIL}). Nothing changed.`);
  process.exit(0);
}

const password = process.env.SAMPLE_PASSWORD ?? generatePassword();

acc.ensureTeam(db, "McD (Contoh)");
await acc.addMember(db, { email: OWNER_EMAIL, name: "Owner McD (Contoh)", password, role: "owner" });

const settings: Record<string, string> = {
  shop_name: "McD (Contoh)",
  shop_address: "Jl. Contoh No. 1, Jakarta Pusat",
  shop_hours: "06.00 - 23.00",
  delivery_fee_idr: "10000",
  booking_deposit_idr: "50000",
  utc_offset_hours: "7",
};
for (const [k, v] of Object.entries(settings)) d.setSetting(db, k, v);

const burger = d.upsertProduct(db, { name: "Burger Sapi Besar", category: "Burger", price_idr: 45000, stock_qty: 60, description: "Patty sapi, keju, selada" }).id;
d.upsertProduct(db, { name: "Burger Ayam Klasik", category: "Burger", price_idr: 32000, stock_qty: 40, description: "Ayam crispy, mayones" });
const ayam = d.upsertProduct(db, { name: "Ayam Goreng 2 Potong", category: "Ayam", price_idr: 38000, stock_qty: 30 }).id;
const kentang = d.upsertProduct(db, { name: "Kentang Goreng Sedang", category: "Sides", price_idr: 18000 }).id;
d.upsertProduct(db, { name: "Es Krim Cone", category: "Dessert", price_idr: 8000 });
d.upsertProduct(db, { name: "Kopi Susu", category: "Minuman", price_idr: 22000, stock_qty: 100 });
d.upsertProduct(db, { name: "Cola", category: "Minuman", price_idr: 12000 });

d.upsertAddon(db, { product_id: burger, name: "Keju ekstra", price_idr: 8000 });
d.upsertAddon(db, { product_id: kentang, name: "Saus sambal", price_idr: 2000 });
d.upsertAddon(db, { product_id: ayam, name: "Nasi tambahan", price_idr: 7000, stock_qty: 20 });

for (const t of [
  { name: "A1", capacity: 2 },
  { name: "A2", capacity: 4 },
  { name: "B1", capacity: 4 },
  { name: "B2", capacity: 6 },
  { name: "Outdoor O1", capacity: 4 },
]) d.upsertTable(db, t);

d.upsertPromotion(db, { code: "HEMAT10", name: "Hemat 10% min. Rp 50.000", kind: "percent", value: 10, min_subtotal_idr: 50000 });

db.close();
console.log("Sample seeded.");
console.log(`  Team     : ${settings.shop_name}`);
console.log(`  Login    : ${OWNER_EMAIL}`);
console.log(`  Password : ${password}`);
console.log("  Store the password now; it is not shown again.");

function generatePassword(): string {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}
