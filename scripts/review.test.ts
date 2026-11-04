import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFiles, readContents, staticChecks, safeForAi, aiReview, reviewApp, renderReport, SECRET_PATTERNS } from "./review-app.ts";

function app(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "review-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

const GOOD_README = "# App\n\n## Install\n\n```bash\nbun install\nbun run start\n```\n\n" + "Penjelasan fitur lengkap aplikasi ini untuk pengguna. ".repeat(10);

describe("static checks", () => {
  it("clean app has no must-fix items", async () => {
    const dir = app({
      "README.md": GOOD_README,
      ".gitignore": "node_modules/\n.env\n",
      "Dockerfile": "FROM oven/bun",
      "package.json": "{}",
      "src/server.ts": "console.log('hi')",
      "test/a.test.ts": "",
    });
    const files = await listFiles(dir);
    const r = staticChecks(dir, files, await readContents(dir, files));
    expect(r.filter((c) => c.level === "must")).toEqual([]);
    expect(r.find((c) => c.name === "Tes")!.level).toBe("ok");
  });

  it("leaked key is a must-fix and the file is withheld from AI", async () => {
    const leaked = "const k = 'sk-abcdefghijklmnopqrstuvwxyz123456';";
    const dir = app({ "README.md": GOOD_README, "src/x.ts": leaked, "src/ok.ts": "export const a = 1;" });
    const files = await listFiles(dir);
    const contents = await readContents(dir, files);
    const r = staticChecks(dir, files, contents);
    const secret = r.find((c) => c.name === "Secrets")!;
    expect(secret.level).toBe("must");
    expect(secret.detail).toContain("src/x.ts");
    expect(safeForAi(files, contents)).not.toContain("src/x.ts");
    expect(safeForAi(files, contents)).toContain("src/ok.ts");
  });

  it("committed .env and database are must-fix", async () => {
    const dir = app({ "README.md": GOOD_README, ".env": "A=1", "data/fnb.db": "x" });
    const files = await listFiles(dir);
    const r = staticChecks(dir, files, await readContents(dir, files));
    expect(r.find((c) => c.name === "Data lokal")!.level).toBe("must");
  });

  it("missing README is must-fix; thin README and no Meta model are suggestions", async () => {
    const none = app({ "src/a.ts": "" });
    const f1 = await listFiles(none);
    expect(staticChecks(none, f1, await readContents(none, f1)).find((c) => c.name === "README")!.level).toBe("must");

    const thin = app({ "README.md": "hi" });
    const f2 = await listFiles(thin);
    const r = staticChecks(thin, f2, await readContents(thin, f2));
    expect(r.find((c) => c.name === "README")!.level).toBe("suggest");
    expect(r.find((c) => c.name === "Model Meta")!.level).toBe("suggest");
  });

  it("secret pattern list catches an assigned API key but not a placeholder", () => {
    const hit = SECRET_PATTERNS.some((p) => p.re.test('MODEL_API_KEY="abcdefghijklmnopqrstuvwx1234"'));
    const miss = SECRET_PATTERNS.some((p) => p.re.test("MODEL_API_KEY=\n"));
    expect(hit).toBe(true);
    expect(miss).toBe(false);
  });
});

describe("AI review", () => {
  it("skips AI cleanly without a key", async () => {
    const dir = app({ "README.md": GOOD_README });
    const r = await reviewApp(dir, { ai: true, apiKey: "" });
    expect(r.ai).toBeNull();
    expect(r.aiError).toBeNull();
    expect(r.markdown).toContain("tidak dijalankan");
  });

  it("parses the Meta Model API response and clamps the score", async () => {
    let seen: any = null;
    const stub = Bun.serve({
      port: 0,
      async fetch(req) {
        seen = await req.json();
        expect(req.headers.get("authorization")).toBe("Bearer test-key");
        return Response.json({
          choices: [{ message: { content: JSON.stringify({ score: 42, summary: "Bagus.", strengths: ["a"], must_fix: ["b"], suggestions: ["c"] }) } }],
        });
      },
    });
    const dir = app({ "README.md": GOOD_README, "src/x.ts": "export const x = 1;" });
    const files = await listFiles(dir);
    const contents = await readContents(dir, files);
    const ai = await aiReview("demo", files, contents, { apiKey: "test-key", baseUrl: `http://127.0.0.1:${stub.port}/v1` });
    expect(ai.score).toBe(10);
    expect(ai.must_fix).toEqual(["b"]);
    expect(seen.model).toBe("muse-spark-1.3");
    expect(JSON.stringify(seen.messages)).toContain("export const x");
    stub.stop(true);
  });

  it("reports a provider error without failing the static review", async () => {
    const stub = Bun.serve({ port: 0, fetch: () => new Response("no", { status: 401 }) });
    const dir = app({ "README.md": GOOD_README });
    const files = await listFiles(dir);
    const contents = await readContents(dir, files);
    const r = { checks: staticChecks(dir, files, contents) };
    let err: string | null = null;
    try {
      await aiReview("x", files, contents, { apiKey: "bad", baseUrl: `http://127.0.0.1:${stub.port}/v1` });
    } catch (e) {
      err = String(e);
    }
    expect(err).toContain("401");
    expect(renderReport("x", r.checks, null, err!)).toContain("tidak berjalan");
    stub.stop(true);
  });
});
