// Sample business for demos: Saung Ranggon (rumah makan Sunda, Tasikmalaya).
// Menu, prices, and paket follow the restaurant's printed menu. Tables, the
// promo, and the owner login are placeholders for the demo.
// Idempotent: does nothing if the sample owner already exists.
//   bun scripts/seed-sample.ts --db ./data/fnb.db
// Optional: SAMPLE_PASSWORD=... to choose the password (otherwise one is generated and printed once).
import { openDb } from "../src/db.ts";
import * as d from "../src/domain.ts";
import * as acc from "../src/accounts.ts";

const args = process.argv.slice(2);
const dbPath = args[args.indexOf("--db") + 1];
if (!dbPath || args.indexOf("--db") < 0) {
  console.error("Usage: bun scripts/seed-sample.ts --db <path>");
  process.exit(1);
}

const OWNER_EMAIL = "demo@saung-ranggon.local";
const db = openDb(dbPath);

if (db.query("SELECT id FROM users WHERE email = $e").get({ $e: OWNER_EMAIL })) {
  console.log(`Sample already seeded (${OWNER_EMAIL}). Nothing changed.`);
  process.exit(0);
}

const password = process.env.SAMPLE_PASSWORD ?? generatePassword();

acc.ensureTeam(db, "Saung Ranggon");
await acc.addMember(db, { email: OWNER_EMAIL, name: "Demo Saung Ranggon", password, role: "owner" });

const settings: Record<string, string> = {
  shop_name: "Saung Ranggon",
  shop_address: "Tasikmalaya, Jawa Barat",
  utc_offset_hours: "7",
  booking_deposit_idr: "50000",
};
for (const [k, v] of Object.entries(settings)) d.setSetting(db, k, v);

