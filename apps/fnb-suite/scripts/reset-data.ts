// Deletes ALL business data (orders, customers, menu, accounts, campaigns) but keeps the schema.
// Destructive. Requires --yes and an explicit DB path.
//   bun scripts/reset-data.ts --db ./data/fnb.db --yes
import { existsSync } from "node:fs";
import { openDb } from "../src/db.ts";

const args = process.argv.slice(2);
const dbPath = args[args.indexOf("--db") + 1];
if (!dbPath || args.indexOf("--db") < 0) {
  console.error("Usage: bun scripts/reset-data.ts --db <path> --yes");
  process.exit(1);
}
if (!args.includes("--yes")) {
  console.error("Refusing to delete without --yes.");
  process.exit(1);
}
if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}; nothing to do.`);
  process.exit(0);
}

const db = openDb(dbPath);
const TABLES = [
  "payments", "order_items", "orders", "cart_items", "carts", "bookings", "addons",
  "campaigns", "sessions", "team_members", "users", "team", "customers", "promotions",
  "products", "tables", "settings",
];
db.transaction(() => {
  for (const t of TABLES) db.exec(`DELETE FROM ${t};`);
  db.exec("DELETE FROM sqlite_sequence;");
})();
db.exec("VACUUM;");
db.close();
console.log(`Reset ${dbPath}: all business data removed, schema kept.`);
