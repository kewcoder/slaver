// Creates the real business: its team, the owner account, and the shop name.
// Run once per deployment. Refuses to run if the team already has an owner.
//
//   OWNER_PASSWORD='min-8-karakter' bun scripts/create-owner.ts \
//     --db ./data/fnb.db --email pemilik@usaha.id --name "Nama Pemilik" --business "Rumah Makan Contoh"
//
// The password is read from OWNER_PASSWORD so it does not end up in shell history.
import { openDb } from "../src/db.ts";
import * as d from "../src/domain.ts";
import * as acc from "../src/accounts.ts";

export async function createOwner(
  dbPath: string,
  input: { email: string; name: string; business: string; password: string },
) {
  const db = openDb(dbPath);
  try {
    const existing = db
      .query("SELECT u.email FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.role = 'owner'")
      .get() as { email: string } | null;
    if (existing) throw new Error(`This deployment already has an owner (${existing.email}). Nothing changed.`);
    if (!input.business.trim()) throw new Error("--business is required.");
    if (!input.name.trim()) throw new Error("--name is required.");

    acc.ensureTeam(db, input.business.trim());
    const user = await acc.addMember(db, { email: input.email, name: input.name.trim(), password: input.password, role: "owner" });
    d.setSetting(db, "shop_name", input.business.trim());
    return { team: input.business.trim(), owner: user.email };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] ?? "" : "";
  };
  const password = process.env.OWNER_PASSWORD ?? "";
  const db = get("--db");
  const email = get("--email");
  if (!db || !email || !get("--name") || !get("--business") || !password) {
    console.error('Usage: OWNER_PASSWORD=... bun scripts/create-owner.ts --db <path> --email <email> --name "<nama>" --business "<nama usaha>"');
    process.exit(1);
  }
  try {
    const r = await createOwner(db, { email, name: get("--name"), business: get("--business"), password });
    console.log(`Owner created for "${r.team}": ${r.owner}`);
    console.log("Log in at /admin/ with that email and password.");
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
