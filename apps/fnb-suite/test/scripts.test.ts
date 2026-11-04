import { describe, it, expect } from "bun:test";
import { openDb } from "../src/db.ts";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acc from "../src/accounts.ts";

function run(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawnSync([process.execPath, ...args], { cwd: join(import.meta.dir, ".."), env: { ...process.env, ...env } });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

describe("seed and reset scripts", () => {
  const dir = mkdtempSync(join(tmpdir(), "fnb-scripts-"));
  const db = join(dir, "fnb.db");

  it("seeds one owner, one team, a menu; second run changes nothing", () => {
    const r = run(["scripts/seed-sample.ts", "--db", db], { SAMPLE_PASSWORD: "sample-pass-123" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("owner@mcd-sample.local");

    const again = run(["scripts/seed-sample.ts", "--db", db], { SAMPLE_PASSWORD: "sample-pass-123" });
    expect(again.out).toContain("already seeded");

    const h = openDb(db);
    expect((h.query("SELECT COUNT(*) AS n FROM users").get() as any).n).toBe(1);
    expect((h.query("SELECT COUNT(*) AS n FROM team").get() as any).n).toBe(1);
    expect((h.query("SELECT COUNT(*) AS n FROM products").get() as any).n).toBe(7);
    expect((h.query("SELECT COUNT(*) AS n FROM tables").get() as any).n).toBe(5);
    expect((h.query("SELECT role FROM team_members").get() as any).role).toBe("owner");
    h.close();
  });

  it("seeded owner can log in with the chosen password", async () => {
    const h = openDb(db);
    const s = await acc.login(h, "owner@mcd-sample.local", "sample-pass-123");
    expect(s.user.role).toBe("owner");
    h.close();
  });

  it("reset refuses without --yes, then wipes business data but keeps schema", () => {
    expect(run(["scripts/reset-data.ts", "--db", db]).code).not.toBe(0);
    const r = run(["scripts/reset-data.ts", "--db", db, "--yes"]);
    expect(r.code).toBe(0);
    const h = openDb(db);
    for (const t of ["users", "products", "tables", "team", "sessions", "orders"]) {
      expect((h.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n).toBe(0);
    }
    h.close();
    // Schema still works: seed again after reset.
    expect(run(["scripts/seed-sample.ts", "--db", db], { SAMPLE_PASSWORD: "sample-pass-123" }).code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