// [name, category, price in IDR, description?]
type Item = [string, string, number, string?];
const PAKET: Item[] = [
  ["Timbel Komplit Ayam Kampung Goreng", "Paket", 44000, "Nasi putih, tahu, tempe, sambal lalab, pencok kacang, ayam goreng kampung serundeng"],
  ["Timbel Komplit Ayam Kampung Bakar", "Paket", 45000, "Nasi putih, tahu, tempe, sambal lalab, pencok kacang, ayam bakar kampung bumbu khas Ranggon"],
  ["Timbel Komplit Ayam Parahyangan Bakar / Goreng", "Paket", 43000, "Nasi putih, tahu, tempe, sambal lalab, pencok kacang, ayam pejantan goreng / bakar"],
  ["Timbel Komplit Sate Ayam", "Paket", 35000, "Nasi putih, tahu, tempe, sambal lalab, pencok kacang, sate ayam 5 tusuk"],
  ["Timbel Komplit Sate Sapi", "Paket", 38000, "Nasi putih, tahu, tempe, sambal lalab, pencok kacang, sate sapi 4 tusuk"],
  ["Nasi Sop Iga Rebus", "Paket", 49000, "Nasi putih, tahu, tempe, sambal irisan cabai, sop iga rebus"],
  ["Nasi Sop Iga Bakar", "Paket", 49000, "Nasi putih, tahu, tempe, sambal garang, irisan cabai, kuah sop, iga bakar"],
  ["Nasi Tutug Oncom Spesial", "Paket", 36000, "Nasi tutug oncom, tahu, mendoan, sambal lalab, ayam goreng kampung serundeng"],
];
const MENU: Item[] = [
  ["Ayam Parahyangan Goreng", "Masakan Daging", 33000],
  ["Ayam Parahyangan Bakar", "Masakan Daging", 33000],
  ["Ayam Kampung Goreng", "Masakan Daging", 34000],
  ["Ayam Kampung Bakar", "Masakan Daging", 35000],
  ["Gepuk", "Masakan Daging", 28000],
  ["Sate Sapi (10 tusuk)", "Masakan Daging", 55000, "Bumbu kacang / kecap"],
  ["Sate Maranggi", "Masakan Daging", 55000],
  ["Sate Ayam (10 tusuk)", "Masakan Daging", 45000, "Bumbu kacang / kecap"],
  ["Seblak Ceker", "Masakan Daging", 30000],
  ["Iga Bakar Garang", "Masakan Daging", 38000],
  ["Tahu", "Gorengan", 2500],
  ["Tempe", "Gorengan", 2500],
  ["Mendoan (5 pcs)", "Gorengan", 15000],
  ["Gehu Spesial (5 pcs)", "Gorengan", 25000],
  ["Pencok Bonteng", "Pencok / Karedok", 12000],
  ["Pencok Kacang", "Pencok / Karedok", 12000],
  ["Pencok Leunca", "Pencok / Karedok", 12000],
  ["Karedok Mentah", "Pencok / Karedok", 25000],
  ["Dadar Polos (2 telor)", "Dadar Telor", 15000],
  ["Dadar Peda (2 telor)", "Dadar Telor", 18000],
  ["Dadar Petai (2 telor)", "Dadar Telor", 18000],
  ["Dadar Petai + Peda (2 telor)", "Dadar Telor", 20000],
  ["Sop Iga Bakar", "Sop", 42000],
  ["Sop Dengkul", "Sop", 42000],
  ["Sop Iga (tidak dibakar)", "Sop", 42000],
  ["Udang Krispi", "Udang", 35000],
  ["Udang Saus Padang", "Udang", 37000],
  ["Udang Asam Manis", "Udang", 37000],
  ["Cumi Krispi", "Cumi", 35000],
  ["Cumi Saus Padang", "Cumi", 37000],
  ["Cumi Asam Manis", "Cumi", 37000],
  ["Petai Mentah", "Petai", 8000],
  ["Petai Bakar", "Petai", 10000],
  ["Petai Goreng", "Petai", 10000],
  ["Tumis Jambal", "Tumis", 20000],
  ["Tumis Jambal Pete", "Tumis", 23000],
  ["Tumis Tongkol Sps", "Tumis", 25000],
  ["Tumis Teri Sps", "Tumis", 25000],
  ["Tumis Ampela Ati", "Tumis", 18000],
  ["Tumis Peda", "Tumis", 18000],
  ["Tumis Peda + Pete", "Tumis", 20000],
  ["Peda Bakar / Goreng", "Lainnya", 11000],
  ["Jambal Goreng", "Lainnya", 11000],
  ["Ulukutek Leunca", "Lainnya", 11000],
  ["Oseng Pokcoy", "Oseng", 25000],
  ["Oseng Kangkung", "Oseng", 25000],
  ["Oseng Genjer", "Oseng", 25000],
  ["Oseng Kangkung Cikur", "Oseng", 25000],
  ["Oseng Genjer Cikur", "Oseng", 25000],
];

// Stock is only tracked for a few items to show the stock flow in the demo.
const LIMITED: Record<string, number> = { "Timbel Komplit Ayam Kampung Goreng": 30, "Timbel Komplit Ayam Kampung Bakar": 30 };
for (const [name, category, price, description] of [...PAKET, ...MENU]) {
  d.upsertProduct(db, { name, category, price_idr: price, description, stock_qty: LIMITED[name] ?? null });
}

for (const t of [
  { name: "Meja 1", capacity: 2 },
  { name: "Meja 2", capacity: 4 },
  { name: "Meja 3", capacity: 4 },
  { name: "Meja 4", capacity: 6 },
  { name: "Saung 1", capacity: 6 },
]) d.upsertTable(db, t);

d.upsertPromotion(db, { code: "CONTOH10", name: "Contoh promo 10% (hapus jika tidak perlu)", kind: "percent", value: 10, min_subtotal_idr: 50000 });

db.close();
console.log("Sample seeded: Saung Ranggon.");
console.log(`  Products : ${PAKET.length + MENU.length}`);
console.log(`  Login    : ${OWNER_EMAIL}`);
console.log(`  Password : ${password}`);
console.log("  Store the password now; it is not shown again.");

function generatePassword(): string {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}
